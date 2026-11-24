import { randomUUID } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { mkdir, realpath, writeAtomic } from "@/utils/media/objectFiles";
import { z } from "zod";
import conf from "@/utils/conf";
import { canViewAllWebProjects, requireWebAccount } from "@/lib/webContext";
import { credentialSchema, getBaseUrl } from "@/utils/account";
import { decryptWebSecret, getWebDatabase } from "./store";
import type { ProjectRole } from "@/types/collaboration";

export async function listWebProjects(all = false) {
  const userId = requireWebAccount().user.id;
  if (all && !canViewAllWebProjects()) throw Object.assign(new Error("仅管理员可以查看其他人员的项目"), { status: 403 });
  const sql = getWebDatabase();
  const account = requireWebAccount();
  const projects = await sql<{ id: string; ownerId: number; name: string; ownerName: string; role: ProjectRole; lastOpenedAt: Date }[]>`SELECT project.id, project."ownerId", project.name, project."lastOpenedAt", owner.name AS "ownerName",
    CASE WHEN project."ownerId" = ${userId} THEN 'owner' WHEN ${(account.user.role ?? 0) >= 10} THEN 'admin' ELSE member.role END AS role
    FROM yixianflow.projects AS project JOIN yixianflow.users AS owner ON owner.id = project."ownerId"
    LEFT JOIN yixianflow.projectMembers AS member ON member."projectId" = project.id AND member."userId" = ${userId}
    WHERE project."ownerId" = ${userId} OR member."userId" IS NOT NULL OR ${(account.user.role ?? 0) >= 10}
    ORDER BY project."lastOpenedAt" DESC, project.id`;
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
  return projects.map(project => ({ ...project, directory: project.id, ownerName: project.ownerName || ownerNames.get(project.ownerId), lastOpenedAt: new Date(project.lastOpenedAt).getTime() }));
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
    return { id, ownerId, directory: id, name, role: "owner", lastOpenedAt: Date.now() };
  });
}

export async function getWebProject(id: string, permission: "read" | "edit" | "manage" = "read") {
  if (!z.uuid().safeParse(id).success) throw Object.assign(new Error("请选择有效的项目"), { status: 400 });
  const sql = getWebDatabase();
  const account = requireWebAccount();
  const [project] = await sql`SELECT project.*, owner.name AS "ownerName", member.role AS "memberRole"
    FROM yixianflow.projects AS project JOIN yixianflow.users AS owner ON owner.id = project."ownerId"
    LEFT JOIN yixianflow.projectMembers AS member ON member."projectId" = project.id AND member."userId" = ${account.user.id}
    WHERE project.id = ${id}`;
  if (!project) throw Object.assign(new Error("项目不存在或无权访问"), { status: 404 });
  const role = project.ownerId === account.user.id ? "owner" : (account.user.role ?? 0) >= 10 ? "admin" : project.memberRole;
  if (!role) throw Object.assign(new Error("项目不存在或无权访问"), { status: 404 });
  if (permission === "manage" && !["owner", "admin"].includes(role) || permission === "edit" && role === "viewer")
    throw Object.assign(new Error("当前项目权限不允许此操作"), { status: 403 });
  return { ...project, role };
}

export async function resolveWebProject(id: string, permission: "read" | "edit" | "manage" = "read") {
  const project = await getWebProject(id, permission);
  const root = await realpath(resolve(dirname(conf.path), "workspaces"));
  const directory = await realpath(resolve(root, project.id)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw Object.assign(new Error("项目目录不存在"), { status: 404 });
    throw error;
  });
  if (relative(root, directory) !== project.id) throw Object.assign(new Error("项目目录越界"), { status: 403 });
  return directory;
}

export async function requireProjectAgentRead(id: string, userId: number) {
  const { user } = requireWebAccount();
  if (userId === user.id) return;
  await getWebProject(id, "manage");
  if ((user.role ?? 0) >= 10) return;
  const [account] = await getWebDatabase()`SELECT id FROM yixianflow.users WHERE id = ${userId} AND role < 10`;
  if (!account) throw Object.assign(new Error("对话不存在或无权访问"), { status: 404 });
}

export async function renameWebProject(id: string, name: string) {
  await getWebProject(id, "manage");
  const sql = getWebDatabase();
  const rows = await sql`UPDATE yixianflow.projects SET name = ${name} WHERE id = ${id} RETURNING id`;
  if (!rows.length) throw Object.assign(new Error("项目不存在或无权访问"), { status: 404 });
}
