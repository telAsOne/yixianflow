import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import { createReadStream, createWriteStream, link, lstat, unlink } from "@toonflow/file";
import { fileTransferRequest, transferBatchMaxBytes, transferFileMaxBytes } from "@toonflow/local-helper/protocol";
import { requireReadyDevice } from "./index";
import { readWebAccount } from "@/utils/web/auth";
import { webContext } from "@/lib/webContext";
import { listWebProjects, resolveWebProject } from "@/utils/web/projects";
import { lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";
import { notifyFileChange } from "@/utils/workspace/canvasSync";

type TransferFile = { path: string; target: string; size: number; revision?: string };
type Transfer = { deviceId: string; ownerId: number; projectId: string; action: "upload" | "download";
  files: TransferFile[]; expiresAt: number; active: Set<number>; completed: Set<number> };
// ACT: 单进程内短期传输许可，不持久化文件正文；重启或 15 分钟后失效，不自动重放上传。
const transfers = new Map<string, Transfer>();

async function withDeviceAccount<T>(req: Request, operation: (device: Awaited<ReturnType<typeof requireReadyDevice>>) => Promise<T>) {
  const device = await requireReadyDevice(req);
  const account = await readWebAccount(device.ownerId, req.app.locals.appVersion || process.env.appVersion || "2.0.0");
  if (!account) throw Object.assign(new Error("账户已失效，请在网页重新登录"), { status: 401 });
  return webContext.run({ sessionHash: "", ...account }, () => operation(device));
}

function fileRevision(info: Awaited<ReturnType<typeof lstat>>) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

export function deviceProjects(req: Request) {
  return withDeviceAccount(req, () => listWebProjects());
}

export function prepareTransfer(req: Request) {
  const request = fileTransferRequest.parse(req.body);
  return withDeviceAccount(req, async device => {
    for (const [id, transfer] of transfers) if (transfer.expiresAt <= Date.now() && !transfer.active.size) transfers.delete(id);
    for (const [id, transfer] of transfers) {
      if (transfer.deviceId !== device.id) continue;
      if (transfer.active.size) throw Object.assign(new Error("本机已有文件正在传输"), { status: 409 });
      transfers.delete(id);
    }
    if (transfers.size >= 1000) throw Object.assign(new Error("文件传输繁忙，请稍后重试"), { status: 429 });
    const directory = await resolveWebProject(request.projectId);
    const files: TransferFile[] = [];
    const targets = new Set<string>();
    let total = 0;
    for (const file of request.files) {
      const targetKey = request.action === "download" ? file.target.toLowerCase().replaceAll("/", "\\") : file.target.replaceAll("\\", "/");
      if (targets.has(targetKey)) throw Object.assign(new Error("同一批次不能包含重复目标文件"), { status: 400 });
      targets.add(targetKey);
      const target = await resolveWorkspacePath(directory, request.action === "upload" ? file.target : file.path);
      const info = await lstat(target.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
      if (request.action === "upload" && info) throw Object.assign(new Error(`目标已存在，不会覆盖：${file.target}`), { status: 409 });
      if (request.action === "download" && !info?.isFile()) throw Object.assign(new Error(`只能下载普通文件：${file.path}`), { status: 400 });
      const size = request.action === "upload" ? request.files[files.length].size : info!.size;
      total += size;
      if (size > transferFileMaxBytes || total > transferBatchMaxBytes) throw Object.assign(new Error("传输超过大小限制：单文件 100 MiB，整批 200 MiB"), { status: 413 });
      files.push({ path: file.path, target: file.target, size, ...(info ? { revision: fileRevision(info) } : {}) });
    }
    const id = randomUUID();
    transfers.set(id, { deviceId: device.id, ownerId: device.ownerId, projectId: request.projectId, action: request.action,
      files, expiresAt: Date.now() + 15 * 60000, active: new Set(), completed: new Set() });
    return { id, files: files.map(({ revision, ...file }) => file) };
  });
}

async function withTransfer(req: Request, action: "upload" | "download", operation: (transfer: Transfer, file: TransferFile, index: number, path: string, directory: string) => Promise<void>) {
  return withDeviceAccount(req, async device => {
    const id = String(req.query.id);
    const index = Number(req.query.index);
    const transfer = transfers.get(id);
    if (!transfer || transfer.deviceId !== device.id || transfer.ownerId !== device.ownerId || transfer.action !== action || transfer.expiresAt <= Date.now())
      throw Object.assign(new Error("文件传输许可已失效，请核对已完成项后重新发起"), { status: 409 });
    const file = transfer.files[index];
    if (!file || transfer.completed.has(index) || transfer.active.size) throw Object.assign(new Error("文件已处理或正在传输，不能重复提交"), { status: 409 });
    transfer.active.add(index);
    try {
      const directory = await resolveWebProject(transfer.projectId);
      const target = await resolveWorkspacePath(directory, action === "upload" ? file.target : file.path);
      const release = lockWorkspaceFiles([target.path]);
      try { await operation(transfer, file, index, target.path, directory); }
      finally { release(); }
    } finally { transfer.active.delete(index); }
  });
}

export function uploadFile(req: Request) {
  if (!req.is("application/octet-stream")) throw Object.assign(new Error("请发送原始文件内容"), { status: 415 });
  return withTransfer(req, "upload", async (transfer, file, index, path, directory) => {
    if (req.get("content-length") !== String(file.size)) throw Object.assign(new Error("文件大小与预检不一致"), { status: 413 });
    const temp = join(dirname(path), `.helper${randomUUID()}.part`);
    let bytes = 0;
    try {
      await pipeline(req, new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.length;
        done(bytes > file.size ? new Error("上传内容超过本次允许的大小") : null, chunk);
      } }), createWriteStream(temp, { flags: "wx", mode: 0o600 }), { signal: AbortSignal.timeout(Math.max(1, transfer.expiresAt - Date.now())) });
      if (bytes !== file.size) throw new Error("文件传输不完整，未保存目标文件");
      await requireReadyDevice(req);
      await link(temp, path);
      transfer.completed.add(index);
      notifyFileChange(directory, path);
    } finally {
      await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
    return;
  });
}

export function downloadFile(req: Request, res: Response) {
  return withTransfer(req, "download", async (transfer, file, index, path) => {
    const info = await lstat(path);
    if (!info.isFile() || fileRevision(info) !== file.revision) throw Object.assign(new Error("源文件已变化，请重新发起下载"), { status: 409 });
    res.set({ "Content-Type": "application/octet-stream", "Content-Length": String(file.size), "Cache-Control": "no-store" });
    await pipeline(createReadStream(path, { start: 0, end: Math.max(0, file.size - 1) }), res,
      { signal: AbortSignal.timeout(Math.max(1, transfer.expiresAt - Date.now())) });
    transfer.completed.add(index);
  });
}

export async function finishTransfer(req: Request, id: string) {
  const device = await requireReadyDevice(req);
  const transfer = transfers.get(id);
  if (!transfer || transfer.deviceId !== device.id || transfer.ownerId !== device.ownerId) return;
  if (transfer.active.size) throw Object.assign(new Error("文件仍在传输中"), { status: 409 });
  transfers.delete(id);
}
