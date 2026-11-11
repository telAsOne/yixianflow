import { nextTick, onScopeDispose, ref, shallowRef, watch } from "vue";
import axios from "axios";
import { debounce } from "lodash-es";
import type { useVueFlow, Node, Edge } from "@vue-flow/core";
import useWorkspaceFiles, { type CanvasUpdate } from "@/lib/workspaceFiles";
import { canvasChanges, mergeCanvas, sameCanvasValue, validateCanvas, type CanvasSnapshot, type CanvasConflict } from "@toonflow/server/canvasMerge";
import { useNodeEvent } from "@toonflow/nodes-scaffold/nodeEvent";
import type { useCanvasHistory } from "./useCanvasHistory";

type Disk = { canvas: CanvasSnapshot; revision: string };
export function useCanvasSync(flow: ReturnType<typeof useVueFlow>, binding: () => { directory: string; path: string } | undefined,
  history: ReturnType<typeof useCanvasHistory>, updateSnapshot: (disk: Disk, dirty: boolean) => void) {
  const applying = ref(false);
  const conflict = shallowRef<{ remote: Disk; fields: CanvasConflict[]; message: string }>();
  const recoveryPath = ref("");
  const recoveryError = ref("");
  const dialogVisible = ref(false);
  const busy = ref(false);
  let baseline: Disk | undefined;
  let queue = Promise.resolve();
  let disposed = false;
  let pendingRemote = false;
  const current = (): CanvasSnapshot => JSON.parse(JSON.stringify({ toonflowCanvas: true, ...flow.toObject() }));
  const errorMessage = (error: unknown) => axios.isAxiosError(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "画布同步失败";

  function applyEdgeRemovals(edges: Edge[]) {
    flow.applyEdgeChanges(edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({ id, source, target, sourceHandle: sourceHandle ?? null, targetHandle: targetHandle ?? null, type: "remove" })));
  }

  flow.onNodesChange(changes => {
    const removed = new Set(changes.filter(change => change.type === "remove").map(change => change.id));
    // 固定连线不能单独删除，但目标节点删除后必须一并移除。
    const edges = flow.getEdges.value.filter(edge => edge.data?.videoContinuation && removed.has(edge.target) && !flow.findNode(edge.target));
    if (edges.length) applyEdgeRemovals(edges);
  });

  function enqueue<T>(action: () => Promise<T>) {
    const pending = queue.then(action);
    queue = pending.then(() => {}, () => {});
    return pending;
  }

  function checkBinding(expected: { directory: string; path: string }) {
    const active = binding();
    if (disposed || active?.directory !== expected.directory || active.path !== expected.path) throw new Error("画布已切换，本次同步已停止");
  }

  async function backup() {
    const target = binding();
    if (!target || !baseline) return;
    const base = baseline.canvas;
    const local = current();
    try {
      const path = await useWorkspaceFiles(target.directory).saveCanvasRecovery(target.path, base, local);
      checkBinding(target);
      recoveryPath.value = path;
      recoveryError.value = "";
    } catch (error) {
      recoveryError.value = `恢复草稿尚未写入磁盘：${errorMessage(error)}。请保留当前窗口。`;
      throw error;
    }
  }
  const scheduleBackup = debounce(() => { void enqueue(async () => { if (conflict.value) await backup(); }).catch(() => {}); }, 800, { maxWait: 3000 });

  async function archiveRecovery() {
    const target = binding();
    if (!target || !baseline || !recoveryPath.value || canvasChanges(baseline.canvas, current()).length) return;
    scheduleBackup.cancel();
    await useWorkspaceFiles(target.directory).removeCanvasRecovery(target.path);
    checkBinding(target);
    recoveryPath.value = recoveryError.value = "";
  }

  async function block(remote: Disk, fields: CanvasConflict[], message = "同一处内容存在不同修改，请选择保留的版本") {
    conflict.value = { remote, fields, message };
    await backup();
  }

  function assignFields(target: Record<string, any>, next: Record<string, any>, previous: Record<string, any>) {
    for (const key of Object.keys(previous)) if (!Object.hasOwn(next, key)) delete target[key];
    for (const [key, value] of Object.entries(next)) {
      // ACT: 只应用持久字段的变化；文本输出通过 toJSON 排除，不能被远端重命名时的空字典清除。
      if (sameCanvasValue(previous[key], value)) continue;
      // 输出字典与节点插件共用引用；替换每个输出值，让媒体 URL 的监听正常触发。
      if (key === "outputs" && target[key] && value && typeof value === "object") {
        for (const name of Object.keys(previous[key] ?? {})) if (!Object.hasOwn(value, name)) delete target[key][name];
        for (const [name, output] of Object.entries(value)) if (!sameCanvasValue(target[key][name], output)) target[key][name] = output;
      } else target[key] = value;
    }
  }

  async function apply(canvas: CanvasSnapshot, previous: CanvasSnapshot) {
    validateCanvas(canvas);
    const changes = canvasChanges(previous, canvas);
    if (!changes.length) return;
    let waitedForSave = false;
    for (const change of changes) {
      if (change.kind === "nodes" && change.before && (!change.after || change.before.type !== change.after.type)) {
        await useNodeEvent(change.id, flow).emit("save", "reload");
        waitedForSave = true;
      }
    }
    // ACT: 没有异步节点保存时，快照比较与应用处于同一同步段；跨 await 才重新核对本机修改。
    if (waitedForSave && canvasChanges(previous, current()).length) throw new Error("同步期间本机又有修改，请重新合并");
    applying.value = true;
    try {
      await history.applyRemote(async () => {
        for (const change of changes) {
          const element = change.kind === "nodes" ? flow.findNode(change.id) : flow.findEdge(change.id);
          if (!change.after) {
            if (change.kind === "nodes") flow.removeNodes(change.id);
            else if (element) applyEdgeRemovals([element as Edge]);
          } else if (!element || change.kind === "nodes" && element.type !== change.after.type) {
            if (element) flow.removeNodes(change.id);
            if (change.kind === "nodes") flow.addNodes(structuredClone(change.after) as Node);
            else flow.addEdges(structuredClone(change.after) as Edge);
          } else {
            for (const key of Object.keys(change.before ?? {})) if (!Object.hasOwn(change.after, key)) Reflect.deleteProperty(element, key);
            for (const [key, value] of Object.entries(change.after)) {
              if (sameCanvasValue(change.before?.[key], value)) continue;
              if (key === "data" && element.data && value) assignFields(element.data, structuredClone(value), change.before?.data ?? {});
              else Reflect.set(element, key, structuredClone(value));
            }
          }
        }
        await nextTick();
      });
    } finally { applying.value = false; }
  }

  function accept(disk: Disk) {
    baseline = structuredClone(disk);
    const dirty = canvasChanges(baseline.canvas, current()).length > 0;
    updateSnapshot(disk, dirty);
    return dirty;
  }

  async function receive(disk: Disk) {
    if (!baseline) return;
    const local = current();
    const merged = mergeCanvas(disk.canvas, canvasChanges(baseline.canvas, local));
    if (merged.conflicts.length) { await block(disk, merged.conflicts); return; }
    try { await apply(merged.canvas, local); }
    catch (error) { await block(disk, [], errorMessage(error)); return; }
    conflict.value = undefined;
    accept(disk);
    await archiveRecovery();
  }

  async function readDisk(target: { directory: string; path: string }): Promise<Disk> {
    const snapshot = await useWorkspaceFiles(target.directory).readTextSnapshot(target.path);
    checkBinding(target);
    const canvas = JSON.parse(snapshot.text) as CanvasSnapshot;
    validateCanvas(canvas);
    return { canvas, revision: snapshot.revision };
  }

  function sync(event?: CanvasUpdate) {
    return enqueue(async () => {
      if (history.busy.value) { pendingRemote = true; return; }
      const target = binding();
      if (!target || !baseline || event?.revision === baseline.revision) return;
      const disk = await readDisk(target);
      checkBinding(target);
      if (disk.revision !== baseline.revision || conflict.value || canvasChanges(baseline.canvas, current()).length) await receive(disk);
    });
  }
  watch(history.busy, busy => {
    if (busy || !pendingRemote) return;
    pendingRemote = false;
    void sync().catch(error => { recoveryError.value = errorMessage(error); });
  });

  function initialize(disk: Disk) {
    accept(disk);
    conflict.value = undefined;
    recoveryPath.value = recoveryError.value = "";
    const target = binding();
    if (!target) return;
    void enqueue(async () => {
      const recovery = await useWorkspaceFiles(target.directory).getCanvasRecovery(target.path);
      checkBinding(target);
      if (recovery && canvasChanges(recovery.base, recovery.local).length) {
        let restored = mergeCanvas(current(), canvasChanges(recovery.base, recovery.local));
        let message = "检测到上次未保存的修改，请合并后保存或采用主机版本";
        try { validateCanvas(restored.canvas); }
        catch (error) {
          validateCanvas(recovery.local);
          restored = { canvas: recovery.local, conflicts: [] };
          message = `已恢复上次本机草稿，但无法自动合并：${errorMessage(error)}`;
        }
        await apply(restored.canvas, current());
        baseline = { canvas: recovery.base, revision: disk.revision };
        await block(await readDisk(target), restored.conflicts, message);
      } else {
        // 补齐首次读盘到同步就绪之间的更新。
        const latest = await readDisk(target);
        if (latest.revision !== baseline?.revision) await receive(latest);
      }
    }).catch(error => { if (!disposed) recoveryError.value = errorMessage(error); });
  }

  function save() {
    return enqueue(async () => {
      const target = binding();
      if (!target || !baseline) throw new Error("画布尚未完成读取，无法保存");
      if (conflict.value) { await backup(); throw new Error(conflict.value.message); }
      const before = baseline;
      const local = current();
      const changes = canvasChanges(before.canvas, local);
      const deletedNodes = history.getDeletedNodes();
      let dirty = false;
      try {
        if (changes.length || deletedNodes.length) {
          const result = await useWorkspaceFiles(target.directory).saveCanvasChanges(target.path, before.revision, changes, deletedNodes.map(entry => entry.node), deletedNodes.flatMap(entry => entry.edges));
          checkBinding(target);
          history.acknowledgeDeletions(deletedNodes);
          const disk = { canvas: result.canvas ?? mergeCanvas(before.canvas, result.changes).canvas, revision: result.revision };
          const latest = current();
          const merged = mergeCanvas(disk.canvas, canvasChanges(local, latest));
          if (merged.conflicts.length) { await block(disk, merged.conflicts); throw new Error(conflict.value!.message); }
          try { await apply(merged.canvas, latest); }
          catch (error) { await block(disk, [], errorMessage(error)); throw error; }
          dirty = accept(disk);
        }
        await archiveRecovery();
        return dirty;
      } catch (error) {
        const data = axios.isAxiosError(error) ? error.response?.data?.data : undefined;
        if (data?.code === "ECANVASCONFLICT") await block({ canvas: data.canvas, revision: data.revision }, data.conflicts, data.message);
        throw error;
      }
    });
  }

  async function resolve(choices: Record<string, "local" | "remote">, useRemote = false) {
    if (busy.value) return;
    busy.value = true;
    scheduleBackup.cancel();
    try {
      await enqueue(async () => {
        const target = binding();
        if (!target || !baseline || !conflict.value) return;
        await backup();
        const disk = conflict.value.remote;
        const local = current();
        const resolved = useRemote ? { canvas: disk.canvas, conflicts: [] } : mergeCanvas(disk.canvas, canvasChanges(baseline.canvas, local), choices);
        if (resolved.conflicts.length) {
          conflict.value = { remote: disk, fields: resolved.conflicts, message: "画布又有新的修改，请选择每一处冲突要保留的版本" };
          throw new Error(conflict.value.message);
        }
        await apply(resolved.canvas, local);
        conflict.value = undefined;
        accept(disk);
      });
      await save();
      if (conflict.value) return;
      dialogVisible.value = false;
    } finally { busy.value = false; }
  }

  onScopeDispose(() => { disposed = true; scheduleBackup.flush(); scheduleBackup.cancel(); });
  return { applying, conflict, recoveryPath, recoveryError, dialogVisible, busy, initialize, save, sync, resolve, scheduleBackup,
    isDirty: () => !!baseline && canvasChanges(baseline.canvas, current()).length > 0,
    flushRecovery: async () => { scheduleBackup.cancel(); if (conflict.value) await backup(); } };
}
