import { randomUUID } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { mkdir, realpath, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import conf from "@/utils/conf";
import { canViewAllWebProjects, requireWebAccount } from "@/lib/webContext";
import { credentialSchema, getBaseUrl } from "@/utils/account";
import { decryptWebSecret, getWebDatabase } from "./store";

export async function listWebProjects(all = false) {
  const userId = requireWebAccount().user.id;
  if (all && !canViewAllWebProjects()) throw Object.assign(new Error("仅管理员可以查看其他人员的项目"), { status: 403 });
  const sql = getWebDatabase();
  const projects: { id: string; ownerId: number; name: string; lastOpenedAt: Date }[] = await sql`SELECT id, "ownerId", name, "lastOpenedAt" FROM yixianflow.projects
    WHERE (${all} OR "ownerId" = ${userId}) ORDER BY "lastOpenedAt" DESC, id`;
  const ownerNames = new Map<number, string>();
  if (all && projects.length) {
    const baseUrl = getBaseUrl();
    const owners: { id: number; credentials: string }[] = await sql`SELECT id, credentials FROM yixianflow.users
      WHERE id IN (SELECT "ownerId" FROM yixianflow.projects)`;
    for (const owner of owners) {
      const account = credentialSchema.parse(JSON.parse(decryptWebSecret(owner.credentials, `account:${baseUrl}:${owner.id}`)));
      if (account.user.id !== owner.id || account.baseUrl !== baseUrl) throw new Error("服务端账户凭据不匹配");
      ownerNames.set(owner.id, account.user.display_name || account.user.username);
    }
  }
  return projects.map(project => ({ ...project, directory: project.id, ownerName: ownerNames.get(project.ownerId), lastOpenedAt: new Date(project.lastOpenedAt).getTime() }));
}

export async function createWebProject(name: string) {
  const sql = getWebDatabase();
  const ownerId = requireWebAccount().user.id;
  const id = randomUUID();
  const root = resolve(dirname(conf.path), "workspaces");
  await mkdir(root, { recursive: true });
  const directory = resolve(await realpath(root), id);
  return sql.begin(async transaction => {
    await transaction`INSERT INTO yixianflow.projects (id, "ownerId", name) VALUES (${id}, ${ownerId}, ${name})`;
    await mkdir(directory);
    // ACT: 初始化失败保留已写文件供恢复，避免递归删除与外部操作并发写入的内容。
    await writeAtomic(resolve(directory, "画布1.json"), JSON.stringify({ toonflowCanvas: true, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }), { exclusive: true });
    return { id, ownerId, directory: id, name, lastOpenedAt: Date.now() };
  });
}

export async function resolveWebProject(id: string) {
  if (!z.uuid().safeParse(id).success) throw Object.assign(new Error("请选择有效的项目"), { status: 400 });
  const sql = getWebDatabase();
  const [project] = await sql`SELECT id FROM yixianflow.projects WHERE id = ${id}
    AND ("ownerId" = ${requireWebAccount().user.id} OR ${canViewAllWebProjects()})`;
  if (!project) throw Object.assign(new Error("项目不存在或无权访问"), { status: 404 });
  const root = await realpath(resolve(dirname(conf.path), "workspaces"));
  const directory = await realpath(resolve(root, project.id)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw Object.assign(new Error("项目目录不存在"), { status: 404 });
    throw error;
  });
  if (relative(root, directory) !== project.id) throw Object.assign(new Error("项目目录越界"), { status: 403 });
  return directory;
}

export async function renameWebProject(id: string, name: string) {
  const sql = getWebDatabase();
  const rows = await sql`UPDATE yixianflow.projects SET name = ${name} WHERE id = ${id} AND "ownerId" = ${requireWebAccount().user.id} RETURNING id`;
  if (!rows.length) throw Object.assign(new Error("项目不存在或无权访问"), { status: 404 });
}
