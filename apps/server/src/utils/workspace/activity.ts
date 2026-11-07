import type { Request } from "express";

const activity = new Map<string, { requests: Set<Request>; operations: number; lastSeenAt: number; cleaning: boolean }>();
function state(directory: string) {
  const key = process.platform === "win32" ? directory.toLowerCase() : directory;
  let value = activity.get(key);
  if (!value) { value = { requests: new Set(), operations: 0, lastSeenAt: 0, cleaning: false }; activity.set(key, value); }
  return value;
}
function requireAvailable(value: ReturnType<typeof state>) {
  if (value.cleaning) throw Object.assign(new Error("项目正在释放回收站空间，请稍后重试"), { status: 409, code: "EBUSY" });
}

export function trackWorkspaceRequest(req: Request, directory: string) {
  const value = state(directory);
  requireAvailable(value);
  value.lastSeenAt = Date.now();
  if (!value.requests.has(req)) {
    value.requests.add(req);
    const release = () => { value.requests.delete(req); value.lastSeenAt = Date.now(); };
    req.res?.once("finish", release);
    req.res?.once("close", release);
  }
  return directory;
}

export function beginWorkspaceOperation(directory: string) {
  const value = state(directory);
  requireAvailable(value);
  value.operations++;
  return () => { value.operations--; value.lastSeenAt = Date.now(); };
}

export function beginWorkspaceCleanup(directory: string, request?: Request) {
  const value = state(directory);
  requireAvailable(value);
  if (value.operations || [...value.requests].some(active => active !== request) || !request && Date.now() - value.lastSeenAt < 120000) {
    throw Object.assign(new Error("项目正在使用，素材清理将在空闲后重试"), { status: 409, code: "EBUSY" });
  }
  value.cleaning = true;
  return () => { value.cleaning = false; };
}
