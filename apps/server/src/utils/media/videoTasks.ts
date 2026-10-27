import { platformFetch } from "@/utils/account";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { constants, copyFile, createReadStream, link, mkdir, open, readFile, stat, unlink, writeAtomic } from "@toonflow/file";
import { setTimeout as wait } from "node:timers/promises";
import { z } from "zod";
import type { VideoTaskContext } from "@toonflow/providers";
import type { GeneratedMedia, MediaGenerationRequest, VideoTaskStatus } from "@toonflow/tools-scaffold/runtime";
import { videoGenerationSchema } from "@toonflow/tool-media-generation/runtime";
import { lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";

const active = new Set<string>();
const taskIdSchema = z.uuid();
const stateSchema = z.object({
  phase: z.enum(["prepared", "submitting", "queued", "in_progress", "downloading", "failed"]),
  taskId: z.string().min(1).optional(), progress: z.number().min(0).max(100).optional(), error: z.string().optional(),
  retryAt: z.number().finite().positive().optional(),
});
const recordSchema = z.object({
  version: z.literal(1), id: taskIdSchema, identity: z.string(), request: videoGenerationSchema,
  state: stateSchema, createdAt: z.number(), updatedAt: z.number(), finishedAt: z.number().optional(), lastError: z.string().optional(),
  result: z.array(z.object({ path: z.string(), mimeType: z.string(), mediaType: z.literal("video") })).optional(),
  download: z.object({ validator: z.string().optional(), total: z.number().int().positive().optional(), source: z.string().optional() }).optional(),
});
type TaskRecord = z.infer<typeof recordSchema>;

function invalid(message: string, status = 409): never { throw Object.assign(new Error(message), { status }); }
function hash(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function taskDirectory(cwd: string, outputDirectory: string) {
  const output = await resolveWorkspacePath(cwd, outputDirectory, true);
  const key = process.platform === "win32" ? output.path.toLowerCase() : output.path;
  return (await resolveWorkspacePath(cwd, `.toonflow/videoTasks/${hash(key)}`, true)).path;
}

async function readRecord(path: string) {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.size > 2 * 1024 * 1024) invalid("视频任务记录无效，请保留现场并检查文件");
  return recordSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function currentRecord(cwd: string, directory: string) {
  const path = (await resolveWorkspacePath(cwd, relative(cwd, join(directory, "current.json")))).path;
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.size > 128) invalid("视频任务索引无效，请保留现场，不能重新提交");
  const id = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (id === null) return null;
  const parsed = taskIdSchema.parse(JSON.parse(id));
  const recordPath = (await resolveWorkspacePath(cwd, relative(cwd, join(directory, `${parsed}.json`)))).path;
  const record = await readRecord(recordPath);
  if (!record || record.id !== parsed) invalid("视频任务索引不完整，请保留现场，不能重新提交");
  return record;
}

export async function getVideoTask(cwd: string, outputDirectory: string): Promise<VideoTaskStatus | null> {
  const directory = await taskDirectory(cwd, outputDirectory);
  if (!(await stat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; }))) return null;
  const task = await currentRecord(cwd, directory);
  if (!task) return null;
  return {
    operationId: task.id, providerId: task.request.providerId, modelId: task.request.modelId,
    startedAt: task.createdAt, endedAt: task.finishedAt ?? (task.result || task.state.phase === "failed" ? task.updatedAt : undefined),
    phase: task.result ? "completed" : task.state.phase, taskId: task.state.taskId,
    progress: task.result ? 100 : task.state.progress, error: task.state.error ?? task.lastError,
    running: active.has(directory), result: task.result, updatedAt: task.updatedAt,
  };
}

export async function getVideoTaskRequest(cwd: string, outputDirectory: string, operationId: string): Promise<MediaGenerationRequest> {
  const directory = await taskDirectory(cwd, outputDirectory);
  const task = await currentRecord(cwd, directory);
  if (!task || task.id !== operationId) invalid("原视频任务不存在或已被新操作替代");
  if (task.request.outputDirectory !== outputDirectory) invalid("视频任务与节点不匹配");
  return task.request;
}

async function validateMp4(path: string, signal?: AbortSignal) {
  const file = await open(path, "r");
  try {
    const length = (await file.stat()).size;
    const header = Buffer.alloc(16);
    let offset = 0;
    const boxes = new Set<string>();
    while (offset < length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(header, 0, Math.min(16, length - offset), offset);
      if (bytesRead < 8) invalid("原片不完整，请恢复下载", 502);
      let size = header.readUInt32BE(0);
      const type = header.toString("ascii", 4, 8);
      let headerSize = 8;
      if (size === 1) {
        if (bytesRead < 16) invalid("原片不完整，请恢复下载", 502);
        const largeSize = header.readBigUInt64BE(8);
        if (largeSize > BigInt(length)) invalid("原片不完整，请恢复下载", 502);
        size = Number(largeSize); headerSize = 16;
      } else if (size === 0) size = length - offset;
      if (size < headerSize || offset + size > length) invalid("原片不完整，请恢复下载", 502);
      boxes.add(type);
      offset += size;
    }
    if (!["ftyp", "moov", "mdat"].every(type => boxes.has(type))) invalid("下载内容不是完整的 MP4 原片", 502);
  } finally { await file.close(); }
}

function retryAfter(response: Response) {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}

async function downloadError(response: Response, sanitize: (error: unknown) => string) {
  const reader = response.body?.getReader();
  const timer = globalThis.setTimeout(() => { void reader?.cancel().catch(() => {}); }, 3000);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (reader && size < 16000) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, 16000 - size);
      chunks.push(chunk); size += chunk.byteLength;
    }
  } catch { /* 错误正文也可能中断，仍保留 HTTP 状态和追踪编号。 */ }
  finally { clearTimeout(timer); await reader?.cancel().catch(() => {}); }
  const text = Buffer.concat(chunks, size).toString("utf8");
  let value: any = text;
  try { value = JSON.parse(text); } catch { /* 非 JSON 正文交给现有脱敏工具处理。 */ }
  const code = value?.error?.code ?? value?.error?.type ?? value?.code;
  const trace = ["x-request-id", "x-trace-id", "request-id", "x-oneapi-request-id"].flatMap(name => {
    const value = response.headers.get(name);
    return value ? [`${name}: ${value}`] : [];
  });
  return sanitize([`原片下载失败（HTTP ${response.status}${code ? ` / ${String(code)}` : ""}）`, sanitize(value), ...trace].filter(Boolean).join("；"));
}

async function downloadAttempt(
  cwd: string, path: string, url: string, headers: Record<string, string>, record: TaskRecord,
  save: () => Promise<void>, sanitize: (error: unknown) => string, signal?: AbortSignal, source: VideoDownloadSource = "original",
) {
  await resolveWorkspacePath(cwd, relative(cwd, path));
  const local = await stat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (local && !local.isFile()) invalid("原片临时文件无效");
  if (local?.size && local.size === record.download?.total) {
    try { await validateMp4(path, signal); return; }
    catch (error) {
      signal?.throwIfAborted();
      if ((error as { status?: number }).status !== 502) throw error;
      record.download = undefined; await save();
    }
  }
  const sourceHash = hash(url);
  let offset = record.download?.validator && (!record.download.source || record.download.source === sourceHash) ? local?.size ?? 0 : 0;
  const publicSource = source === "publicCdn" || source === "publicHttpCdn";
  let response: Response;
  try {
    if (publicSource && Object.keys(headers).length) invalid("公开 CDN 下载不能附带接口凭据");
    const downloadSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000);
    for (let redirects = 0; ; redirects++) {
      if (publicSource) {
        const target = new URL(url);
        if (!(target.protocol === "https:" || (source === "publicHttpCdn" && target.protocol === "http:")) || target.username || target.password) invalid("成品链接的协议或账号密码不符合此渠道下载要求");
      }
      response = await (source === "gateway" ? platformFetch : fetch)(url, {
        headers: { ...headers, ...(offset ? { Range: `bytes=${offset}-`, "If-Range": record.download!.validator! } : {}) },
        signal: downloadSignal, redirect: "manual",
      });
      if (!publicSource || ![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects >= 5) invalid("成品下载重定向无效，请恢复原任务重新获取链接");
      url = new URL(location, url).href;
    }
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as { status?: number }).status) throw error;
    throw Object.assign(new Error(`原片下载连接中断：${sanitize(error)}`), { retryable: true });
  }
  const reject = async (message: string): Promise<never> => { await response.body?.cancel(); return invalid(message, 502); };
  if (response.status === 416) {
    record.download = undefined;
    await save();
    return reject("原片续传长度已变化；断点已重置，恢复时将从头下载原任务，不会重新生成");
  }
  if (!response.ok) throw Object.assign(new Error(await downloadError(response, sanitize)), {
    httpStatus: response.status,
    retryable: response.status === 408 || response.status === 429 || response.status >= 500,
    retryAfter: retryAfter(response),
  });
  if (source === "original" && response.headers.get("x-video-quality")?.toLowerCase() !== "original") return reject("接口未返回原片标记，已保留任务，请稍后恢复下载");
  const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (mime !== "video/mp4" && mime !== "application/octet-stream") return reject("原片内容类型不正确，已保留任务");
  const lengthHeader = response.headers.get("content-length");
  const length = lengthHeader === null ? undefined : Number(lengthHeader);
  if (length !== undefined && (!Number.isSafeInteger(length) || length <= 0)) return reject("原片声明长度无效");
  const etag = response.headers.get("etag");
  const validator = etag && !etag.startsWith("W/") ? etag : response.headers.get("last-modified") ?? undefined;
  let total = length;
  if (response.status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
    if (!range || Number(range[1]) !== offset || Number(range[2]) !== Number(range[3]) - 1 || (length !== undefined && Number(range[2]) - offset + 1 !== length)) return reject("原片续传范围不匹配，请保留任务并检查下载接口");
    total = Number(range[3]);
    if (offset && (validator !== record.download?.validator || (record.download?.total !== undefined && total !== record.download.total))) return reject("原片在续传期间发生变化，已停止追加");
  } else if (response.status === 200) offset = 0;
  else return reject("原片下载返回了不支持的状态码");
  if (total !== undefined && (!Number.isSafeInteger(total) || total <= 0)) return reject("原片完整长度无效");
  record.download = { validator, total, source: sourceHash };
  const reader = response.body?.getReader();
  if (!reader) invalid("原片响应为空", 502);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let received = 0;
  try {
    await save();
    file = await open(path, offset ? "a" : "w");
    while (true) {
      signal?.throwIfAborted();
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try { chunk = await reader.read(); }
      catch (error) {
        signal?.throwIfAborted();
        throw Object.assign(new Error(`原片传输中断，已保留断点：${sanitize(error)}`), { retryable: true });
      }
      const { value, done } = chunk;
      if (done) break;
      received += value.byteLength;
      if (!Number.isSafeInteger(received + offset) || (total !== undefined && received + offset > total)) invalid("原片实际长度超过声明值", 502);
      await file.writeFile(value);
    }
    await file.sync();
  } finally { try { await file?.close(); } finally { await reader.cancel().catch(() => {}); } }
  if (!received || (length !== undefined && received !== length) || (total !== undefined && received + offset !== total)) throw Object.assign(new Error("原片下载中断，已保存断点，请恢复原任务"), { retryable: true });
  try { await validateMp4(path, signal); }
  catch (error) { record.download = undefined; await save(); throw error; }
  record.download.total = received + offset;
  await save();
}

async function downloadVideo(
  cwd: string, path: string, url: string, headers: Record<string, string>, record: TaskRecord,
  save: () => Promise<void>, sanitize: (error: unknown) => string, signal?: AbortSignal, source: VideoDownloadSource = "original",
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    try {
      await downloadAttempt(cwd, path, url, headers, record, save, sanitize, signal, source);
      record.state.retryAt = undefined;
      await save();
      return;
    } catch (error) {
      signal?.throwIfAborted();
      const failure = error as Error & { retryable?: boolean; retryAfter?: number };
      if (!failure.retryable) throw error;
      const delay = Math.max(5000 * (attempt + 1), failure.retryAfter ?? 0);
      record.lastError = sanitize(error);
      record.state.retryAt = attempt < 2 || failure.retryAfter !== undefined ? Date.now() + delay : undefined;
      await save();
      if (attempt === 2 || delay > 60000) throw Object.assign(new Error(`${sanitize(error)}；自动下载已停止，请稍后恢复原任务，不会重新生成`), { httpStatus: (error as { httpStatus?: number }).httpStatus });
      await wait(delay, undefined, { signal });
    }
  }
}

async function fileDigest(path: string, signal?: AbortSignal) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) digest.update(chunk);
  return digest.digest("hex");
}

async function publishDownload(cwd: string, path: string, record: TaskRecord, signal?: AbortSignal): Promise<DownloadedVideoAsset> {
  const outputDirectory = record.request.outputDirectory ?? "assets/generated";
  const output = await resolveWorkspacePath(cwd, outputDirectory, true);
  const release = lockWorkspaceFiles([output.path]);
  const staging = `${path}.${crypto.randomUUID()}.ready`;
  let copied = false;
  try {
    await mkdir(output.path, { recursive: true });
    const target = await resolveWorkspacePath(cwd, join(outputDirectory, `video${record.id}.mp4`));
    signal?.throwIfAborted();
    await copyFile(path, staging, constants.COPYFILE_EXCL);
    copied = true;
    signal?.throwIfAborted();
    try { await link(staging, target.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await stat(target.path);
      if (!existing.isFile() || existing.size !== (await stat(path)).size || await fileDigest(target.path, signal) !== await fileDigest(path, signal)) throw new Error("原任务视频文件已发生变化，未覆盖已有文件");
    }
    return { type: "file", mediaType: "video", path: relative(cwd, target.path).replace(/\\/g, "/"), mimeType: "video/mp4" };
  } finally {
    try { if (copied) await unlink(staging); } finally { release(); }
  }
}

export async function runVideoTask(
  cwd: string, input: MediaGenerationRequest, config: Record<string, unknown>,
  generate: (request: MediaGenerationRequest, context: VideoTaskContext) => Promise<GeneratedMedia[]>,
  readReferenceImages: () => Promise<MediaInput[]>,
  sanitize: (error: unknown) => string, signal?: AbortSignal,
) {
  const outputDirectory = input.outputDirectory ?? "assets/generated";
  const directory = await taskDirectory(cwd, outputDirectory);
  if (active.has(directory)) invalid("此节点的原视频任务仍在运行，请等待或恢复查询，不能重复提交");
  active.add(directory);
  try {
    await mkdir(directory, { recursive: true });
    const previous = await currentRecord(cwd, directory);
    const operationId = taskIdSchema.parse(input.operationId ?? crypto.randomUUID());
    const request = videoGenerationSchema.parse({ ...input, outputDirectory, operationId });
    const recordPath = (await resolveWorkspacePath(cwd, relative(cwd, join(directory, `${operationId}.json`)))).path;
    let record = await readRecord(recordPath);
    if (previous && previous.id !== operationId && !previous.result && previous.state.phase !== "failed") invalid("此节点存在未完成的视频任务，请先恢复原任务");
    const identity = hash(canonical({ apiKey: String(config.apiKey ?? "").trim().replace(/^Bearer\s+/i, "").trim(), apiUrl: String(config.apiUrl ?? "").replace(/\/+$/, "") }));
    if (record) {
      if (record.id !== operationId || canonical(record.request) !== canonical(request)) invalid("同一操作不能修改生成参数，请先恢复原任务");
      if (record.result) return record.result;
      if (record.identity !== identity) invalid("恢复任务须使用原 API 地址和密钥，请恢复原配置");
      if (record.state.phase === "failed") invalid(record.state.error || "原任务已失败，请确认后发起新生成");
    } else {
      record = { version: 1, id: operationId, identity, request, state: { phase: "prepared" }, createdAt: Date.now(), updatedAt: Date.now() };
      await writeAtomic(recordPath, JSON.stringify(record), { exclusive: true });
    }
    await writeAtomic(join(directory, "current.json"), JSON.stringify(operationId));
    const task = record;
    const save = async () => {
      task.updatedAt = Date.now();
      if (task.result || task.state.phase === "failed") task.finishedAt ??= task.updatedAt;
      await writeAtomic(recordPath, JSON.stringify(task));
    };
    const requestPath = (await resolveWorkspacePath(cwd, relative(cwd, join(directory, `${operationId}.request.json`)))).path;
    let requestSaved = !!(await stat(requestPath).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; }));
    let downloaded: DownloadedVideoAsset | undefined;
    const context: VideoTaskContext = {
      id: operationId,
      idHash: hash(operationId),
      readReferenceImages,
      get state() { return task.state; },
      get requestSaved() { return requestSaved; },
      get downloaded() { return downloaded; },
      async readRequest() {
        const info = await stat(requestPath);
        if (!info.isFile() || info.size > 128 * 1024 * 1024) invalid("原始请求记录无效");
        return readFile(requestPath, "utf8");
      },
      async saveRequest(body) {
        if (requestSaved) invalid("不能覆盖原视频请求");
        await writeAtomic(requestPath, body, { exclusive: true });
        requestSaved = true;
      },
      async update(state) { task.state = stateSchema.parse({ ...task.state, ...state }); task.lastError = undefined; await save(); },
      async download(url, headers, source) {
        const path = join(directory, `${operationId}.part`);
        await downloadVideo(cwd, path, url, headers, task, save, sanitize, signal, source);
        downloaded = Object.freeze(await publishDownload(cwd, path, task, signal));
        return downloaded;
      },
    };
    try {
      const result = await generate(request, context);
      if (result.length !== 1 || result[0]?.mediaType !== "video") invalid("视频任务应返回一条视频", 502);
      task.result = result as TaskRecord["result"];
      task.lastError = undefined;
      await save();
      return result;
    } catch (error) {
      task.lastError = signal?.aborted ? "本地等待已中断，原任务已保留；恢复不会新建视频" : sanitize(error);
      if (!requestSaved) task.state = { phase: "failed", error: task.lastError };
      await save();
      throw error;
    }
  } finally { active.delete(directory); }
}
