import { logEvent, logError, type LogContext } from "./logger";

export async function deviceRequest<T>(server: URL, token: string, path: string, body: unknown, signal: AbortSignal, method = "POST", context?: LogContext): Promise<T> {
  const started = Date.now();
  let httpStatus: number | undefined;
  let requestId: string | null = null;
  if (path !== "poll") void logEvent("info", "requestStarted", { ...context, endpoint: path, method });
  try {
    const response = await fetch(new URL(`api/localHelper/device/${path}`, server), { method, redirect: "error",
      headers: { Authorization: `Bearer ${token}`, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}), signal });
    httpStatus = response.status;
    requestId = response.headers.get("x-request-id");
    const result = await response.json() as { code?: number; message?: string; data: T };
    if (!response.ok || result.code !== 200) throw Object.assign(new Error(result.message || `平台返回 HTTP ${response.status}`), { status: response.status });
    if (path !== "poll") void logEvent("info", "requestCompleted", { ...context, endpoint: path, method, httpStatus, requestId, durationMs: Date.now() - started });
    return result.data;
  } catch (error) {
    void logError("requestFailed", error, { ...context, endpoint: path, method, httpStatus, requestId, durationMs: Date.now() - started, cancelled: signal.aborted });
    throw error;
  }
}
