export async function deviceRequest<T>(server: URL, token: string, path: string, body: unknown, signal: AbortSignal, method = "POST"): Promise<T> {
  const response = await fetch(new URL(`api/localHelper/device/${path}`, server), { method, redirect: "error",
    headers: { Authorization: `Bearer ${token}`, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}), signal });
  const result = await response.json() as { code?: number; message?: string; data: T };
  if (!response.ok || result.code !== 200) throw Object.assign(new Error(result.message || `平台返回 HTTP ${response.status}`), { status: response.status });
  return result.data;
}
