import { join } from "node:path";
import { cpus } from "node:os";
import { spawn } from "bun";

export type WhisperPythonStatus = { python: string; executable: string; modelDirectory: string; whisper: boolean; torch: boolean; cuda: boolean; error?: string };

export async function runPython(pythonPath: string, args: string[], signal: AbortSignal,
  options: { env?: Record<string, string | undefined>; onOutput?: (text: string) => void } = {}) {
  signal.throwIfAborted();
  const child = spawn([pythonPath, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", ...options.env } });
  let stopping: Promise<void> | undefined;
  const cancel = () => {
    stopping = (async () => {
      if (process.platform === "win32") {
        const killer = spawn([join(process.env.SystemRoot || "C:\\Windows", "System32/taskkill.exe"), "/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdout: "ignore", stderr: "ignore" });
        if (await killer.exited === 0) return;
      }
      try { child.kill(); } catch { /* 进程可能已结束。 */ }
    })();
    void stopping.catch(() => { try { child.kill(); } catch { /* 保留原取消原因。 */ } });
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  async function read(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    let output = "";
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      output = (output + text).slice(-64 * 1024);
      options.onOutput?.(text);
    }
    return output + decoder.decode();
  }
  try {
    const [stdout, stderr, code] = await Promise.all([read(child.stdout), read(child.stderr), child.exited]);
    await stopping;
    signal.throwIfAborted();
    if (code !== 0) throw new Error((stderr.trim() || stdout.trim() || `Python 退出码 ${code}`).slice(-4000));
    return { stdout, stderr };
  } finally {
    signal.removeEventListener("abort", cancel);
    await stopping?.catch(() => {});
  }
}

export async function inspectWhisperPython(pythonPath: string, signal: AbortSignal): Promise<WhisperPythonStatus> {
  const script = [
    "import json, sys, os, importlib.util",
    "result = {'python': sys.version.split()[0], 'executable': sys.executable, 'modelDirectory': os.path.join(os.getenv('XDG_CACHE_HOME', os.path.join(os.path.expanduser('~'), '.cache')), 'whisper'), 'whisper': False, 'torch': False, 'cuda': False}",
    "try:",
    " import torch",
    " result['torch'] = True",
    " result['cuda'] = bool(torch.cuda.is_available())",
    " try:",
    "  if result['cuda']:",
    "   torch.zeros(1, device='cuda').add_(1)",
    " except Exception:",
    "  result['cuda'] = False",
    " if importlib.util.find_spec('whisper') is not None:",
    "  import whisper",
    "  result['whisper'] = True",
    "except Exception as error:",
    " result['error'] = str(error)",
    "print(json.dumps(result))",
  ].join("\n");
  const { stdout } = await runPython(pythonPath, ["-B", "-c", script], signal);
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) || "null") as WhisperPythonStatus;
  if (!result || typeof result.python !== "string" || typeof result.executable !== "string" || typeof result.modelDirectory !== "string"
    || typeof result.whisper !== "boolean" || typeof result.torch !== "boolean" || typeof result.cuda !== "boolean")
    throw new Error("Python 环境检测没有返回有效结果");
  return result;
}

export async function transcribeWhisper(input: {
  pythonPath: string; audioPath: string; modelPath: string; directory: string; language: string;
  device: string; signal: AbortSignal; onProgress?: (seconds: number) => void;
}) {
  const script = [
    "import sys, wave, numpy as np, whisper, torch",
    "from whisper.utils import get_writer",
    "audioPath, modelPath, directory, language, device, threads = sys.argv[1:]",
    "torch.set_num_threads(int(threads))",
    "with wave.open(audioPath, 'rb') as audio:",
    " if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (1, 2, 16000):",
    "  raise ValueError('Expected mono 16 kHz PCM16 audio')",
    " samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype='<i2').astype(np.float32) / 32768.0",
    "model = whisper.load_model(modelPath, device=device)",
    "result = model.transcribe(samples, task='transcribe', verbose=True, language=language or None, fp16=device.startswith('cuda'))",
    "get_writer('srt', directory)(result, audioPath)",
  ].join("\n");
  let tail = "";
  await runPython(input.pythonPath, ["-u", "-B", "-c", script, input.audioPath, input.modelPath, input.directory,
    input.language, input.device, String(Math.max(1, Math.min(4, cpus().length - 2)))], input.signal, { onOutput(text) {
    tail = (tail + text).slice(-1024);
    const matches = [...tail.matchAll(/\[?(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})\s*-->/g)];
    const match = matches.at(-1);
    if (match) input.onProgress?.(Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000);
  } });
}
