import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { Request } from "express";
import { lstat, mkdir, readFile, readdir, realpath, rm, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import conf from "@/utils/conf";
import { lockWorkspaceFiles, resolveWorkspacePath } from "./files";
import { beginWorkspaceCleanup } from "./activity";
import { validateCanvas, type CanvasSnapshot } from "./canvasMerge";
import { recycleAssetRoots, recycleNodeRoots, type RecycleEntry, type RecycleOverview } from "./recycleTypes";

const retentionDays = Math.min(90, Math.max(1, Number(process.env.TOONFLOW_RECYCLE_RETENTION_DAYS) || 7));
const retentionMs = retentionDays * 86400000;
const recordSchema = z.object({
  id: z.uuid(), kind: z.enum(["nodes", "canvas"]), canvasPath: z.string().min(1), label: z.string(),
  deletedAt: z.number(), expiresAt: z.number(), status: z.enum(["pending", "deleted", "restored", "purging"]),
  snapshot: z.object({ toonflowCanvas: z.literal(true), nodes: z.array(z.looseObject({ id: z.string().min(1),
    position: z.object({ x: z.number(), y: z.number() }), parentNode: z.string().optional(), data: z.record(z.string(), z.any()).optional() })),
    edges: z.array(z.looseObject({ id: z.string(), source: z.string(), target: z.string() })),
    viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number().positive() }) }),
  positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })),
  error: z.string().optional(), restoredPath: z.string().optional(), restoreRevision: z.string().optional(),
});
type RecycleRecord = z.infer<typeof recordSchema>;
const registryPath = join(dirname(conf.path), "recycleWorkspaces.json");
const registered = new Set<string>();
let registryQueue = Promise.resolve();
let maintenanceStarted = false;
let maintenanceRunning = false;
const pins = new Map<string, { directory: string; roots: string[]; seenAt: number }>();

function failure(message: string, status = 409): never { throw Object.assign(new Error(message), { status }); }
function missing(error: NodeJS.ErrnoException) { if (error.code !== "ENOENT") throw error; return undefined; }
function normalized(path: string) { return process.platform === "win32" ? path.toLowerCase() : path; }
function recordPath(directory: string, id: string) { return resolveWorkspacePath(directory, `.toonflow/recycleBin/${z.uuid().parse(id)}.json`, true); }

export async function registerRecycleWorkspace(directory: string) {
  if (registered.has(directory)) return;
  registered.add(directory);
  const persist = registryQueue.catch(() => {}).then(async () => {
    const previous = z.array(z.string()).parse(JSON.parse(await readFile(registryPath, "utf8").catch(error => {
      if (error.code === "ENOENT") return "[]";
      throw error;
    })));
    await writeAtomic(registryPath, JSON.stringify([...new Set([...previous, ...registered])]), { mode: 0o600 });
  });
  registryQueue = persist;
  try { await persist; } catch (error) { registered.delete(directory); throw error; }
}

async function writeRecord(directory: string, record: RecycleRecord) {
  const target = await recordPath(directory, record.id);
  await mkdir(dirname(target.path), { recursive: true });
  await writeAtomic(target.path, JSON.stringify(record), { mode: 0o600 });
}

async function readRecords(directory: string) {
  const folder = await resolveWorkspacePath(directory, ".toonflow/recycleBin", true);
  const entries = await readdir(folder.path, { withFileTypes: true }).catch(error => { missing(error); return []; });
  const records: RecycleRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !z.uuid().safeParse(entry.name.replace(/\.json$/, "")).success || !entry.name.endsWith(".json")) continue;
    const target = await recordPath(directory, entry.name.slice(0, -5));
    const info = await lstat(target.path);
    if (info.size > 100 * 1024 * 1024) failure("回收记录过大，已停止清理，请检查项目", 422);
    const record = recordSchema.parse(JSON.parse(await readFile(target.path, "utf8")));
    if (`${record.id}.json` !== entry.name) failure("回收记录标识不一致，已停止清理", 422);
    records.push(record);
  }
  return records;
}

export async function captureDeletedNodes(directory: string, path: string, before: CanvasSnapshot, after?: CanvasSnapshot, deletedNodes: CanvasSnapshot["nodes"] = [], deletedEdges: CanvasSnapshot["edges"] = []) {
  const retained = new Set(after?.nodes.map(node => node.id));
  const recent = new Map(deletedNodes.map(node => [node.id, node]));
  const nodes = before.nodes.filter(node => !retained.has(node.id)
    && !(after && node.type === "canvasGroup" && before.nodes.some(child => child.parentNode === node.id && retained.has(child.id))))
    .map(node => recent.get(node.id) ?? node);
  const previousIds = new Set(before.nodes.map(node => node.id));
  const ephemeral = deletedNodes.filter(node => !retained.has(node.id) && !previousIds.has(node.id));
  if (ephemeral.length) {
    const recorded = new Set((await readRecords(directory)).filter(record => record.canvasPath === path && record.status !== "restored" && record.status !== "purging").flatMap(record => record.snapshot.nodes.map(node => node.id)));
    nodes.push(...ephemeral.filter(node => !recorded.has(node.id)));
  }
  if (after && !nodes.length) return;
  await registerRecycleWorkspace(directory);
  const ids = new Set(nodes.map(node => node.id));
  const byId = new Map([...before.nodes, ...deletedNodes].map(node => [node.id, node]));
  const positions: RecycleRecord["positions"] = Object.create(null);
  for (const node of nodes) {
    let current = node;
    const position = { x: node.position?.x ?? 0, y: node.position?.y ?? 0 };
    const visited = new Set([node.id]);
    while (current.parentNode && byId.has(current.parentNode) && !visited.has(current.parentNode)) {
      current = byId.get(current.parentNode)!;
      visited.add(current.id);
      position.x += current.position?.x ?? 0;
      position.y += current.position?.y ?? 0;
    }
    positions[node.id] = position;
  }
  const deletedAt = Date.now();
  const record: RecycleRecord = {
    id: crypto.randomUUID(), kind: after ? "nodes" : "canvas", canvasPath: path,
    label: after ? nodes.length === 1 ? String(nodes[0]!.data?.label || "未命名节点") : `${nodes.length} 个节点` : basename(path, ".json"),
    deletedAt, expiresAt: deletedAt + retentionMs, status: "pending", positions,
    snapshot: { ...before, nodes, edges: [...new Map([...before.edges, ...deletedEdges].filter(edge => ids.has(edge.source) || ids.has(edge.target)).map(edge => [edge.id, edge])).values()] } as RecycleRecord["snapshot"],
  };
  await writeRecord(directory, record);
  return record;
}

export async function commitRecycleRecord(directory: string, record?: RecycleRecord) {
  if (!record) return;
  record.status = "deleted";
  // 已保存画布后遇到磁盘故障，保留 pending 日志；下次读取按实际画布内容恢复提交状态。
  await writeRecord(directory, record).catch(error => console.error("回收记录提交待恢复：", error));
}

async function reconcileRecords(directory: string, records: RecycleRecord[]) {
  const { readCanvas } = await import("./canvasSync");
  for (const record of records) {
    if (record.status === "purging" || record.status === "restored") continue;
    if (record.restoredPath && record.restoreRevision) {
      const restored = await resolveWorkspacePath(directory, record.restoredPath, true);
      const bytes = await readFile(restored.path).catch(missing);
      if (bytes && createHash("sha256").update(bytes).digest("hex") === record.restoreRevision) {
        record.status = "restored";
        await writeRecord(directory, record);
        continue;
      }
    }
    const target = await resolveWorkspacePath(directory, record.canvasPath, true);
    const disk = await readCanvas(target.path).catch(missing);
    const live = new Set(disk?.canvas.nodes.map(node => node.id));
    const restored = record.kind === "canvas" ? false : record.snapshot.nodes.every(node => live.has(node.id));
    if (record.status === "pending") {
      if (record.kind === "canvas" && disk || restored) {
        record.status = "restored";
      } else record.status = "deleted";
      await writeRecord(directory, record);
    } else if (restored) {
      record.status = "restored";
      await writeRecord(directory, record);
    }
  }
}

async function treeBytes(directory: string, path: string): Promise<number> {
  const target = await resolveWorkspacePath(directory, path, true);
  const info = await lstat(target.path).catch(missing);
  if (!info) return 0;
  if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) failure("素材目录含有符号链接或特殊文件，已停止清理", 422);
  if (info.isFile()) return info.size;
  let bytes = 0;
  for (const entry of await readdir(target.path)) bytes += await treeBytes(directory, `${path}/${entry}`);
  return bytes;
}

async function protectedRoots(directory: string, records: RecycleRecord[], excluding = new Set<string>()) {
  const roots = new Set<string>();
  const collect = (value: unknown) => { for (const root of recycleAssetRoots(value)) roots.add(root); };
  const folders = [""];
  while (folders.length) {
    const folder = folders.pop()!;
    const target = await resolveWorkspacePath(directory, folder, true);
    for (const entry of await readdir(target.path, { withFileTypes: true })) {
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      if (path === "assets" || path === ".toonflow/recycleBin" || entry.name === ".git") continue;
      if (entry.isSymbolicLink()) failure("项目存在符号链接，无法确认素材引用，已停止清理", 422);
      if (entry.isDirectory()) { folders.push(path); continue; }
      if (!entry.isFile() || !/\.(json|jsonl|md|txt)$/i.test(entry.name)) continue;
      const file = await resolveWorkspacePath(directory, path);
      const info = await lstat(file.path);
      if (info.size > 100 * 1024 * 1024) failure("项目引用文件过大，无法安全清理", 422);
      const raw = await readFile(file.path);
      const text = new TextDecoder(raw[0] === 0xff ? "utf-16le" : raw[0] === 0xfe ? "utf-16be" : "utf-8").decode(raw);
      if (path.startsWith(".toonflow/imageTasks/") || path.startsWith(".toonflow/videoTasks/")) {
        const task = JSON.parse(text);
        if (task && typeof task === "object" && !task.result && (!task.finishedAt || task.state?.taskId && task.state?.phase !== "expired")) collect(task);
        continue;
      }
      if (path.startsWith(".toonflow/recovery/") && entry.name.endsWith(".archived.json")) {
        const recovery = JSON.parse(text);
        if (Date.now() - Number(recovery.savedAt || info.mtimeMs) < retentionMs) collect(recovery);
        continue;
      }
      if (/\.json$/i.test(path)) {
        const value = JSON.parse(text.replace(/^\uFEFF/, ""));
        if (value?.toonflowCanvas === true) {
          validateCanvas(value);
          for (const root of recycleNodeRoots(value.nodes)) roots.add(root);
        }
        collect(value);
      } else collect(text);
    }
  }
  for (const record of records) {
    if (!excluding.has(record.id) && record.status !== "restored" && record.status !== "purging" && record.expiresAt > Date.now()) {
      for (const root of recycleNodeRoots(record.snapshot.nodes)) roots.add(root);
    }
  }
  for (const [key, pin] of pins) {
    if (Date.now() - pin.seenAt > 120000) { pins.delete(key); continue; }
    if (pin.directory === directory) for (const root of pin.roots) roots.add(root);
  }
  return new Set([...roots].map(normalized));
}

function ownedRoots(record: RecycleRecord) {
  // ACT: 只回收本次删除节点的所属目录；不从引用 URL 推断所有权，也不清扫历史遗留目录。
  return [...recycleNodeRoots(record.snapshot.nodes.map(node => ({ id: node.id })))];
}

export async function validateRecycledMedia(directory: string, nodes: CanvasSnapshot["nodes"]) {
  const paths = new Set<string>();
  for (const node of nodes) {
    if (typeof node.data?.textPath === "string") paths.add(node.data.textPath);
    for (const output of Object.values(node.data?.outputs ?? {}) as any[]) {
      if (["IMAGE", "VIDEO", "AUDIO"].includes(output?.dataType) && typeof output.value?.url === "string") paths.add(output.value.url);
    }
  }
  for (const path of paths) {
    if (!/^assets[\\/]/.test(path)) continue;
    const target = await resolveWorkspacePath(directory, path, true);
    const info = await lstat(target.path).catch(missing);
    if (!info?.isFile()) failure("素材保留期已结束或文件已被移走，无法完整恢复该节点", 410);
  }
}

export function pinRecycleHistory(directory: string, sessionId: string, roots: string[]) {
  const key = `${directory}:${sessionId}`;
  if (!pins.has(key) && [...pins.values()].filter(pin => pin.directory === directory).length >= 256) failure("项目在线会话过多", 429);
  pins.set(key, { directory, roots, seenAt: Date.now() });
}

export async function getRecycleOverview(directory: string, inventory = true): Promise<RecycleOverview> {
  await registerRecycleWorkspace(directory);
  const release = lockWorkspaceFiles([directory]);
  try {
    const records = await readRecords(directory);
    await reconcileRecords(directory, records);
    const visible = records.filter(record => record.status === "deleted" && record.expiresAt > Date.now());
    const managed = records.filter(record => record.status === "purging" || visible.includes(record));
    const roots = [...new Set(managed.flatMap(ownedRoots))];
    const bytes = new Map<string, number>();
    for (const root of roots) bytes.set(root, await treeBytes(directory, root));
    const protectedSet = await protectedRoots(directory, records, new Set(visible.map(record => record.id)));
    const entries: RecycleEntry[] = visible.map(record => {
      const roots = ownedRoots(record);
      const media = record.snapshot.nodes.flatMap(node => Object.values(node.data?.outputs ?? {})).find((output: any) => output?.value?.url && /^(image|video)\//.test(output.value.mimeType));
      return { id: record.id, kind: record.kind, canvasPath: record.canvasPath, label: record.label,
        deletedAt: record.deletedAt, expiresAt: record.expiresAt, nodeCount: record.snapshot.nodes.length,
        assetBytes: roots.reduce((sum, root) => sum + (bytes.get(root) ?? 0), 0),
        reclaimableBytes: roots.reduce((sum, root) => sum + (protectedSet.has(normalized(root)) ? 0 : bytes.get(root) ?? 0), 0),
        ...(media ? { preview: { path: (media as any).value.url, mimeType: (media as any).value.mimeType } } : {}), ...(record.error ? { error: record.error } : {}) };
    }).sort((a, b) => b.deletedAt - a.deletedAt);
    let orphanBytes = 0, orphanCount = 0;
    if (inventory) {
      const protectedAll = await protectedRoots(directory, records);
      const managedRoots = new Set(records.flatMap(ownedRoots).map(normalized));
      const assets = await resolveWorkspacePath(directory, "assets", true);
      for (const entry of await readdir(assets.path, { withFileTypes: true }).catch(error => { missing(error); return []; })) {
        const root = `assets/${entry.name}`;
        if (!entry.isDirectory() || managedRoots.has(normalized(root)) || protectedAll.has(normalized(root))) continue;
        orphanBytes += await treeBytes(directory, root);
        orphanCount++;
      }
    }
    return { entries, retentionDays, assetBytes: [...bytes.values()].reduce((sum, size) => sum + size, 0),
      reclaimableBytes: roots.reduce((sum, root) => sum + (protectedSet.has(normalized(root)) ? 0 : bytes.get(root) ?? 0), 0), orphanBytes, orphanCount,
      pendingCleanupCount: records.filter(record => record.status === "purging").length,
      cleanupErrors: records.flatMap(record => record.error ? [`${record.label}：${record.error}`] : []) };
  } finally { release(); }
}

export async function restoreRecycleEntry(directory: string, id: string) {
  const release = lockWorkspaceFiles([directory]);
  try {
    const records = await readRecords(directory);
    await reconcileRecords(directory, records);
    const record = records.find(record => record.id === id);
    if (!record || record.expiresAt <= Date.now() || record.status === "purging") failure("该记录已过保留期或已永久删除", 410);
    if (record.status === "restored") return { path: record.restoredPath ?? record.canvasPath };
    const { readCanvas, notifyFileChange } = await import("./canvasSync");
    let path = record.canvasPath;
    let target = await resolveWorkspacePath(directory, path, true);
    let disk = record.kind === "nodes" ? await readCanvas(target.path).catch(missing) : undefined;
    if (record.kind === "canvas" && await lstat(target.path).catch(missing)) {
      for (let number = 1; ; number++) {
        path = `${record.canvasPath.slice(0, -5)}（恢复${number}）.json`;
        target = await resolveWorkspacePath(directory, path, true);
        if (!(await lstat(target.path).catch(missing))) break;
      }
      disk = undefined;
    }
    const canvas = disk?.canvas ?? { toonflowCanvas: true as const, nodes: [], edges: [], viewport: record.snapshot.viewport };
    const nodeIds = new Set(canvas.nodes.map(node => node.id));
    for (const node of record.snapshot.nodes) nodeIds.add(node.id);
    const restoredNodes = record.snapshot.nodes.filter(node => !canvas.nodes.some(current => current.id === node.id)).map(node => {
      const copy = structuredClone(node);
      if (copy.parentNode && !nodeIds.has(copy.parentNode)) {
        delete copy.parentNode; delete copy.extent; delete copy.expandParent;
        copy.position = record.positions[copy.id];
      }
      return copy;
    });
    const edges = record.snapshot.edges.filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target) && !canvas.edges.some(current => current.id === edge.id));
    const next: CanvasSnapshot = { ...canvas, nodes: [...canvas.nodes, ...restoredNodes], edges: [...canvas.edges, ...edges] };
    validateCanvas(next);
    await validateRecycledMedia(directory, restoredNodes);
    for (const root of recycleNodeRoots(restoredNodes)) {
      const owned = records.filter(item => item.status === "purging").some(item => ownedRoots(item).includes(root));
      if (owned && !(await lstat((await resolveWorkspacePath(directory, root, true)).path).catch(missing))) failure("部分素材已永久删除，无法完整恢复", 410);
    }
    await mkdir(dirname(target.path), { recursive: true });
    const text = `${JSON.stringify(next, null, 2)}\n`;
    record.restoredPath = path;
    record.restoreRevision = createHash("sha256").update(text).digest("hex");
    await writeRecord(directory, record);
    await writeAtomic(target.path, text, { exclusive: !disk });
    record.status = "restored"; record.restoredPath = path;
    await writeRecord(directory, record);
    notifyFileChange(directory, target.path);
    return { path };
  } finally { release(); }
}

export async function recycleCanvasFile(directory: string, path: string) {
  const { readCanvas } = await import("./canvasSync");
  const target = await resolveWorkspacePath(directory, path);
  if ((await lstat(target.path)).size > 100 * 1024 * 1024) failure("文件过大，无法完整写入回收站，请先导出备份", 422);
  const text = await readFile(target.path);
  const probe = new TextDecoder(text[0] === 0xff ? "utf-16le" : text[0] === 0xfe ? "utf-16be" : "utf-8").decode(text);
  let value: any;
  try { value = JSON.parse(probe); } catch { return false; }
  if (value?.toonflowCanvas !== true) return false;
  const disk = await readCanvas(target.path);
  const record = await captureDeletedNodes(directory, path, disk.canvas);
  await rm(target.path);
  await commitRecycleRecord(directory, record);
  return true;
}

export async function captureCanvasOverwrite(directory: string, path: string, bytes: Uint8Array) {
  if (!/\.json$/i.test(path) || path.startsWith(".toonflow/")) return;
  const target = await resolveWorkspacePath(directory, path);
  const previous = await readFile(target.path).catch(missing);
  if (!previous) return;
  const decode = (value: Uint8Array) => new TextDecoder(value[0] === 0xff ? "utf-16le" : value[0] === 0xfe ? "utf-16be" : "utf-8").decode(value);
  let value: any;
  try { value = JSON.parse(decode(previous)); } catch { return; }
  if (value?.toonflowCanvas !== true) return;
  const { readCanvas, canvasSchema } = await import("./canvasSync");
  const before = await readCanvas(target.path);
  const after = canvasSchema.parse(JSON.parse(decode(bytes))) as CanvasSnapshot;
  try { validateCanvas(after, before.canvas); }
  catch (error) { throw Object.assign(error as Error, { status: 400 }); }
  const previousIds = new Set(before.canvas.nodes.map(node => node.id));
  await validateRecycledMedia(directory, after.nodes.filter(node => !previousIds.has(node.id)));
  return captureDeletedNodes(directory, path, before.canvas, after);
}

export async function cleanRecycleEntries(directory: string, ids?: string[], request?: Request) {
  const endCleanup = beginWorkspaceCleanup(directory, request);
  let release: (() => void) | undefined;
  try {
    release = lockWorkspaceFiles([directory]);
    const records = await readRecords(directory);
    await reconcileRecords(directory, records);
    // 已恢复的记录到期只移除快照；后续再次删除节点会登记新的回收记录。
    for (const record of records) if (record.status === "restored" && record.expiresAt <= Date.now()) await rm((await recordPath(directory, record.id)).path);
    const selected = ids ? records.filter(record => record.status !== "restored" && (ids.includes(record.id) || record.status === "purging"))
      : records.filter(record => record.status !== "restored" && (record.status === "purging" || record.expiresAt <= Date.now()));
    if (!selected.length) return { freedBytes: 0, retainedCount: 0 };
    for (const record of selected) { record.status = "purging"; await writeRecord(directory, record); }
    const roots = await protectedRoots(directory, records);
    const removed = new Set<string>();
    let freedBytes = 0, retainedCount = 0;
    for (const record of selected) {
      let retained = false;
      try {
        for (const root of ownedRoots(record)) {
          if (roots.has(normalized(root))) { retained = true; continue; }
          if (removed.has(root)) continue;
          const size = await treeBytes(directory, root);
          const target = await resolveWorkspacePath(directory, root, true);
          await rm(target.path, { recursive: true, force: true });
          freedBytes += size;
          removed.add(root);
        }
        if (retained) { retainedCount++; delete record.error; await writeRecord(directory, record); }
        else await rm((await recordPath(directory, record.id)).path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        record.error = ["EBUSY", "EPERM"].includes(code ?? "") ? "素材正在被占用，服务器会在空闲后重试"
          : code === "EACCES" ? "素材删除权限不足，请检查服务器文件权限后重试" : "素材清理未完成，服务器会自动重试";
        console.warn(`回收素材清理失败 ${record.id}：`, error);
        await writeRecord(directory, record);
        retainedCount++;
      }
    }
    return { freedBytes, retainedCount };
  } finally { release?.(); endCleanup(); }
}

export function startRecycleMaintenance() {
  if (maintenanceStarted) return;
  maintenanceStarted = true;
  const run = async () => {
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    try {
      const directories = z.array(z.string()).parse(JSON.parse(await readFile(registryPath, "utf8").catch(error => { missing(error); return "[]"; })));
      for (const directory of directories) {
        try {
          if (normalized(await realpath(directory)) !== normalized(directory)) continue;
          await cleanRecycleEntries(directory);
        } catch (error) {
          if (["ENOENT", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
          console.error("项目回收站定时清理失败：", error);
        }
      }
    } catch (error) { console.error("回收站清理调度失败：", error); }
    finally { maintenanceRunning = false; }
  };
  // ACT: 单进程每小时串行处理登记项目；重启后先给在线画布两分钟续期撤销保护。
  setTimeout(() => { void run(); setInterval(() => { void run(); }, 3600000).unref(); }, 120000).unref();
}
