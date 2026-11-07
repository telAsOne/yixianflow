import { randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { resolve, dirname } from "node:path";
import { stat } from "@toonflow/file";
import type { Request } from "express";
import { helperVersion, localHelperRequest, type LocalHelperRequest, type LocalMediaStatus, type LocalHelperDevice, type LocalHelperJob, type LocalHelperResult, type LocalHelperStatus } from "@toonflow/local-helper/protocol";
import { isWebMode, requireWebAccount, webContext } from "@/lib/webContext";
import { getWebDatabase, hashWebToken } from "@/utils/web/store";
import conf from "@/utils/conf";

export { chat } from "./chat";
export { deviceProjects, prepareTransfer, uploadFile, downloadFile, finishTransfer } from "./files";
export { getUpdate, downloadUpdate } from "./update";
export { mediaInput, mediaOutput, mediaEvent, executeMedia } from "./media";

const registrationLimits = new Map<string, { count: number; until: number }>();
const mediaStatuses = new Map<string, LocalMediaStatus>();

export function getMediaStatus(id: string) { return mediaStatuses.get(id); }
export function setMediaStatus(id: string, status: LocalMediaStatus) { mediaStatuses.set(id, status); }

function unavailable(message: string, status = 409) { return Object.assign(new Error(message), { status }); }

export function getDownloadPath() {
  return resolve(process.env.TOONFLOW_LOCAL_HELPER_PACKAGE || resolve(dirname(conf.path), "downloads/unionFlfowHelper.zip"));
}

export async function getStatus(): Promise<LocalHelperStatus> {
  const ownerId = requireWebAccount().user.id;
  const sql = getWebDatabase();
  const devices = await sql<(Omit<LocalHelperDevice, "lastSeenAt"> & { lastSeenAt: Date | null })[]>`SELECT id, name, approved, paused, "autoExecute", version, "lastSeenAt",
    ("lastSeenAt" > CURRENT_TIMESTAMP - INTERVAL '45 seconds') AS online
    FROM yixianflow.localDevices WHERE "ownerId" = ${ownerId} AND NOT revoked ORDER BY name`;
  const [session] = await sql`SELECT "localDeviceId" FROM yixianflow.sessions WHERE hash = ${webContext.getStore()!.sessionHash}`;
  const downloadAvailable = await stat(getDownloadPath()).then(info => info.isFile()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  return { devices: devices.map(device => ({ ...device, online: device.online === true, lastSeenAt: device.lastSeenAt?.toISOString() ?? null })),
    selectedId: session?.localDeviceId ?? null, downloadAvailable, version: helperVersion };
}

export async function bindDevice(code: string) {
  const account = requireWebAccount();
  const sql = getWebDatabase();
  await sql.begin(async transaction => {
    const [device] = await transaction`UPDATE yixianflow.localDevices SET "ownerId" = ${account.user.id},
      "ownerName" = ${account.user.display_name || account.user.username}, "pairHash" = NULL, "pairExpiresAt" = NULL
      WHERE "pairHash" = ${hashWebToken(code.replace(/\s|-/g, "").toUpperCase())}
        AND "pairExpiresAt" > CURRENT_TIMESTAMP AND "ownerId" IS NULL AND NOT revoked RETURNING id`;
    if (!device) throw unavailable("配对码无效或已过期，请查看本机托盘中的配对码", 400);
    await transaction`UPDATE yixianflow.sessions SET "localDeviceId" = ${device.id} WHERE hash = ${webContext.getStore()!.sessionHash}`;
  });
}

export async function selectDevice(id: string | null) {
  const sql = getWebDatabase();
  const sessionHash = webContext.getStore()!.sessionHash;
  await sql.begin(async transaction => {
    if (id) {
      const [device] = await transaction`SELECT id FROM yixianflow.localDevices WHERE id = ${id} AND "ownerId" = ${requireWebAccount().user.id} AND NOT revoked FOR UPDATE`;
      if (!device) throw unavailable("本地设备不存在或已解除绑定", 404);
    }
    await transaction`UPDATE yixianflow.sessions SET "localDeviceId" = ${id} WHERE hash = ${sessionHash}`;
    await transaction`UPDATE yixianflow.localCalls SET status = 'cancelled', error = '本次网页登录会话已切换或关闭本机工具', "finishedAt" = CURRENT_TIMESTAMP
      WHERE "sessionHash" = ${sessionHash} AND "deviceId" IS DISTINCT FROM ${id}::uuid AND status IN ('queued', 'running')`;
  });
}

export async function revokeDevice(id: string, ownerId = requireWebAccount().user.id) {
  const sql = getWebDatabase();
  await sql.begin(async transaction => {
    const [device] = await transaction`UPDATE yixianflow.localDevices SET revoked = true, approved = false, "pairHash" = NULL
      WHERE id = ${id} AND "ownerId" = ${ownerId} RETURNING id`;
    if (!device) throw unavailable("本地设备不存在", 404);
    await transaction`UPDATE yixianflow.sessions SET "localDeviceId" = NULL WHERE "localDeviceId" = ${id}`;
    await transaction`UPDATE yixianflow.localCalls SET status = 'cancelled', error = '设备已解除绑定', "finishedAt" = CURRENT_TIMESTAMP
      WHERE "deviceId" = ${id} AND status IN ('queued', 'running')`;
  });
  mediaStatuses.delete(id);
}

export async function registerDevice(req: Request, input: { id: string; code: string; name: string; version: string }) {
  if (!isWebMode()) throw unavailable("需要连接 UnionFlfow 网页版", 404);
  const token = deviceToken(req);
  const now = Date.now();
  for (const [key, limit] of registrationLimits) if (limit.until < now) registrationLimits.delete(key);
  const key = req.ip ?? "unknown";
  const limit = registrationLimits.get(key) ?? { count: 0, until: now + 60000 };
  if (++limit.count > 5 || registrationLimits.size > 10000) throw unavailable("请求过于频繁，请稍后重试", 429);
  registrationLimits.set(key, limit);
  const sql = getWebDatabase();
  await sql`DELETE FROM yixianflow.localDevices WHERE "ownerId" IS NULL AND "pairExpiresAt" < CURRENT_TIMESTAMP`;
  await sql`INSERT INTO yixianflow.localDevices (id, "tokenHash", "pairHash", "pairExpiresAt", name, version)
    VALUES (${input.id}, ${hashWebToken(token)}, ${hashWebToken(input.code)}, CURRENT_TIMESTAMP + INTERVAL '10 minutes', ${input.name}, ${input.version})`;
}

function deviceToken(req: Request) {
  if (req.get("origin") || req.get("cookie")) throw unavailable("设备接口不接受浏览器请求", 403);
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get("authorization") ?? "");
  if (!match) throw unavailable("设备凭据无效", 401);
  return match[1]!;
}

export async function authenticateDevice(req: Request) {
  if (!isWebMode()) throw unavailable("需要连接 UnionFlfow 网页版", 404);
  const sql = getWebDatabase();
  const [device] = await sql`SELECT id, "ownerId", "ownerName" FROM yixianflow.localDevices
    WHERE "tokenHash" = ${hashWebToken(deviceToken(req))} AND NOT revoked`;
  if (!device) throw unavailable("设备凭据已失效，请重新配对", 401);
  return device as { id: string; ownerId: number | null; ownerName: string | null };
}

export async function requireReadyDevice(req: Request) {
  const device = await authenticateDevice(req);
  const sql = getWebDatabase();
  const [ready] = await sql`SELECT id FROM yixianflow.localDevices WHERE id = ${device.id} AND "ownerId" = ${device.ownerId}
    AND NOT revoked AND approved AND NOT paused AND "lastSeenAt" > CURRENT_TIMESTAMP - INTERVAL '45 seconds'`;
  if (!ready || !device.ownerId) throw unavailable("本地助手尚未授权、已暂停或离线");
  return { ...device, ownerId: device.ownerId };
}

export async function disconnectDevice(req: Request) {
  const device = await authenticateDevice(req);
  if (device.ownerId !== null) return revokeDevice(device.id, device.ownerId);
  const sql = getWebDatabase();
  await sql`DELETE FROM yixianflow.localDevices WHERE id = ${device.id} AND "ownerId" IS NULL`;
}

export async function pollDevice(req: Request, input: { activeId?: string; approved: boolean; paused: boolean; autoExecute: boolean; version: string; media?: LocalMediaStatus; subtitleTasks?: string[] }) {
  const device = await authenticateDevice(req);
  if (input.media) mediaStatuses.set(device.id, input.media);
  const sql = getWebDatabase();
  await sql`UPDATE yixianflow.localDevices SET "lastSeenAt" = CURRENT_TIMESTAMP,
    approved = ${input.approved && !!device.ownerId}, paused = ${input.paused}, "autoExecute" = ${input.autoExecute}, version = ${input.version}
    WHERE id = ${device.id}`;
  const owner = device.ownerId ? { id: device.ownerId, name: device.ownerName ?? String(device.ownerId) } : null;
  const subtitleCancelled = input.subtitleTasks?.length
    ? await import("@/utils/whisper/runtime").then(module => module.cancelledSubtitles(device.id, device.ownerId, input.subtitleTasks!)) : [];
  const deadline = Date.now() + 18000;
  do {
    if (req.res?.destroyed) break;
    const [current] = await sql`SELECT revoked FROM yixianflow.localDevices WHERE id = ${device.id}`;
    if (!current || current.revoked) throw unavailable("设备绑定已撤销", 401);
    await sql`UPDATE yixianflow.localCalls AS call SET status = 'cancelled', error = '授权会话结束或任务超时', "finishedAt" = CURRENT_TIMESTAMP
      WHERE "deviceId" = ${device.id} AND status IN ('queued', 'running') AND ("expiresAt" <= CURRENT_TIMESTAMP
        OR NOT EXISTS (SELECT 1 FROM yixianflow.sessions WHERE hash = call."sessionHash" AND "userId" = call."ownerId"
          AND "expiresAt" > CURRENT_TIMESTAMP AND "seenAt" > CURRENT_TIMESTAMP - INTERVAL '30 minutes'))`;
    const cancelled = input.activeId ? await sql`SELECT id FROM yixianflow.localCalls WHERE id = ${input.activeId}
      AND "deviceId" = ${device.id} AND status <> 'running'` : [];
    if (cancelled.length) return { owner, job: null, cancelled: cancelled.map((item: { id: string }) => item.id), subtitleCancelled };
    if (owner && input.approved && !input.paused && !input.activeId) {
      const job = await sql.begin(async transaction => {
        const [available] = await transaction`SELECT id FROM yixianflow.localDevices WHERE id = ${device.id} AND NOT revoked FOR UPDATE`;
        if (!available) return null;
        // ACT: 已领取任务永不自动重跑；助手重启后将失联任务标成中断，避免重复执行写入或安装。
        await transaction`UPDATE yixianflow.localCalls SET status = 'failed', error = '本地助手已重启或执行中断，请核对本机后重新操作', "finishedAt" = CURRENT_TIMESTAMP
          WHERE "deviceId" = ${device.id} AND status = 'running' AND "claimedAt" < CURRENT_TIMESTAMP - INTERVAL '60 seconds'`;
        const [running] = await transaction`SELECT id FROM yixianflow.localCalls WHERE "deviceId" = ${device.id} AND status = 'running' LIMIT 1`;
        if (running) return null;
        const [call] = await transaction`UPDATE yixianflow.localCalls SET status = 'running', "claimedAt" = CURRENT_TIMESTAMP,
          nonce = ${randomBytes(24).toString("base64url")} WHERE id = (
            SELECT id FROM yixianflow.localCalls WHERE "deviceId" = ${device.id} AND "ownerId" = ${owner.id}
              AND status = 'queued' AND "expiresAt" > CURRENT_TIMESTAMP ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED
          ) RETURNING id, nonce, request`;
        return call as LocalHelperJob | undefined ?? null;
      });
      if (job) return { owner, job, cancelled: [], subtitleCancelled };
    }
    // 首次绑定立即通知本机，让托盘完成本地授权。
    if (!input.approved || input.paused) break;
    await setTimeout(1000);
  } while (Date.now() < deadline);
  return { owner, job: null, cancelled: [], subtitleCancelled };
}

export async function completeDeviceCall(req: Request, input: LocalHelperResult) {
  const device = await authenticateDevice(req);
  const sql = getWebDatabase();
  const [call] = await sql`UPDATE yixianflow.localCalls AS call SET status = ${input.error ? "failed" : "completed"},
    result = ${input.result == null ? null : JSON.stringify(input.result)}::jsonb, error = ${input.error ?? null}, "finishedAt" = CURRENT_TIMESTAMP
    WHERE id = ${input.id} AND "deviceId" = ${device.id} AND "ownerId" = ${device.ownerId} AND nonce = ${input.nonce}
      AND status = 'running' AND "expiresAt" > CURRENT_TIMESTAMP
      AND EXISTS (SELECT 1 FROM yixianflow.sessions WHERE hash = call."sessionHash" AND "userId" = call."ownerId"
        AND "expiresAt" > CURRENT_TIMESTAMP AND "seenAt" > CURRENT_TIMESTAMP - INTERVAL '30 minutes') RETURNING id`;
  if (!call) {
    const [previous] = await sql`SELECT status FROM yixianflow.localCalls WHERE id = ${input.id} AND "deviceId" = ${device.id} AND nonce = ${input.nonce}`;
    if (!previous || !["completed", "failed", "cancelled"].includes(previous.status)) throw unavailable("任务已失效，结果未保存");
  }
}

export async function getSelectedDevice() {
  if (!isWebMode()) return;
  const context = webContext.getStore();
  if (!context) return;
  const sql = getWebDatabase();
  const [device] = await sql`SELECT device.id, device.name, device.version, device.approved, device.paused,
    (device."lastSeenAt" > CURRENT_TIMESTAMP - INTERVAL '45 seconds') AS online FROM yixianflow.localDevices AS device
    JOIN yixianflow.sessions AS session ON session."localDeviceId" = device.id
    WHERE session.hash = ${context.sessionHash} AND device."ownerId" = ${context.account.user.id} AND NOT device.revoked`;
  if (device) return { id: device.id as string, name: device.name as string, version: device.version as string,
    ready: device.approved && !device.paused && device.online === true, ownerId: context.account.user.id, sessionHash: context.sessionHash };
}

export async function callDevice(device: NonNullable<Awaited<ReturnType<typeof getSelectedDevice>>>, request: LocalHelperRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  request = localHelperRequest.parse(request);
  if (request.action.startsWith("subtitle") && !Bun.semver.satisfies(device.version, ">=0.6.0"))
    throw unavailable("请将本地助手升级到 0.6.0 后使用字幕任务", 424);
  const sql = getWebDatabase();
  const id = crypto.randomUUID();
  const timeout = ("timeoutSeconds" in request ? request.timeoutSeconds ?? (request.action === "install" ? 1200 : 60)
    : request.action === "ffmpeg" ? 7200 : ["upload", "download", "ffmpegInstall", "subtitleTranscribe", "subtitleStart", "subtitleScan"].includes(request.action) ? 900 : 60) * 1000 + 180000;
  await sql.begin(async transaction => {
    const [available] = await transaction`SELECT id FROM yixianflow.localDevices
      WHERE id = ${device.id} AND "ownerId" = ${device.ownerId} AND NOT revoked AND approved AND NOT paused
        AND "lastSeenAt" > CURRENT_TIMESTAMP - INTERVAL '45 seconds' FOR UPDATE`;
    if (!available) throw unavailable("本地助手未就绪，请在 Windows 托盘中启动、确认授权或继续接收任务");
    const [session] = await transaction`SELECT hash FROM yixianflow.sessions WHERE hash = ${device.sessionHash}
      AND "userId" = ${device.ownerId} AND "localDeviceId" = ${device.id} AND "expiresAt" > CURRENT_TIMESTAMP
      AND "seenAt" > CURRENT_TIMESTAMP - INTERVAL '30 minutes'`;
    if (!session) throw unavailable("本轮本机授权已改变，请重新发起对话");
    const [queue] = await transaction`SELECT count(*)::int AS size FROM yixianflow.localCalls WHERE "deviceId" = ${device.id} AND status IN ('queued', 'running')`;
    if (queue.size >= 20) throw unavailable("本地任务队列已满，请等待现有任务完成", 429);
    await transaction`DELETE FROM yixianflow.localCalls WHERE "deviceId" = ${device.id} AND "finishedAt" < CURRENT_TIMESTAMP - INTERVAL '1 day'`;
    await transaction`INSERT INTO yixianflow.localCalls (id, "deviceId", "ownerId", "sessionHash", request, "expiresAt")
      VALUES (${id}, ${device.id}, ${device.ownerId}, ${device.sessionHash}, ${request}::jsonb, ${new Date(Date.now() + timeout)})`;
  });
  let finished = false;
  try {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const [call] = await sql`SELECT status, result, error FROM yixianflow.localCalls WHERE id = ${id} AND "ownerId" = ${device.ownerId}`;
      if (!call) throw unavailable("本地任务不存在");
      if (["completed", "failed", "cancelled"].includes(call.status)) {
        finished = true;
        if (call.status !== "completed") throw new Error(call.error || "本地操作未完成");
        return call.result;
      }
      await setTimeout(600, undefined, { signal });
    }
    throw new Error("等待本地操作超时，请核对本机结果；不会自动重复执行");
  } finally {
    if (!finished) await sql`UPDATE yixianflow.localCalls SET status = 'cancelled', error = '调用已取消或超时', "finishedAt" = CURRENT_TIMESTAMP
      WHERE id = ${id} AND status IN ('queued', 'running')`;
  }
}
