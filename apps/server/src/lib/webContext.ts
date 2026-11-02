import { AsyncLocalStorage } from "node:async_hooks";

export type WebAccount = { key: string; baseUrl: string; user: { id: number; username: string; display_name: string; role?: number; status?: number } };
export const webContext = new AsyncLocalStorage<{ sessionHash: string; account: WebAccount }>();

export function isWebMode() {
  return process.env.TOONFLOW_WEB_MODE === "1";
}

export function requireWebAccount() {
  const context = webContext.getStore();
  if (!context) throw Object.assign(new Error("请先登录逸仙账户"), { status: 401 });
  return context.account;
}
