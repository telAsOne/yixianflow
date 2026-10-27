import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { readFile, unlink, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import conf from "@/utils/conf";
import { translateMessage } from "@/lib/i18n";
import { accountInfoSchema, userSchema, type AccountView } from "@/types/account";

const credentialSchema = z.object({ key: z.string().max(8192).regex(/^sk-[a-zA-Z0-9_-]+$/), user: userSchema, baseUrl: z.string() });
let credentials: z.infer<typeof credentialSchema> | undefined;
let version = "";
let loginGeneration = 0;
let loginStatus: AccountView["loginStatus"] = "idle";
let message = "";
let pending: { state: string; verifier: string; redirectUri: string; expiresAt: number } | undefined;
let accountWrite = Promise.resolve();
const accountPath = join(dirname(conf.path), "account.json");

export function getBaseUrl() {
  const url = new URL(process.env.TOONFLOW_YIXIAN_BASE_URL || "https://yixian.lol");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("逸仙平台地址必须是不含凭据、参数或路径的 HTTPS 站点地址");
  return url.origin;
}

export function getAccount() { return credentials?.baseUrl === getBaseUrl() ? credentials : undefined; }
export function requireAccount() {
  const account = getAccount();
  if (!account) throw Object.assign(new Error("请登录或注册逸仙账户后开始生成"), { status: 401, code: "toonflow.login_required" });
  return account;
}
export function getApiKey() { return requireAccount().key; }

function saveAccount(account?: z.infer<typeof credentialSchema>) {
  const operation = accountWrite.then(async () => {
    if (account) await writeAtomic(accountPath, JSON.stringify(account), { mode: 0o600 });
    else await unlink(accountPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    credentials = account;
  });
  accountWrite = operation.catch(() => {});
  return operation;
}

export async function logout() {
  loginGeneration++;
  pending = undefined;
  loginStatus = "idle";
  message = "";
  await saveAccount();
}

export function startLogin(port: number, screen: "signin" | "signup") {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("本地登录回调端口无效");
  loginGeneration++;
  const verifier = randomBytes(32).toString("base64url");
  pending = { state: randomBytes(32).toString("base64url"), verifier,
    redirectUri: `http://127.0.0.1:${port}/api/account/callback`, expiresAt: Date.now() + 10 * 60_000 };
  loginStatus = "waiting";
  message = "";
  const url = new URL("/toonflow/authorize", getBaseUrl());
  url.search = new URLSearchParams({ client_id: "toonflow", redirect_uri: pending.redirectUri, state: pending.state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", screen, client_version: version }).toString();
  return { url: url.href };
}

export async function completeLogin(state: string, code?: string, error?: string) {
  const currentGeneration = loginGeneration;
  const login = pending;
  if (!login || login.expiresAt <= Date.now() || Buffer.byteLength(state) !== Buffer.byteLength(login.state)
    || !timingSafeEqual(Buffer.from(state), Buffer.from(login.state)))
    throw Object.assign(new Error("登录已过期或状态不匹配，请重新登录"), { status: 400 });
  pending = undefined;
  if (error === "access_denied") { loginStatus = "cancelled"; message = "已取消登录"; return; }
  try {
    if (error || !code) throw new Error("授权未完成，请重新登录");
    const baseUrl = getBaseUrl();
    const response = await fetch(`${baseUrl}/api/toonflow/auth/token`, { method: "POST", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(30000), headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: login.verifier,
        redirect_uri: login.redirectUri, client_version: version }) });
    const body = await response.json() as { success?: boolean; data?: unknown; message?: string; error_code?: string };
    if (!response.ok || body.success !== true) throw Object.assign(new Error(body.message || "授权失败，请重新登录"), { status: response.status, code: body.error_code });
    const account = credentialSchema.parse({ ...z.object({ key: z.string(), user: userSchema }).parse(body.data), baseUrl });
    if (currentGeneration !== loginGeneration) throw new Error("此次登录已取消，请重新登录");
    await saveAccount(account);
    const { refreshConfig } = await import("./config");
    await refreshConfig().catch(error => { if (getAccount() !== account) throw error; });
    if (currentGeneration !== loginGeneration || getAccount() !== account) throw new Error("此次登录已取消，请重新登录");
    loginStatus = "idle";
  } catch (error) {
    if (currentGeneration === loginGeneration) { loginStatus = "failed"; message = error instanceof Error ? error.message : "登录失败"; }
    throw error;
  }
}

export async function platformFetch(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  const account = requireAccount();
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== account.baseUrl || !url.pathname.startsWith("/v1/") || url.username || url.password)
    throw new Error("只允许调用当前逸仙平台接口");
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  if (headers.has("Authorization") && headers.get("Authorization") !== `Bearer ${account.key}`)
    throw Object.assign(new Error("账户已切换，请重新发起操作"), { status: 401 });
  headers.set("Authorization", `Bearer ${account.key}`);
  headers.set("X-Toonflow-Version", version);
  const response = await fetch(input, { ...init, headers, cache: "no-store", redirect: "error" });
  if (!response.ok) {
    const body = await response.clone().json().catch(() => undefined) as { error_code?: string; error?: { code?: string }; message?: string } | undefined;
    const code = body?.error_code ?? body?.error?.code;
    if ((response.status === 401 || code === "toonflow.not_toonflow_key") && getAccount() === account) {
      const clearing = logout();
      const invalidGeneration = loginGeneration;
      await clearing;
      if (invalidGeneration === loginGeneration) { loginStatus = "failed"; message = "登录已失效，请重新登录"; }
      throw Object.assign(new Error("登录已失效，请重新登录"), { status: 401, code: "toonflow.login_required" });
    }
    if (code === "toonflow.model_unavailable" && url.pathname !== "/v1/toonflow/config") {
      const { refreshConfig } = await import("./config");
      await refreshConfig().catch(() => {});
    }
  }
  return response;
}

export async function accountFetch(path: string, init?: RequestInit) {
  const response = await platformFetch(new URL(path, getBaseUrl()), { signal: AbortSignal.timeout(30000), ...init });
  const body = await response.json() as { success?: boolean; data?: unknown; message?: string; error_code?: string };
  if (body.message && getAccount()) body.message = body.message.replaceAll(getAccount()!.key, "••••••");
  if (!response.ok || body.success !== true) throw Object.assign(new Error(body.error_code === "toonflow.client_outdated"
    ? "当前版本过旧，请在设置的关于页面更新逸仙版 Toonflow" : body.message || `逸仙接口请求失败（HTTP ${response.status}）`),
    { status: response.ok ? 502 : response.status, code: body.error_code });
  return body.data;
}

export async function getView(): Promise<AccountView> {
  if (pending && pending.expiresAt <= Date.now()) { pending = undefined; loginStatus = "expired"; message = "登录已超时，请重新登录"; }
  const { getConfigState } = await import("./config");
  const account = getAccount();
  const info = account ? accountInfoSchema.parse(await accountFetch("/v1/toonflow/me")) : undefined;
  if (info && getAccount() !== account) return getView();
  if (info && info.user.id !== account!.user.id) throw new Error("平台返回的账户不匹配，请重新登录");
  return { authenticated: !!account, loginStatus, message: translateMessage(message), account: info, ...getConfigState() };
}

export async function initializeAccount(appVersion: string) {
  version = appVersion;
  const source = await readFile(accountPath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (source) credentials = credentialSchema.parse(JSON.parse(source));
  const { initializeConfig } = await import("./config");
  await initializeConfig();
}

export { refreshConfig, getConfigState } from "./config";
