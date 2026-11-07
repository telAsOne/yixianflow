import { createHash } from "node:crypto";
import { cpus, freemem, homedir, totalmem } from "node:os";
import { dirname, join, parse } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream, link, lstat, mkdir, readFile, rename, unlink, writeAtomic } from "@toonflow/file";
import { unzipSync } from "fflate";
import { z } from "zod";
import { whisperCatalog } from "@toonflow/node-subtitle/whisperModels";
import type { WhisperModel } from "@toonflow/node-subtitle/whisperModels";
import { inspectWhisperPython, runPython } from "@toonflow/node-subtitle/whisperRuntime";
import type { WhisperPythonStatus } from "@toonflow/node-subtitle/whisperRuntime";
import { dataDirectory } from "./logger";
import { localPath, operate, fileRevision } from "./operations";
import { selectWhisperModel, subtitleSettingsSchema } from "./subtitleProtocol";
import type { SubtitleEnvironment, SubtitleHardware, SubtitleSettings } from "./subtitleProtocol";
import { installedWhisperPythons, pythonModelDirectories, searchWhisperDisks } from "./whisperDiscovery";
import type { WhisperLocations } from "./whisperDiscovery";

const gib = 1024 ** 3;
const settingsPath = join(dataDirectory, "subtitleSettings.json");
const discoveryPath = join(dataDirectory, "whisperDiscovery.json");
const discoverySchema = z.object({ pythonPaths: z.array(z.string().max(4096)).max(24), modelDirectories: z.array(z.string().max(4096)).max(64), incomplete: z.boolean().default(false) });
const pythonAsset = { file: "python.zip", bytes: 11133606, sha256: "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3",
  url: "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip" };
const pipAsset = { file: "pip.whl", bytes: 1825227, sha256: "2913a38a2abf4ea6b64ab507bd9e967f3b53dc1ede74b01b0931e1ce548751af",
  url: "https://files.pythonhosted.org/packages/29/a2/d40fb2460e883eca5199c62cfc2463fd261f760556ae6290f88488c362c0/pip-25.1.1-py3-none-any.whl" };
const whisperAsset = { file: "openaiWhisper.tar.gz", bytes: 803191, sha256: "37a91a3921809d9f44748ffc73c0a55c9f366c85a3ef5c2ae0cc09540432eb96",
  url: "https://files.pythonhosted.org/packages/35/8e/d36f8880bcf18ec026a55807d02fe4c7357da9f25aebd92f85178000c0dc/openai_whisper-20250625.tar.gz" };
const officialHosts = new Set(["www.python.org", "files.pythonhosted.org", "openaipublic.azureedge.net", "download.pytorch.org"]);

async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function fileInfo(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
}

async function downloadOfficial(asset: { url: string; sha256: string; bytes: number }, target: string,
  signal: AbortSignal, report: (bytes: number, total: number) => void) {
  await mkdir(dirname(target), { recursive: true });
  const existing = await fileInfo(target);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("下载目标不是普通文件");
    if (existing.size === asset.bytes && await digest(target) === asset.sha256) { report(asset.bytes, asset.bytes); return; }
    await rename(target, `${target}.invalid${crypto.randomUUID()}`);
  }
  const partial = `${target}.part`;
  const info = await fileInfo(partial);
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("下载临时文件不是普通文件");
  let received = info?.size ?? 0;
  if (received > asset.bytes) { await unlink(partial); received = 0; }
  if (received < asset.bytes) {
    const response = await fetch(asset.url, { signal, headers: { "Accept-Encoding": "identity", ...(received ? { Range: `bytes=${received}-` } : {}) } });
    if (!officialHosts.has(new URL(response.url).hostname) || !response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`官方下载失败（HTTP ${response.status}），不会切换到第三方镜像`);
    }
    if (received && response.status === 200) received = 0;
    if (response.status === 206 && response.headers.get("content-range") !== `bytes ${received}-${asset.bytes - 1}/${asset.bytes}`) {
      await response.body.cancel(); throw new Error("官方下载的续传范围不匹配");
    }
    if (response.status !== 200 && response.status !== 206) { await response.body.cancel(); throw new Error("官方下载返回了不支持的响应状态"); }
    let reportedAt = 0;
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
      received += chunk.length;
      if (Date.now() - reportedAt > 200) { reportedAt = Date.now(); report(received, asset.bytes); }
      done(received > asset.bytes ? new Error("官方下载超过预期大小") : null, chunk);
    } }), createWriteStream(partial, { flags: received ? "a" : "w" }), { signal });
  }
  signal.throwIfAborted();
  if (received !== asset.bytes || await digest(partial) !== asset.sha256) {
    await unlink(partial);
    throw new Error("官方下载大小或 SHA-256 不匹配，已丢弃损坏文件");
  }
  await link(partial, target);
  await unlink(partial);
  report(asset.bytes, asset.bytes);
}

async function extractSmallArchive(path: string, target: string) {
  if ((await lstat(path)).size > 32 * 1024 * 1024) throw new Error("引导安装包超过解压上限");
  const entries = unzipSync(await readFile(path));
  let bytes = 0;
  for (const [name, content] of Object.entries(entries)) {
    if (/^[\\/]|[:\x00-\x1f]/.test(name) || name.split(/[\\/]/).some(part => part === ".." || part === ".")) throw new Error("官方安装包路径无效");
    bytes += content.length;
    if (bytes > 128 * 1024 * 1024) throw new Error("引导安装包解压后超过上限");
    if (name.endsWith("/")) continue;
    const output = join(target, name);
    await mkdir(dirname(output), { recursive: true });
    await writeAtomic(output, content, { exclusive: true });
  }
}

async function inspectHardware(directory: string, acceleration: SubtitleSettings["acceleration"]): Promise<SubtitleHardware> {
  const script = [
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "$subtitleGpus = @()",
    "$subtitleNvidia = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue",
    "if ($subtitleNvidia) {",
    " $subtitlePreviousPreference = $ErrorActionPreference; $ErrorActionPreference = 'Continue'",
    " $subtitleRows = & $subtitleNvidia.Source --query-gpu=index,name,memory.total,memory.free,driver_version --format=csv,noheader,nounits 2>$null",
    " if ($LASTEXITCODE -eq 0) { foreach ($subtitleRow in $subtitleRows) {",
    "  $subtitleParts = $subtitleRow -split ',\\s*'",
    "  if ($subtitleParts.Length -eq 5) { try { $subtitleGpus += @{ name=$subtitleParts[1]; index=[int]$subtitleParts[0]; memoryTotal=[double]$subtitleParts[2]*1MB; memoryFree=[double]$subtitleParts[3]*1MB; driver=$subtitleParts[4]; cuda=([version]$subtitleParts[4] -ge [version]'560.76') } } catch {} }",
    " } }",
    " $ErrorActionPreference = $subtitlePreviousPreference",
    "}",
    "$subtitleAdapters = @(Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch 'Virtual|Remote|Idd|Zako' })",
    "foreach ($subtitleAdapter in $subtitleAdapters) { if (-not ($subtitleGpus | Where-Object { $_.name -eq $subtitleAdapter.Name })) { $subtitleGpus += @{ name=$subtitleAdapter.Name; cuda=$false } } }",
    "$subtitleDisks = @(Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 2 -or $_.DriveType -eq 3 } | ForEach-Object { @{ path=$_.DeviceID; total=[double]$_.Size; free=[double]$_.FreeSpace } })",
    "@{ gpus=@($subtitleGpus); disks=@($subtitleDisks) } | ConvertTo-Json -Depth 5 -Compress",
    "exit 0",
  ].join("\n");
  const result = await operate({ action: "execute", command: script, timeoutSeconds: 25 }, AbortSignal.timeout(30000)) as { stdout: string; exitCode: number };
  if (result.exitCode !== 0) throw new Error("无法读取 GPU 或磁盘信息，未开始下载");
  const inventory = JSON.parse(result.stdout.trim()) as Pick<SubtitleHardware, "disks" | "gpus">;
  if (!Array.isArray(inventory.disks) || !Array.isArray(inventory.gpus)) throw new Error("硬件检测返回格式无效");
  for (const gpu of inventory.gpus) {
    const blackwell = /RTX\s*50\d\d|Blackwell|\bB[12]00\b|\bGB\d+/i.test(gpu.name);
    gpu.runtime = blackwell ? "cu128" : "cu126";
    if (blackwell && Number(gpu.driver?.split(".")[0] || 0) < 570) gpu.cuda = false;
  }
  const gpu = acceleration === "auto" ? inventory.gpus.filter(item => item.cuda && Number.isFinite(item.memoryFree))
    .sort((a, b) => b.memoryFree! - a.memoryFree!)[0] : undefined;
  const storageFree = inventory.disks.find(disk => disk.path.toLowerCase() === parse(directory).root.slice(0, 2).toLowerCase())?.free ?? 0;
  const hardware: SubtitleHardware = { ...inventory, cpu: cpus()[0]?.model || "未知 CPU", cores: cpus().length,
    memoryTotal: totalmem(), memoryFree: freemem(), cuda: !!gpu, device: gpu ? `cuda:${gpu.index}` : "cpu", storageFree, reason: "" };
  const preferred: WhisperModel[] = gpu ? ["turbo", "small", "base", "tiny"] : hardware.memoryFree >= 8 * gib && hardware.cores >= 6 ? ["small", "base", "tiny"] : ["base", "tiny"];
  hardware.recommended = preferred.find(id => !modelUnavailable(id, hardware));
  hardware.reason = hardware.recommended
    ? `${gpu ? `可用 NVIDIA 显存 ${(gpu.memoryFree! / gib).toFixed(1)} GiB` : "当前使用 CPU"}，可用内存 ${(hardware.memoryFree / gib).toFixed(1)} GiB，缓存盘剩余 ${(storageFree / gib).toFixed(1)} GiB；推荐 ${hardware.recommended}`
    : "当前可用内存或缓存盘空间不足，未推荐模型，也不会开始下载";
  if (!gpu && inventory.gpus.some(item => /AMD|Radeon|Intel/i.test(item.name))) hardware.reason += "。此版本使用 PyTorch CPU／CUDA，不把 AMD／Intel 显存当成可用 CUDA 显存";
  return hardware;
}

function modelUnavailable(id: WhisperModel, hardware: SubtitleHardware, cached = false, ready = false) {
  const model = whisperCatalog.find(item => item.id === id)!;
  if (hardware.memoryFree < model.ramBytes + gib) return "当前可用内存不足（已保留系统余量）";
  if (hardware.cuda) {
    const gpu = hardware.gpus.find(item => `cuda:${item.index}` === hardware.device);
    if ((gpu?.memoryFree ?? 0) < model.vramBytes + 0.75 * gib) return "当前可用 CUDA 显存不足";
  }
  if (hardware.storageFree < (cached ? 0 : model.bytes * 2) + (ready ? 1 : hardware.cuda ? 10 : 4) * gib) return "缓存盘剩余空间不足（包含安装与临时空间）";
  return undefined;
}

export function createWhisperEnvironment(publish: (environment: SubtitleEnvironment) => void) {
  const environment: SubtitleEnvironment = {
    settings: subtitleSettingsSchema.parse({ directory: join(dataDirectory, "recognition") }), ready: false, models: [],
    download: { phase: "idle", label: "尚未检测本机识别环境", bytes: 0, total: 0 },
  };
  const verifiedModels = new Map<string, string>();
  let controller: AbortController | undefined;
  let installation: Promise<void> | undefined;
  let checking: Promise<SubtitleEnvironment> | undefined;
  let discovered: WhisperLocations = { pythonPaths: [], modelDirectories: [], incomplete: false };
  let searched = false;
  const notify = () => publish(structuredClone(environment));

  async function cached(model: typeof whisperCatalog[number], directories: string[]) {
    for (const directory of directories) {
      if (!/^[a-z]:[\\/]/i.test(directory)) continue;
      const path = join(directory, model.file);
      try {
        const info = await fileInfo(path);
        if (!info?.isFile() || info.isSymbolicLink() || info.size !== model.bytes) continue;
        const resolved = await localPath(path);
        const revision = fileRevision(info);
        if (verifiedModels.get(resolved) === revision) return resolved;
        if (await digest(resolved) !== model.sha256) continue;
        verifiedModels.set(resolved, revision);
        return resolved;
      } catch { /* 搜索候选不可读时继续检查其余目录，不能将其当成已缓存模型。 */ }
    }
  }

  async function refresh(rescan = false) {
    if (checking) return checking;
    checking = (async () => {
      environment.detection = { running: true, message: "正在自动检测本机 Python、识别依赖和模型" };
      environment.pythonPath = undefined;
      environment.pythonVersion = undefined;
      environment.ready = false;
      environment.error = undefined;
      notify();
      try {
        environment.hardware = await inspectHardware(environment.settings.directory, environment.settings.acceleration);
        const directories = new Set<string>();
        for (const root of [environment.settings.modelDirectory, environment.settings.directory, join(dataDirectory, "recognition")]) {
          if (root) for (const suffix of ["", "models", "cache/whisper", "whisper/cache/whisper"]) directories.add(join(root, suffix));
        }
        for (const directory of [...discovered.modelDirectories, join(homedir(), ".cache/whisper")]) directories.add(directory);
        if (process.env.XDG_CACHE_HOME) directories.add(join(process.env.XDG_CACHE_HOME, "whisper"));
        const candidates: string[] = [];
        if (environment.settings.pythonPath) candidates.push(environment.settings.pythonPath);
        else {
          for (const root of new Set([environment.settings.directory, join(dataDirectory, "recognition")])) {
            try {
              const path = join(root, "runtime.json");
              if ((await lstat(path)).size > 16384) continue;
              const manifest = JSON.parse(await readFile(path, "utf8")) as { pythonPath?: string };
              if (typeof manifest.pythonPath === "string" && dirname(dirname(manifest.pythonPath)).toLowerCase() === root.toLowerCase()) candidates.push(manifest.pythonPath);
            } catch { /* 失效的独立环境记录不阻断其他本机环境。 */ }
          }
          candidates.push(...discovered.pythonPaths, ...await installedWhisperPythons());
        }
        let selected: WhisperPythonStatus | undefined;
        const inspected = new Set<string>();
        let inspectionIncomplete = false;
        async function inspect(paths: string[]) {
          const deadline = Date.now() + 45000;
          for (const candidate of paths) {
            if (Date.now() >= deadline) { inspectionIncomplete = true; break; }
            if (/\\WindowsApps\\/i.test(candidate)) continue;
            try {
              const resolved = await localPath(candidate);
              if (inspected.has(resolved.toLowerCase())) continue;
              inspected.add(resolved.toLowerCase());
              const status = await inspectWhisperPython(resolved, AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - Date.now()))));
              directories.add(status.modelDirectory);
              for (const path of pythonModelDirectories(status.executable)) directories.add(path);
              if (!selected || status.whisper && status.torch) selected = status;
              if (status.whisper && status.torch) break;
            } catch (error) {
              if (environment.settings.pythonPath) environment.error = error instanceof Error ? error.message : String(error);
            }
          }
        }
        async function models() {
          environment.models = await Promise.all(whisperCatalog.map(async model => {
            const path = await cached(model, [...directories]);
            const reason = modelUnavailable(model.id, environment.hardware!, !!path, !!selected?.whisper && !!selected?.torch);
            return { id: model.id, bytes: model.bytes, cached: !!path, path, allowed: !reason, reason };
          }));
        }
        await inspect(candidates);
        await models();
        if (rescan || !searched && (!selected?.whisper || !selected.torch || !environment.models.some(model => model.cached && model.allowed))) {
          environment.detection.message = "正在搜索本机磁盘中的已有识别环境和模型"; notify();
          discovered = await searchWhisperDisks(environment.hardware.disks.map(disk => disk.path), count => {
            environment.detection!.message = `正在搜索本机已有环境和模型，已检查 ${count} 个文件夹`; notify();
          });
          searched = true;
          for (const directory of discovered.modelDirectories) directories.add(directory);
          if (!environment.settings.pythonPath && (!selected?.whisper || !selected.torch)) await inspect(discovered.pythonPaths);
          await models();
        }
        if (selected) {
          const status = selected;
          environment.pythonPath = status.executable;
          environment.pythonVersion = status.python;
          environment.ready = status.whisper && status.torch;
          environment.error = environment.ready ? undefined : `已找到 Python ${status.python}，但识别依赖不可用：${status.error || "该环境尚未安装 Whisper"}`;
          if (environment.hardware.cuda && !status.cuda) {
            environment.hardware.cuda = false;
            environment.hardware.device = "cpu";
            environment.hardware.reason += "。当前 Python 未提供可用 CUDA，将使用 CPU";
          }
        } else environment.error ||= "未找到可运行的本机 Python，请选择已有 Python 或安装独立识别环境";
        await models();
        if (!environment.hardware.cuda) {
          const choices: WhisperModel[] = environment.hardware.memoryFree >= 8 * gib && environment.hardware.cores >= 6 ? ["small", "base", "tiny"] : ["base", "tiny"];
          environment.hardware.recommended = choices.find(id => environment.models.some(model => model.id === id && model.allowed));
        }
        const usable = environment.ready && environment.models.some(model => model.cached && model.allowed);
        environment.detection = { running: false, incomplete: discovered.incomplete || inspectionIncomplete,
          message: usable ? "已检测到可用识别环境和本机模型"
            : discovered.incomplete || inspectionIncomplete ? "本次自动搜索未覆盖所有位置，可重新检测或选择已有文件；缺少的部分也可一键准备"
            : "本机识别环境或所选模型尚未齐全，请选择已有文件或一键准备" };
        const verified: WhisperLocations = { pythonPaths: environment.ready && environment.pythonPath ? [environment.pythonPath] : [],
          modelDirectories: [...new Set(environment.models.flatMap(model => model.path ? [dirname(model.path)] : []))], incomplete: false };
        await mkdir(dataDirectory, { recursive: true });
        await writeAtomic(discoveryPath, JSON.stringify(verified), { mode: 0o600 });
        discovered.pythonPaths = verified.pythonPaths;
        discovered.modelDirectories = verified.modelDirectories;
      } catch (error) {
        environment.ready = false;
        environment.error = error instanceof Error ? error.message : String(error);
        environment.detection = { running: false, message: "本机环境检测未完成，请查看原因后重新检测" };
      }
      notify();
      return environment;
    })().finally(() => { checking = undefined; });
    return checking;
  }

  async function install(choice: "auto" | WhisperModel) {
    if (installation) throw new Error("识别环境或模型正在安装，请等待完成或取消");
    controller = new AbortController();
    const signal = controller.signal;
    const change = (phase: SubtitleEnvironment["download"]["phase"], label: string, bytes = 0, total = 0) => {
      environment.download = { phase, label, bytes, total }; notify();
    };
    installation = (async () => {
      try {
        change("checking", "检测本机 GPU、可用内存和缓存磁盘");
        await refresh();
        const hardware = environment.hardware;
        const selected = selectWhisperModel(environment, choice);
        if (!hardware || !selected) throw new Error(environment.error || "没有适合当前硬件和剩余空间的模型");
        const available = environment.models.find(item => item.id === selected);
        if (!available?.allowed) throw new Error(available?.reason || "当前资源不允许安装所选模型");
        const root = await localPath(environment.settings.directory, true);
        await mkdir(root, { recursive: true });
        const downloads = join(root, "downloads");
        if (!environment.ready) {
          const staged = join(root, `runtime${crypto.randomUUID().replaceAll("-", "")}`);
          await mkdir(staged);
          const pythonZip = join(downloads, pythonAsset.file);
          change("downloading", "从 Python 官方下载独立 Python 3.12.10");
          await downloadOfficial(pythonAsset, pythonZip, signal, (bytes, total) => change("downloading", "下载官方 Python", bytes, total));
          await extractSmallArchive(pythonZip, staged);
          const packages = join(staged, "Lib/site-packages");
          await mkdir(packages, { recursive: true });
          await writeAtomic(join(staged, "python312._pth"), "python312.zip\n.\nLib/site-packages\nimport site\n");
          const pipWheel = join(downloads, pipAsset.file);
          await downloadOfficial(pipAsset, pipWheel, signal, (bytes, total) => change("downloading", "从 PyPI 官方下载 pip", bytes, total));
          await extractSmallArchive(pipWheel, packages);
          const pythonPath = join(staged, "python.exe");
          const pipArgs = ["-B", "-m", "pip", "--isolated", "--disable-pip-version-check", "install", "--no-input", "--no-warn-script-location", "--no-cache-dir"];
          const pipEnvironment = { PIP_CONFIG_FILE: "NUL", PYTHONHOME: undefined, PYTHONPATH: undefined };
          change("installing", "从 PyPI 官方安装识别运行依赖");
          await runPython(pythonPath, [...pipArgs, "--index-url", "https://pypi.org/simple", "--only-binary=:all:",
            "setuptools==80.9.0", "wheel==0.45.1", "numpy==2.2.6", "numba==0.61.2", "tiktoken==0.9.0", "more-itertools==10.7.0", "tqdm==4.67.1"],
          signal, { env: pipEnvironment });
          const torchVariant = hardware.cuda ? hardware.gpus.find(gpu => `cuda:${gpu.index}` === hardware.device)?.runtime || "cu126" : "cpu";
          change("installing", hardware.cuda ? `从 PyTorch 官方安装 ${torchVariant} 识别环境` : "从 PyTorch 官方安装 CPU 识别环境");
          await runPython(pythonPath, [...pipArgs, "--index-url", `https://download.pytorch.org/whl/${torchVariant}`,
            "--extra-index-url", "https://pypi.org/simple", "--only-binary=:all:", `torch==2.7.1+${torchVariant}`], signal, { env: pipEnvironment });
          const whisperArchive = join(downloads, "openai_whisper-20250625.tar.gz");
          await downloadOfficial(whisperAsset, whisperArchive, signal, (bytes, total) => change("downloading", "从 PyPI 官方下载 Whisper", bytes, total));
          change("installing", "安装并检测本机 Whisper");
          await runPython(pythonPath, [...pipArgs, "--index-url", "https://pypi.org/simple", "--no-build-isolation", "--no-deps", whisperArchive], signal, { env: pipEnvironment });
          const status = await inspectWhisperPython(pythonPath, signal);
          if (!status.whisper || !status.torch || hardware.cuda && !status.cuda) throw new Error(status.error || "本机识别环境未通过实际可用性检测");
          signal.throwIfAborted();
          await writeAtomic(join(root, "runtime.json"), JSON.stringify({ pythonPath, version: 1, cuda: status.cuda }), { mode: 0o600 });
          if (environment.settings.pythonPath) {
            const settings = { ...environment.settings, pythonPath: "" };
            await writeAtomic(settingsPath, JSON.stringify(settings), { mode: 0o600 });
            environment.settings = settings;
          }
          environment.pythonPath = pythonPath;
          environment.ready = true;
        }
        const model = whisperCatalog.find(item => item.id === selected)!;
        if (!available.cached) {
          change("downloading", `从 OpenAI 官方下载 ${selected}`);
          await downloadOfficial(model, join(root, "models", model.file), signal,
            (bytes, total) => change("downloading", `下载 ${selected}（官方源）`, bytes, total));
        }
        change("verifying", `校验 ${selected} 模型`);
        await refresh();
        if (!environment.ready || !environment.models.some(item => item.id === selected && item.cached)) throw new Error(environment.error || "识别环境或模型尚未就绪");
        change("completed", `${selected} 已就绪，可以离线识别`, model.bytes, model.bytes);
      } catch (error) {
        environment.download = { phase: signal.aborted ? "cancelled" : "failed", label: signal.aborted ? "安装已取消，可继续下载" : "安装失败",
          bytes: environment.download.bytes, total: environment.download.total, error: error instanceof Error ? error.message : String(error) };
        notify();
        throw error;
      }
    })().finally(() => { installation = undefined; controller = undefined; });
    return installation;
  }

  return {
    snapshot: () => structuredClone(environment), refresh, install,
    busy: () => !!installation,
    cancel: () => controller?.abort(),
    wait: () => installation?.catch(() => {}),
    async initialize() {
      try { environment.settings = subtitleSettingsSchema.parse(JSON.parse(await readFile(settingsPath, "utf8"))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") environment.error = "识别设置文件无效，未覆盖原文件"; }
      try {
        if ((await lstat(discoveryPath)).size <= 128 * 1024) discovered = discoverySchema.parse(JSON.parse(await readFile(discoveryPath, "utf8")));
      } catch { /* 发现缓存只作候选，缺失或失效时重新检测，不影响用户设置。 */ }
      notify();
    },
    async settings(input: SubtitleSettings) {
      if (installation) throw new Error("请等待安装完成后再修改存储位置");
      await checking;
      const settings = subtitleSettingsSchema.parse(input);
      settings.directory = await localPath(settings.directory, true);
      if (settings.pythonPath) settings.pythonPath = await localPath(settings.pythonPath);
      if (settings.modelDirectory) {
        settings.modelDirectory = await localPath(settings.modelDirectory);
        if (!(await lstat(settings.modelDirectory)).isDirectory()) throw new Error("请选择已有 Whisper 模型所在的文件夹");
      }
      await writeAtomic(settingsPath, JSON.stringify(settings), { mode: 0o600 });
      environment.settings = settings;
      environment.pythonPath = undefined;
      searched = false;
      verifiedModels.clear();
      return refresh();
    },
    async prepare(choice: "auto" | WhisperModel) {
      await refresh();
      const id = selectWhisperModel(environment, choice);
      const model = whisperCatalog.find(item => item.id === id);
      if (!environment.ready || !environment.pythonPath)
        throw Object.assign(new Error(environment.error || "未找到可用识别环境，请在批量字幕页面重新检测或一键准备"), { code: "WHISPER_SETUP_REQUIRED" });
      if (!model || !environment.models.find(item => item.id === id)?.cached)
        throw Object.assign(new Error(`尚未找到 ${id || "推荐"} 模型，请重新检测、选择已有模型目录或一键准备`), { code: "WHISPER_SETUP_REQUIRED" });
      const unavailable = modelUnavailable(model.id, environment.hardware!, true, true);
      if (unavailable) throw new Error(unavailable);
      return { model, pythonPath: environment.pythonPath, modelPath: environment.models.find(item => item.id === id)!.path!,
        directory: environment.settings.directory, hardware: environment.hardware!, device: environment.hardware!.device };
    },
  };
}
