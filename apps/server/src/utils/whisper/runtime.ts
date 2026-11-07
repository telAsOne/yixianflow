import { createHash, randomBytes } from "node:crypto";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import { createReadStream, lstat, mkdir, readFile, stat, withFileAccess, writeAtomic } from "@toonflow/file";
import { parseSrt, serializeSrt } from "@toonflow/node-shared/subtitleSrt";
import { subtitleReportSchema, whisperSelections } from "@toonflow/local-helper/subtitleProtocol";
import type { SubtitleEnvironment } from "@toonflow/local-helper/subtitleProtocol";
import { transferFileMaxBytes } from "@toonflow/local-helper/protocol";
import { z } from "zod";
import conf from "@/utils/conf";
import { callDevice, getSelectedDevice, requireReadyDevice } from "@/utils/localHelper";
import { requireWebAccount } from "@/lib/webContext";
import { isWithin, lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";
import { notifyFileChange } from "@/utils/workspace/canvasSync";
import type { WhisperCheckResult, WhisperStartInput, WhisperTask } from "./types";

const recordDirectory = join(dirname(conf.path), "subtitleTasks");
const recordSchema = z.object({
  operationId: z.uuid(), ownerId: z.number().int(), deviceId: z.uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  directory: z.string(), source: z.string(), output: z.string(), sourceRevision: z.string(), size: z.number().int(), createdAt: z.number(), expiresAt: z.number(),
  state: z.object({ operationId: z.uuid(), phase: z.enum(["preparing", "downloadingModel", "transcribing", "reviewing", "writing", "completed", "failed", "cancelled"]),
    running: z.boolean(), model: z.enum(whisperSelections), output: z.string().optional(), error: z.string().optional(), updatedAt: z.number(), progress: z.number().optional(),
    review: subtitleReportSchema.shape.review }),
});
type Record = z.infer<typeof recordSchema>;
type Entry = { record: Record; queue: Promise<void>; release?: () => void; dispatch?: AbortController };
const entries = new Map<string, Entry>();
const loads = new Map<string, Promise<Entry>>();
const revision = (info: Awaited<ReturnType<typeof lstat>>) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

async function readyDevice() {
  const device = await getSelectedDevice();
  if (!device?.ready) throw Object.assign(new Error("请在设置 → 本地助手连接并选择已授权电脑，Whisper 由本地托盘执行"), { status: 424, code: "LOCAL_HELPER_REQUIRED" });
  if (!Bun.semver.satisfies(device.version, ">=0.6.0")) throw Object.assign(new Error("请先升级本地助手至 0.6.0，安装本机识别环境后再生成字幕"), { status: 424, code: "LOCAL_HELPER_UPDATE_REQUIRED" });
  return device;
}

async function persist(entry: Entry) {
  await mkdir(recordDirectory, { recursive: true });
  await writeAtomic(join(recordDirectory, `${entry.record.operationId}.json`), JSON.stringify(entry.record), { mode: 0o600 });
}

async function load(id: string): Promise<Entry> {
  z.uuid().parse(id);
  if (entries.has(id)) return entries.get(id)!;
  if (loads.has(id)) return loads.get(id)!;
  const pending = (async () => {
    try {
      const path = join(recordDirectory, `${id}.json`);
      if ((await stat(path)).size > 128 * 1024) throw new Error("字幕任务元数据过大");
      const record = recordSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (record.operationId !== id) throw new Error("字幕任务记录编号不匹配");
      const entry: Entry = { record, queue: Promise.resolve() };
      if (record.state.running) entry.release = lockWorkspaceFiles([(await resolveWorkspacePath(record.directory, record.output)).path]);
      entries.set(id, entry); return entry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Object.assign(new Error("字幕任务不存在或已过期"), { status: 404, code: "WHISPER_TASK_EXPIRED" });
      throw error;
    }
  })().finally(() => loads.delete(id));
  loads.set(id, pending); return pending;
}

function change<T>(entry: Entry, operation: () => Promise<T>): Promise<T> {
  const pending = entry.queue.then(operation);
  entry.queue = pending.then(() => {}, () => {}); return pending;
}

async function finish(entry: Entry, phase: "completed" | "failed" | "cancelled", error?: string) {
  entry.record.state = { ...entry.record.state, phase, running: false, error, updatedAt: Date.now(),
    output: phase === "completed" ? entry.record.output : undefined, progress: phase === "completed" ? 100 : entry.record.state.progress };
  await persist(entry); entry.release?.(); entry.release = undefined;
}

async function owned(directory: string, id: string) {
  const entry = await load(id);
  if (entry.record.ownerId !== requireWebAccount().user.id || resolve(directory) !== resolve(entry.record.directory))
    throw Object.assign(new Error("字幕任务不属于当前账户或工作区"), { status: 404 });
  if (entry.record.state.running && entry.record.expiresAt < Date.now()) await change(entry, () => finish(entry, "failed", "本地字幕任务超时，已有本机结果保留，请核对后重试"));
  return entry;
}

async function fromDevice(req: Request) {
  const device = await requireReadyDevice(req);
  const id = z.uuid().parse(req.query.operationId ?? req.body?.operationId);
  const entry = await load(id);
  if (entry.record.deviceId !== device.id || entry.record.ownerId !== device.ownerId || (req.get("x-subtitle-token") ?? req.body?.token) !== entry.record.token)
    throw Object.assign(new Error("字幕任务不属于该设备或任务凭据无效"), { status: 403 });
  if (entry.record.expiresAt < Date.now()) throw Object.assign(new Error("字幕任务凭据已过期"), { status: 410 });
  return entry;
}

export async function checkWhisper(): Promise<WhisperCheckResult> {
  const device = await readyDevice();
  const environment = await callDevice(device, { action: "subtitleEnvironment" }) as SubtitleEnvironment;
  const models = environment.models.filter(model => model.cached && model.allowed);
  const errors = [environment.error, !environment.ready ? "请从本地助手 → 批量字幕安装识别环境" : undefined,
    !models.length ? "请在本地助手下载适合本机硬件的模型，云端不下载模型" : undefined].filter((value): value is string => !!value);
  const ffmpeg = await import("@/utils/ffmpeg").then(module => module.getStatus());
  return { models: whisperSelections, defaultModel: environment.hardware?.recommended,
    python: { path: environment.pythonPath, available: environment.ready }, whisper: { available: environment.ready },
    torch: { available: environment.ready, cuda: !!environment.hardware?.cuda }, device: environment.ready ? environment.hardware?.cuda ? "cuda" : "cpu" : "unavailable",
    ffmpeg, cacheDirectory: environment.settings.directory, ready: environment.ready && models.length > 0, errors,
    execution: "localHelper", localDevice: { id: device.id, name: device.name }, cachedModels: models.map(model => model.id) };
}

export async function startWhisper(input: WhisperStartInput): Promise<WhisperTask> {
  const device = await readyDevice();
  if (!isAbsolute(input.directory) || !isWithin(input.directory, input.sourcePath) || !isWithin(input.directory, input.outputPath)
    || resolve(input.sourcePath) === resolve(input.outputPath) || extname(input.outputPath).toLowerCase() !== ".srt") throw new Error("字幕任务输入输出路径无效");
  const sourceName = relative(input.directory, input.sourcePath).split(sep).join("/");
  const outputName = relative(input.directory, input.outputPath).split(sep).join("/");
  const source = await resolveWorkspacePath(input.directory, sourceName);
  const output = await resolveWorkspacePath(input.directory, outputName);
  const sourceInfo = await lstat(source.path);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("字幕源文件必须是普通媒体文件");
  if (!sourceInfo.size || sourceInfo.size > transferFileMaxBytes) throw Object.assign(new Error("字幕素材传输上限为单文件 100 MiB，请先缩小素材"), { status: 413 });
  if (!(await stat(dirname(output.path))).isDirectory()) throw new Error("字幕输出目录不存在");
  if (await lstat(output.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; }))
    throw Object.assign(new Error("字幕输出已经存在，不会覆盖"), { status: 409, code: "EEXIST" });
  const operationId = crypto.randomUUID();
  const entry: Entry = { queue: Promise.resolve(), dispatch: new AbortController(), release: lockWorkspaceFiles([output.path]), record: {
    operationId, ownerId: device.ownerId, deviceId: device.id, token: randomBytes(32).toString("base64url"), directory: input.directory, source: sourceName,
    output: outputName, sourceRevision: revision(sourceInfo), size: sourceInfo.size, createdAt: Date.now(), expiresAt: Date.now() + 24 * 60 * 60000,
    state: { operationId, phase: "preparing", running: true, model: input.model, updatedAt: Date.now(), progress: 0 },
  } };
  try { await persist(entry); entries.set(operationId, entry); } catch (error) { entry.release?.(); throw error; }
  // 仅协调和传输；识别在托盘持久队列执行，浏览器关闭不取消已提交任务。
  void (async () => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(source.path)) hash.update(chunk);
    if (revision(await lstat(source.path)) !== entry.record.sourceRevision) throw new Error("字幕源文件在提交期间发生变化");
    const extension = /^[a-z0-9]{1,8}$/i.test(extname(source.path).slice(1)) ? extname(source.path).slice(1).toLowerCase() : "bin";
    await callDevice(device, { action: "subtitleTranscribe", operationId, token: entry.record.token, fileName: `input.${extension}`,
      size: sourceInfo.size, sha256: hash.digest("hex"), model: input.model, language: input.language || "" }, entry.dispatch!.signal);
  })().catch(error => change(entry, async () => {
    if (entry.record.state.running) await finish(entry, entry.dispatch?.signal.aborted ? "cancelled" : "failed", error instanceof Error ? error.message : String(error));
  })).catch(error => console.error("字幕任务协调记录保存失败", error instanceof Error ? error.name : "Error"));
  return structuredClone(entry.record.state);
}

export async function getWhisperTask(directory: string, id: string) { return structuredClone((await owned(directory, id)).record.state); }

export async function cancelWhisper(directory: string, id: string) {
  const entry = await owned(directory, id);
  return change(entry, async () => {
    if (entry.record.state.running && entry.record.state.phase !== "writing") { entry.dispatch?.abort(); await finish(entry, "cancelled", "已取消本地字幕任务"); }
    return structuredClone(entry.record.state);
  });
}

export async function subtitleInput(req: Request, res: Response) {
  const entry = await fromDevice(req);
  if (!entry.record.state.running) throw Object.assign(new Error("字幕任务已经结束"), { status: 409 });
  const source = await resolveWorkspacePath(entry.record.directory, entry.record.source);
  await withFileAccess([source.path], "read", async () => {
    if (revision(await lstat(source.path)) !== entry.record.sourceRevision) throw Object.assign(new Error("字幕源文件已变化"), { status: 409 });
    res.set({ "Content-Type": "application/octet-stream", "Content-Length": String(entry.record.size), "Cache-Control": "no-store" });
    await pipeline(createReadStream(source.path), res);
  });
}

export async function subtitleEvent(req: Request) {
  const report = subtitleReportSchema.parse(req.body);
  const entry = await fromDevice(req);
  return change(entry, async () => {
    if (entry.record.state.phase === "completed") return { accepted: true };
    if (!entry.record.state.running) throw Object.assign(new Error("字幕任务已结束，不接受后续修改"), { status: 409 });
    if (report.model) entry.record.state.model = report.model;
    entry.record.state.progress = report.progress; entry.record.state.review = report.review;
    if (report.state === "completed") {
      if (!report.srt || Buffer.byteLength(report.srt) > 2 * 1024 * 1024) throw new Error("本机字幕结果为空或超过 2 MiB");
      const segments = parseSrt(report.srt);
      if (!segments.length) throw new Error("本机字幕没有有效分段");
      const content = serializeSrt(segments);
      const source = await resolveWorkspacePath(entry.record.directory, entry.record.source);
      if (revision(await lstat(source.path)) !== entry.record.sourceRevision) throw Object.assign(new Error("原媒体已经变化，本机字幕保留但未写入该工作区"), { status: 409 });
      const output = await resolveWorkspacePath(entry.record.directory, entry.record.output);
      const recovering = entry.record.state.phase === "writing";
      entry.record.state.phase = "writing"; await persist(entry);
      try { await writeAtomic(output.path, content, { exclusive: true }); }
      catch (error) {
        if (!recovering || (error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(output.path, "utf8") !== content) throw error;
      }
      await finish(entry, "completed"); notifyFileChange(entry.record.directory, entry.record.output);
    } else if (["failed", "cancelled", "interrupted", "noSpeech", "waitingEnvironment"].includes(report.state)) {
      await finish(entry, report.state === "cancelled" ? "cancelled" : "failed", report.error || (report.state === "noSpeech" ? "没有识别到有效语音" : "本机识别已中断，请查看托盘任务记录"));
    } else {
      entry.record.state.phase = report.state === "reviewing" ? "reviewing" : report.state === "transcribing" ? "transcribing" : "preparing";
      entry.record.state.updatedAt = Date.now(); await persist(entry);
    }
    return { accepted: true };
  });
}

export async function cancelledSubtitles(deviceId: string, ownerId: number | null, ids: string[]) {
  const cancelled: string[] = [];
  for (const id of ids) {
    try {
      const { record } = await load(id);
      if (record.deviceId !== deviceId || record.ownerId !== ownerId || record.expiresAt < Date.now() || !record.state.running && record.state.phase !== "completed") cancelled.push(id);
    } catch (error) { if ((error as { status?: number }).status === 404) cancelled.push(id); else throw error; }
  }
  return cancelled;
}
