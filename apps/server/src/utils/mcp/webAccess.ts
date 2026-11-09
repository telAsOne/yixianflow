import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Request } from "express";
import { isWebMode, requireWebAccount, webContext } from "@/lib/webContext";
import { getSettings } from "@/utils/conf";
import { readWebAccount } from "@/utils/web/auth";
import { getWebProject } from "@/utils/web/projects";
import { getWebBasePath, getWebDatabase, getWebOrigin, hashWebToken } from "@/utils/web/store";

export const scopeSchema = z.enum(["generateImage", "generateVideo", "arrangeCanvas", "runAgent", "localComputer"]);
export type WebMcpScope = z.infer<typeof scopeSchema>;
type WebMcpAccess = { id: string; userId: number; projectId: string; name: string; permission: "read" | "edit"; scopes: WebMcpScope[]; deviceId: string | null; expiresAt: Date };
const accessContext = new AsyncLocalStorage<WebMcpAccess>();
// ACT: 与现有 MCP 会话一样，运行中的调用只属于当前服务进程。
const activeCalls = new Map<string, { userId: number; controllers: Set<AbortController> }>();
const requestWindows = new Map<string, { startedAt: number; count: number }>();
let lastWindowCleanup = 0;

function limitRequests(key: string, limit: number) {
  const now = Date.now();
  if (now - lastWindowCleanup >= 60_000) {
    for (const [id, window] of requestWindows) if (now - window.startedAt >= 60_000) requestWindows.delete(id);
    lastWindowCleanup = now;
  }
  let window = requestWindows.get(key);
  if (!window || now - window.startedAt >= 60_000) {
    if (!window && requestWindows.size >= 10_000) throw Object.assign(new Error("MCP 请求过多，请稍后重试"), { status: 429, retryAfter: 60 });
    window = { startedAt: now, count: 0 };
    requestWindows.set(key, window);
  }
  if (++window.count > limit) throw Object.assign(new Error("MCP 调用过于频繁，请稍后重试"), { status: 429, retryAfter: Math.max(1, Math.ceil((60_000 - now + window.startedAt) / 1000)) });
}

export function requireWebMcpAccess() {
  const access = accessContext.getStore();
  if (!access) throw Object.assign(new Error("MCP 访问凭证无效或已过期"), { status: 401 });
  return access;
}

export function getWebMcpEndpoint() {
  return `${getWebOrigin()}${getWebBasePath()}/mcp`;
}

export function isWebMcpEnabled() {
  return (getSettings().mcp as { enabled?: unknown } | undefined)?.enabled === true;
}

export async function runWebMcpRequest(req: Request, next: () => void) {
  limitRequests(`ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`, 600);
  const token = /^Bearer (ufm_[A-Za-z0-9_-]{43})$/.exec(req.get("authorization") ?? "")?.[1];
  const sql = getWebDatabase();
  const [access] = token ? await sql<WebMcpAccess[]>`SELECT access.id, access."userId", access."projectId", access.name, access.permission, access.scopes, access."deviceId", access."expiresAt"
    FROM yixianflow.mcpAccess AS access JOIN yixianflow.users AS account ON account.id = access."userId"
    WHERE access."tokenHash" = ${hashWebToken(token)} AND NOT access.revoked AND access."expiresAt" > CURRENT_TIMESTAMP
      AND account.settings->'mcp'->'enabled' = 'true'::jsonb` : [];
  if (!access) throw Object.assign(new Error("MCP 未开启或访问凭证无效、已过期"), { status: 401 });
  limitRequests(`key:${access.id}`, 120);
  const account = await readWebAccount(access.userId, req.app.locals.appVersion || process.env.appVersion || "2.0.0");
  if (!account) throw Object.assign(new Error("MCP 所属账户不可用"), { status: 401 });
  return webContext.run({ ...account, sessionHash: `mcp:${access.id}` }, async () => {
    await getWebProject(access.projectId, access.permission);
    if (access.scopes.includes("localComputer") && access.deviceId) await sql.begin(async transaction => {
      const [current] = await transaction`SELECT id FROM yixianflow.mcpAccess WHERE id = ${access.id} AND NOT revoked AND "expiresAt" > CURRENT_TIMESTAMP FOR SHARE`;
      if (!current) throw Object.assign(new Error("MCP 授权已撤销或过期"), { status: 401 });
      await transaction`INSERT INTO yixianflow.sessions (hash, "userId", "localDeviceId", "expiresAt")
        SELECT ${`mcp:${access.id}`}, ${access.userId}, device.id, ${access.expiresAt}
        FROM yixianflow.localDevices AS device WHERE device.id = ${access.deviceId} AND device."ownerId" = ${access.userId} AND NOT device.revoked
        ON CONFLICT (hash) DO UPDATE SET "seenAt" = CURRENT_TIMESTAMP, "localDeviceId" = EXCLUDED."localDeviceId", "expiresAt" = EXCLUDED."expiresAt"`;
    });
    accessContext.run(access, next);
  });
}

export async function listWebMcpAccess() {
  const { user } = requireWebAccount();
  return getWebDatabase()`SELECT access.id, access."projectId", CASE WHEN project."ownerId" = ${user.id} OR ${(user.role ?? 0) >= 10}
    THEN project.name ELSE '无权访问的项目' END AS "projectName", access.name, access.permission, access.scopes, access."deviceId", access."createdAt", access."expiresAt"
    FROM yixianflow.mcpAccess AS access JOIN yixianflow.projects AS project ON project.id = access."projectId"
    WHERE access."userId" = ${user.id} AND NOT access.revoked AND access."expiresAt" > CURRENT_TIMESTAMP
    ORDER BY access."createdAt" DESC`;
}

export async function createWebMcpAccess(projectId: string, name: string, permission: "read" | "edit", scopes: WebMcpScope[] = [], deviceId?: string) {
  if (!isWebMode() || !isWebMcpEnabled()) throw Object.assign(new Error("请先开启 MCP"), { status: 403 });
  await getWebProject(projectId, permission);
  const userId = requireWebAccount().user.id;
  scopes = [...new Set(z.array(scopeSchema).max(5).parse(scopes))];
  if (scopes.length && permission !== "edit") throw Object.assign(new Error("扩展能力需要读取和编辑权限"), { status: 400 });
  if (scopes.includes("localComputer")) {
    const [device] = deviceId ? await getWebDatabase()`SELECT id FROM yixianflow.localDevices WHERE id = ${deviceId} AND "ownerId" = ${userId} AND NOT revoked` : [];
    if (!device) throw Object.assign(new Error("请选择自己已绑定的本机设备"), { status: 403 });
  } else if (deviceId) throw Object.assign(new Error("选择本机设备需要同时授权本机工具"), { status: 400 });
  const id = randomUUID();
  const token = `ufm_${randomBytes(32).toString("base64url")}`;
  const access = await getWebDatabase().begin(async sql => {
    await sql`SELECT id FROM yixianflow.users WHERE id = ${userId} FOR UPDATE`;
    const [count] = await sql`SELECT COUNT(*)::int AS count FROM yixianflow.mcpAccess
      WHERE "userId" = ${userId} AND NOT revoked AND "expiresAt" > CURRENT_TIMESTAMP`;
    if (count.count >= 20) throw Object.assign(new Error("最多保留 20 个有效 MCP 凭证，请先撤销不再使用的凭证"), { status: 409 });
    const [created] = await sql`INSERT INTO yixianflow.mcpAccess (id, "userId", "projectId", name, permission, scopes, "deviceId", "tokenHash")
      VALUES (${id}, ${userId}, ${projectId}, ${name}, ${permission}, ${scopes}::jsonb, ${deviceId ?? null}, ${hashWebToken(token)}) RETURNING id, "expiresAt"`;
    return created;
  });
  return { ...access, token, endpoint: getWebMcpEndpoint() };
}

export function cancelWebMcpCalls(userId: number, id?: string) {
  for (const [key, calls] of activeCalls) {
    if (calls.userId !== userId || id && key !== id) continue;
    for (const controller of calls.controllers) controller.abort(new Error("MCP 授权已撤销或关闭"));
  }
}

export async function revokeWebMcpAccess(id: string) {
  const userId = requireWebAccount().user.id;
  await getWebDatabase()`UPDATE yixianflow.mcpAccess SET revoked = true WHERE id = ${id} AND "userId" = ${userId}`;
  cancelWebMcpCalls(userId, id);
  await clearWebMcpDeviceSessions(id);
}

export async function clearWebMcpDeviceSessions(id?: string) {
  const userId = requireWebAccount().user.id;
  const sql = getWebDatabase();
  await sql`DELETE FROM yixianflow.sessions WHERE "userId" = ${userId} AND hash LIKE 'mcp:%' AND (${id ?? null}::text IS NULL OR hash = ${`mcp:${id}`})`;
  await sql`UPDATE yixianflow.localCalls SET status = 'cancelled', error = 'MCP 授权已撤销或关闭', "finishedAt" = CURRENT_TIMESTAMP
    WHERE "ownerId" = ${userId} AND "sessionHash" LIKE 'mcp:%' AND (${id ?? null}::text IS NULL OR "sessionHash" = ${`mcp:${id}`}) AND status IN ('queued', 'running')`;
}

export function assertWebMcpScope(scope: WebMcpScope) {
  const access = requireWebMcpAccess();
  if (access.permission !== "edit" || !access.scopes.includes(scope)) throw Object.assign(new Error(`此 MCP Key 未授权 ${scope}`), { status: 403 });
}

export async function runWebMcpOperation<T>(requestId: string | undefined, input: unknown, operation: () => Promise<T>) {
  if (!requestId) throw new Error("生成、智能整理、Agent 委托和本机操作必须在顶层提供唯一 UUID requestId；重试须沿用相同 requestId");
  const { id } = requireWebMcpAccess();
  const hash = createHash("sha256").update(JSON.stringify(input, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)).digest("hex");
  const sql = getWebDatabase();
  const [created] = await sql`INSERT INTO yixianflow.mcpOperations ("accessId", "requestId", hash) VALUES (${id}, ${requestId}, ${hash})
    ON CONFLICT ("accessId", "requestId") DO NOTHING RETURNING "requestId"`;
  if (!created) {
    const [previous] = await sql`SELECT hash, status, result, error FROM yixianflow.mcpOperations WHERE "accessId" = ${id} AND "requestId" = ${requestId}`;
    if (previous.hash !== hash) throw new Error("requestId 已用于其他参数，未执行本次调用");
    if (previous.status === "completed") return previous.result as T;
    if (previous.status === "failed") throw new Error(`${previous.error}；此 requestId 不会自动重跑，请先核对原任务和费用`);
    return { status: "runningOrInterrupted", requestId, message: "原操作仍在执行或已中断，不会重复发起；请核对原任务或本机结果" } as T;
  }
  try {
    limitRequests(`operation:${id}`, 12);
    const result = await operation();
    const serialized = JSON.stringify(result ?? null);
    if (Buffer.byteLength(serialized) > 1024 * 1024) throw new Error("操作已执行，但回执超过 1 MiB；请在项目中查看原结果，不要重复发起");
    await sql`UPDATE yixianflow.mcpOperations SET status = 'completed', result = ${result ?? null}::jsonb WHERE "accessId" = ${id} AND "requestId" = ${requestId}`;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`UPDATE yixianflow.mcpOperations SET status = 'failed', error = ${message.slice(0, 8000)} WHERE "accessId" = ${id} AND "requestId" = ${requestId}`;
    throw error;
  }
}

export async function runWebMcpCall<T>(signal: AbortSignal, edit: boolean, operation: (signal: AbortSignal) => Promise<T>) {
  const access = requireWebMcpAccess();
  if (edit && access.permission !== "edit") throw Object.assign(new Error("此 MCP 凭证仅允许读取"), { status: 403 });
  await getWebProject(access.projectId, edit ? "edit" : "read");
  const controller = new AbortController();
  const calls = activeCalls.get(access.id) ?? { userId: access.userId, controllers: new Set<AbortController>() };
  if (calls.controllers.size >= 2) throw Object.assign(new Error("此 MCP Key 已有 2 个操作正在执行，请等待完成"), { status: 429 });
  activeCalls.set(access.id, calls);
  calls.controllers.add(controller);
  const remaining = new Date(access.expiresAt).getTime() - Date.now();
  const timer = setTimeout(() => controller.abort(new Error("MCP 凭证已过期")), Math.min(Math.max(0, remaining), 2_147_483_647));
  try {
    const currentSignal = AbortSignal.any([signal, controller.signal]);
    const [current] = await getWebDatabase()`SELECT access.id FROM yixianflow.mcpAccess AS access
      JOIN yixianflow.users AS account ON account.id = access."userId"
      WHERE access.id = ${access.id} AND NOT access.revoked AND access."expiresAt" > CURRENT_TIMESTAMP
        AND account.settings->'mcp'->'enabled' = 'true'::jsonb`;
    if (!current) throw new Error("MCP 授权已撤销、关闭或过期");
    if (access.scopes.includes("localComputer")) await getWebDatabase()`UPDATE yixianflow.sessions SET "seenAt" = CURRENT_TIMESTAMP WHERE hash = ${`mcp:${access.id}`}`;
    currentSignal.throwIfAborted();
    return await operation(currentSignal);
  } finally {
    clearTimeout(timer);
    calls.controllers.delete(controller);
    if (!calls.controllers.size) activeCalls.delete(access.id);
  }
}
