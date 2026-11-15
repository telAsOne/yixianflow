import { createHash } from "node:crypto";
import { dirname, extname, isAbsolute, join, relative } from "node:path";
import { lstat, mkdir, readFile, unlink, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createFfmpeg, type BrowserFfmpegRequest } from "@toonflow/ffmpeg";
import { executeRemoteFfmpeg } from "@toonflow/ffmpeg/remote";
import { executeMedia } from "@/utils/localHelper/media";
import { callDevice, getSelectedDevice } from "@/utils/localHelper";
import { isWithin, resolveWorkspacePath } from "@/utils/workspace/files";
import { isWebMode } from "@/lib/webContext";
import { parseSrt } from "@toonflow/node-shared/subtitleSrt";
import { startWhisper, getWhisperTask } from "@/utils/whisper";
import type { BrowserMediaReader, MediaFrame, MediaMetadata } from "./readTypes";

export const mediaReadSchema = z.strictObject({
  action: z.enum(["info", "frames", "detect", "audio", "transcribe", "transcript", "history", "note"]).default("frames"),
  path: z.string().min(1).max(4096),
  engine: z.enum(["auto", "local", "browser"]).default("auto"),
  start: z.number().finite().nonnegative().optional(), end: z.number().finite().positive().optional(),
  times: z.array(z.number().finite().nonnegative()).min(1).optional(),
  interval: z.number().finite().positive().optional(), fps: z.number().finite().positive().optional(),
  maxEdge: z.number().int().nonnegative().default(960).describe("图片最长边；0 保留源尺寸。"),
  crop: z.strictObject({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  pageSize: z.number().int().positive().default(8).describe("本次希望读取的帧数，超过单次传输预算时返回 cursor 继续。"),
  offset: z.number().int().nonnegative().default(0).describe("history 和 transcript 的列表续读位置，使用返回的 nextOffset。"),
  maxBytes: z.number().int().positive().default(6 * 1024 * 1024).describe("单次图片传输预算，首张超过预算时仍返回该张，避免无法前进。"),
  cursor: z.uuid().optional(),
  recordId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  detection: z.enum(["scene", "black", "freeze", "silence"]).optional(), threshold: z.number().finite().positive().optional(),
  windowSeconds: z.number().finite().positive().default(60).describe("本次信号扫描窗口，可调整；剩余范围用 cursor 续查。"),
  operationId: z.uuid().optional(), language: z.string().max(32).optional(),
  sampleRate: z.number().int().positive().optional(), channels: z.number().int().positive().optional(),
  model: z.enum(["auto", "tiny", "base", "small", "medium", "large", "turbo"]).optional(),
  evidenceIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).optional(), observation: z.string().min(1).max(20000).optional(),
});
type Request = z.infer<typeof mediaReadSchema>;
type Evidence = MediaFrame & { id: string; engine: "local" | "browser"; returnedAt?: number };
type AudioEvidence = { path: string; start: number; end: number; sampleRate: number; channels: number;
  operationId?: string; operationIds?: string[]; transcriptionModel?: string; transcriptionLanguage?: string };
type ReadRecord = {
  version: 1; id: string; source: string; revision: string; metadata?: MediaMetadata; frames: Evidence[];
  detections: { kind: string; start: number; end: number; events: { seconds: number; detail: string }[] }[];
  audio: AudioEvidence[]; notes: { evidenceIds: string[]; observation: string; createdAt: number }[];
  continuations?: { query: string; cursor: string; action: string; index?: number; start?: number }[];
};
type Source = { path: string; revision: string; local: boolean; size: number; device?: NonNullable<Awaited<ReturnType<typeof getSelectedDevice>>> };
type Cursor = { source: string; revision: string; request: Request; query?: string; index?: number; start?: number };
const queues = new Map<string, Promise<unknown>>();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function sourceInfo(cwd: string, path: string, signal?: AbortSignal): Promise<Source> {
  if (/^[a-z]:[\\/]/i.test(path) && (process.platform !== "win32" || !isWithin(cwd, path))) {
    if (!isWebMode() && process.platform === "win32") {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || !info.size) throw new Error("本机媒体必须是非空普通文件");
      return { path, revision: `${info.size}:${info.mtimeMs}:${info.ctimeMs}`, local: true, size: info.size };
    }
    const device = await getSelectedDevice();
    if (!device?.ready) throw Object.assign(new Error("读取本机视频需要选择已连接的本地助手"), { status: 424 });
    // 复用既有只读文件协议取得真实版本；内容不会进入 AI 或保存为缓存。
    const file = await callDevice(device, { action: "read", path, encoding: "base64" }, signal) as { revision?: string; size?: number };
    if (!file.revision || !file.size) throw new Error("本地助手未返回有效的媒体文件版本");
    return { path, revision: `${device.id}:${file.revision}`, local: true, size: file.size, device };
  }
  const target = await resolveWorkspacePath(cwd, path);
  const info = await lstat(target.path);
  if (!info.isFile() || info.isSymbolicLink() || !info.size) throw new Error("媒体必须是当前工作区内非空普通文件");
  return { path, revision: `${info.size}:${info.mtimeMs}:${info.ctimeMs}`, local: false, size: info.size };
}

async function jsonFile<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}

async function execute(cwd: string, source: string, calls: BrowserFfmpegRequest["calls"], signal?: AbortSignal) {
  let result: unknown;
  let stderr = "";
  let failure: Error | undefined;
  await runMediaCommand(cwd, source, { directory: cwd, requestId: crypto.randomUUID(), options: { stdoutLines: 0 },
    calls: [{ method: "input", args: [source] }, ...calls], operation: { method: "run", args: [] } }, event => {
    if (event.event === "result") result = event.args[0];
    if (event.event === "stderr") stderr += String(event.args[0]) + "\n";
    if (event.event === "end") { result = event.args[0]; stderr = String(event.args[1] ?? stderr); }
    if (event.event === "error") failure = new Error((event.args[0] as { message?: string })?.message ?? "本地媒体处理失败");
  }, signal ?? new AbortController().signal);
  signal?.throwIfAborted();
  if (failure) throw failure;
  return { result, stderr };
}

async function probe(cwd: string, source: string, signal?: AbortSignal): Promise<MediaMetadata> {
  let result: { format?: { duration?: unknown }; streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; duration?: unknown }[] } | undefined;
  let failure: Error | undefined;
  await runMediaCommand(cwd, source, { directory: cwd, requestId: crypto.randomUUID(), options: {},
    calls: [{ method: "input", args: [source] }], operation: { method: "ffprobe", args: [] } }, event => {
    if (event.event === "result") result = event.args[0] as typeof result;
    if (event.event === "error") failure = new Error((event.args[0] as { message?: string })?.message ?? "媒体探测失败");
  }, signal ?? new AbortController().signal);
  signal?.throwIfAborted();
  if (failure) throw failure;
  const video = result?.streams?.find(stream => stream.codec_type === "video");
  const [numerator, denominator] = (video?.avg_frame_rate ?? "0/1").split("/").map(Number);
  const fps = denominator ? numerator! / denominator : undefined;
  const duration = Number(result?.format?.duration ?? video?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("媒体没有可确认的正时长，不能按时间读取");
  const videoDuration = Number(video?.duration);
  return { duration, ...(Number.isFinite(videoDuration) && videoDuration > 0 ? { videoDuration } : {}), ...(video ? { width: video.width, height: video.height, ...(fps && Number.isFinite(fps) ? { fps } : {}) } : {}),
    hasAudio: result?.streams?.some(stream => stream.codec_type === "audio"), streams: result?.streams };
}

async function runMediaCommand(cwd: string, source: string, request: BrowserFfmpegRequest,
  emit: Parameters<typeof executeRemoteFfmpeg>[2], signal: AbortSignal) {
  if (!isWebMode() && process.platform === "win32") {
    await executeRemoteFfmpeg(createFfmpeg(cwd, { localFiles: true }), request, emit, signal);
    return;
  }
  const local = /^[a-z]:[\\/]/i.test(source) && (process.platform !== "win32" || !isWithin(cwd, source));
  const inputName = `input${extname(source) || ".bin"}`;
  const inputs = local ? [] : [{ name: inputName, path: (await resolveWorkspacePath(cwd, source)).path }];
  const outputs: { name: string; path: string }[] = [];
  const mapped = structuredClone(request);
  // 生成的内部命令只传递本次文件，私有 .agent 结果映射为任务内名字，不经项目相对路径反推。
  for (const call of mapped.calls) {
    if (call.method === "input") call.args[0] = local ? source : inputName;
    if (call.method === "output") {
      const path = String(call.args[0]);
      const name = `output${outputs.length}${extname(path)}`;
      outputs.push({ name, path: (await resolveWorkspacePath(cwd, path)).path });
      call.args[0] = name;
    }
  }
  await executeMedia({ request: mapped, inputs, outputs }, emit, signal);
}

function jpegDimensions(bytes: Uint8Array) {
  if (bytes[0] !== 255 || bytes[1] !== 216) throw new Error("解码结果不是 JPEG 图片");
  for (let offset = 2; offset + 9 < bytes.length;) {
    if (bytes[offset++] !== 255) continue;
    const marker = bytes[offset++];
    if (marker === 255 || marker === 216 || marker === 1 || marker! >= 208 && marker! <= 215) continue;
    if (marker === 217 || marker === 218) break;
    const length = bytes[offset]! * 256 + bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length) break;
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker!))
      return { height: bytes[offset + 3]! * 256 + bytes[offset + 4]!, width: bytes[offset + 5]! * 256 + bytes[offset + 6]! };
    offset += length;
  }
  throw new Error("无法确认视频帧尺寸");
}

async function localFrames(cwd: string, source: string, times: number[], paths: string[], request: Request, metadata: MediaMetadata, signal?: AbortSignal): Promise<MediaFrame[]> {
  // 容器末尾可能仍在显示最后一帧；从最后一帧之前定位，避免精确 seek 越过最后可解码帧。
  const lastFrame = metadata.fps ? Math.max(0, (metadata.videoDuration ?? metadata.duration) - 1 / metadata.fps - 0.000001) : metadata.duration;
  const seeks = times.map(time => Math.min(time, lastFrame));
  const calls: BrowserFfmpegRequest["calls"] = [{ method: "seekInput", args: [seeks[0]!] }];
  for (const time of seeks.slice(1)) calls.push({ method: "input", args: [source] }, { method: "seekInput", args: [time] });
  for (let index = 0; index < times.length; index++) {
    const filters: { filter: string; options?: string | number | object }[] = [{ filter: `showinfo@read${index}` }];
    if (request.crop) filters.push({ filter: "crop", options: { x: request.crop.x, y: request.crop.y, w: request.crop.width, h: request.crop.height } });
    if (request.maxEdge) filters.push({ filter: "scale", options: { w: Math.min(request.maxEdge, request.crop?.width ?? metadata.width!), h: Math.min(request.maxEdge, request.crop?.height ?? metadata.height!), force_original_aspect_ratio: "decrease" } });
    calls.push({ method: "output", args: [paths[index]!] }, { method: "videoFilters", args: [filters] },
      { method: "outputOptions", args: [["-map", `${index}:v:0`, "-frames:v", "1", "-q:v", "3", "-loglevel", "info", "-nostats"]] });
  }
  const { stderr } = await execute(cwd, source, calls, signal);
  const frames: MediaFrame[] = [];
  for (let index = 0; index < times.length; index++) {
    const match = new RegExp(`\\[showinfo@read${index}[^\\]]*\\][^\\n]*\\bn:\\s*0\\s+pts:[^\\n]*?pts_time:([+\\-\\d.eE]+)`).exec(stderr);
    if (!match || !Number.isFinite(Number(match[1]))) throw new Error("本地解码没有返回实际帧时间，未将请求时间冒充观察时间");
    const path = paths[index]!;
    const bytes = await readFile((await resolveWorkspacePath(cwd, path)).path);
    frames.push({ path, requestedSeconds: times[index]!, seconds: Math.max(0, seeks[index]! + Number(match[1])),
      timestampKind: "decodedFrame", mimeType: "image/jpeg", ...jpegDimensions(bytes) });
  }
  return frames;
}

function sampleTimes(request: Request, metadata: MediaMetadata, index: number) {
  if (request.interval !== undefined && request.fps !== undefined) throw new Error("interval 和 fps 请选择一种");
  const start = request.start ?? 0;
  const videoDuration = metadata.videoDuration ?? metadata.duration;
  const end = Math.min(request.end ?? videoDuration, videoDuration);
  if (!(end > start) || start >= videoDuration || request.end !== undefined && request.end > metadata.duration + 0.001) throw new Error("读取时间范围必须位于视频时长内且 end 大于 start");
  const interval = request.fps ? 1 / request.fps : request.interval ?? 1;
  const count = request.times?.length ?? Math.ceil((end - start) / interval - 1e-9);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("采样间隔过小，无法表示续读位置");
  if (request.times?.some((time, offset) => time >= videoDuration || offset > 0 && time < request.times![offset - 1]!)) throw new Error("times 必须按原片时间升序排列且小于视频画面时长");
  // 单批输出沿用现有助手 20 文件传输能力；分页次数与全片采样总数没有业务上限。
  const length = Math.max(0, Math.min(request.pageSize, 20, count - index));
  const times = Array.from({ length }, (_, offset) => request.times?.[index + offset] ?? start + (index + offset) * interval);
  if (times.some(time => time < 0 || time >= videoDuration)) throw new Error("抽帧位置必须小于视频画面时长");
  if (times.some((time, offset) => offset > 0 && time < times[offset - 1]!)) throw new Error("times 请按原片时间升序排列");
  return { times, count };
}

async function verifySource(cwd: string, source: Source, signal?: AbortSignal) {
  const current = await sourceInfo(cwd, source.path, signal);
  if (current.revision !== source.revision) throw new Error("源视频在读取期间发生变化，未把结果记到新版本，请重新读取");
}

export async function readMedia(cwd: string, input: Request, browser?: BrowserMediaReader, signal?: AbortSignal,
  onUpdate?: Parameters<ToolDefinition["execute"]>[3], authorize?: (request: Request) => void): ReturnType<ToolDefinition["execute"]> {
  signal?.throwIfAborted();
  authorize?.(input);
  if (isAbsolute(input.path) && isWithin(cwd, input.path)) input = { ...input, path: relative(cwd, input.path).replaceAll("\\", "/") };
  const source = await sourceInfo(cwd, input.path, signal);
  const root = (await resolveWorkspacePath(cwd, ".agent/mediaReads", true)).path;
  await mkdir(root, { recursive: true });
  const id = input.action === "history" && input.recordId ? input.recordId : hash([source.path, source.revision]);
  const manifest = join(root, `${id}.json`);
  const previous = queues.get(manifest) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    signal?.throwIfAborted();
    let request = input;
    let index = 0;
    let query = hash({ ...input, cursor: undefined, pageSize: undefined, maxBytes: undefined });
    if (input.cursor) {
      const saved = await jsonFile<Cursor>(join(root, `cursor${input.cursor}.json`));
      if (!saved || saved.source !== source.path || saved.revision !== source.revision) throw new Error("续读位置不属于此视频版本，请用 history 核对后重新读取");
      request = { ...saved.request, pageSize: input.pageSize, maxBytes: input.maxBytes, ...(saved.start === undefined ? {} : { start: saved.start }) };
      index = saved.index ?? 0;
      query = saved.query ?? hash({ ...saved.request, cursor: undefined, pageSize: undefined, maxBytes: undefined });
    }
    authorize?.(request);
    const stored = await jsonFile<ReadRecord>(manifest);
    if (!stored && request.action === "history" && request.recordId) throw new Error("指定的视频读取记录不存在");
    const record = stored ?? { version: 1, id, source: source.path, revision: source.revision, frames: [], detections: [], audio: [], notes: [] };
    if (record.source !== source.path || record.revision !== source.revision && request.action !== "history") throw new Error("媒体读取记录与当前文件版本不一致");
    // ACT: 证据清单更新随已读取帧数线性增长；数小时逐帧审查可升级为分页清单，图像始终独立存储。
    const save = async () => { await verifySource(cwd, source, signal); await writeAtomic(manifest, JSON.stringify(record)); };
    const continuation = async (next: { index?: number; start?: number }) => {
      const cursor = crypto.randomUUID();
      await writeAtomic(join(root, `cursor${cursor}.json`), JSON.stringify({ source: source.path, revision: source.revision, request: { ...request, cursor: undefined }, query, ...next } satisfies Cursor), { exclusive: true });
      record.continuations = [...(record.continuations ?? []).filter(item => item.query !== query), { query, cursor, action: request.action, ...next }];
      return cursor;
    };
    const details: Record<string, unknown> = { source: source.path, revision: record.revision, recordId: id, ...(record.revision !== source.revision ? { currentRevision: source.revision } : {}) };
    const content: { type: "text" | "image"; text?: string; data?: string; mimeType?: string }[] = [];
    const result = (extra: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify({ ...details, ...extra }) }, ...content], details: { ...details, ...extra } });
    if (request.action === "history") {
      const offset = request.offset;
      const length = request.pageSize;
      const returned = record.frames.filter(frame => frame.returnedAt !== undefined);
      return result({ metadata: record.metadata, frames: returned.slice(offset, offset + length), totalFramesReturned: returned.length, totalFramesDecoded: record.frames.length,
        nextOffset: offset + length < Math.max(returned.length, record.notes.length, record.detections.length, record.audio.length) ? offset + length : null,
        notes: record.notes.slice(offset, offset + length), detections: record.detections.slice(offset, offset + length), audio: record.audio.slice(offset, offset + length), continuations: record.continuations ?? [],
        coverage: "Records describe returned evidence and agent notes, not proof that every intervening frame or sound was reviewed." });
    }
    if (request.action === "note") {
      if (!request.observation || !request.evidenceIds?.length || request.evidenceIds.some(value => !record.frames.some(frame => frame.id === value && frame.returnedAt !== undefined)))
        throw new Error("审查观察必须引用此版本已经返回的 evidenceIds，并填写 observation");
      record.notes.push({ evidenceIds: request.evidenceIds, observation: request.observation, createdAt: Date.now() });
      await save();
      return result({ saved: true, noteCount: record.notes.length });
    }
    let engine: "local" | "browser" = request.engine === "browser" ? "browser" : "local";
    const canUseBrowser = !source.local && browser && request.engine !== "local";
    if (engine === "browser" && !canUseBrowser) throw new Error("本轮没有可用的网页媒体读取通道；本机绝对路径请使用本地工具");
    if (canUseBrowser && request.engine === "auto" && isWebMode() && (!((await getSelectedDevice())?.ready) || source.size > 100 * 1024 * 1024)) engine = "browser";
    const outputDirectory = `.agent/mediaReads/frames${id}`;
    await mkdir((await resolveWorkspacePath(cwd, outputDirectory, true)).path, { recursive: true });
    if (!record.metadata || request.action === "info" || engine === "local" && ["audio", "detect", "transcribe"].includes(request.action) && !record.metadata.streams) {
      try { record.metadata = engine === "browser" && canUseBrowser ? (await browser!({ path: source.path, revision: source.revision, outputDirectory, times: [], maxEdge: request.maxEdge }, signal)).metadata : await probe(cwd, source.path, signal); }
      catch (error) {
        if (!canUseBrowser || ![409, 413, 424].includes((error as { status?: number }).status ?? 0)) throw error;
        engine = "browser";
        record.metadata = (await browser!({ path: source.path, revision: source.revision, outputDirectory, times: [], maxEdge: request.maxEdge }, signal)).metadata;
      }
      await save();
    }
    const metadata = record.metadata!;
    if (request.action === "info") return result({ engine, metadata });
    if (engine === "browser" && !["frames", "transcript"].includes(request.action)) throw new Error("网页备用路径负责读取视频画面；声音、转写和信号检测请连接本地助手后执行");
    if (request.action === "frames") {
      const sampled = sampleTimes(request, metadata, index);
      if (!metadata.width || !metadata.height) throw new Error("此媒体没有可读取的视频画面");
      if (request.crop && (request.crop.x + request.crop.width > metadata.width || request.crop.y + request.crop.height > metadata.height)) throw new Error("裁剪范围超出源视频画面");
      const selected: Evidence[] = [];
      let bytes = 0;
      onUpdate?.({ content: [{ type: "text", text: `正在读取 ${sampled.times[0] ?? 0} 秒起的视频画面，可继续补读。` }], details: {} });
      const paths = sampled.times.map(time => `${outputDirectory}/${hash([time, request.maxEdge, request.crop, request.engine])}.jpg`);
      const missing: { time: number; path: string }[] = [];
      for (let offset = 0; offset < sampled.times.length; offset++) {
        const path = paths[offset]!;
        const exists = record.frames.some(frame => frame.requestedSeconds === sampled.times[offset] && frame.path === path)
          && await lstat((await resolveWorkspacePath(cwd, path)).path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
        if (!exists && !missing.some(item => item.time === sampled.times[offset])) missing.push({ time: sampled.times[offset]!, path });
      }
      if (missing.length) {
        let decoded: MediaFrame[];
        try {
          if (engine === "browser") {
            if (!canUseBrowser) throw new Error("本机绝对路径需要本地助手读取");
            const response = await browser!({ path: source.path, revision: source.revision, outputDirectory, times: missing.map(item => item.time), maxEdge: request.maxEdge, crop: request.crop }, signal);
            if (response.revision !== source.revision) throw new Error("网页读取的源文件版本发生变化");
            decoded = response.frames;
          } else decoded = await localFrames(cwd, source.path, missing.map(item => item.time), missing.map(() => `${outputDirectory}/decode${crypto.randomUUID()}.jpg`), request, metadata, signal);
        } catch (error) {
          if (!canUseBrowser || engine === "browser" || ![409, 413, 424].includes((error as { status?: number }).status ?? 0)) throw error;
          engine = "browser";
          const response = await browser!({ path: source.path, revision: source.revision, outputDirectory, times: missing.map(item => item.time), maxEdge: request.maxEdge, crop: request.crop }, signal);
          if (response.revision !== source.revision) throw new Error("网页读取的源文件版本发生变化");
          decoded = response.frames;
        }
        if (decoded.length !== missing.length || decoded.some((frame, offset) => frame.requestedSeconds !== missing[offset]!.time || !frame.path.startsWith(outputDirectory + "/") || frame.path.slice(outputDirectory.length + 1).includes("/") || frame.path.includes("\\") || frame.path.includes("..")))
          throw new Error("解码返回的帧数、时间或输出目录与本次请求不一致");
        for (const frame of decoded) {
          const data = await readFile((await resolveWorkspacePath(cwd, frame.path)).path);
          const dimensions = jpegDimensions(data);
          const evidence: Evidence = { ...frame, ...dimensions, id: hash([id, missing[decoded.indexOf(frame)]!.path, frame.seconds]), engine };
          // 网页使用随机输出名；保存请求对应路径，后续按时间与读取参数复用。
          const target = paths[sampled.times.indexOf(frame.requestedSeconds)]!;
          if (frame.path !== target) {
            await writeAtomic((await resolveWorkspacePath(cwd, target)).path, data);
            await unlink((await resolveWorkspacePath(cwd, frame.path)).path);
            evidence.path = target;
          }
          const previous = record.frames.findIndex(item => item.path === evidence.path && item.requestedSeconds === evidence.requestedSeconds);
          if (previous < 0) record.frames.push(evidence);
          else record.frames[previous] = evidence;
        }
      }
      for (let offset = 0; offset < sampled.times.length; offset++) {
        const frame = record.frames.findLast(frame => frame.requestedSeconds === sampled.times[offset] && frame.path === paths[offset]);
        if (!frame) throw new Error("抽帧没有形成可读取的图像证据");
        const data = await readFile((await resolveWorkspacePath(cwd, frame.path)).path);
        if (selected.length && bytes + data.length > request.maxBytes) break;
        bytes += data.length;
        frame.returnedAt = Date.now();
        selected.push(frame);
        content.push({ type: "text", text: `Video frame evidence ${frame.id}; source time ${frame.seconds.toFixed(6)} seconds; requested ${frame.requestedSeconds.toFixed(6)}; ${frame.timestampKind}; no audio.` },
          { type: "image", data: data.toString("base64"), mimeType: "image/jpeg" });
      }
      const nextIndex = index + selected.length;
      const cursor = nextIndex < sampled.count ? await continuation({ index: nextIndex }) : null;
      if (!cursor) record.continuations = (record.continuations ?? []).filter(item => item.query !== query);
      await save();
      const engines = [...new Set(selected.map(frame => frame.engine))];
      return result({ engine: engines.length === 1 ? engines[0] : "mixed", metadata: { ...metadata, streams: undefined }, frames: selected, bytes, nextIndex, totalRequestedFrames: sampled.count, cursor,
        coverage: "Only the images returned in this call were supplied as visual evidence. Intervening motion and audio are not certified." });
    }
    if (request.action === "transcript") {
      if (!request.operationId) throw new Error("请提供 transcribe 返回的 operationId");
      const audio = record.audio.find(item => item.operationId === request.operationId || item.operationIds?.includes(request.operationId!));
      if (!audio) throw new Error("转写任务不属于当前视频版本");
      const transcriptionDirectory = dirname((await resolveWorkspacePath(cwd, audio.path)).path);
      const task = await getWhisperTask(transcriptionDirectory, request.operationId);
      if (!task.output || task.phase !== "completed") return result({ task, audio });
      const segments = parseSrt(await readFile((await resolveWorkspacePath(transcriptionDirectory, task.output)).path, "utf8"));
      const offset = request.offset;
      return result({ task, audio, segments: segments.slice(offset, offset + request.pageSize).map(segment => ({ ...segment, start: segment.start + audio.start, end: segment.end + audio.start })),
        totalSegments: segments.length, nextOffset: offset + request.pageSize < segments.length ? offset + request.pageSize : null,
        audioHeardByModel: false, limitation: "Local ASR transcript only; speaker, voice quality, effects and lip sync were not verified." });
    }
    const start = request.start ?? 0;
    const end = request.end ?? metadata.duration;
    if (!(end > start) || start >= metadata.duration || end > metadata.duration + 0.001) throw new Error("读取范围超出源媒体时长");
    if (request.action === "detect") {
      const kind = request.detection ?? "scene";
      const threshold = request.threshold ?? (kind === "scene" ? 10 : kind === "silence" ? 0.01 : kind === "freeze" ? 0.003 : 0.1);
      if ((kind === "silence" || kind === "freeze" || kind === "black") && threshold > 1 || kind === "scene" && threshold > 100) throw new Error("检测阈值超出滤镜取值范围");
      if (kind === "silence" && !metadata.hasAudio) return result({ detection: kind, events: [], hasAudio: false });
      const output = `${outputDirectory}/detect${crypto.randomUUID()}.${kind === "silence" ? "wav" : "mp4"}`;
      const scanEnd = Math.min(end, start + request.windowSeconds);
      const calls: BrowserFfmpegRequest["calls"] = [{ method: "seekInput", args: [start] }, { method: "duration", args: [scanEnd - start] }, { method: "output", args: [output] }];
      if (kind === "silence") calls.push({ method: "noVideo", args: [] }, { method: "audioFilters", args: [[
        { filter: "atrim", options: { end: scanEnd - start } }, { filter: "silencedetect", options: { n: threshold, d: 0.3 } },
      ]] }, { method: "audioFrequency", args: [16000] }, { method: "audioChannels", args: [1] });
      else calls.push({ method: "noAudio", args: [] }, { method: "videoFilters", args: [
        { filter: "trim", options: { end: scanEnd - start } },
        { filter: "scale", options: { w: 160, h: 160, force_original_aspect_ratio: "decrease", force_divisible_by: 2 } },
        { filter: kind === "scene" ? "scdet" : kind === "black" ? "blackdetect" : "freezedetect", options: kind === "scene" ? { t: threshold } : kind === "black" ? { pix_th: threshold, d: 0.1 } : { n: threshold, d: 0.5 } },
      ] }, { method: "videoCodec", args: ["libx264"] }, { method: "outputOptions", args: [["-preset", "ultrafast", "-crf", "40", "-pix_fmt", "yuv420p"]] });
      calls.push({ method: "outputOptions", args: [["-loglevel", "info", "-nostats"]] });
      const { stderr } = await execute(cwd, source.path, calls, signal);
      const pattern = kind === "scene" ? /lavfi\.scd\.time:\s*([\d.]+)/g : kind === "black" ? /black_(?:start|end):\s*([\d.]+)/g : kind === "freeze" ? /freeze_(?:start|end):\s*([\d.]+)/g : /silence_(?:start|end):\s*([\d.]+)/g;
      const events = [...stderr.matchAll(pattern)].map(match => ({ seconds: Math.min(scanEnd, start + Number(match[1])), detail: match[0] }));
      record.detections.push({ kind, start, end: scanEnd, events });
      const cursor = scanEnd < end ? await continuation({ start: scanEnd }) : null;
      if (!cursor) record.continuations = (record.continuations ?? []).filter(item => item.query !== query);
      await save();
      return result({ detection: kind, start, end: scanEnd, events, cursor, analysisPath: output, coverage: "Local signal scan only; candidates require visual or audio review." });
    }
    if (metadata.hasAudio === false) return result({ hasAudio: false, audioHeardByModel: false });
    const sourceAudio = metadata.streams?.find(stream => (stream as { codec_type?: string }).codec_type === "audio") as { sample_rate?: unknown; channels?: number } | undefined;
    const sampleRate = request.sampleRate ?? (request.action === "transcribe" ? 16000 : Number(sourceAudio?.sample_rate) || 48000);
    const channels = request.channels ?? (request.action === "transcribe" ? 1 : sourceAudio?.channels || 2);
    // 按 PCM 实际码率和本次传输预算分段；普通音轨保留采样率和声道，转写默认 16 kHz 单声道。
    const segmentEnd = Math.min(end, start + Math.max(1 / sampleRate, Math.floor(request.maxBytes / (sampleRate * channels * 2) * sampleRate) / sampleRate));
    const audioPath = `${outputDirectory}/audio${hash([start, segmentEnd, sampleRate, channels])}.wav`;
    const audioAbsolute = (await resolveWorkspacePath(cwd, audioPath)).path;
    if (!await lstat(audioAbsolute).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; })) {
      await execute(cwd, source.path, [{ method: "seekInput", args: [start] }, { method: "duration", args: [segmentEnd - start] },
        { method: "noVideo", args: [] }, { method: "audioCodec", args: ["pcm_s16le"] }, { method: "audioFrequency", args: [sampleRate] },
        { method: "audioChannels", args: [channels] }, { method: "output", args: [audioPath] }], signal);
    }
    const audio: AudioEvidence = record.audio.find(item => item.path === audioPath) ?? { path: audioPath, start, end: segmentEnd, sampleRate, channels };
    if (!record.audio.includes(audio)) record.audio.push(audio);
    let needsTranscription = request.action === "transcribe";
    if (needsTranscription && audio.operationId && audio.transcriptionModel === (request.model ?? "auto") && audio.transcriptionLanguage === request.language) {
      const previous = await getWhisperTask(dirname(audioAbsolute), audio.operationId).catch((error: { status?: number }) => { if (error.status !== 404) throw error; return undefined; });
      needsTranscription = !previous || !previous.running && previous.phase !== "completed";
    }
    if (needsTranscription) {
      const outputPath = (await resolveWorkspacePath(cwd, `${outputDirectory}/transcript${crypto.randomUUID()}.srt`)).path;
      const task = await startWhisper({ directory: dirname(audioAbsolute), sourcePath: audioAbsolute, outputPath, model: request.model ?? "auto", language: request.language });
      audio.operationIds = [...new Set([...(audio.operationIds ?? []), ...(audio.operationId ? [audio.operationId] : []), task.operationId])];
      audio.operationId = task.operationId;
      audio.transcriptionModel = request.model ?? "auto";
      audio.transcriptionLanguage = request.language;
    }
    const cursor = segmentEnd < end ? await continuation({ start: segmentEnd }) : null;
    if (!cursor) record.continuations = (record.continuations ?? []).filter(item => item.query !== query);
    await save();
    return result({ audio, audioHeardByModel: false, cursor,
      ...(audio.operationId ? { nextAction: "transcript", operationId: audio.operationId } : {}),
      limitation: "Decoded PCM audio file only; the text/image model did not hear it. Use local ASR for dialogue or an audio-capable model for listening." });
  });
  queues.set(manifest, task);
  try { return await task as Awaited<ReturnType<ToolDefinition["execute"]>>; }
  finally { if (queues.get(manifest) === task) queues.delete(manifest); }
}
