import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { credentialSchema, getBaseUrl } from "@/utils/account";
import { webContext, type WebAccount } from "@/lib/webContext";
import { accountInfoSchema, userSchema } from "@/types/account";
import { decryptWebSecret, encryptWebSecret, getWebDatabase, getWebOrigin, getWebBasePath, hashWebToken } from "./store";

const sessionCookie = "__Host-yixianflow";
const loginCookie = "__Host-yixianflowLogin";
const cookieOptions = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const;
const webAccountSchema = accountInfoSchema.extend({ user: userSchema.extend({ role: z.number().int(), status: z.number().int() }) });

async function requireWebUser(account: WebAccount, version: string) {
  const response = await fetch(`${account.baseUrl}/v1/toonflow/me`, { cache: "no-store", redirect: "error",
    signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${account.key}`, "X-Toonflow-Version": version } });
  if (response.status === 401 || response.status === 403)
    throw Object.assign(new Error("登录已失效，请重新登录"), { status: response.status });
  const body = await response.json() as { success?: boolean; data?: { user?: unknown } };
  if (!response.ok || body.success !== true) throw Object.assign(new Error("暂时无法确认账户身份，请稍后重试"), { status: 503 });
  const info = webAccountSchema.parse(body.data);
  const identity = info.user;
  if (identity.id !== account.user.id) throw Object.assign(new Error("账户身份不匹配，请重新登录"), { status: 401 });
  if (identity.status !== 1)
    throw Object.assign(new Error("当前账户已被停用"), { status: 403, code: "toonflow.account_disabled" });
  return info;
}

function readCookie(req: Request, name: string) {
  const values = (req.get("cookie") ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (values.length !== 1) return;
  const value = values[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

export async function readWebSession(req: Request) {
  const token = readCookie(req, sessionCookie);
  if (!token) return;
  const sql = getWebDatabase();
  const sessionHash = hashWebToken(token);
  const [session] = await sql`UPDATE yixianflow.sessions SET "seenAt" = CURRENT_TIMESTAMP
    WHERE hash = ${sessionHash} AND "expiresAt" > CURRENT_TIMESTAMP
      AND "seenAt" > CURRENT_TIMESTAMP - INTERVAL '30 minutes' RETURNING "userId"`;
  if (!session) return;
  try {
    const account = await readWebAccount(session.userId, req.app.locals.appVersion || process.env.appVersion || "2.0.0");
    return account && { sessionHash, ...account };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 401 && status !== 403) throw error;
    await sql`DELETE FROM yixianflow.sessions WHERE hash = ${sessionHash}`;
  }
}

export async function readWebAccount(userId: number, version: string) {
  const sql = getWebDatabase();
  const [record] = await sql`SELECT credentials, settings FROM yixianflow.users WHERE id = ${userId}`;
  if (!record) return;
  const baseUrl = getBaseUrl();
  const account = credentialSchema.parse(JSON.parse(decryptWebSecret(record.credentials, `account:${baseUrl}:${userId}`)));
  if (account.baseUrl !== baseUrl || account.user.id !== userId) throw new Error("服务端账户凭据不匹配");
  const accountInfo = await requireWebUser(account, version);
  account.user = accountInfo.user;
  return { account, settings: record.settings as Record<string, unknown>, accountInfo };
}

export async function startWebLogin(req: Request, res: Response, screen: "signin" | "signup") {
  const sql = getWebDatabase();
  const state = randomBytes(32).toString("base64url");
  const browser = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const hash = hashWebToken(state);
  const previous = readCookie(req, loginCookie);
  await sql`DELETE FROM yixianflow.logins WHERE "expiresAt" <= CURRENT_TIMESTAMP OR "browserHash" = ${hashWebToken(previous ?? "")}`;
  await sql`INSERT INTO yixianflow.logins (hash, "browserHash", verifier)
    VALUES (${hash}, ${hashWebToken(browser)}, ${encryptWebSecret(verifier, `login:${hash}`)})`;
  res.cookie(loginCookie, browser, { ...cookieOptions, maxAge: 10 * 60_000 });
  const url = new URL("/toonflow/authorize", getBaseUrl());
  url.search = new URLSearchParams({ client_id: "toonflow", redirect_uri: `${getWebOrigin()}${getWebBasePath()}/api/account/callback`, state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", screen,
    client_version: req.app.locals.appVersion || process.env.appVersion || "2.0.0" }).toString();
  return { url: url.href, browserOpened: false };
}

export async function completeWebLogin(req: Request, res: Response, state: string, code?: string, error?: string) {
  const browser = readCookie(req, loginCookie);
  if (!browser) throw Object.assign(new Error("登录已过期，请重新登录"), { status: 400 });
  const sql = getWebDatabase();
  const hash = hashWebToken(state);
  // 原子领取后保留记录，退出或重新登录仍能取消正在交换凭据的请求。
  const [login] = await sql`UPDATE yixianflow.logins SET "claimedAt" = CURRENT_TIMESTAMP WHERE hash = ${hash}
    AND "browserHash" = ${hashWebToken(browser)} AND "expiresAt" > CURRENT_TIMESTAMP AND "claimedAt" IS NULL RETURNING verifier`;
  if (!login) throw Object.assign(new Error("登录已过期或状态不匹配"), { status: 400 });
  res.clearCookie(loginCookie, cookieOptions);
  if (error === "access_denied") {
    await sql`DELETE FROM yixianflow.logins WHERE hash = ${hash}`;
    return;
  }
  if (error || !code) throw Object.assign(new Error("授权未完成，请重新登录"), { status: 400 });
  const baseUrl = getBaseUrl();
  const response = await fetch(`${baseUrl}/api/toonflow/auth/token`, { method: "POST", redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(30000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: decryptWebSecret(login.verifier, `login:${hash}`),
      redirect_uri: `${getWebOrigin()}${getWebBasePath()}/api/account/callback`, client_version: req.app.locals.appVersion || process.env.appVersion || "2.0.0" }) });
  const body = await response.json() as { success?: boolean; data?: unknown; error_code?: string };
  if (!response.ok || body.success !== true) throw Object.assign(new Error("UnionAIGC 授权失败，请重新登录"), { status: 400 });
  const account = credentialSchema.parse({ ...body.data as object, baseUrl });
  account.user = (await requireWebUser(account, req.app.locals.appVersion || process.env.appVersion || "2.0.0")).user;
  const token = randomBytes(32).toString("base64url");
  const oldToken = readCookie(req, sessionCookie);
  await sql.begin(async transaction => {
    const remaining = await transaction`DELETE FROM yixianflow.logins WHERE hash = ${hash}
      AND "browserHash" = ${hashWebToken(browser)} AND "claimedAt" IS NOT NULL AND "expiresAt" > CURRENT_TIMESTAMP RETURNING hash`;
    if (!remaining.length) throw Object.assign(new Error("此次登录已取消，请重新登录"), { status: 400 });
    await transaction`INSERT INTO yixianflow.users (id, credentials)
      VALUES (${account.user.id}, ${encryptWebSecret(JSON.stringify(account), `account:${baseUrl}:${account.user.id}`)})
      ON CONFLICT (id) DO UPDATE SET credentials = EXCLUDED.credentials`;
    await transaction`DELETE FROM yixianflow.sessions WHERE hash = ${hashWebToken(oldToken ?? "")} OR "expiresAt" <= CURRENT_TIMESTAMP`;
    await transaction`INSERT INTO yixianflow.sessions (hash, "userId", "expiresAt")
      VALUES (${hashWebToken(token)}, ${account.user.id}, CURRENT_TIMESTAMP + INTERVAL '12 hours')`;
  });
  res.cookie(sessionCookie, token, { ...cookieOptions, maxAge: 12 * 60 * 60_000 });
  console.info(`[web] login userId=${account.user.id}`);
}

export async function logoutWebSession(res?: Response, req?: Request) {
  const sql = getWebDatabase();
  const current = webContext.getStore();
  if (current) await sql`DELETE FROM yixianflow.sessions WHERE hash = ${current.sessionHash}`;
  if (current) console.info(`[web] logout userId=${current.account.user.id}`);
  const browser = req && readCookie(req, loginCookie);
  if (browser) await sql`DELETE FROM yixianflow.logins WHERE "browserHash" = ${hashWebToken(browser)}`;
  res?.clearCookie(sessionCookie, cookieOptions);
  res?.clearCookie(loginCookie, cookieOptions);
}
