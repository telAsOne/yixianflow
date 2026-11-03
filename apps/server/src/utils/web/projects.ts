import { randomUUID } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { mkdir, realpath, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import conf from "@/utils/conf";
import { requireWebAccount } from "@/lib/webContext";
import { getWebDatabase } from "./store";

export async function listWebProjects() {
  const sql = getWebDatabase();
  const projects: { id: string; ownerId: number; name: string; lastOpenedAt: Date }[] = await sql`SELECT id, "ownerId", name, "lastOpenedAt" FROM yixianflow.projects
    WHERE "ownerId" = ${requireWebAccount().user.id} ORDER BY "lastOpenedAt" DESC, id`;
  return projects.map(project => ({ ...project, directory: project.id, lastOpenedAt: new Date(project.lastOpenedAt).getTime() }));
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
  const [project] = await sql`SELECT id FROM yixianflow.projects WHERE id = ${id} AND "ownerId" = ${requireWebAccount().user.id}`;
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
