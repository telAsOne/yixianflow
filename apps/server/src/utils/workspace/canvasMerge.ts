export type CanvasElement = { id: string; [key: string]: any };
export type CanvasSnapshot = { toonflowCanvas: true; nodes: CanvasElement[]; edges: CanvasElement[]; viewport: { x: number; y: number; zoom: number } };
export type CanvasChange = { kind: "nodes" | "edges"; id: string; before?: CanvasElement; after?: CanvasElement };
export type CanvasConflict = { key: string; label: string; local: unknown; remote: unknown };

const parameterFields = ["model", "size", "ratio", "duration", "resolution", "mode", "generateAudio", "referenceImageUrlsText"];
const resultFields = ["outputs", "appliedImageTaskId", "appliedVideoTaskId", "generationTiming"];
const promptFields = ["prompt", "promptModel"];
const inpaintFields = ["inpaintPrompt", "inpaintPromptModel"];
const atomicGroups = [parameterFields, resultFields, promptFields, inpaintFields];
const groupLabels = ["模型与生成参数", "生成结果与任务状态", "提示词", "重绘提示词"];
const nodeRuntimeFields = new Set(["computedPosition", "handleBounds", "selected", "dimensions", "isParent", "resizing", "dragging", "events", "initialized"]);
const edgeRuntimeFields = new Set(["selected", "sourceNode", "targetNode", "sourceX", "sourceY", "targetX", "targetY", "events", "initialized"]);

function savedElement(item: CanvasElement, kind: CanvasChange["kind"]): CanvasElement {
  const runtimeFields = kind === "nodes" ? nodeRuntimeFields : edgeRuntimeFields;
  return Object.fromEntries(Object.entries(item).filter(([key]) => !runtimeFields.has(key))) as CanvasElement;
}

export function sameCanvasValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameCanvasValue(a[key], b[key]));
}

export function canvasChanges(before: Pick<CanvasSnapshot, "nodes" | "edges">, after: Pick<CanvasSnapshot, "nodes" | "edges">): CanvasChange[] {
  return (["nodes", "edges"] as const).flatMap(kind => {
    const previous = new Map(before[kind].map(item => [item.id, savedElement(item, kind)]));
    const changes: CanvasChange[] = [];
    for (const element of after[kind]) {
      const item = savedElement(element, kind);
      const old = previous.get(item.id);
      if (!sameCanvasValue(old, item)) changes.push({ kind, id: item.id, before: old, after: item });
      previous.delete(item.id);
    }
    for (const item of previous.values()) changes.push({ kind, id: item.id, before: item });
    return changes;
  });
}

export function mergeCanvas(current: CanvasSnapshot, changes: CanvasChange[], choices: Record<string, "local" | "remote"> = {}) {
  const conflicts: CanvasConflict[] = [];
  function conflict(key: string, label: string, local: unknown, remote: unknown) {
    if (!choices[key]) conflicts.push({ key, label, local, remote });
    return choices[key] === "remote" ? remote : local;
  }
  function merge(base: any, local: any, remote: any, key: string, label: string, depth: number): any {
    if (sameCanvasValue(local, base) || sameCanvasValue(local, remote)) return remote;
    if (sameCanvasValue(remote, base)) return local;
    if (!base || !local || !remote || [base, local, remote].some(value => typeof value !== "object" || Array.isArray(value))
      || depth === 0 && (base.type !== local.type || base.type !== remote.type)) return conflict(key, label, local, remote);
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    const entries: [string, unknown][] = [];
    if (depth === 1 && key.endsWith("/data")) {
      atomicGroups.forEach((group, index) => {
        const pick = (value: any) => Object.fromEntries(group.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]));
        const a = pick(base), b = pick(local), c = pick(remote);
        const value = sameCanvasValue(b, a) || sameCanvasValue(b, c) ? c : sameCanvasValue(c, a) ? b : conflict(`${key}/${index}`, `${label} · ${groupLabels[index]}`, b, c);
        entries.push(...Object.entries(value as object));
        group.forEach(field => keys.delete(field));
      });
    }
    for (const field of keys) {
      const value = merge(base[field], local[field], remote[field], `${key}/${encodeURIComponent(field)}`, `${label} · ${field}`, depth + 1);
      if (value !== undefined) entries.push([field, value]);
    }
    return Object.fromEntries(entries);
  }
  const maps = { nodes: new Map(current.nodes.map(item => [item.id, savedElement(item, "nodes")])), edges: new Map(current.edges.map(item => [item.id, savedElement(item, "edges")])) };
  for (const change of changes) {
    const current = maps[change.kind].get(change.id);
    const name = change.after?.data?.label || current?.data?.label || change.before?.data?.label || change.id;
    const item = merge(change.before && savedElement(change.before, change.kind), change.after && savedElement(change.after, change.kind), current,
      `${change.kind}/${encodeURIComponent(change.id)}`, `${change.kind === "nodes" ? "节点" : "连线"} ${name}`, 0);
    if (item === undefined) maps[change.kind].delete(change.id);
    else maps[change.kind].set(change.id, item);
  }
  const removedNodes = new Set(changes.filter(change => change.kind === "nodes" && change.before && !maps.nodes.has(change.id)).map(change => change.id));
  for (const [id, edge] of maps.edges) {
    if (edge.data?.videoContinuation && removedNodes.has(edge.target)) maps.edges.delete(id);
  }
  return { canvas: { ...current, nodes: [...maps.nodes.values()], edges: [...maps.edges.values()] }, conflicts };
}

export function validateCanvas(canvas: CanvasSnapshot, previous?: CanvasSnapshot, { allowIncompleteReferences = false } = {}) {
  const nodes = new Map(canvas.nodes.map(node => [node.id, node]));
  const visited = new Set<string>();
  if (nodes.size !== canvas.nodes.length || new Set(canvas.edges.map(edge => edge.id)).size !== canvas.edges.length) throw new Error("画布含有重复的节点或连线");
  for (const node of canvas.nodes) {
    if (!node.id || /[\\/\0]/.test(node.id) || [".", ".."].includes(node.id)) throw new Error("节点编号无效");
    const parents = new Set<string>();
    let parent: string | undefined = node.id;
    while (parent) {
      if (visited.has(parent)) break;
      if (!nodes.has(parent) && allowIncompleteReferences) break;
      if (!nodes.has(parent) || parents.has(parent)) throw new Error("节点所属分组已删除或形成循环，请检查分组修改");
      parents.add(parent);
      parent = nodes.get(parent)?.parentNode;
    }
    for (const id of parents) visited.add(id);
  }
  if (!allowIncompleteReferences && canvas.edges.some(edge => !nodes.has(edge.source) || !nodes.has(edge.target))) throw new Error("连线关联的节点已删除，请先处理节点与连线的修改");
  for (const old of previous?.nodes ?? []) {
    const binding = old.data?.continuationBinding;
    if (!binding) continue;
    const current = nodes.get(old.id);
    if (current && !sameCanvasValue(current.data?.continuationBinding, binding)) throw new Error("续接来源已固定，请删除续接节点后重新创建");
    if (current && !nodes.has(binding.source)) throw new Error("来源视频仍有续接节点，请先删除续接节点");
  }
  for (const node of canvas.nodes) {
    if (allowIncompleteReferences) continue;
    const binding = node.data?.continuationBinding;
    if (!binding) continue;
    const edges = canvas.edges.filter(edge => edge.target === node.id && edge.targetHandle === "continuation");
    const edge = edges[0];
    if (node.type !== "remote-videoGenerationNode" || typeof binding.source !== "string" || binding.source === node.id || !nodes.has(binding.source)
      || typeof binding.sourceHandle !== "string" || !binding.sourceHandle || edges.length !== 1 || edge?.id !== binding.edgeId || edge.source !== binding.source || edge.sourceHandle !== binding.sourceHandle
      || edge.deletable !== false || edge.updatable !== false || edge.data?.videoContinuation !== true) throw new Error("续接来源连线不允许删除或改接；删除续接节点后可重新创建");
  }
  const pending: unknown[] = [canvas];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("画布含有无效字段");
      if (item && typeof item === "object") pending.push(item);
    }
  }
}
