import { SQL } from "bun";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { requireWebAccount, webContext } from "@/lib/webContext";

let database: SQL | undefined;
let secret: Buffer;
let origin: string;
let basePath = "";

export function getWebDatabase() {
  if (!database) throw new Error("网页版数据库尚未初始化");
  return database;
}

export function getWebOrigin() {
  if (!origin) throw new Error("网页版地址尚未配置");
  return origin;
}

export function getWebBasePath() {
  return basePath;
}

export function hashWebToken(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function encryptWebSecret(value: string, scope: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret, nonce);
  cipher.setAAD(Buffer.from(scope));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [nonce, cipher.getAuthTag(), encrypted].map(part => part.toString("base64url")).join(".");
}

export function decryptWebSecret(value: string, scope: string) {
  const [nonce, tag, encrypted, extra] = value.split(".");
  if (!nonce || !tag || !encrypted || extra !== undefined) throw new Error("服务端凭据无法解密");
  const decipher = createDecipheriv("aes-256-gcm", secret, Buffer.from(nonce, "base64url"));
  decipher.setAAD(Buffer.from(scope));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

export async function initializeWebStore() {
  const address = new URL(process.env.TOONFLOW_WEB_ORIGIN || "");
  if (address.protocol !== "https:" || address.username || address.password || address.pathname !== "/" || address.search || address.hash)
    throw new Error("TOONFLOW_WEB_ORIGIN 必须是固定的 HTTPS 站点地址");
  const connection = new URL(process.env.TOONFLOW_WEB_DATABASE_URL || "");
  if (!["postgres:", "postgresql:"].includes(connection.protocol)) throw new Error("网页版必须使用 PostgreSQL");
  const key = process.env.TOONFLOW_WEB_SECRET || "";
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error("TOONFLOW_WEB_SECRET 必须是 32 字节随机密钥的十六进制值");
  secret = Buffer.from(key, "hex");
  origin = address.origin;
  basePath = process.env.TOONFLOW_WEB_BASE_PATH || "";
  if (!/^(?:\/[a-zA-Z0-9_-]+)*$/.test(basePath)) throw new Error("TOONFLOW_WEB_BASE_PATH 必须为空或不带末尾斜杠的子路径");
  database = new SQL(connection.href, { max: 10, connectionTimeout: 10, idleTimeout: 30 });
  const sql = database;
  await sql`CREATE SCHEMA IF NOT EXISTS yixianflow`;
  await sql`CREATE TABLE IF NOT EXISTS yixianflow.users (
    id INTEGER PRIMARY KEY, credentials TEXT NOT NULL, settings JSONB NOT NULL DEFAULT '{}'
  )`;
  await sql`CREATE TABLE IF NOT EXISTS yixianflow.sessions (
    hash TEXT PRIMARY KEY, "userId" INTEGER NOT NULL REFERENCES yixianflow.users(id),
    "expiresAt" TIMESTAMPTZ NOT NULL, "seenAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`;
  await sql`CREATE TABLE IF NOT EXISTS yixianflow.logins (
    hash TEXT PRIMARY KEY, "browserHash" TEXT NOT NULL, verifier TEXT NOT NULL, "claimedAt" TIMESTAMPTZ,
    "expiresAt" TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '10 minutes')
  )`;
  await sql`CREATE TABLE IF NOT EXISTS yixianflow.projects (
    id UUID PRIMARY KEY, "ownerId" INTEGER NOT NULL REFERENCES yixianflow.users(id), name TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, "lastOpenedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`;
  await sql`CREATE INDEX IF NOT EXISTS "projectsOwner" ON yixianflow.projects ("ownerId", "lastOpenedAt" DESC)`;
}

export async function getWebSettings(): Promise<Record<string, unknown>> {
  const sql = getWebDatabase();
  const [user] = await sql`SELECT settings FROM yixianflow.users WHERE id = ${requireWebAccount().user.id}`;
  return user?.settings ?? {};
}

export async function saveWebSettings(settings: Record<string, unknown>) {
  const sql = getWebDatabase();
  const content = { ...settings };
  for (const key of ["customProviders", "mediaProviderConfigs", "defaultModels", "yixianConfig"]) delete content[key];
  const [user] = await sql`UPDATE yixianflow.users AS currentUser SET settings = ${content}::jsonb || COALESCE(
    (SELECT jsonb_object_agg(key, value) FROM jsonb_each(currentUser.settings)
      WHERE key IN ('customProviders', 'mediaProviderConfigs', 'defaultModels', 'yixianConfig')), '{}'::jsonb)
    WHERE id = ${requireWebAccount().user.id} RETURNING settings`;
  const context = webContext.getStore();
  if (context) context.settings = user.settings;
}

export async function saveWebManagedSettings(settings: Record<string, unknown>) {
  const sql = getWebDatabase();
  // ACT: 模型目录同步只更新托管字段，保留其他请求刚保存的个人设置。
  const [user] = await sql`UPDATE yixianflow.users SET settings = settings || ${settings}::jsonb
    WHERE id = ${requireWebAccount().user.id} RETURNING settings`;
  const context = webContext.getStore();
  if (context) context.settings = user.settings;
}
