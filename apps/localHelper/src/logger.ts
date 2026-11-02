import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { appendFile, createReadStream, createWriteStream, link, lstat, mkdir, open, readdir, rmdir, stat, unlink } from "@toonflow/file";
import { Zip, ZipDeflate } from "fflate";
import { z } from "zod";
import { helperVersion } from "./protocol";

export const dataDirectory = resolve(process.env.TOONFLOW_HELPER_DATA_DIR || join(process.env.LOCALAPPDATA || homedir(), "UnionFlfow/localHelper"));
export const logDirectory = join(dataDirectory, "logs");
export type LogContext = { source: "web" | "tray" | "helper"; taskId?: string; chatId?: string };
export const nativeDiagnosticSchema = z.strictObject({
  event: z.enum(["workerStarted", "workerExited", "workerStderr", "workerStartFailed", "nativeMessageFailed", "nativeSendFailed", "startupSettingFailed", "openLogsFailed"]),
  errorType: z.string().regex(/^[a-zA-Z][a-zA-Z0-9.]{0,95}$/).optional(),
  systemCode: z.number().int().optional(), exitCode: z.number().int().optional(), length: z.number().int().nonnegative().optional(), pid: z.number().int().positive().optional(),
});

const maxLogBytes = 16 * 1024 * 1024;
const retentionMs = 7 * 24 * 60 * 60 * 1000;
const archiveBatchBytes = 512 * 1024 * 1024;
const allowedFields = new Set(["source", "taskId", "chatId", "deviceId", "approvalId", "action", "kind", "reason", "allowed", "approved", "paused", "autoExecute",
  "ownerId", "pid", "bunVersion", "platform", "arch", "server", "endpoint", "method", "httpStatus", "upstreamStatus", "requestId", "durationMs", "waitMs", "retryMs",
  "fileCount", "index", "bytes", "transferId", "completed", "failed", "remaining", "cancelled", "messageCount", "round", "toolCount", "errorType", "errorCode",
  "causeCode", "invalidFields", "exitCode", "systemCode", "length", "dropped", "truncated", "day", "stackFrames"]);
let component = "worker";
let initialized = false;
let queue = Promise.resolve();
let pending = 0;
let dropped = 0;
let failureReported = false;
let activeFile: { path: string; day: string; size: number } | undefined;
let sequence = 0;
let maintenance: Promise<void> | undefined;
let maintenanceTimer: ReturnType<typeof setInterval> | undefined;

function dayName(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function timestamp(date: Date) {
  return `${dayName(date)}_${String(date.getHours()).padStart(2, "0")}-${String(date.getMinutes()).padStart(2, "0")}-${String(date.getSeconds()).padStart(2, "0")}_${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function expired(day: string, now: number) {
  const end = new Date(`${day}T00:00:00`);
  end.setDate(end.getDate() + 1);
  return Number.isFinite(end.getTime()) && now - end.getTime() >= retentionMs;
}

async function removeFile(path: string) {
  await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}

type LogFile = { path: string; name: string; size: number; mtimeMs: number };

async function archiveFiles(day: string, files: LogFile[]) {
  const standard = join(logDirectory, `${day}.zip`);
  const exists = await lstat(standard).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
  const archive = exists ? join(logDirectory, `${day}_${timestamp(new Date()).slice(11)}_${process.pid}_${++sequence}.zip`) : standard;
  const temporary = `${archive}.${process.pid}.part`;
  const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  const complete = finished(output);
  void complete.catch(() => {});
  let streamError: Error | undefined;
  output.on("error", error => { streamError = error; });
  const zip = new Zip((error, data, final) => {
    if (error) { output.destroy(error); return; }
    if (!output.destroyed) { output.write(data); if (final) output.end(); }
  });
  try {
    for (const file of files) {
      const entry = new ZipDeflate(file.name, { level: 6 });
      zip.add(entry);
      for await (const chunk of createReadStream(file.path)) {
        if (streamError) throw streamError;
        entry.push(chunk);
        if (output.writableNeedDrain) await once(output, "drain");
      }
      entry.push(new Uint8Array(), true);
      const current = await stat(file.path);
      if (current.size !== file.size || current.mtimeMs !== file.mtimeMs) throw new Error("归档期间日志发生变化，保留原文件稍后处理");
    }
    zip.end();
    await complete;
    const handle = await open(temporary, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await link(temporary, archive);
    for (const file of files) {
      const current = await stat(file.path);
      if (current.size === file.size && current.mtimeMs === file.mtimeMs) await removeFile(file.path);
    }
    void logEvent("info", "logsArchived", { day, fileCount: files.length, bytes: files.reduce((total, file) => total + file.size, 0) });
  } finally {
    if (!output.closed) { output.destroy(); await complete.catch(() => {}); }
    await removeFile(temporary);
  }
}

function maintainLogs() {
  if (maintenance) return maintenance;
  maintenance = (async () => {
    const now = Date.now();
    const today = dayName(new Date(now));
    // 先等待本进程的旧日写入结束并切换文件，再读取旧日快照。
    if (activeFile && activeFile.day !== today) {
      await queue;
      await logEvent("info", "logDayChanged", { day: today });
    }
    for (const item of await readdir(logDirectory, { withFileTypes: true })) {
      const match = /^(\d{4}-\d{2}-\d{2})(?:_[a-zA-Z0-9_-]+)?(?:\.zip(?:\.\d+\.part)?)?$/.exec(item.name);
      if (!match || item.isSymbolicLink()) continue;
      const day = match[1];
      const path = join(logDirectory, item.name);
      if ((await lstat(path)).isSymbolicLink()) continue;
      if (item.isFile()) {
        if (/\.zip(?:\.\d+\.part)?$/.test(item.name) && expired(day, now)) await removeFile(path);
        continue;
      }
      if (!item.isDirectory() || item.name !== day || day >= today) continue;
      const files: LogFile[] = [];
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.log(?:\.part)?$/.test(entry.name)) continue;
        const target = join(path, entry.name);
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        if (expired(day, now)) await removeFile(target);
        else if (entry.name.endsWith(".log")) files.push({ path: target, name: entry.name, size: info.size, mtimeMs: info.mtimeMs });
      }
      // ACT: 沿用现有 ZIP32 依赖，按 512 MiB 原始日志分卷，避免单个日归档超过 ZIP32 上限。
      for (let offset = 0; offset < files.length;) {
        const batch: LogFile[] = [];
        let bytes = 0;
        while (offset < files.length && batch.length < 60000 && (!batch.length || bytes + files[offset].size <= archiveBatchBytes)) {
          const file = files[offset++];
          if (file.size >= 4 * 1024 * 1024 * 1024) throw new Error("旧日志超过 ZIP32 单文件限制，已保留原文件");
          bytes += file.size; batch.push(file);
        }
        await archiveFiles(day, batch);
      }
      await rmdir(path).catch((error: NodeJS.ErrnoException) => { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code ?? "")) throw error; });
    }
  })().catch(reportFailure).finally(() => { maintenance = undefined; });
  return maintenance;
}

function safeValue(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  return value.slice(0, 1024).replace(/\bBearer\s+\S+|\bsk-[a-zA-Z0-9_-]+|[a-zA-Z0-9_-]{43,}/g, "[redacted]");
}

function reportFailure(error: unknown) {
  if (failureReported) return;
  failureReported = true;
  const code = safeValue((error as { code?: string })?.code);
  process.stdout.write(JSON.stringify({ type: "logFailure", code }) + "\n");
}

export async function initializeLogs(name: "worker" | "tray" = "worker") {
  component = name;
  try { await mkdir(logDirectory, { recursive: true }); initialized = true; }
  catch (error) { reportFailure(error); }
  if (initialized && name === "worker") {
    void maintainLogs();
    maintenanceTimer = setInterval(() => { void maintainLogs(); }, 60000);
    maintenanceTimer.unref();
  }
}

export function logEvent(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}) {
  if (!initialized) return Promise.resolve();
  // ACT: 诊断队列最多 256 条；磁盘拥塞时将丢弃计数写入下一条，避免拖垮业务进程。
  if (pending >= 256) { dropped++; return Promise.resolve(); }
  const details = Object.fromEntries(Object.entries(fields).filter(([key]) => allowedFields.has(key)).map(([key, value]) => [key, safeValue(value)]));
  const entry = { at: new Date().toISOString(), level, event, component, version: helperVersion, ...details };
  pending++;
  queue = queue.then(async () => {
    const line = JSON.stringify({ ...entry, ...(dropped ? { dropped } : {}) }) + "\n";
    dropped = 0;
    const now = new Date();
    const day = dayName(now);
    const bytes = Buffer.byteLength(line);
    if (!activeFile || activeFile.day !== day || activeFile.size + bytes > maxLogBytes) {
      const directory = join(logDirectory, day);
      await mkdir(directory, { recursive: true });
      const path = join(directory, `${timestamp(now)}_${component}_${process.pid}_${++sequence}.log${component === "tray" ? ".part" : ""}`);
      const handle = await open(path, "wx", 0o600);
      await handle.close();
      activeFile = { path, day, size: 0 };
    }
    await appendFile(activeFile.path, line, { mode: 0o600 });
    activeFile.size += bytes;
    failureReported = false;
  }).catch(error => { activeFile = undefined; reportFailure(error); }).finally(() => { pending--; });
  return queue;
}

export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}) {
  const failure = error as { name?: string; code?: string; status?: number; message?: string; stack?: string; cause?: { code?: string } } | null;
  const message = typeof failure?.message === "string" ? failure.message : "";
  const kind = /concurrency|并发/i.test(message) ? "accountConcurrency" : /timeout|超时/i.test(message) ? "timeout"
    : /取消|拒绝/.test(message) ? "cancelledOrDenied" : /已存在/.test(message) ? "targetExists"
      : /变化/.test(message) ? "fileChanged" : /大小|大小限制/.test(message) ? "sizeLimit" : "runtime";
  const trace = typeof failure?.stack === "string" ? failure.stack.slice(-16000) : "";
  const boundary = message ? trace.lastIndexOf(message) : -1;
  const stackFrames = boundary >= 0 ? trace.slice(boundary + message.length).split("\n").filter(line => /^\s+at\s+.*:\d+/.test(line)).slice(0, 6).map(line => line.trim()).join("\n") : undefined;
  // ACT: 异常正文可能含文件内容、聊天或命令，始终不落盘；调用栈仅保留正文后的代码位置。
  return logEvent("error", event, { ...fields, kind, errorType: failure?.name ?? typeof error, errorCode: failure?.code,
    httpStatus: failure?.status ?? fields.httpStatus, causeCode: failure?.cause?.code, upstreamStatus: message.match(/HTTP\s+(\d{3})/i)?.[1],
    invalidFields: error instanceof z.ZodError ? error.issues.slice(0, 10).map(issue => `${issue.path.join(".")}:${issue.code}`).join(",") : undefined, stackFrames });
}

export async function flushLogs() {
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  await maintenance;
  await queue;
  if (component === "tray" && activeFile?.path.endsWith(".part")) {
    // 原生诊断子进程独立写入；只有写完的 .log 才对后台归档可见。
    try {
      const handle = await open(activeFile.path, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      await link(activeFile.path, activeFile.path.slice(0, -5));
      await removeFile(activeFile.path);
      activeFile = undefined;
    } catch (error) { reportFailure(error); }
  }
}
