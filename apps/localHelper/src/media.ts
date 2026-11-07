import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream, lstat, mkdir, mkdtemp, opendir, realpath, rm, writeAtomic } from "@toonflow/file";
import { build, createFfmpeg, executeRemoteFfmpeg, getToolStatus, installFfmpeg, target, type SourceId } from "@toonflow/ffmpeg";
import type { FfmpegRemoteEvent } from "@toonflow/ffmpeg/remote";
import { fileBatchLimit, transferBatchMaxBytes, transferFileMaxBytes, type LocalHelperJob, type LocalHelperRequest, type LocalMediaStatus } from "./protocol";
import { dataDirectory, logError, type LogContext } from "./logger";
import { toolsDirectory } from "./operations";

let download: LocalMediaStatus["download"] = { phase: "idle", received: 0 };
let snapshot: LocalMediaStatus | undefined;
let checkedAt = 0;

export async function getMediaStatus(refresh = false): Promise<LocalMediaStatus> {
  if (!snapshot || refresh || Date.now() - checkedAt > 30000) {
    snapshot = { platform: process.platform, arch: process.arch, target, supported: Boolean(build), directory: toolsDirectory,
      version: build?.version ?? "", tools: await getToolStatus(toolsDirectory, "download"), download };
    checkedAt = Date.now();
  }
  return { ...snapshot, download };
}

async function taskPath(root: string, value: string, folder = false) {
  if (isAbsolute(value) || /[\x00-\x1f:<>"|?*]/.test(value) || value.split(/[\\/]/).some(part => part === ".."
    || part !== "." && (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) throw new Error("本地媒体任务路径无效");
  const path = resolve(root, value);
  const offset = relative(root, path);
  if (isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`) || !folder && !offset) throw new Error("媒体文件必须在本次任务缓存目录内");
  return path;
}

async function digestFile(path: string, signal: AbortSignal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

export async function runMedia(operation: Extract<LocalHelperRequest, { action: "ffmpegStatus" | "ffmpegInstall" | "ffmpeg" }>,
  server: URL, token: string, job: Pick<LocalHelperJob, "id" | "nonce"> | undefined, signal: AbortSignal, context?: LogContext) {
  if (operation.action === "ffmpegStatus") return getMediaStatus(true);
  if (operation.action === "ffmpegInstall") {
    try {
      await installFfmpeg(toolsDirectory, operation.source as SourceId, signal, state => { download = state; });
      download = { phase: "completed", received: 0 };
      return await getMediaStatus(true);
    } catch (error) {
      download = { phase: signal.aborted ? "cancelled" : "error", received: 0, error: error instanceof Error ? error.message : String(error) };
      throw error;
    }
  }
  if (!job) throw new Error("媒体任务缺少本机执行凭据");
  signal = AbortSignal.any([signal, AbortSignal.timeout(2 * 60 * 60000)]);
  const status = await getMediaStatus();
  if (Object.values(status.tools).some(tool => !tool.path || tool.error)) throw new Error("本地助手缺少可用 FFmpeg/ffprobe，请在设置 → 本地助手中重新安装本机组件");
  const cache = join(dataDirectory, "mediaTasks");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "task"));
  const headers = { Authorization: `Bearer ${token}`, "x-toonflow-call": job.id, "x-toonflow-nonce": job.nonce };
  const jsonHeaders = { ...headers, "Content-Type": "application/json" };
  const endpoint = (name: string, query: Record<string, string> = {}) => {
    const url = new URL(`api/localHelper/device/${name}`, server);
    url.search = new URLSearchParams({ mediaId: operation.mediaId, ...query }).toString();
    return url;
  };
  const pendingEvents = new Map<string, FfmpegRemoteEvent>();
  let reporting: Promise<void> | undefined;
  const report = (event: FfmpegRemoteEvent) => {
    if (!["start", "progress", "codecData", "filenames"].includes(event.event)) return;
    pendingEvents.set(event.event, event);
    if (reporting) return;
    reporting = (async () => {
      while (pendingEvents.size && !signal.aborted) {
        const event = pendingEvents.values().next().value!;
        pendingEvents.delete(event.event);
        const response = await fetch(endpoint("mediaEvent"), { method: "POST", redirect: "error", headers: jsonHeaders,
          body: JSON.stringify({ mediaId: operation.mediaId, event }), signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`本地媒体任务进度回传失败（HTTP ${response.status}）`);
      }
    })().catch(error => { void logError("mediaProgressFailed", error, context); }).finally(() => { reporting = undefined; });
  };
  try {
    let total = 0;
    for (let index = 0; index < operation.inputs.length; index++) {
      signal.throwIfAborted();
      const file = operation.inputs[index];
      total += file.size;
      if (total > transferBatchMaxBytes) throw new Error("媒体输入总量超过 200 MiB");
      const path = await taskPath(directory, file.path);
      await mkdir(dirname(path), { recursive: true });
      if (file.content !== undefined) {
        if (Buffer.byteLength(file.content) !== file.size) throw new Error("媒体清单大小不一致");
        await writeAtomic(path, file.content, { exclusive: true });
        continue;
      }
      const response = await fetch(endpoint("mediaInput", { index: String(index) }), { headers, redirect: "error", signal });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`媒体素材下载失败（HTTP ${response.status}）`); }
      let bytes = 0;
      await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.length;
        done(bytes > file.size ? new Error("媒体下载超过声明大小") : null, chunk);
      } }), createWriteStream(path, { flags: "wx" }), { signal });
      if (bytes !== file.size) throw new Error("媒体素材下载不完整");
    }
    for (const path of operation.outputs) await mkdir(dirname(await taskPath(directory, path)), { recursive: true });
    for (const folder of operation.folders) await mkdir(await taskPath(directory, folder, true), { recursive: true });
    const request = structuredClone(operation.request);
    request.directory = directory;
    const cwd = request.options.cwd && isAbsolute(request.options.cwd) ? request.options.cwd : directory;
    if (cwd === directory && request.options.cwd) await mkdir(await taskPath(directory, request.options.cwd, true), { recursive: true });
    if (!/^(ffprobe|(?:get)?available)/i.test(request.operation.method)) request.calls.push({ method: "outputOptions", args: ["-n"] });
    const factory = createFfmpeg(cwd, { localFiles: true });
    factory.setFfmpegPath(status.tools.ffmpeg.path!);
    factory.setFfprobePath(status.tools.ffprobe.path!);
    let terminal: FfmpegRemoteEvent | undefined;
    await executeRemoteFfmpeg(factory, request, event => {
      if (["error", "end", "result"].includes(event.event)) terminal = event;
      else report(event);
    }, signal);
    await reporting;
    signal.throwIfAborted();
    if (!terminal || terminal.event === "error") {
      const failure = terminal?.args[0] as { message?: string } | undefined;
      throw new Error(failure?.message || "本机 FFmpeg 未返回完成结果");
    }
    if (terminal.event === "end") {
      const inputNames = new Set(operation.inputs.map(file => file.path.toLowerCase()));
      const outputs: { path: string; name: string; size: number }[] = [];
      const folders = [directory];
      let bytes = 0;
      while (folders.length) {
        const folder = folders.pop()!;
        for await (const entry of await opendir(folder)) {
          signal.throwIfAborted();
          const path = join(folder, entry.name);
          if (entry.isDirectory()) { folders.push(path); continue; }
          if (!entry.isFile()) throw new Error("媒体输出包含不支持的文件类型");
          const name = relative(directory, path).split(sep).join("/");
          if (inputNames.has(name.toLowerCase())) continue;
          const size = (await lstat(path)).size;
          bytes += size;
          if (outputs.length >= fileBatchLimit || size > transferFileMaxBytes || bytes > transferBatchMaxBytes) throw new Error("媒体输出超过传输限制：最多 20 个文件，单文件 100 MiB，整批 200 MiB");
          outputs.push({ path, name, size });
        }
      }
      if (!outputs.length && (operation.outputs.length || operation.folders.length)) throw new Error("本机 FFmpeg 未生成输出文件");
      for (const file of outputs) {
        const sha256 = await digestFile(file.path, signal);
        const response = await fetch(endpoint("mediaOutput", { path: file.name, size: String(file.size), sha256 }), {
          method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream", "Content-Length": String(file.size) },
          body: Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>, redirect: "error", signal,
        });
        const result = await response.json() as { code?: number; message?: string };
        if (!response.ok || result.code !== 200) throw new Error(result.message || `媒体输出上传失败（HTTP ${response.status}）`);
      }
    }
    return terminal;
  } finally {
    await reporting;
    // directory 仅来自本次 mkdtemp，清理前再核对父目录，绝不清理用户文件。
    if (dirname(await realpath(directory)) !== await realpath(cache)) throw new Error("媒体缓存清理路径无效");
    await rm(directory, { recursive: true, force: true });
  }
}
