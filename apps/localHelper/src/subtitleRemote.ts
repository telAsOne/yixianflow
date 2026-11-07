import { createHash } from "node:crypto";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream, link, lstat, mkdir, unlink } from "@toonflow/file";
import { dataDirectory } from "./logger";
import type { LocalHelperRequest } from "./protocol";

export async function receiveSubtitleInput(request: Extract<LocalHelperRequest, { action: "subtitleTranscribe" }>, server: URL, token: string, signal: AbortSignal) {
  const directory = join(dataDirectory, "subtitleTasks", request.operationId);
  await mkdir(directory, { recursive: true });
  const target = join(directory, request.fileName);
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
  if (existing) {
    const hash = createHash("sha256");
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== request.size) throw new Error("已有画布字幕素材与本次请求不一致");
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    if (hash.digest("hex") !== request.sha256) throw new Error("已缓存画布素材的摘要不匹配，未覆盖原文件");
    return target;
  }
  const partial = join(directory, `input${crypto.randomUUID()}.part`);
  try {
    const url = new URL("api/localHelper/device/subtitleInput", server);
    url.searchParams.set("operationId", request.operationId);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "x-subtitle-token": request.token }, redirect: "error", signal });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`画布字幕素材下载失败（HTTP ${response.status}）`); }
    const hash = createHash("sha256");
    let bytes = 0;
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length; hash.update(chunk); done(bytes > request.size ? new Error("画布素材超过声明大小") : null, chunk);
    } }), createWriteStream(partial, { flags: "wx" }), { signal });
    if (bytes !== request.size || hash.digest("hex") !== request.sha256) throw new Error("画布素材大小或摘要不匹配");
    signal.throwIfAborted(); await link(partial, target); return target;
  } finally {
    await unlink(partial).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}
