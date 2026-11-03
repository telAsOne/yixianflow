import { Router } from "express";
import { mkdir, readdir, realpath } from "@toonflow/file";
import { dirname, relative, resolve, sep } from "node:path";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { isWebMode } from "@/lib/webContext";

const router = Router();

export default router.get("/", validateFields({ path: z.string().max(4096).optional() }, "query"), async (req, res) => {
  if (isWebMode()) {
    const projects = await u.webProjects.listWebProjects();
    const selected = projects.find(project => project.id === req.query.path);
    if (req.query.path && !selected) return void res.status(404).json(error("项目不存在或无权访问", null, 404));
    return void res.set("Cache-Control", "no-store").json(success({ path: "", absolutePath: selected?.id ?? "", name: selected?.name,
      parent: null, entries: projects.map(project => ({ name: project.name, path: project.id, type: "directory" })) }));
  }
  const workspaceRoot = resolve(dirname(u.conf.path), "workspaces");
  await mkdir(workspaceRoot, { recursive: true });
  const root = await realpath(workspaceRoot);
  const target = resolve(root, (req.query.path as string | undefined) ?? "");
  if (!u.workspaceFile.isWithin(root, target)) return res.status(403).json(error("只能选择服务器工作区内的目录", null, 403));
  try {
    const directory = await realpath(target);
    if (!u.workspaceFile.isWithin(root, directory)) return res.status(403).json(error("只能选择服务器工作区内的目录", null, 403));
    const entries = await readdir(directory, { withFileTypes: true });
    const path = relative(root, directory).split(sep).join("/");
    res.set("Cache-Control", "no-store").json(success({
      path,
      absolutePath: directory,
      parent: path ? relative(root, dirname(directory)).split(sep).join("/") : null,
      directories: entries.filter(entry => entry.isDirectory()).map(entry => ({ name: entry.name, path: [path, entry.name].filter(Boolean).join("/") }))
        .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true })),
    }));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return res.status(404).json(error("目录不存在", null, 404));
    if (code === "EACCES" || code === "EPERM") return res.status(403).json(error("没有权限访问此目录", null, 403));
    throw err;
  }
});
