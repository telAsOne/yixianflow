import { constants, copyFile, cp, lstat, mkdir, opendir, rename, unlink, realpath, writeAtomic } from "@/utils/media/objectFiles";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Request } from "express";
import { resolveWorkspace } from "@/utils/workspace";
import { mentionAssetType } from "@/agent/mentionSources";
import { createHash } from "node:crypto";
import conf from "@/utils/conf";
import { isWebMode, requireWebAccount } from "@/lib/webContext";
import { getWebDatabase } from "@/utils/web/store";
import { requireProjectAgentRead } from "@/utils/web/projects";

export function getAgentDirectory(directory: string) {
  if (!isWebMode()) return resolve(directory, ".agent");
  return getProjectAgentDirectory(directory, requireWebAccount().user.id);
}

export function getProjectAgentDirectory(directory: string, userId: number) {
  const key = createHash("sha256").update(process.platform === "win32" ? directory.toLowerCase() : directory).digest("hex");
  return resolve(dirname(conf.path), "users", String(userId), "projectAgents", key);
}

const agentDirectories = new Map<string, Promise<void>>();
async function prepareAgentDirectory(directory: string) {
  const target = getAgentDirectory(directory);
  let pending = agentDirectories.get(directory);
  if (!pending) {
    pending = (async () => {
      const [project] = await getWebDatabase()`SELECT "ownerId" FROM yixianflow.projects WHERE id::text = ${basename(directory)}`;
      if (project) {
        const ownerRoot = getProjectAgentDirectory(directory, project.ownerId);
        await mkdir(dirname(ownerRoot), { recursive: true });
        for (const [source, destination] of [[resolve(directory, ".agent"), ownerRoot], [resolve(directory, ".toonflow/recovery"), resolve(ownerRoot, "recovery")]]) {
          const legacy = await lstat(source).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
          if (!legacy?.isDirectory() || legacy.isSymbolicLink()) continue;
          const exists = await lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
          await mkdir(dirname(destination), { recursive: true });
          await rename(source, exists ? resolve(ownerRoot, `legacy${crypto.randomUUID().replaceAll("-", "")}`) : destination);
        }
      }
    })();
    agentDirectories.set(directory, pending);
    pending.catch(() => { agentDirectories.delete(directory); });
  }
  await pending;
  await mkdir(target, { recursive: true });
  return target;
}

export async function getWorkspaceUsage(directory: string, signal?: AbortSignal) {
  const usage = { totalBytes: 0, fileCount: 0, assetBytes: 0, assetCount: 0 };
  const folders = [""];
  // ACT: 逐文件读取元数据，耗时随项目文件数增长；后续配额可改用写入时维护的用量索引。
  while (folders.length) {
    signal?.throwIfAborted();
    const folder = await resolveWorkspacePath(directory, folders.pop()!);
    for await (const entry of await opendir(folder.path)) {
      signal?.throwIfAborted();
      if (!entry.isFile() && !entry.isDirectory()) continue;
      const path = relative(directory, resolve(folder.path, entry.name));
      const target = await resolveWorkspacePath(directory, path);
      const info = await lstat(target.path);
      if (info.isDirectory()) { folders.push(path); continue; }
      if (!info.isFile()) continue;
      usage.totalBytes += info.size;
      usage.fileCount++;
      if (path.split(sep)[0]?.toLowerCase() === "assets" || ["IMAGE", "VIDEO", "AUDIO"].includes(mentionAssetType(entry.name).dataType)) {
        usage.assetBytes += info.size;
        usage.assetCount++;
      }
    }
  }
  const recycleDirectory = await resolveWorkspacePath(directory, ".toonflow/recycleBin", true);
  if (!(await lstat(recycleDirectory.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }))) {
    return { ...usage, recycleBytes: 0, reclaimableBytes: 0 };
  }
  const { getRecycleOverview } = await import("./recycleBin");
  const recycled = await getRecycleOverview(directory, false);
  return { ...usage, recycleBytes: recycled.assetBytes, reclaimableBytes: recycled.reclaimableBytes };
}

export async function writeWorkspaceFile(path: string, content: string | Uint8Array, exclusive = false) {
  await writeAtomic(path, content, { exclusive });
}

export async function copyWorkspaceFile(source: string, target: string) {
  const info = await lstat(source);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw Object.assign(new Error("只能复制普通文件或文件夹"), { status: 403 });
  if (!info.isDirectory()) return copyFile(source, target, constants.COPYFILE_EXCL);
  if (isWithin(source, target)) throw Object.assign(new Error("不能把文件夹复制到自身或子目录"), { status: 400 });
  await mkdir(target);
  try {
    await cp(source, target, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      async filter(path) {
        const entry = await lstat(path);
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()) || !isWithin(source, await realpath(path))) {
          throw new Error("不能复制包含符号链接或特殊文件的文件夹");
        }
        return true;
      },
    });
  } catch (cause) {
    // ACT: 失败保留已复制内容，不递归回滚删除可能被外部加入文件的目标目录。
    throw Object.assign(new Error(`复制未完成，已复制的内容保留在 ${target}。${cause instanceof Error ? cause.message : "请检查文件权限后重试"}`, { cause }), { code: "ECOPYINCOMPLETE" });
  }
}

export async function renameWorkspaceFile(source: string, target: string) {
  const info = await lstat(source);
  if (source === target || (process.platform === "win32" && source.toLowerCase() === target.toLowerCase())) {
    if (source !== target) await rename(source, target);
    return;
  }
  if (info.isDirectory()) {
    const exists = await lstat(target).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return null; throw err; });
    if (exists) throw Object.assign(new Error("已存在同名文件或目录"), { code: "EEXIST" });
    await rename(source, target);
    return;
  }
  await copyFile(source, target, constants.COPYFILE_EXCL);
  // ACT: 目标完整写入后才移除源文件；移除失败只回滚本次目标。
  try { await unlink(source); }
  catch (err) {
    await unlink(target).catch(error => console.warn(`重命名回滚失败：${target}`, error));
    throw err;
  }
}

export function isWithin(root: string, path: string) {
  const offset = relative(root, path);
  return offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

export async function resolveWorkspaceFile(req: Request, directory: string, path: string) {
  const root = await resolveWorkspace(req, directory);
  return resolveWorkspacePath(root, path);
}

export async function resolveAgentRead(req: Request, directory: string, path: string, userId?: number) {
  const cwd = await resolveWorkspace(req, directory);
  if (userId === undefined) return resolveWorkspacePath(cwd, `.agent/${path}`);
  if (!isWebMode()) throw Object.assign(new Error("仅网页版支持查看成员对话"), { status: 400 });
  await requireProjectAgentRead(directory, userId);
  const target = await resolveWorkspacePath(getProjectAgentDirectory(cwd, userId), path);
  return { directory: cwd, path: target.path };
}

export async function resolveWorkspacePath(root: string, path: string, allowMissingParents = false): Promise<{ directory: string; path: string }> {
  if (isAbsolute(path) || path.split(/[\\/]/).some(part => part === ".." || /[<>:"|?*\x00-\x1f]/.test(part)
    || (process.platform === "win32" && part !== "." && (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))))) {
    throw Object.assign(new Error("文件路径无效"), { status: 400 });
  }
  const normalizedPath = path.replaceAll("\\", "/").split("/").filter(part => part && part !== ".").join("/");
  if (isWebMode() && /^(?:\.agent|\.toonflow\/recovery)(?:\/|$)/.test(normalizedPath)) {
    const privateRoot = await prepareAgentDirectory(root);
    const scopedPath = normalizedPath.startsWith(".agent") ? normalizedPath.slice(6).replace(/^\//, "") : normalizedPath.slice(10);
    const resolved = await resolveWorkspacePath(privateRoot, scopedPath || ".", allowMissingParents);
    return { directory: root, path: resolved.path };
  }
  const target = resolve(root, path);
  const info = await lstat(target).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return null; throw err; });
  if (info?.isSymbolicLink()) throw Object.assign(new Error("不能通过符号链接操作文件"), { status: 403 });
  let parent = dirname(target);
  if (!info && allowMissingParents) {
    while (!(await lstat(parent).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return null; throw err; }))) parent = dirname(parent);
  }
  const actual = info ? await realpath(target) : resolve(await realpath(parent), relative(parent, target));
  if (!isWithin(root, actual)) throw Object.assign(new Error("只能操作当前工作区内的文件"), { status: 403 });
  return { directory: root, path: actual };
}

// ACT: 桌面和独立 Server 均为单进程；锁防止并发文件操作互相覆盖。
const busyFiles = new Set<string>();
export function lockWorkspaceFiles(paths: string[]) {
  const keys = paths.map(path => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
  if (keys.some(path => [...busyFiles].some(busy => isWithin(path, busy) || isWithin(busy, path)))) {
    throw Object.assign(new Error("文件正在使用，请等待操作完成"), { status: 409, code: "EBUSY" });
  }
  keys.forEach(path => busyFiles.add(path));
  return () => keys.forEach(path => busyFiles.delete(path));
}

export function protectWorkspaceRoot(directory: string, path: string) {
  if (directory === path) throw Object.assign(new Error("不能修改工作区根目录"), { status: 400 });
  const name = relative(directory, path).replaceAll("\\", "/").toLowerCase();
  if (name === ".toonflow" || name === ".toonflow/recyclebin" || name.startsWith(".toonflow/recyclebin/")) {
    throw Object.assign(new Error("请通过项目回收站管理删除记录"), { status: 403 });
  }
}
