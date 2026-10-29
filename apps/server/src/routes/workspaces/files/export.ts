import { lstat, open, opendir, realpath, type Stats } from "@toonflow/file";
import { Router } from "express";
import { Zip, ZipDeflate } from "fflate";
import { once } from "node:events";
import { basename, join } from "node:path";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";

const router = Router();
const maxBytes = 1024 * 1024 * 1024;

export default router.get("/", validateFields({ directory: z.string().min(1).max(4096) }, "query"), async (req, res) => {
  const controller = new AbortController();
  const { signal } = controller;
  const close = () => controller.abort(new Error("项目导出已取消"));
  res.once("close", close);
  req.once("aborted", close);
  let archive: Zip | undefined;
  try {
    if (req.aborted || res.destroyed) close();
    signal.throwIfAborted();
    const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
    const entries: { path: string; name: string; info: Stats }[] = [];
    const pending = [{ path: directory, prefix: "" }];
    let totalBytes = 0;
    while (pending.length) {
      signal.throwIfAborted();
      const current = pending.pop()!;
      for await (const child of await opendir(current.path)) {
        signal.throwIfAborted();
        if (entries.length >= 10000) throw Object.assign(new Error("项目导出最多包含 10000 个文件和目录"), { status: 413 });
        if (/[\\:]/.test(child.name)) throw Object.assign(new Error("项目包含无法安全导出为 ZIP 的文件名"), { status: 400 });
        const path = join(current.path, child.name);
        const name = current.prefix + child.name;
        const info = await lstat(path);
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
          throw Object.assign(new Error("项目不能包含符号链接或特殊文件"), { status: 400 });
        }
        const actualPath = await realpath(path);
        if (!u.workspaceFile.isWithin(directory, actualPath)) throw Object.assign(new Error("项目文件超出工作区范围"), { status: 403 });
        entries.push({ path: actualPath, name: info.isDirectory() ? `${name}/` : name, info });
        if (info.isDirectory()) pending.push({ path: actualPath, prefix: `${name}/` });
        else totalBytes += info.size;
        if (totalBytes > maxBytes) throw Object.assign(new Error("项目文件总大小不能超过 1 GB"), { status: 413 });
      }
    }

    let writtenBytes = 0;
    let readBytes = 0;
    let archiveError: Error | undefined;
    // ACT: 服务端每次读取 64 KiB 并等待响应排空；最多收集 10000 项元数据，客户端保存仍受 1 GB Blob 上限约束。
    archive = new Zip((error, chunk, final) => {
      if (error) { archiveError = error; return; }
      if (signal.aborted || archiveError) return;
      writtenBytes += chunk.length;
      if (writtenBytes > maxBytes) {
        archiveError = Object.assign(new Error("项目 ZIP 文件不能超过 1 GB"), { status: 413 });
        return;
      }
      res.write(chunk);
      if (final) res.end();
    });
    async function drain() {
      signal.throwIfAborted();
      if (archiveError) throw archiveError;
      if (res.writableNeedDrain) await once(res, "drain", { signal });
    }
    res.set("Cache-Control", "no-store").type("application/zip").attachment(`${basename(directory) || "项目"}.zip`);
    for (const entry of entries) {
      signal.throwIfAborted();
      if (entry.info.isDirectory()) {
        const folder = new ZipDeflate(entry.name, { level: 0 });
        archive.add(folder);
        folder.push(new Uint8Array(), true);
        await drain();
        continue;
      }
      const { path } = await u.workspaceFile.resolveWorkspacePath(directory, entry.name);
      const file = await open(path, "r");
      try {
        const current = await file.stat();
        const expected = entry.info;
        if (!current.isFile() || current.dev !== expected.dev || current.ino !== expected.ino
          || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs) {
          throw Object.assign(new Error("项目文件在导出期间发生变化，请重试"), { status: 409 });
        }
        const output = new ZipDeflate(entry.name, { level: 1 });
        archive.add(output);
        await drain();
        let fileBytes = 0;
        for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024, signal })) {
          readBytes += chunk.length;
          fileBytes += chunk.length;
          if (readBytes > maxBytes) throw Object.assign(new Error("项目文件总大小不能超过 1 GB"), { status: 413 });
          output.push(chunk, false);
          await drain();
        }
        const after = await file.stat();
        if (fileBytes !== expected.size || after.size !== expected.size || after.mtimeMs !== expected.mtimeMs) {
          throw Object.assign(new Error("项目文件在导出期间发生变化，请重试"), { status: 409 });
        }
        output.push(new Uint8Array(), true);
        await drain();
      } finally { await file.close(); }
    }
    signal.throwIfAborted();
    archive.end();
    if (archiveError) throw archiveError;
  } finally {
    archive?.terminate();
    res.off("close", close);
    req.off("aborted", close);
  }
});
