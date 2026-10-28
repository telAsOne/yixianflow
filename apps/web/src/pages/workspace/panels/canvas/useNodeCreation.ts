import { computed, nextTick, type Component, type Ref } from "vue";
import type { GraphNode, useVueFlow, XYPosition } from "@vue-flow/core";
import { msg, translate, type MessageDescriptor } from "@toonflow/i18n/vue";
import { IconBox, IconCameraAi, IconCube3dSphere, IconFileText, IconMusic, IconPhoto, IconPhotoAi, IconSubtitles, IconVideo } from "@tabler/icons-vue";
import { getSelectionConnections } from "./selectionConnections";

export type NodeOption = { type: string; label: string; icon: Component };
export const nodeDragType = "application/x-toonflow-node";

// 节点菜单与左侧创作栏共用的顺序：四种基础节点在前，生成节点紧随其后。
const nodeOrder = ["remote-textNode", "remote-imageNode", "remote-videoNode", "remote-audioNode", "remote-imageGenerationNode", "remote-videoGenerationNode"];
// ACT: 远端节点按需加载，加载前用内置节点的同款图标，避免仅为显示图标预载全部节点脚本；新增内置节点时同步此表。
const builtinIcons: Record<string, Component> = {
  "remote-textNode": IconFileText,
  "remote-imageNode": IconPhoto,
  "remote-videoNode": IconVideo,
  "remote-audioNode": IconMusic,
  "remote-imageGenerationNode": IconPhotoAi,
  "remote-videoGenerationNode": IconCameraAi,
  "remote-subtitleNode": IconSubtitles,
  "remote-subtitleBurnNode": IconSubtitles,
  "remote-director3dNode": IconCube3dSphere,
};
// 新节点左上角相对落点的偏移，使节点大致居中于点击或拖放位置。
const nodeOffset = { x: 120, y: 80 };

type Starter = { id: string; title: MessageDescriptor; description: MessageDescriptor; nodes: { type: string; label: MessageDescriptor }[] };
const starterList: Starter[] = [
  {
    id: "textToImage",
    title: msg`文生图`,
    description: msg`写下画面描述，连到图片生成出图。`,
    nodes: [{ type: "remote-textNode", label: msg`画面描述` }, { type: "remote-imageGenerationNode", label: msg`生成画面` }],
  },
  {
    id: "imageToVideo",
    title: msg`图生视频`,
    description: msg`上传一张参考图，让画面动起来。`,
    nodes: [{ type: "remote-imageNode", label: msg`参考图` }, { type: "remote-videoGenerationNode", label: msg`生成视频` }],
  },
  {
    id: "scriptToShot",
    title: msg`剧本到镜头`,
    description: msg`从剧本出发，先出分镜画面，再生成镜头视频。`,
    nodes: [
      { type: "remote-textNode", label: msg`剧本` },
      { type: "remote-imageGenerationNode", label: msg`分镜画面` },
      { type: "remote-videoGenerationNode", label: msg`镜头视频` },
    ],
  },
];

export function sortNodeOptions(flow: ReturnType<typeof useVueFlow>, nodes: { type: string; label: string }[]): NodeOption[] {
  const rank = (type: string) => nodeOrder.includes(type) ? nodeOrder.indexOf(type) : nodeOrder.length;
  return nodes.map(node => ({
    ...node,
    icon: (flow.nodeTypes?.value?.[node.type] as { icon?: Component } | undefined)?.icon ?? builtinIcons[node.type] ?? IconBox,
  })).sort((left, right) => rank(left.type) - rank(right.type));
}

export function useNodeCreation(flow: ReturnType<typeof useVueFlow>, options: {
  availableNodes: Ref<{ type: string; label: string }[]>;
  ensureNodeType: (type: string) => Promise<void>;
  batchHistory: (action: () => Promise<void>) => Promise<void>;
  focusNodes: (nodeIds: string[]) => Promise<boolean>;
  signal: () => AbortSignal;
}) {
  const nodeOptions = computed(() => sortNodeOptions(flow, options.availableNodes.value));
  const starters = computed(() => starterList.filter(starter => starter.nodes.every(node => options.availableNodes.value.some(item => item.type === node.type))));

  function viewportCenter() {
    const bounds = flow.vueFlowRef.value?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return;
    return flow.screenToFlowCoordinate({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 });
  }

  function snap(position: XYPosition) {
    if (!flow.snapToGrid.value) return position;
    const [x, y] = flow.snapGrid.value;
    return { x: Math.round(position.x / x) * x, y: Math.round(position.y / y) * y };
  }

  function select(nodes: GraphNode[]) {
    flow.removeSelectedElements();
    flow.nodesSelectionActive.value = nodes.length > 1;
    flow.addSelectedNodes(nodes);
  }

  // 节点渲染并注册端口、尺寸后才能连线和聚焦；最多等待约 1 秒，超时按已有状态继续。
  async function waitForNodes(ids: string[], signal: AbortSignal) {
    for (let frame = 0; frame < 60; frame++) {
      await nextTick();
      signal.throwIfAborted();
      if (ids.every(id => {
        const node = flow.findNode(id);
        return node?.data.handles && node.dimensions.width > 0;
      })) return;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  }

  async function addNode(type: string, position?: XYPosition) {
    const option = nodeOptions.value.find(node => node.type === type);
    const center = position ?? viewportCenter();
    if (!option || !center) return;
    const signal = options.signal();
    await options.ensureNodeType(type);
    signal.throwIfAborted();
    const target = snap({ x: center.x - nodeOffset.x, y: center.y - nodeOffset.y });
    const id = crypto.randomUUID();
    await options.batchHistory(async () => {
      flow.addNodes({ id, type, position: target, data: { label: option.label } });
      await nextTick();
      const created = flow.findNode(id);
      if (!created) return;
      select([created]);
      if (position) return;
      await waitForNodes([id], signal);
      // 点击新建按实际尺寸沿当前行避让；拖放仍使用用户指定的落点。
      const neighbors = flow.getNodes.value.filter(node => node.id !== id && !node.hidden
        && node.computedPosition.y < target.y + created.dimensions.height + 32
        && node.computedPosition.y + node.dimensions.height + 32 > target.y)
        .sort((left, right) => left.computedPosition.x - right.computedPosition.x);
      for (const node of neighbors) {
        const right = node.computedPosition.x + node.dimensions.width + 32;
        if (target.x < right && target.x + created.dimensions.width + 32 > node.computedPosition.x)
          target.x = flow.snapToGrid.value ? Math.ceil(right / flow.snapGrid.value[0]) * flow.snapGrid.value[0] : right;
      }
      created.position = snap(target);
    });
    if (!position) await options.focusNodes([id]);
  }

  async function addStarter(id: string) {
    const starter = starters.value.find(item => item.id === id);
    const center = viewportCenter();
    if (!starter || !center) return;
    const signal = options.signal();
    await Promise.all(starter.nodes.map(node => options.ensureNodeType(node.type)));
    signal.throwIfAborted();
    const gap = 420;
    const left = center.x - (starter.nodes.length - 1) * gap / 2;
    const ids = starter.nodes.map(() => crypto.randomUUID());
    await options.batchHistory(async () => {
      flow.addNodes(starter.nodes.map((node, index) => ({
        id: ids[index]!,
        type: node.type,
        position: snap({ x: left + index * gap - nodeOffset.x, y: center.y - nodeOffset.y }),
        data: { label: translate(node.label) },
      })));
      await waitForNodes(ids, signal);
      const created = ids.map(id => flow.findNode(id)).filter((node): node is GraphNode => !!node);
      for (let index = 1; index < created.length; index++) {
        const connections = getSelectionConnections([created[index - 1]!], created[index]!, flow.getNodes.value, flow.getEdges.value);
        if (connections) flow.addEdges(connections);
      }
      select(created);
    });
    await options.focusNodes(ids);
  }

  function startNodeDrag(event: DragEvent, type: string) {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData(nodeDragType, type);
    event.dataTransfer.effectAllowed = "copy";
  }

  function isNodeDrag(event: DragEvent) {
    return !!event.dataTransfer?.types.includes(nodeDragType);
  }

  function dropNode(event: DragEvent) {
    const type = event.dataTransfer?.getData(nodeDragType);
    if (!type) return;
    return addNode(type, flow.screenToFlowCoordinate({ x: event.clientX, y: event.clientY }));
  }

  return { nodeOptions, starters, viewportCenter, addNode, addStarter, startNodeDrag, isNodeDrag, dropNode };
}
