import { createHash } from "node:crypto";
import { dirname, relative } from "node:path";
import { mkdir, readFile, rm, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import { lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";
import { getVideoTask } from "@/utils/media/videoTasks";
import { getImageTask } from "@/utils/media/imageTasks";
import { canvasChanges, mergeCanvas, sameCanvasValue, validateCanvas, type CanvasChange, type CanvasSnapshot } from "./canvasMerge";
import { captureDeletedNodes, commitRecycleRecord, validateRecycledMedia } from "./recycleBin";

export const elementSchema = z.looseObject({ id: z.string().min(1).max(500) });
export const canvasSchema = z.object({ toonflowCanvas: z.literal(true),
  nodes: z.array(elementSchema.extend({ position: z.object({ x: z.number().finite(), y: z.number().finite() }), data: z.record(z.string(), z.json()).optional() })),
  edges: z.array(elementSchema.extend({ source: z.string().min(1), target: z.string().min(1) })),
  viewport: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().positive() }),
});
export const changeSchema = z.object({ kind: z.enum(["nodes", "edges"]), id: z.string().min(1).max(500), before: elementSchema.optional(), after: elementSchema.optional() })
  .refine(change => (change.before !== undefined || change.after !== undefined) && (!change.before || change.before.id === change.id) && (!change.after || change.after.id === change.id));
type CanvasEvent = { path: string; revision?: string };
const eventHistory: { sequence: number; directory: string; event: CanvasEvent }[] = [];
const eventSession = crypto.randomUUID();
let eventSequence = 0;
const saves = new Map<string, Promise<unknown>>();
const normalize = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function recordChange(directory: string, event: CanvasEvent) {
  eventHistory.push({ sequence: ++eventSequence, directory: normalize(directory), event });
  // ACT: 全进程最多保留 256 条文件变更标记，不缓存画布正文；游标过旧时客户端重新同步打开的画布。
  if (eventHistory.length > 256) eventHistory.shift();
}

export function getUpdates(directory: string, cursor?: string) {
  const sequence = cursor?.startsWith(`${eventSession}:`) ? Number(cursor.slice(eventSession.length + 1)) : -1;
  const nextCursor = `${eventSession}:${eventSequence}`;
  if (!Number.isSafeInteger(sequence) || sequence < eventSequence - eventHistory.length || sequence > eventSequence) {
    return { cursor: nextCursor, events: [{ ready: true }] };
  }
  const changes = new Map<string, CanvasEvent>();
  const key = normalize(directory);
  for (const item of eventHistory) if (item.sequence > sequence && item.directory === key) changes.set(normalize(item.event.path), item.event);
  return { cursor: nextCursor, events: [...changes.values()] };
}

export function notifyFileChange(directory: string, path: string) {
  const name = relative(directory, path).replaceAll("\\", "/");
  if (!name.endsWith(".json") || name.startsWith(".toonflow/")) return;
  recordChange(directory, { path: name });
}

export async function readCanvas(path: string) {
  const bytes = await readFile(path);
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be"
    : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? "utf-8-bom" : "utf-8";
  const canvas = canvasSchema.parse(JSON.parse(new TextDecoder(encoding === "utf-8-bom" ? "utf-8" : encoding, { fatal: true }).decode(bytes))) as CanvasSnapshot;
  validateCanvas(canvas);
  return { canvas, revision: hash(bytes), encoding };
}

async function recoveryPath(directory: string, path: string, author: string) {
  return (await resolveWorkspacePath(directory, `.toonflow/recovery/${hash(`${normalize(path)}:${author}`)}.json`, true)).path;
}

export async function saveRecovery(directory: string, path: string, author: string, value: { base: CanvasSnapshot; local: CanvasSnapshot }) {
  const target = await recoveryPath(directory, path, author);
  await mkdir(dirname(target), { recursive: true });
  await writeAtomic(target, JSON.stringify({ path, savedAt: Date.now(), ...value }));
  return relative(directory, target).replaceAll("\\", "/");
}

export async function readRecovery(directory: string, path: string, author: string) {
  const text = await readFile(await recoveryPath(directory, path, author), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  return text ? JSON.parse(text) : null;
}

export async function removeRecovery(directory: string, path: string, author: string) {
  const target = await recoveryPath(directory, path, author);
  const content = await readFile(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!content) return;
  // 处理后保留一份最近的恢复记录，不把被用户舍弃的内容立即删除，也不无限积累历史文件。
  await writeAtomic(target.replace(/\.json$/, ".archived.json"), content);
  await rm(target, { force: true });
}

async function normalizeTaskResults(directory: string, changes: CanvasChange[], current: CanvasSnapshot) {
  const tasks = changes.filter(change => change.kind === "nodes" && change.after?.data?.generationTiming?.operationId
    && ["generationTiming", "outputs", "appliedImageTaskId", "appliedVideoTaskId"].some(field => !sameCanvasValue(change.before?.data?.[field], change.after?.data?.[field])));
  const nodes = new Map(current.nodes.map(node => [node.id, node]));
  for (let offset = 0; offset < tasks.length; offset += 4) await Promise.all(tasks.slice(offset, offset + 4).map(async change => {
    const node = change.after!;
    const type = node.type === "remote-videoGenerationNode" ? "video" : node.type === "remote-imageGenerationNode" ? "image" : undefined;
    if (!type) return;
    const task = await (type === "video" ? getVideoTask : getImageTask)(directory, `assets/${node.id}${type === "image" && node.data.inpaint ? "/inpaint" : ""}`);
    if (!task || task.operationId !== node.data.generationTiming.operationId) return;
    const result = task.result?.[0];
    const appliedField = type === "video" ? "appliedVideoTaskId" : "appliedImageTaskId";
    for (const target of [node, nodes.get(node.id)]) {
      if (!target || target.type !== node.type || target.data?.generationTiming?.operationId !== task.operationId) continue;
      // 重绘原片还需客户端合成，不能提前发布为节点成品。
      if (type === "image" && target.data.inpaint && task.phase === "completed" && target.data[appliedField] !== task.operationId) continue;
      if (task.phase === "completed" && result?.mediaType === type && target.data[appliedField] !== task.operationId) {
        target.data.outputs = { ...target.data.outputs, [type]: { dataType: type === "video" ? "VIDEO" : "IMAGE", value: { url: result.path, mimeType: result.mimeType } } };
        target.data[appliedField] = task.operationId;
      }
      target.data.generationTiming = { operationId: task.operationId, startedAt: task.startedAt, ...(task.endedAt ? { endedAt: task.endedAt } : {}),
        status: task.phase === "completed" ? "succeeded" : ["failed", "expired"].includes(task.phase) ? "failed" : task.running ? "running" : "interrupted" };
    }
  }));
}

export async function saveCanvas(directory: string, path: string, baseRevision: string, input: CanvasChange[], deletedNodes: CanvasSnapshot["nodes"] = [], deletedEdges: CanvasSnapshot["edges"] = []) {
  const resolved = await resolveWorkspacePath(directory, path);
  if (!/\.json$/i.test(path) || resolved.path === directory) throw Object.assign(new Error("请选择画布文件"), { status: 400 });
  const key = normalize(resolved.path);
  const pending = (saves.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const changes = structuredClone(input);
    const release = lockWorkspaceFiles([resolved.path]);
    try {
      const disk = await readCanvas(resolved.path);
      const current = structuredClone(disk.canvas);
      await normalizeTaskResults(directory, changes, current);
      const result = mergeCanvas(current, changes);
      if (result.conflicts.length) return { conflict: true as const, conflicts: result.conflicts, canvas: disk.canvas, revision: disk.revision };
      canvasSchema.parse(result.canvas);
      try { validateCanvas(result.canvas, disk.canvas); }
      catch (error) {
        if (baseRevision === disk.revision) throw Object.assign(error as Error, { status: 400 });
        return { conflict: true as const, conflicts: [], canvas: disk.canvas, revision: disk.revision,
          message: `${(error as Error).message}。本机修改已保留，可调整后重新合并，或保存副本并采用主机版本。` };
      }
      const accepted = canvasChanges(disk.canvas, result.canvas);
      await validateRecycledMedia(directory, accepted.filter(change => change.kind === "nodes" && !change.before && change.after).map(change => change.after!));
      const recycled = await captureDeletedNodes(directory, path, disk.canvas, result.canvas, deletedNodes, deletedEdges);
      let revision = disk.revision;
      if (accepted.length) {
        const text = `${JSON.stringify(result.canvas, null, 2)}\n`;
        let bytes = Buffer.from(text);
        if (disk.encoding === "utf-8-bom") bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
        else if (disk.encoding !== "utf-8") {
          bytes = Buffer.from(text, "utf16le");
          if (disk.encoding === "utf-16be") bytes.swap16();
          bytes = Buffer.concat([Buffer.from(disk.encoding === "utf-16be" ? [0xfe, 0xff] : [0xff, 0xfe]), bytes]);
        }
        await writeAtomic(resolved.path, bytes);
        revision = hash(bytes);
        recordChange(directory, { path, revision });
      }
      await commitRecycleRecord(directory, recycled);
      return { conflict: false as const, revision, baseRevision: disk.revision, changes: accepted, ...(baseRevision === disk.revision ? {} : { canvas: result.canvas }) };
    } finally { release(); }
  });
  saves.set(key, pending);
  try { return await pending; }
  finally { if (saves.get(key) === pending) saves.delete(key); }
}
