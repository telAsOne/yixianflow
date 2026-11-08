import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { mkdir, readFile, stat, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import type { ImageTaskContext } from "@toonflow/providers";
import type { GeneratedMedia, MediaGenerationRequest, ImageTaskStatus } from "@toonflow/tools-scaffold/runtime";
import { imageGenerationSchema } from "@toonflow/tool-media-generation/runtime";
import { resolveWorkspacePath } from "@/utils/workspace/files";

const active = new Set<string>();
const taskIdSchema = z.uuid();
const stateSchema = z.object({
  phase: z.enum(["prepared", "submitting", "accepted", "queued", "processing", "reconciling", "settling", "downloading", "failed", "expired"]),
  taskId: z.string().min(1).max(2048).optional(), pollUrl: z.string().max(4096).optional(),
  submissions: z.number().int().min(0).max(3).optional(), error: z.string().optional(), retryAt: z.number().finite().positive().optional(),
});
const recordSchema = z.object({
  version: z.literal(1), id: taskIdSchema, identity: z.string(), request: imageGenerationSchema,
  recovery: z.enum(["provider", "result"]).optional(),
  state: stateSchema, createdAt: z.number(), updatedAt: z.number(), finishedAt: z.number().optional(), lastError: z.string().optional(),
  result: z.array(z.object({ path: z.string(), mimeType: z.string(), mediaType: z.literal("image") })).min(1).max(4).optional(),
});
const requestSchema = z.object({ endpoint: z.enum(["/v1/images/generations/async", "/v1/images/edits/async", "/v1/task"]), body: z.string(), digest: z.string() });
const assetsSchema = z.array(z.discriminatedUnion("type", [
  z.object({ type: z.literal("base64"), data: z.string(), mimeType: z.string(), mediaType: z.literal("image") }),
  z.object({ type: z.literal("url"), url: z.string(), mimeType: z.string().optional(), mediaType: z.literal("image") }),
])).min(1).max(4);

function invalid(message: string): never { throw Object.assign(new Error(message), { status: 409 }); }
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function taskDirectory(cwd: string, outputDirectory: string) {
  const output = await resolveWorkspacePath(cwd, outputDirectory, true);
  const key = process.platform === "win32" ? output.path.toLowerCase() : output.path;
  return (await resolveWorkspacePath(cwd, `.toonflow/imageTasks/${hash(key)}`, true)).path;
}

async function readJson(path: string, limit: number) {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return undefined;
  if (!info.isFile() || info.size > limit) invalid("图片任务记录无效，请保留文件并检查，不能重新提交");
  return JSON.parse(await readFile(path, "utf8"));
}

async function currentRecord(cwd: string, directory: string) {
  const path = (await resolveWorkspacePath(cwd, relative(cwd, join(directory, "current.json")), true)).path;
  const id = await readJson(path, 128);
  if (id === undefined) return null;
  const parsed = taskIdSchema.parse(id);
  const recordPath = (await resolveWorkspacePath(cwd, relative(cwd, join(directory, `${parsed}.json`)))).path;
  const value = await readJson(recordPath, 2 * 1024 * 1024);
  if (!value) invalid("图片任务索引不完整，请保留现场，不能重新提交");
  const record = recordSchema.parse(value);
  if (record.id !== parsed) invalid("图片任务索引与记录不匹配");
  return record;
}

export async function getImageTask(cwd: string, outputDirectory: string): Promise<ImageTaskStatus | null> {
  const directory = await taskDirectory(cwd, outputDirectory);
  const task = await currentRecord(cwd, directory);
  if (!task) return null;
  return {
    operationId: task.id, providerId: task.request.providerId, modelId: task.request.modelId,
    startedAt: task.createdAt, endedAt: task.finishedAt ?? (task.result || ["failed", "expired"].includes(task.state.phase) ? task.updatedAt : undefined),
    phase: task.result ? "completed" : task.state.phase, taskId: task.state.taskId, retryAt: task.state.retryAt,
    error: task.state.error ?? task.lastError, running: active.has(directory), result: task.result, updatedAt: task.updatedAt,
  };
}

export async function getImageTaskRequest(cwd: string, outputDirectory: string, operationId: string): Promise<MediaGenerationRequest> {
  const task = await currentRecord(cwd, await taskDirectory(cwd, outputDirectory));
  if (!task || task.id !== operationId) invalid("原图片任务不存在或已被新操作替代");
  if (task.request.outputDirectory !== outputDirectory) invalid("图片任务与节点不匹配");
  return task.request;
}

export async function runImageTask(
  cwd: string, input: MediaGenerationRequest, config: Record<string, unknown>,
  generate: (request: MediaGenerationRequest, context: ImageTaskContext) => Promise<GeneratedMedia[]>,
  sanitize: (error: unknown) => string, signal?: AbortSignal, recovery: "provider" | "result" = "provider",
) {
  const outputDirectory = input.outputDirectory ?? "assets/generated";
  const directory = await taskDirectory(cwd, outputDirectory);
  if (active.has(directory)) invalid("此节点的原图片任务仍在运行，不能重复提交");
  active.add(directory);
  try {
    await mkdir(directory, { recursive: true });
    const previous = await currentRecord(cwd, directory);
    const operationId = taskIdSchema.parse(input.operationId ?? crypto.randomUUID());
    const request = imageGenerationSchema.parse({ ...input, outputDirectory, operationId });
    const recordPath = (await resolveWorkspacePath(cwd, relative(cwd, join(directory, `${operationId}.json`)))).path;
    const value = await readJson(recordPath, 2 * 1024 * 1024);
    let record = value === undefined ? undefined : recordSchema.parse(value);
    if (previous && previous.id !== operationId && !previous.result && !["failed", "expired"].includes(previous.state.phase)) invalid("此节点存在未完成的图片任务，请先恢复原任务");
    const identity = hash(canonical({ apiKey: String(config.apiKey ?? "").trim().replace(/^Bearer\s+/i, "").trim(), apiUrl: new URL(String(config.apiUrl)).origin }));
    if (record) {
      if (record.id !== operationId || canonical(record.request) !== canonical(request)) invalid("同一操作不能修改图片参数，请恢复原任务");
      if (record.result) return record.result;
      if (record.identity !== identity) invalid("恢复图片任务须使用原 API 地址和密钥，请恢复原配置");
      if (["failed", "expired"].includes(record.state.phase)) invalid(record.state.error || "原图片任务已结束");
    } else {
      record = { version: 1, id: operationId, identity, request, recovery, state: { phase: "prepared" }, createdAt: Date.now(), updatedAt: Date.now() };
      await writeAtomic(recordPath, JSON.stringify(record), { exclusive: true });
    }
    await writeAtomic(join(directory, "current.json"), JSON.stringify(operationId));
    const task = record;
    const save = async () => {
      task.updatedAt = Date.now();
      if (task.result || ["failed", "expired"].includes(task.state.phase)) task.finishedAt ??= task.updatedAt;
      await writeAtomic(recordPath, JSON.stringify(task));
    };
    const requestPath = (await resolveWorkspacePath(cwd, relative(cwd, join(directory, `${operationId}.request.json`)))).path;
    const resultPath = (await resolveWorkspacePath(cwd, relative(cwd, join(directory, `${operationId}.result.json`)))).path;
    let requestSaved = !!(await stat(requestPath).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; }));
    if (!requestSaved && task.state.phase !== "prepared" && !(task.recovery === "result" && await readJson(resultPath, 140 * 1024 * 1024))) {
      invalid(task.recovery === "result" ? "原图片请求已提交，但尚未收到结果；请核查使用日志，不能重复生成" : "原图片请求快照缺失，不能重新生成，请保留记录并核查");
    }
    const context: ImageTaskContext = {
      id: operationId,
      get state() { return task.state; },
      get requestSaved() { return requestSaved; },
      async readRequest() {
        const saved = requestSchema.parse(await readJson(requestPath, 64 * 1024 * 1024));
        if (hash(saved.endpoint + "\n" + saved.body) !== saved.digest) invalid("原始图片请求已变化，不能重放提交");
        return saved;
      },
      async saveRequest(value) {
        if (requestSaved) invalid("不能覆盖原图片请求");
        const saved = requestSchema.parse({ ...value, digest: hash(value.endpoint + "\n" + value.body) });
        if (Buffer.byteLength(saved.body) > 45 * 1024 * 1024) invalid("图片请求超过 45 MiB");
        await writeAtomic(requestPath, JSON.stringify(saved), { exclusive: true });
        requestSaved = true;
      },
      async update(state) { task.state = stateSchema.parse({ ...task.state, ...state }); task.lastError = undefined; await save(); },
      async readResult() {
        const value = await readJson(resultPath, 140 * 1024 * 1024);
        return value === undefined ? undefined : assetsSchema.parse(value);
      },
      async saveResult(assets) {
        const value = JSON.stringify(assetsSchema.parse(assets));
        if (Buffer.byteLength(value) > 140 * 1024 * 1024) invalid("原图回执超过本地 140 MiB 缓存预算");
        // URL 下载完成后用原始字节替换回执快照，后续落盘恢复不再依赖临时 URL。
        await writeAtomic(resultPath, value);
        task.state = { ...task.state, phase: "downloading", error: undefined, retryAt: undefined };
        await save();
      },
    };
    try {
      const result = await generate(request, context);
      task.result = recordSchema.shape.result.parse(result);
      task.lastError = undefined;
      task.state.retryAt = undefined;
      await save();
      return result;
    } catch (error) {
      task.lastError = signal?.aborted ? "已停止本地等待；原任务和费用不会因此取消，请恢复原任务" : sanitize(error);
      if (!requestSaved && task.state.phase === "prepared") task.state = { phase: "failed", error: task.lastError };
      await save();
      throw error;
    }
  } finally { active.delete(directory); }
}
