import { webMode, webUserId } from "@/lib/webRuntime";

export const appBasePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function resolveAppUrl(value: string | URL) {
  const url = new URL(value, window.location.href);
  if (appBasePath && url.origin === location.origin && /^\/(api|mcp|a2a)(\/|$)/.test(url.pathname))
    url.pathname = appBasePath + url.pathname;
  return url;
}

export function assetFileUrl(path: string) {
  const url = resolveAppUrl("/api/assets/read");
  url.searchParams.set("path", path);
  if (webMode.value && webUserId.value) url.searchParams.set("userId", String(webUserId.value));
  return url.href;
}

{
  const originalFetch = window.fetch.bind(window);
  // ACT: 现有节点插件使用绝对 API 路径，子路径部署统一在宿主页面适配同源请求。
  window.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const source = input instanceof Request ? input.url : input;
    const target = resolveAppUrl(source);
    const apiRequest = target.origin === location.origin && target.pathname.startsWith(`${appBasePath}/api/`);
    const userId = webMode.value && apiRequest ? webUserId.value : undefined;
    const rewritten = target.href !== new URL(source, location.href).href;
    if (!rewritten && !userId) return originalFetch(input, init);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (userId) headers.set("x-yixianflow-user", String(userId));
    if (input instanceof Request) return originalFetch(rewritten ? new Request(target, input) : input, { ...init, headers });
    return originalFetch(target, { ...init, headers });
  }, window.fetch);
}
