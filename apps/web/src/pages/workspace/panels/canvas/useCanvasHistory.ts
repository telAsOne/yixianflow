import { computed, nextTick, onScopeDispose, ref, shallowRef, watch } from "vue";
import { debounce } from "lodash-es";
import { useVueFlow, type Node, type Edge } from "@vue-flow/core";
import { useNodeEvent } from "@toonflow/nodes-scaffold/nodeEvent";
import { canvasChanges, mergeCanvas, type CanvasSnapshot as SharedCanvasSnapshot } from "@toonflow/server/canvasMerge";

type CanvasSnapshot = { nodes: Node[]; edges: Edge[]; key: string };

export function useCanvasHistory(flow: ReturnType<typeof useVueFlow>, binding: () => string) {
  const snapshots = shallowRef<CanvasSnapshot[]>([]);
  const cursor = ref(-1);
  const applying = ref(false);
  const grouping = ref(0);
  const nodeReferences = new Map<string, Node>();
  const pendingDeletions = new Map<string, { node: Node; version: number; edges: Edge[] }>();
  let previousNodeIds = new Set<string>();
  let previousEdges: Edge[] = [];
  let deletionVersion = 0;
  const edgeReferences = new Map<string, Edge>();
  const nodeRuntimeFields = new Set(["data", "computedPosition", "handleBounds", "selected", "dimensions", "isParent", "resizing", "dragging", "events", "initialized"]);
  const edgeRuntimeFields = new Set(["data", "selected", "sourceNode", "targetNode", "sourceX", "sourceY", "targetX", "targetY", "events", "initialized"]);
  let revision = 0;
  let dragging = false;
  const canUndo = computed(() => !!binding() && !applying.value && !grouping.value && cursor.value > 0);
  const canRedo = computed(() => !!binding() && !applying.value && !grouping.value && cursor.value < snapshots.value.length - 1);
  const busy = computed(() => applying.value || grouping.value > 0);

  function capture(): CanvasSnapshot {
    const nodeIds = new Set(flow.getNodes.value.map(node => node.id));
    for (const id of previousNodeIds) {
      const node = nodeReferences.get(id);
      if (!nodeIds.has(id) && node) pendingDeletions.set(id, { node, version: ++deletionVersion,
        edges: previousEdges.filter(edge => edge.source === id || edge.target === id) });
    }
    for (const id of nodeIds) pendingDeletions.delete(id);
    previousNodeIds = nodeIds;
    previousEdges = [...flow.getEdges.value];
    flow.getNodes.value.forEach(node => nodeReferences.set(node.id, node));
    flow.getEdges.value.forEach(edge => edgeReferences.set(edge.id, edge));
    const fields = (element: Node | Edge, runtimeFields: Set<string>) => Object.fromEntries(
      Object.entries(element).filter(([key]) => !runtimeFields.has(key)),
    );
    // ACT: 只复制结构和名称；删除后恢复内容由上面的节点、连线引用保留。
    const key = JSON.stringify({
      nodes: flow.getNodes.value.map(node => ({ ...fields(node, nodeRuntimeFields), data: { label: node.data?.label } })),
      edges: flow.getEdges.value.map(edge => fields(edge, edgeRuntimeFields)),
    });
    return { ...JSON.parse(key), key };
  }

  function commit() {
    if (!binding() || applying.value || grouping.value) return;
    const snapshot = capture();
    if (snapshot.key === snapshots.value[cursor.value]?.key) return;
    // ACT: 最多保存 100 步画布结构；节点内部内容、生成结果和外部文件不属于撤销历史。
    snapshots.value = [...snapshots.value.slice(0, cursor.value + 1), snapshot].slice(-101);
    cursor.value = snapshots.value.length - 1;
    const nodeIds = new Set(snapshots.value.flatMap(item => item.nodes.map(node => node.id)));
    const edgeIds = new Set(snapshots.value.flatMap(item => item.edges.map(edge => edge.id)));
    for (const id of nodeReferences.keys()) if (!nodeIds.has(id)) nodeReferences.delete(id);
    for (const id of edgeReferences.keys()) if (!edgeIds.has(id)) edgeReferences.delete(id);
  }

  const record = debounce(commit, 0);

  function restoreFields(element: Node | Edge, snapshot: Node | Edge, runtimeFields: Set<string>) {
    for (const key of Object.keys(element)) {
      if (!runtimeFields.has(key) && !Object.hasOwn(snapshot, key) && typeof Reflect.get(element, key) !== "function") Reflect.deleteProperty(element, key);
    }
    for (const [key, value] of Object.entries(snapshot)) {
      if (!runtimeFields.has(key)) Reflect.set(element, key, value);
    }
  }

  async function restore(index: number) {
    const target = snapshots.value[index];
    if (!target || !binding() || applying.value || grouping.value) return;
    const snapshot = JSON.parse(JSON.stringify(target)) as CanvasSnapshot;
    const currentRevision = revision;
    const before = capture();
    const nodeIds = new Set(snapshot.nodes.map(node => node.id));
    const removedNodes = flow.getNodes.value.filter(node => !nodeIds.has(node.id));
    applying.value = true;
    record.cancel();
    try {
      for (const node of removedNodes) {
        await useNodeEvent(node.id, flow).emit("save");
        if (currentRevision !== revision) return;
        await useNodeEvent(node.id, flow).emit("delete");
        if (currentRevision !== revision) return;
      }
      if (capture().key !== before.key || removedNodes.some(node => flow.findNode(node.id) !== node)) {
        throw new Error("画布已发生变化，请重新撤销或重做");
      }
      flow.setNodes(snapshot.nodes.map(saved => {
        const node = flow.findNode(saved.id);
        if (node) {
          restoreFields(node, saved, nodeRuntimeFields);
          if (Object.hasOwn(saved.data ?? {}, "label")) node.data.label = saved.data!.label;
          else delete node.data.label;
          return node;
        }
        const data = JSON.parse(JSON.stringify(nodeReferences.get(saved.id)?.data ?? saved.data ?? {}));
        if (Object.hasOwn(saved.data ?? {}, "label")) data.label = saved.data!.label;
        else delete data.label;
        const restored = { ...saved, data };
        Reflect.deleteProperty(restored, "initialized");
        return restored;
      }));
      flow.setEdges(snapshot.edges.map(saved => {
        const edge = flow.findEdge(saved.id);
        if (edge) {
          restoreFields(edge, saved, edgeRuntimeFields);
          return edge;
        }
        return { ...saved, data: JSON.parse(JSON.stringify(edgeReferences.get(saved.id)?.data ?? saved.data ?? {})) };
      }));
      await nextTick();
      if (currentRevision !== revision) return;
      snapshots.value[index] = capture();
      cursor.value = index;
    } finally {
      if (currentRevision === revision) {
        record.cancel();
        applying.value = false;
        commit();
      }
    }
  }

  async function undo() {
    record.cancel();
    commit();
    if (canUndo.value) await restore(cursor.value - 1);
  }

  async function redo() {
    record.cancel();
    commit();
    if (canRedo.value) await restore(cursor.value + 1);
  }

  async function batch(action: () => Promise<void>) {
    if (!binding() || applying.value) throw new Error("画布尚未就绪");
    record.cancel();
    commit();
    const currentRevision = revision;
    grouping.value++;
    try {
      await action();
    } finally {
      await nextTick();
      if (currentRevision === revision) {
        grouping.value--;
        record.cancel();
        commit();
      }
    }
  }

  async function applyRemote(action: () => Promise<void>) {
    commit();
    const before = capture();
    const wasApplying = applying.value;
    applying.value = true;
    record.cancel();
    try {
      await action();
      const after = capture();
      const changes = canvasChanges(before, after);
      if (!changes.length) return;
      // 远端变更同步到每个结构快照，撤销不把其他成员已保存的操作一起回退。
      snapshots.value = snapshots.value.map(snapshot => {
        const merged = mergeCanvas({ ...snapshot, toonflowCanvas: true, viewport: flow.viewport.value } as SharedCanvasSnapshot, changes).canvas;
        const value = { nodes: merged.nodes as Node[], edges: merged.edges as Edge[] };
        return { ...value, key: JSON.stringify(value) };
      });
    } finally { record.cancel(); applying.value = wasApplying; }
  }

  flow.onNodeDragStart(() => {
    if (!binding() || applying.value || dragging) return;
    record.cancel();
    commit();
    dragging = true;
    grouping.value++;
  });
  flow.onNodeDragStop(async () => {
    if (!dragging) return;
    const currentRevision = revision;
    dragging = false;
    await nextTick();
    if (currentRevision !== revision) return;
    grouping.value--;
    record.cancel();
    commit();
  });

  function reset() {
    revision++;
    record.cancel();
    snapshots.value = [];
    cursor.value = -1;
    nodeReferences.clear();
    pendingDeletions.clear();
    previousNodeIds.clear();
    previousEdges = [];
    edgeReferences.clear();
    applying.value = false;
    grouping.value = 0;
    dragging = false;
    if (binding()) commit();
  }
  watch(binding, reset, { immediate: true, flush: "sync" });
  onScopeDispose(() => { revision++; record.cancel(); });

  const getRetainedNodes = () => [...nodeReferences.values(), ...[...pendingDeletions.values()].map(entry => entry.node), ...flow.getNodes.value];
  function getDeletedNodes() {
    capture();
    return [...pendingDeletions.values()].map(({ node, version, edges }) => ({ version,
      node: JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(node).filter(([key]) => key === "data" || !nodeRuntimeFields.has(key))))) as Node,
      edges: edges.map(edge => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(edge).filter(([key]) => !edgeRuntimeFields.has(key))))) as Edge),
    }));
  }
  function acknowledgeDeletions(entries: ReturnType<typeof getDeletedNodes>) {
    for (const entry of entries) if (pendingDeletions.get(entry.node.id)?.version === entry.version) pendingDeletions.delete(entry.node.id);
  }
  return { canUndo, canRedo, busy, record, commit, undo, redo, batch, applyRemote, getRetainedNodes, reset, getDeletedNodes, acknowledgeDeletions };
}
