import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream, link, lstat, mkdir, unlink, withFileAccess } from "@toonflow/file";
import type { Request, Response } from "express";
import type { BrowserFfmpegRequest } from "@toonflow/ffmpeg";
import type { FfmpegRemoteEvent } from "@toonflow/ffmpeg/remote";
import { fileBatchLimit, transferBatchMaxBytes, transferFileMaxBytes } from "@toonflow/local-helper/protocol";
import { callDevice, getSelectedDevice, requireReadyDevice } from "./index";
import { getWebDatabase } from "@/utils/web/store";
import { lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";
import { notifyFileChange } from "@/utils/workspace/canvasSync";

type MediaFile = { name: string; path: string; content?: string };
type MediaPlan = { request: BrowserFfmpegRequest; inputs: MediaFile[]; outputs: MediaFile[]; folders?: MediaFile[] };
type MediaSession = MediaPlan & { deviceId: string; ownerId: number; sessionHash: string; signal: AbortSignal;
  emit: (event: FfmpegRemoteEvent) => void; files: (MediaFile & { size: number; revision: string })[];
  uploaded: Set<string>; active: Set<string>; uploadedBytes: number };
// ACT: 传输许可随协调进程结束失效；沿用设备队列的中断语义，不自动重跑媒体任务。
const sessions = new Map<string, MediaSession>();

function revision(info: Awaited<ReturnType<typeof lstat>>) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

export async function requireMediaDevice() {
  const device = await getSelectedDevice();
  if (!device?.ready) throw Object.assign(new Error("请在设置 → 本地助手中连接并选择已授权的电脑，FFmpeg 由本地助手执行。"),
    { status: 424, code: "LOCAL_HELPER_REQUIRED" });
  if (!Bun.semver.satisfies(device.version, ">=0.5.1")) throw Object.assign(new Error("请将本地助手更新到 0.5.1 或更新版本后使用 FFmpeg。"),
    { status: 424, code: "LOCAL_HELPER_UPDATE_REQUIRED" });
  return device;
}

async function checkInputs(session: MediaSession) {
  session.signal.throwIfAborted();
  for (const file of session.files) {
    if (revision(await lstat(file.path)) !== file.revision) throw Object.assign(new Error("媒体源文件已变化，请重新发起处理"), { status: 409 });
  }
}

export async function executeMedia(plan: MediaPlan, emit: (event: FfmpegRemoteEvent) => void, signal: AbortSignal) {
  const device = await requireMediaDevice();
  signal.throwIfAborted();
  if (plan.inputs.length > fileBatchLimit || plan.outputs.length > fileBatchLimit) throw new Error("本地媒体任务每次最多传输 20 个输入或输出文件");
  const files: MediaSession["files"] = [];
  let total = 0;
  for (const file of plan.inputs) {
    const info = await lstat(file.path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("媒体输入必须是普通文件");
    total += info.size;
    if (info.size > transferFileMaxBytes || total > transferBatchMaxBytes) throw new Error("本地媒体传输超过限制：单文件 100 MiB，整批 200 MiB");
    if (file.content && Buffer.byteLength(file.content) > 65536) throw new Error("拼接清单超过 64 KiB");
    files.push({ ...file, size: info.size, revision: revision(info) });
  }
  for (const file of plan.outputs) {
    if (!/%\d*d/.test(file.name) && await lstat(file.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; }))
      throw Object.assign(new Error(`输出已存在，不会覆盖：${file.name}`), { code: "EEXIST", status: 409 });
  }
  const id = crypto.randomUUID();
  const session: MediaSession = { ...plan, deviceId: device.id, ownerId: device.ownerId, sessionHash: device.sessionHash,
    signal, emit, files, uploaded: new Set(), active: new Set(), uploadedBytes: 0 };
  sessions.set(id, session);
  try {
    const result = await callDevice(device, { action: "ffmpeg", mediaId: id,
      request: { ...plan.request, directory: "." } as Extract<import("@toonflow/local-helper/protocol").LocalHelperRequest, { action: "ffmpeg" }>["request"],
      inputs: files.map(file => ({ path: file.name, size: file.content === undefined ? file.size : Buffer.byteLength(file.content),
        ...(file.content === undefined ? {} : { content: file.content }) })),
      outputs: plan.outputs.map(file => file.name), folders: (plan.folders ?? []).map(file => file.name),
    }, signal) as FfmpegRemoteEvent;
    await checkInputs(session);
    if (!result || !["result", "end"].includes(result.event) || !Array.isArray(result.args)) throw new Error("本地助手未返回有效的媒体处理结果");
    if (result.event === "end" && (!session.uploaded.size && (plan.outputs.length || plan.folders?.length))) throw new Error("本地媒体输出尚未上传，任务未完成");
    emit(result);
  } finally { sessions.delete(id); }
}

async function mediaSession(req: Request) {
  const device = await requireReadyDevice(req);
  const id = String(req.query.mediaId ?? req.body?.mediaId ?? "");
  const session = sessions.get(id);
  if (!session || session.deviceId !== device.id || session.ownerId !== device.ownerId || session.signal.aborted)
    throw Object.assign(new Error("媒体任务许可已失效"), { status: 409 });
  const sql = getWebDatabase();
  if (!/^[a-f0-9-]{36}$/i.test(req.get("x-toonflow-call") ?? "") || !/^[A-Za-z0-9_-]{32}$/.test(req.get("x-toonflow-nonce") ?? ""))
    throw Object.assign(new Error("媒体执行凭据无效"), { status: 403 });
  const [call] = await sql`SELECT call.id FROM yixianflow.localCalls AS call JOIN yixianflow.sessions AS session ON session.hash = call."sessionHash"
    WHERE call.id = ${req.get("x-toonflow-call")}::uuid AND call.nonce = ${req.get("x-toonflow-nonce")}
      AND call."deviceId" = ${device.id} AND call."ownerId" = ${device.ownerId} AND call.status = 'running'
      AND call."expiresAt" > CURRENT_TIMESTAMP AND call.request->>'mediaId' = ${id}
      AND session.hash = ${session.sessionHash} AND session."localDeviceId" = ${device.id} AND session."userId" = ${device.ownerId}
      AND session."expiresAt" > CURRENT_TIMESTAMP AND session."seenAt" > CURRENT_TIMESTAMP - INTERVAL '30 minutes'`;
  if (!call) throw Object.assign(new Error("媒体任务授权已结束"), { status: 409 });
  return session;
}

export async function mediaInput(req: Request, res: Response) {
  const session = await mediaSession(req);
  const file = session.files[Number(req.query.index)];
  if (!file || file.content !== undefined) throw Object.assign(new Error("媒体输入不存在"), { status: 404 });
  await withFileAccess([file.path], "read", async () => {
    await checkInputs(session);
    res.set({ "Content-Type": "application/octet-stream", "Content-Length": String(file.size), "Cache-Control": "no-store" });
    await pipeline(createReadStream(file.path), res, { signal: session.signal });
  }, session.signal);
}

function matchesOutput(pattern: string, name: string) {
  const expression = pattern.split(/(%\d*d)/).map(part => /^%\d*d$/.test(part) ? "[0-9]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
  return new RegExp(`^${expression}$`).test(name);
}

export async function mediaOutput(req: Request, res: Response) {
  const session = await mediaSession(req);
  const name = String(req.query.path);
  if (!name || isAbsolute(name) || name.split(/[\\/]/).some(part => !part || part === "." || part === ".." || /[:<>"|?*\x00-\x1f]/.test(part)))
    throw Object.assign(new Error("媒体输出路径无效"), { status: 400 });
  const output = session.outputs.find(file => matchesOutput(file.name, name));
  const folder = session.folders?.find(file => file.name === "." || name.startsWith(`${file.name}/`));
  let path: string;
  if (output) {
    path = (await resolveWorkspacePath(dirname(output.path), output.name === name ? basename(output.path) : basename(name))).path;
  } else if (folder) {
    await resolveWorkspacePath(session.request.directory, relative(session.request.directory, folder.path), true);
    await mkdir(folder.path, { recursive: true });
    path = (await resolveWorkspacePath(folder.path, folder.name === "." ? name : name.slice(folder.name.length + 1))).path;
  } else throw Object.assign(new Error("媒体输出不在本次任务许可内"), { status: 403 });
  if (session.files.some(file => file.path === path) || session.uploaded.has(name) || session.active.has(name)) throw new Error("媒体输出不能覆盖输入或重复提交");
  const size = Number(req.query.size);
  const digest = String(req.query.sha256);
  if (!Number.isSafeInteger(size) || size < 0 || size > transferFileMaxBytes || !/^[a-f0-9]{64}$/.test(digest)
    || session.uploadedBytes + size > transferBatchMaxBytes || session.uploaded.size + session.active.size >= fileBatchLimit)
    throw Object.assign(new Error("媒体输出超过传输限制或摘要无效"), { status: 413 });
  const release = lockWorkspaceFiles([path]);
  session.active.add(name);
  session.uploadedBytes += size;
  const temporary = resolve(dirname(path), `.helper${crypto.randomUUID().replaceAll("-", "")}.part`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);
  try {
    const signal = AbortSignal.any([session.signal, controller.signal]);
    const hash = createHash("sha256");
    let received = 0;
    await pipeline(req, new Transform({ transform(chunk, _encoding, done) {
      received += chunk.length;
      hash.update(chunk);
      done(received > size ? new Error("媒体上传超过声明大小") : null, chunk);
    } }), createWriteStream(temporary, { flags: "wx" }), { signal });
    if (received !== size || hash.digest("hex") !== digest) throw new Error("媒体上传不完整或摘要不一致");
    await mediaSession(req);
    await checkInputs(session);
    signal.throwIfAborted();
    await resolveWorkspacePath(dirname(path), basename(path));
    await link(temporary, path);
    session.uploaded.add(name);
    notifyFileChange(session.request.directory, path);
  } finally {
    req.off("aborted", abort);
    res.off("close", abort);
    session.active.delete(name);
    release();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function mediaEvent(req: Request) {
  const session = await mediaSession(req);
  const event = req.body.event as FfmpegRemoteEvent;
  if (["progress", "start", "codecData", "filenames"].includes(event.event)) session.emit(event);
}
