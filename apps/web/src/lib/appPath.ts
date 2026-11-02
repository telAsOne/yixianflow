export const appBasePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function resolveAppUrl(value: string | URL) {
  const url = new URL(value, window.location.href);
  if (appBasePath && url.origin === location.origin && /^\/(api|mcp|a2a)(\/|$)/.test(url.pathname))
    url.pathname = appBasePath + url.pathname;
  return url;
}

if (appBasePath) {
  const originalFetch = window.fetch.bind(window);
  // ACT: 现有节点插件使用绝对 API 路径，子路径部署统一在宿主页面适配同源请求。
  window.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const source = input instanceof Request ? input.url : input;
    const target = resolveAppUrl(source);
    if (input instanceof Request) return originalFetch(new Request(target, input), init);
    return originalFetch(target, init);
  }, window.fetch);
}
