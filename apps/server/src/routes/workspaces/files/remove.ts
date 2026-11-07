import { lstat, rm, rmdir } from "@toonflow/file";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { relative } from "node:path";
import { readdir } from "@toonflow/file";

const router = Router();

export default router.delete("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().max(4096), recursive: z.boolean().optional() }), async (req, res) => {
  const { directory, path } = await u.workspaceFile.resolveWorkspaceFile(req, req.body.directory, req.body.path);
  u.workspaceFile.protectWorkspaceRoot(directory, path);
  const release = u.workspaceFile.lockWorkspaceFiles([path]);
  try {
    const name = relative(directory, path).replaceAll("\\", "/");
    if (name === ".toonflow" || name.startsWith(".toonflow/recycleBin")) throw Object.assign(new Error("请通过项目回收站管理删除记录"), { status: 403 });
    const info = await lstat(path);
    if (info.isDirectory() && req.body.recursive !== true) await rmdir(path);
    else {
      const pending = [name];
      // 删除文件夹时，先把其中每张画布分别登记；非画布文件仍沿用文件管理器原有语义。
      if (!name.startsWith("assets/") && name !== "assets" && !name.startsWith(".toonflow/")) {
        while (pending.length) {
          const current = pending.pop()!;
          const target = await u.workspaceFile.resolveWorkspacePath(directory, current);
          const entry = await lstat(target.path);
          if (entry.isDirectory()) {
            for (const child of await readdir(target.path)) pending.push(`${current}/${child}`);
          } else if (entry.isFile() && /\.json$/i.test(current)) await u.recycleBin.recycleCanvasFile(directory, current);
        }
      }
      await rm(path, { recursive: req.body.recursive === true, force: true });
    }
  } finally { release(); }
  u.canvasSync.notifyFileChange(directory, path);
  res.json(success());
});
