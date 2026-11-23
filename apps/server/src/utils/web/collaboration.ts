import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import { isWebMode, requireWebAccount } from "@/lib/webContext";
import { getWebBasePath, getWebDatabase, getWebOrigin, hashWebToken } from "./store";
import { getWebProject, resolveWebProject } from "./projects";
import { publishProjectEvent } from "./projectEvents";
import type { ProjectPresence } from "@/types/collaboration";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { isDeepStrictEqual } from "node:util";

const sessions = new Map<string, Map<string, ProjectPresence & { seenAt: number }>>();
const publishedPresence = new Map<string, Map<string, ProjectPresence>>();
const pendingPresence = new Map<string, ReturnType<typeof setTimeout>>();
const removedPresence = new Map<string, Set<string>>();
const colors = ["#2563eb", "#a855f7", "#059669", "#ea580c", "#db2777", "#0891b2"];
export const presenceSchema = z.object({
  sessionId: z.uuid(), path: z.string().max(4096), panel: z.enum(["canvas", "document"]), visible: z.boolean(),
  activity: z.string().max(160), selected: z.array(z.string().min(1).max(500)).max(100), leave: z.boolean().optional(),
  cursor: z.object({ x: z.number().finite().min(-1e8).max(1e8), y: z.number().finite().min(-1e8).max(1e8) }).optional(),
  viewport: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().positive().max(100) }).optional(),
});

function expireProjectPresence(id: string) {
  const room = sessions.get(id);
  if (!room) return false;
  let changed = false;
  for (const [key, member] of room) if (Date.now() - member.seenAt > 45000) {
    room.delete(key);
    scheduleProjectPresence(id, key);
    changed = true;
  }
  if (!room.size) sessions.delete(id);
  return changed;
}

function scheduleProjectPresence(id: string, removedSession?: string) {
  if (removedSession) {
    const removed = removedPresence.get(id) ?? new Set<string>();
    removed.add(removedSession);
    removedPresence.set(id, removed);
  }
  if (pendingPresence.has(id)) return;
  // ACT: 单进程按项目合并 250ms 内的最新状态；旧页面仍接收合并后的完整快照。
  const timer = setTimeout(() => {
    expireProjectPresence(id);
    pendingPresence.delete(id);
    const members = getProjectPresence(id, true);
    const previous = publishedPresence.get(id) ?? new Map<string, ProjectPresence>();
    const current = new Map(members.map(member => [member.sessionId, member]));
    const changes = members.filter(member => !isDeepStrictEqual(previous.get(member.sessionId), member));
    const removed = [...new Set([...previous.keys(), ...(removedPresence.get(id) ?? [])])].filter(key => !current.has(key));
    removedPresence.delete(id);
    if (members.length) publishedPresence.set(id, current);
    else publishedPresence.delete(id);
    if (changes.length || removed.length) publishProjectEvent(id, { type: "presence", members, changes, removed });
  }, 250);
  timer.unref();
  pendingPresence.set(id, timer);
}

setInterval(() => {
  for (const id of sessions.keys()) if (expireProjectPresence(id)) scheduleProjectPresence(id);
}, 15000).unref();

export function getProjectPresence(id: string, includePlatform = (requireWebAccount().user.role ?? 0) >= 10) {
  if (expireProjectPresence(id)) scheduleProjectPresence(id);
  return [...(sessions.get(id)?.values() ?? [])].filter(member => includePlatform || !member.platformOnly).map(({ seenAt, ...member }) => member);
}

export function updateProjectPresence(project: { id: string; ownerId: number }, state: z.infer<typeof presenceSchema>, agent = false) {
  const { id, ownerId } = project;
  const { user } = requireWebAccount();
  const platformAdmin = (user.role ?? 0) >= 10;
  const platformOnly = platformAdmin && ownerId !== user.id;
  expireProjectPresence(id);
  const room = sessions.get(id) ?? new Map();
  const key = `${user.id}:${state.sessionId}`;
  const joined = !agent && !state.leave && !room.has(key) && ![...room.values()].some(member => member.userId === user.id);
  if (state.leave) { if (room.delete(key)) scheduleProjectPresence(id, key); }
  else {
    if (!room.has(key) && room.size >= 256) throw Object.assign(new Error("项目在线会话过多，请关闭闲置页面"), { status: 429 });
    const { leave, ...presence } = state;
    room.set(key, { ...presence, sessionId: key, userId: user.id,
      name: `${user.display_name || user.username}${agent ? "的 AI" : ""}`, color: colors[user.id % colors.length]!, admin: platformAdmin, agent, platformOnly, seenAt: Date.now() });
  }
  sessions.set(id, room);
  scheduleProjectPresence(id);
  if (joined && !platformAdmin) void recordProjectActivity(id, "进入项目", state.path).catch(() => { console.warn("[collaboration] presence activity could not be saved"); });
}

export function removeProjectPresence(id: string, userId: number) {
  const room = sessions.get(id);
  if (room) for (const [key, member] of room) if (member.userId === userId) {
    room.delete(key);
    scheduleProjectPresence(id, key);
  }
  scheduleProjectPresence(id);
}

export async function getProjectMembers(id: string) {
  const project = await getWebProject(id);
  const sql = getWebDatabase();
  const members = await sql`SELECT member."userId", account.name, member.role FROM yixianflow.projectMembers AS member
    JOIN yixianflow.users AS account ON account.id = member."userId" WHERE member."projectId" = ${id}
      AND account.role < 10 ORDER BY member."joinedAt"`;
  const invites = ["owner", "admin"].includes(project.role) ? await sql`SELECT hash AS id, role, "expiresAt" FROM yixianflow.projectInvites
    WHERE "projectId" = ${id} AND NOT revoked AND "acceptedBy" IS NULL AND "expiresAt" > CURRENT_TIMESTAMP` : [];
  return { project: { id, name: project.name, role: project.role, ownerId: project.ownerId },
    members: [{ userId: project.ownerId, name: project.ownerName || `用户 ${project.ownerId}`, role: "owner" }, ...members], invites };
}

export async function createProjectInvite(id: string, role: "editor" | "viewer") {
  await getWebProject(id, "manage");
  // 开放共享前把所有者的旧聊天迁出公共项目目录，普通文件接口也不能读取他人上下文。
  const directory = await resolveWebProject(id, "manage");
  await resolveWorkspacePath(directory, ".agent", true);
  const sql = getWebDatabase();
  const token = randomBytes(32).toString("base64url");
  const invite = await sql.begin(async transaction => {
    await transaction`SELECT id FROM yixianflow.projects WHERE id = ${id} FOR UPDATE`;
    const [count] = await transaction`SELECT count(*)::int AS total FROM yixianflow.projectInvites WHERE "projectId" = ${id}
      AND NOT revoked AND "acceptedBy" IS NULL AND "expiresAt" > CURRENT_TIMESTAMP`;
    if (count.total >= 50) throw Object.assign(new Error("有效邀请过多，请先撤销不再使用的邀请"), { status: 429 });
    const [created] = await transaction`INSERT INTO yixianflow.projectInvites (hash, "projectId", role, "createdBy")
      VALUES (${hashWebToken(token)}, ${id}, ${role}, ${requireWebAccount().user.id}) RETURNING "expiresAt"`;
    return created;
  });
  return { url: `${getWebOrigin()}${getWebBasePath()}/#/home?projectInvite=${token}`, expiresAt: invite.expiresAt };
}

export async function previewProjectInvite(token: string) {
  if ((requireWebAccount().user.role ?? 0) >= 10) throw Object.assign(new Error("UnionAIGC 管理员无需接受项目邀请，请直接从项目列表打开项目"), { status: 403 });
  const sql = getWebDatabase();
  const [invite] = await sql`SELECT project.name, owner.name AS "ownerName", invite.role FROM yixianflow.projectInvites AS invite
    JOIN yixianflow.projects AS project ON project.id = invite."projectId" JOIN yixianflow.users AS owner ON owner.id = project."ownerId"
    WHERE invite.hash = ${hashWebToken(token)} AND NOT invite.revoked AND invite."expiresAt" > CURRENT_TIMESTAMP
      AND (invite."acceptedBy" IS NULL OR invite."acceptedBy" = ${requireWebAccount().user.id})`;
  if (!invite) throw Object.assign(new Error("邀请已过期、已撤销或已被使用"), { status: 404 });
  return invite;
}

export async function acceptProjectInvite(token: string) {
  if ((requireWebAccount().user.role ?? 0) >= 10) throw Object.assign(new Error("UnionAIGC 管理员不能作为受邀成员加入项目，请直接从项目列表打开项目"), { status: 403 });
  const sql = getWebDatabase();
  const userId = requireWebAccount().user.id;
  const id = await sql.begin(async transaction => {
    const [invite] = await transaction`SELECT invite.*, project."ownerId" FROM yixianflow.projectInvites AS invite
      JOIN yixianflow.projects AS project ON project.id = invite."projectId"
      WHERE hash = ${hashWebToken(token)} AND NOT revoked AND "expiresAt" > CURRENT_TIMESTAMP FOR UPDATE OF invite`;
    if (!invite || invite.acceptedBy && invite.acceptedBy !== userId) throw Object.assign(new Error("邀请已过期、已撤销或已被使用"), { status: 404 });
    if (invite.ownerId === userId) return invite.projectId as string;
    if (invite.acceptedBy) {
      const [member] = await transaction`SELECT "userId" FROM yixianflow.projectMembers WHERE "projectId" = ${invite.projectId} AND "userId" = ${userId}`;
      if (!member) throw Object.assign(new Error("邀请已被使用，请向所有者获取新的邀请"), { status: 403 });
      return invite.projectId as string;
    }
    if (invite.ownerId !== userId) await transaction`INSERT INTO yixianflow.projectMembers ("projectId", "userId", role)
      VALUES (${invite.projectId}, ${userId}, ${invite.role}) ON CONFLICT ("projectId", "userId") DO NOTHING`;
    await transaction`UPDATE yixianflow.projectInvites SET "acceptedBy" = ${userId} WHERE hash = ${hashWebToken(token)}`;
    return invite.projectId as string;
  });
  publishProjectEvent(id, { type: "permissions" });
  return { id };
}

export async function saveProjectMember(id: string, userId: number, role?: "editor" | "viewer") {
  const project = await getWebProject(id, userId === requireWebAccount().user.id && !role ? "read" : "manage");
  if (project.ownerId === userId) throw Object.assign(new Error("不能移除或修改项目所有者"), { status: 400 });
  const sql = getWebDatabase();
  const [account] = await sql`SELECT role FROM yixianflow.users WHERE id = ${userId}`;
  if (account?.role >= 10) throw Object.assign(new Error("UnionAIGC 管理员不使用受邀成员权限"), { status: 403 });
  if (role) await sql`UPDATE yixianflow.projectMembers SET role = ${role} WHERE "projectId" = ${id} AND "userId" = ${userId}`;
  else await sql`DELETE FROM yixianflow.projectMembers WHERE "projectId" = ${id} AND "userId" = ${userId}`;
  removeProjectPresence(id, userId);
  publishProjectEvent(id, { type: "permissions" });
}

export async function revokeProjectInvite(id: string, hash: string) {
  await getWebProject(id, "manage");
  await getWebDatabase()`UPDATE yixianflow.projectInvites SET revoked = true WHERE "projectId" = ${id} AND hash = ${hash}`;
}

export async function listProjectAgentMembers(id: string) {
  const project = await getWebProject(id, "manage");
  const userId = requireWebAccount().user.id;
  const includePlatform = (requireWebAccount().user.role ?? 0) >= 10;
  return getWebDatabase()`SELECT account.id AS "userId", account.name FROM yixianflow.users AS account
    WHERE account.id IN (
      SELECT ${project.ownerId}::integer UNION SELECT ${userId}::integer
      UNION SELECT "userId" FROM yixianflow.projectMembers WHERE "projectId" = ${id}
      UNION SELECT "acceptedBy" FROM yixianflow.projectInvites WHERE "projectId" = ${id} AND "acceptedBy" IS NOT NULL
      UNION SELECT "userId" FROM yixianflow.projectActivity WHERE "projectId" = ${id}
    ) AND (${includePlatform} OR account.role < 10) ORDER BY account.name, account.id`;
}

export async function recordProjectActivity(directory: string, action: string, path = "", nodeIds: string[] = []) {
  if (!isWebMode()) return;
  const id = basename(directory);
  if (!z.uuid().safeParse(id).success) return;
  const { user } = requireWebAccount();
  const platformOnly = (user.role ?? 0) >= 10;
  const name = user.display_name || user.username;
  const [activity] = await getWebDatabase()`INSERT INTO yixianflow.projectActivity ("projectId", "userId", name, action, path, "nodeIds", "platformOnly")
    VALUES (${id}, ${user.id}, ${name}, ${action.slice(0, 300)}, ${path}, (${{ ids: nodeIds.slice(0, 100) }}::jsonb)->'ids', ${platformOnly})
    RETURNING id::text, "userId", name, action, path, "nodeIds", "createdAt", "platformOnly"`;
  publishProjectEvent(id, { type: "activity", activity });
}

export async function listProjectActivity(id: string, before?: string) {
  await getWebProject(id);
  const includePlatform = (requireWebAccount().user.role ?? 0) >= 10;
  return getWebDatabase()`SELECT activity.id::text, activity."userId", activity.name, activity.action, activity.path, activity."nodeIds", activity."createdAt", activity."platformOnly"
    FROM yixianflow.projectActivity AS activity JOIN yixianflow.users AS account ON account.id = activity."userId"
    WHERE activity."projectId" = ${id} AND (${includePlatform} OR NOT activity."platformOnly" AND account.role < 10)
      AND (${before ?? null}::bigint IS NULL OR activity.id < ${before ?? null}::bigint) ORDER BY activity.id DESC LIMIT 50`;
}
