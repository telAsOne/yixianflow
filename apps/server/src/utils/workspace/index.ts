import type { Request } from "express";
import { realpath, stat } from "@toonflow/file";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import conf from "@/utils/conf";
import { getMobileLinkConfig, isMobileLinkRequest } from "@/utils/mobileLink";
import { isLocalSocket, isLocalHost, isSameOrigin } from "@/lib/desktop";
import { isWebMode } from "@/lib/webContext";
import { resolveWebProject } from "@/utils/web/projects";

export function isLocalWorkspaceRequest(req: Request) {
  if (isWebMode()) return false;
  if (isMobileLinkRequest(req)) return false;
  return isLocalSocket(req) && req.get("x-toonflow-local-client") !== "0" && isLocalHost(req)
    && isSameOrigin(req) && req.get("x-toonflow-workspace") === "1";
}

export async function resolveWorkspace(req: Request, path: string) {
  if (isWebMode()) return resolveWebProject(path);
  if (!isAbsolute(path)) throw Object.assign(new Error("工作目录必须是绝对路径"), { status: 400 });
  const directory = await realpath(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") throw Object.assign(new Error("工作目录不存在，请重新选择文件夹"), { status: 404 });
    throw err;
  });
  if (!(await stat(directory)).isDirectory()) throw Object.assign(new Error("工作目录不是文件夹，请重新选择"), { status: 404 });
  const localWorkspace = ["win32", "darwin"].includes(process.platform) && (process.env.NODE_ENV === "dev" || process.env.toonflowDesktop === "1");
  if (localWorkspace && isLocalWorkspaceRequest(req)) return directory;

  if (isMobileLinkRequest(req)) {
    for (const root of getMobileLinkConfig().directories) {
      const offset = relative(root, directory);
      if (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)) return directory;
    }
  }

  const root = await realpath(resolve(dirname(conf.path), "workspaces")).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (root) {
    const offset = relative(root, directory);
    if (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)) return directory;
  }
  throw Object.assign(new Error("服务器部署只能使用服务器工作区"), { status: 403 });
}
