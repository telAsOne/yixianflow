import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream, link, lstat, open, unlink } from "@toonflow/file";
import { z } from "zod";
import { fileTransferRequest, transferBatchMaxBytes, transferFileMaxBytes, type LocalComputerRequest } from "./protocol";
import { fileRevision, localPath } from "./operations";
import { deviceRequest } from "./connection";

export async function remoteFiles(request: Extract<LocalComputerRequest, { action: "projects" | "upload" | "download" }>, server: URL, token: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (request.action === "projects") return deviceRequest(server, token, "projects", undefined, signal, "GET");
  const files: { path: string; target: string; size?: number; revision?: string }[] = [];
  let total = 0;
  const targets = new Set<string>();
  for (const file of request.files) {
    signal.throwIfAborted();
    const path = await localPath(request.action === "upload" ? file.path : file.target, request.action === "download");
    if (request.action === "download") {
      if (targets.has(path.toLowerCase())) throw new Error("同一批次不能包含重复目标文件");
      targets.add(path.toLowerCase());
      const exists = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
      if (exists) throw new Error(`目标已存在，不会覆盖：${file.target}`);
      files.push({ ...file, target: path });
      continue;
    }
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`只能上传普通文件：${file.path}`);
    total += info.size;
    if (info.size > transferFileMaxBytes || total > transferBatchMaxBytes) throw new Error("传输超过大小限制：单文件 100 MiB，整批 200 MiB");
    files.push({ ...file, path, size: info.size, revision: fileRevision(info) });
  }
  const input = fileTransferRequest.parse({ ...request, files: files.map(({ path, target, ...file }) => ({ path, target, ...("size" in file ? { size: file.size } : {}) })) });
  const plan = z.strictObject({ id: z.uuid(), files: z.array(z.strictObject({ path: z.string(), target: z.string(), size: z.number().int().min(0).max(transferFileMaxBytes) })).min(1).max(20) })
    .parse(await deviceRequest(server, token, "transfer", input, signal));
  if (plan.files.length !== files.length || plan.files.some((file, index) => file.path !== files[index].path || file.target !== files[index].target)
    || plan.files.reduce((sum, file) => sum + file.size, 0) > transferBatchMaxBytes) throw new Error("平台返回的传输清单与本次操作不一致");
  const results: { path: string; target: string; ok: boolean; size?: number; error?: string }[] = [];
  try {
    for (let index = 0; index < files.length; index++) {
      if (signal.aborted) break;
      const file = plan.files[index];
      const url = new URL(`api/localHelper/device/${request.action}`, server);
      url.search = new URLSearchParams({ id: plan.id, index: String(index) }).toString();
      try {
        if (request.action === "upload") {
          const handle = await open(file.path, "r");
          let stream: ReturnType<typeof handle.createReadStream> | undefined;
          try {
            const info = await handle.stat();
            const original = files[index];
            if (!info.isFile() || fileRevision(info) !== original.revision || info.size !== file.size) throw new Error("源文件已变化，请重新发起上传");
            stream = handle.createReadStream({ autoClose: false, start: 0, ...(file.size ? { end: file.size - 1 } : {}) });
            const response = await fetch(url, { method: "POST", redirect: "error", signal,
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", "Content-Length": String(file.size) },
              body: Readable.toWeb(stream) as ReadableStream<Uint8Array> });
            const result = await response.json() as { code?: number; message?: string };
            if (!response.ok || result.code !== 200) throw new Error(result.message || `上传失败（HTTP ${response.status}）`);
            if (fileRevision(await handle.stat()) !== original.revision) throw new Error("上传期间源文件已变化，请核对服务器文件，未自动重传");
          } finally { stream?.destroy(); await handle.close(); }
        } else {
          const temp = join(dirname(file.target), `.helper${randomUUID()}.part`);
          try {
            const response = await fetch(url, { redirect: "error", headers: { Authorization: `Bearer ${token}` }, signal });
            if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`下载失败（HTTP ${response.status}）`); }
            let bytes = 0;
            await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
              bytes += chunk.length;
              done(bytes > file.size ? new Error("下载内容超过本次允许的大小") : null, chunk);
            } }), createWriteStream(temp, { flags: "wx" }), { signal });
            if (bytes !== file.size) throw new Error("下载不完整，未保存目标文件");
            signal.throwIfAborted();
            await link(temp, file.target);
          } finally {
            await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
          }
        }
        results.push({ path: file.path, target: file.target, size: file.size, ok: true });
      } catch (error) {
        results.push({ path: file.path, target: file.target, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    await deviceRequest(server, token, "finishTransfer", { id: plan.id }, AbortSignal.timeout(10000)).catch(() => {});
  }
  return { files: results, completed: results.filter(file => file.ok).length, failed: results.filter(file => !file.ok).length,
    remaining: files.length - results.length, cancelled: signal.aborted };
}
