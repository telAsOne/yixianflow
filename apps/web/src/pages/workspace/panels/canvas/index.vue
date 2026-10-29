<template>
  <div
    ref="canvasElement"
    class="canvas"
    :class="{ edgesHidden: !showEdges, handMode, compositingEnabled: generalSettings.canvasCompositingEnabled }"
    :style="{ '--canvasEdgeColor': generalSettings.canvasEdgeColorMode === 'custom' ? generalSettings.canvasEdgeColor : 'var(--el-color-primary)', '--inspectorWidth': `${inspectorShown && !workspaceLayout.compact.value ? Math.min(workspaceLayout.inspectorWidth.value, workspaceLayout.inspectorMaxWidth.value) : 0}px` }"
    @dblclick="openNodeMenu"
    @wheel.capture="zoomCanvas"
    @gesturestart.capture="zoomCanvas"
    @gesturechange.capture="zoomCanvas"
    @gestureend.capture="zoomCanvas"
    @pointerdown.capture="startCanvasPointer"
    @mousedown.capture="panCanvas"
    @auxclick.capture="preventMiddleClick"
    @pointermove.capture="updateCanvasPointer"
    @pointerleave="pointerPosition = undefined; placementPoint = undefined"
    @dragover="dragFilesOver"
    @drop="dropFiles">
    <vue-flow
      :id="runtimeKey"
      :onlyRenderVisibleElements="false"
      :nodesDraggable="true"
      :nodeTypes="nodeTypes"
      :edgeTypes="edgeTypes"
      :snapToGrid="snapEnabled"
      :snapGrid="[16, 16]"
      :minZoom="0.02"
      :maxZoom="8"
      :nodesConnectable="true"
      :connectionMode="ConnectionMode.Strict"
      :nodesFocusable="false"
      :edgesFocusable="false"
      :edgesUpdatable="false"
      :elevateNodesOnSelect="true"
      :elevateEdgesOnSelect="false"
      :disableKeyboardA11y="true"
      :selectNodesOnDrag="false"
      :autoPanOnNodeDrag="false"
      :autoPanOnConnect="false"
      :zoomOnDoubleClick="false"
      :zoomOnScroll="false"
      :zoomOnPinch="active && !settingsVisible"
      :panOnScroll="active && !settingsVisible"
      :panOnScrollSpeed="1"
      :panOnDrag="handMode || isMobile ? true : [1]"
      :panOnScrollMode="PanOnScrollMode.Free"
      :deleteKeyCode="null"
      :selectionKeyCode="!handMode && !isMobile"
      :selectionMode="SelectionMode.Partial"
      :multiSelectionKeyCode="null"
      :zoomActivationKeyCode="zoomKeyPressed ? true : null"
      :panActivationKeyCode="panKeyPressed ? true : null"
      @connect="addEdges"
      @edgeClick="showEdgeDisconnect"
      @paneClick="edgeDisconnect = undefined"
      @moveStart="edgeDisconnect = undefined"
      :defaultEdgeOptions="defaultEdgeOptions">
      <template v-for="type in remoteNodeTypes" :key="type" #[`node-${type}`]="nodeProps">
        <remoteNode
          v-if="!canvasReloading"
          v-bind="nodeProps"
          :component="nodeTypes[type]"
          :error="nodeErrors[type]"
          :loading="nodeLoads.has(type) || (nodeListLoading && !nodeTypes[type] && !nodeErrors[type])" />
      </template>
      <background :gap="16" patternColor="var(--el-border-color)" />
      <teleport :to="workspaceLayout.menuTarget.value ?? 'body'" :disabled="!workspaceLayout.menuTarget.value">
        <div v-show="active" class="canvasMenuHost">
          <canvasMenu ref="canvasMenuRef" v-model:canvasId="canvasId" :directory="project?.directory" :initialCanvasId="initialCanvasId" :activateCanvas="activateCanvas" :flushSave="flushCanvases ?? flushCanvasSave" @loaded="resetSavedState" @reload="canvasReloading = $event" />
          <el-tooltip :showArrow="false" :content="searchHint" placement="bottom" :hideAfter="0" :enterable="false" :triggerKeys="[]">
            <el-button class="searchButton" text :disabled="!active || !canvasId || !project?.directory" aria-label="搜索节点与分组" @click="nodeSearchRef?.open()">
              <icon-search :size="17" />
            </el-button>
          </el-tooltip>
        </div>
      </teleport>
      <panel class="canvasNavPanel" position="bottom-right" @pointerdown.capture="cancelCanvasZoom">
        <canvasMap v-if="showMap" :active="active && !settingsVisible && !!canvasId && !!project?.directory" :navigation="navigation" @zoom="zoomCanvas($event, true)" @close="showMap = false" />
        <canvasControls
          ref="canvasControlsRef"
          :active="active && !settingsVisible && canvasView.ready.value"
          v-model:showMap="showMap"
          v-model:snapEnabled="snapEnabled"
          v-model:showEdges="showEdges"
          :canvasId="canvasId"
          :directory="project?.directory"
          :projectName="project?.name ?? ''"
          :batchHistory="canvasHistory.batch"
          :navigation="navigation"
          @update:showEdges="edgeDisconnect = undefined" />
      </panel>
      <nodeMenu
        :key="JSON.stringify(['nodeMenu', project?.directory, canvasId])"
        ref="nodeMenuRef"
        :remoteNodes="availableNodes"
        :prepareNodes="prepareNodeMenu"
        :pasteNode="pasteClipboardNode"
        :uploadFiles="canvasId && project?.directory ? selectFiles : undefined"
        :canUndo="canUndo"
        :canRedo="canRedo"
        :selectionBusy="selectionToolbarRef?.busy"
        :batchHistory="canvasHistory.batch"
        @duplicateSelection="selectionToolbarRef?.operate('duplicate')"
        @history="canvasHistory.commit"
        @undo="changeHistory('undo')"
        @redo="changeHistory('redo')" />
      <teleport :to="nodeDockSelection ?? 'body'" :disabled="!nodeDockSelection">
      <selectionToolbar
        :key="JSON.stringify(['selectionToolbar', project?.directory, canvasId])"
        ref="selectionToolbarRef"
        :batchHistory="canvasHistory.batch"
        :getSignal="() => canvasController.signal"
        :disabled="!canvasId || !project?.directory" />
      </teleport>
      <nodeSearch ref="nodeSearchRef" :disabled="!active || settingsVisible || !canvasId || !project?.directory" :nodeTypes="availableNodes" :focusNodes="navigation.focusNodes" />
      <teleport :to="flow.viewportRef.value ?? 'body'" :disabled="!flow.viewportRef.value">
      <div v-if="placingNode" class="nodePlacement" @pointerdown.stop @mousedown="$event.button === 0 && !handMode && $event.stopPropagation()" @click.stop="placeNode" @dblclick.stop @contextmenu.stop.prevent="cancelNodePlacement">
        <div class="nodePlacementHint nodrag nopan" role="status" @click.stop>
          <span>点击画布放置{{ placingNode.label }} · Enter 居中 · Esc 或右键取消</span>
          <el-button text aria-label="取消放置节点" @click="cancelNodePlacement"><icon-x :size="16" /></el-button>
        </div>
        <div v-if="placementPoint && !handMode" class="nodePlacementPreview" :style="{ transform: `translate(${placementPoint.x + 16}px, ${placementPoint.y + 16}px)` }" aria-hidden="true">
          <component :is="placingNode.icon" :size="18" />
          <span>{{ placingNode.label }}</span>
        </div>
      </div>
      </teleport>
    </vue-flow>
    <canvasStarter
      v-if="canvasReady && !canvasReloading && !flow.getNodes.value.length && !placingNode"
      :nodeOptions="nodeCreation.nodeOptions.value"
      :starters="nodeCreation.starters.value"
      :disabled="!canCreate"
      @start="createFromStarter"
      @upload="uploadAtCenter"
      @askAgent="openAgent?.()" />
    <canvasDock
      v-model:assetsVisible="assetsVisible"
      :nodeOptions="nodeCreation.nodeOptions.value"
      :starters="nodeCreation.starters.value"
      :disabled="!canCreate"
      :placingType="placingType"
      @addNode="selectNodePlacement"
      @dragNode="startNodeDrag"
      @upload="uploadAtCenter"
      @start="createFromStarter" />
    <div class="assetPanel">
      <assetLibrary ref="assetLibraryRef" v-model="assetsVisible" :directory="project?.directory" />
    </div>
    <nodeInspector v-show="inspectorShown" v-model:width="workspaceLayout.inspectorWidth.value" :maxWidth="workspaceLayout.inspectorMaxWidth.value" :title="inspectorTitle" :requiresModel="inspectorRequiresModel" @close="workspaceLayout.inspectorVisible.value = false">
      <div class="nodeDock">
        <div ref="nodeDockSelection" class="dockSlot" />
        <div ref="nodeDockTop" class="dockSlot" />
        <div ref="nodeDockBottom" class="dockSlot" />
      </div>
    </nodeInspector>
    <teleport to="body">
      <el-button
        v-if="edgeDisconnect && findEdge(edgeDisconnect.id)"
        class="edgeDisconnect"
        type="danger"
        circle
        aria-label="断开连接"
        title="断开连接"
        :style="{ left: `${edgeDisconnect.x}px`, top: `${edgeDisconnect.y}px` }"
        @click.stop="
          removeEdges(edgeDisconnect.id);
          edgeDisconnect = undefined;
        "
        @mouseleave="edgeDisconnect = undefined">
        <icon-unlink :size="16" />
      </el-button>
    </teleport>
    <canvasConflict v-if="canvasSync.conflict.value" v-model="canvasSync.dialogVisible.value" :path="canvasId" :conflict="canvasSync.conflict.value"
      :recoveryPath="canvasSync.recoveryPath.value" :recoveryError="canvasSync.recoveryError.value" :busy="canvasSync.busy.value" :resolve="canvasSync.resolve" />
  </div>
</template>

<script setup lang="ts">
import { computed, inject, markRaw, nextTick, onBeforeUnmount, onMounted, onScopeDispose, provide, ref, shallowRef, watch } from "vue";
import axios from "axios";
import { ElMessage } from "element-plus";
import { translate } from "@toonflow/i18n/vue";
import { isMobile } from "@/lib/mobile";
import { storeToRefs } from "pinia";
import { IconUnlink } from "@tabler/icons-vue";
import "element-plus/dist/index.css";
import {
  VueFlow,
  Panel,
  PanOnScrollMode,
  ConnectionMode,
  SelectionMode,
  useVueFlow,
  isNode,
  type Node,
  type Edge,
  type GraphEdge,
  type EdgeMouseEvent,
  type XYPosition,
} from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { useCanvasTools } from "./useCanvasTools";
import type { CanvasContext } from "@toonflow/tool-canvas/runtime";
import { useCanvasHistory } from "./useCanvasHistory";
import { useCanvasSync } from "./useCanvasSync";
import { useCanvasSave } from "./useCanvasSave";
import { useDocumentNodes } from "./useDocumentNodes";
import { useRemoteNodes } from "./useRemoteNodes";
import { useNodeCreation } from "./useNodeCreation";
import { useCanvasClipboard } from "./useCanvasClipboard";
import canvasConflict from "./components/canvasConflict.vue";
import type { CanvasSnapshot } from "@toonflow/server/canvasMerge";
import type { CanvasUpdate } from "@/lib/workspaceFiles";
import { useCanvasNavigation } from "./useCanvasNavigation";
import { useCanvasView } from "./useCanvasView";
import nodeMenu from "./components/nodeMenu.vue";
import remoteNode from "./components/remoteNode.vue";
import canvasMenu from "./components/canvasMenu.vue";
import canvasControls from "./components/canvasControls.vue";
import canvasMap from "./components/canvasMap.vue";
import assetLibrary from "./components/assetLibrary.vue";
import viewportEdge from "./components/viewportEdge.vue";
import selectionToolbar from "./components/selectionToolbar.vue";
import nodeSearch from "./components/nodeSearch.vue";
import nodeInspector from "./components/nodeInspector.vue";
import canvasDock from "./components/canvasDock.vue";
import canvasStarter from "./components/canvasStarter.vue";
import { workspaceLayoutKey } from "../../workspaceLayout";
import { finishGroupDrag } from "./selectionNodes";
import type { NodeOutput } from "@toonflow/nodes-scaffold/values";
import type { NodeConnectionFeedback } from "@toonflow/nodes-scaffold/connection";
import { useNodeEvent } from "@toonflow/nodes-scaffold/nodeEvent";
import { useWorkspaceStore } from "@/stores/workspace";
import { generalSettings } from "@/stores/settings";
import { shortcutLabel, shortcutMatches, shortcutPressed } from "@/lib/canvasShortcuts";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { dropCanvasFiles, importCanvasFiles, isCanvasFileDrag } from "./canvasDrop";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/minimap/dist/style.css";

const props = withDefaults(defineProps<{
  active?: boolean;
  settingsVisible?: boolean;
  runtimeKey?: string;
  initialCanvasId?: string;
  activateCanvas?: (canvasId: string, signal?: AbortSignal) => Promise<void>;
  resolveCanvasContext?: (canvasId: string) => CanvasContext | undefined;
  flushCanvases?: (action?: () => Promise<void>) => Promise<void>;
}>(), { active: true, settingsVisible: false });
const { project } = storeToRefs(useWorkspaceStore());
const workspaceRefreshing = inject("workspaceRefreshing", ref(false));
const openAgent = inject<() => void>("openAgent");

const canvasElement = ref<HTMLElement>();
const workspaceLayout = inject(workspaceLayoutKey)!;
const nodeDockSelection = ref<HTMLElement>();
const nodeDockTop = ref<HTMLElement>();
const nodeDockBottom = ref<HTMLElement>();
provide("nodeSlotDock", { top: nodeDockTop, bottom: nodeDockBottom });
provide("canvasFocusInsets", () => {
  const canvas = flow.vueFlowRef.value?.getBoundingClientRect();
  // 左侧创作栏与右下角导航浮在画布上，聚焦时让出其占位。
  const dock = canvasElement.value?.querySelector(".canvasDock")?.getBoundingClientRect();
  const left = canvas && dock ? Math.max(0, dock.right - canvas.left) + 12 : 64;
  const bottom = 64;
  const inspectorInset = workspaceLayout.compact.value && inspectorShown.value ? Math.min(workspaceLayout.inspectorWidth.value, workspaceLayout.inspectorMaxWidth.value) : 0;
  const panel = document.getElementById("agentPanel")?.getClientRects()[0];
  if (!canvas || !panel || panel.right <= canvas.left || panel.left >= canvas.right) return { left, right: inspectorInset, top: 24, bottom };
  const leftSpace = Math.max(0, panel.left - canvas.left - 20);
  const rightSpace = Math.max(0, canvas.right - panel.right - 20);
  return leftSpace >= rightSpace ? { left, right: Math.max(inspectorInset, canvas.width - leftSpace), top: 24, bottom }
    : { left: Math.max(left, canvas.width - rightSpace), right: inspectorInset, top: 24, bottom };
});
const canvasId = ref("");
const canvasReloading = ref(false);
const nodeMenuRef = ref<InstanceType<typeof nodeMenu>>();
const canvasMenuRef = ref<InstanceType<typeof canvasMenu>>();
const canvasControlsRef = ref<InstanceType<typeof canvasControls>>();
const selectionToolbarRef = ref<InstanceType<typeof selectionToolbar>>();
provide("duplicateCanvasNode", (nodeId: string, dataPatch?: Record<string, unknown>) => {
  if (!selectionToolbarRef.value) throw new Error("画布尚未就绪，请稍后创建节点");
  return selectionToolbarRef.value.duplicateNode(nodeId, dataPatch);
});
const nodeSearchRef = ref<InstanceType<typeof nodeSearch>>();
const edgeTypes = markRaw({ "simple-bezier": markRaw(viewportEdge) });
const snapEnabled = ref(false);
const zoomKeyPressed = ref(false);
const panKeyPressed = ref(false);
const selectedTool = ref<"move" | "hand">("move");
const handMode = computed(() => props.active && !props.settingsVisible && (selectedTool.value === "hand" || panKeyPressed.value));
const placingType = ref("");
const placementPoint = ref<XYPosition>();
const creatingNode = ref(false);
let pointerPosition: XYPosition | undefined;
const pressedCodes = new Set<string>();
let gestureScale: number | undefined;
const isDesktop = new URLSearchParams(window.location.search).get("desktop") === "1";
const showEdges = ref(true);
const showMap = ref(false);
provide("canvasActive", computed(() => props.active));
provide("canvasShowEdges", showEdges);
const assetsVisible = ref(false);
const assetLibraryRef = ref<InstanceType<typeof assetLibrary>>();
const edgeDisconnect = ref<{ id: string; x: number; y: number }>();
const flow = useVueFlow(props.runtimeKey);
const inspectorShown = computed(() => workspaceLayout.inspectorVisible.value && workspaceLayout.inspectorAvailable.value);
const inspectorTitle = computed(() => flow.getSelectedNodes.value.length > 1 ? `已选中 ${flow.getSelectedNodes.value.length} 个节点` : flow.getSelectedNodes.value[0]?.data.label || "节点设置");
const inspectorRequiresModel = computed(() => flow.getSelectedNodes.value.length === 1
  && ["remote-textNode", "remote-imageGenerationNode", "remote-videoGenerationNode", "remote-director3dNode"].includes(flow.getSelectedNodes.value[0]?.type ?? ""));
const { nodeTypes, nodeLoads, nodeErrors, nodeListLoading, remoteNodeTypes, availableNodes, ensureNodeType, prepareNodeMenu } = useRemoteNodes(flow, {
  signal: () => canvasController.signal, revision: () => canvasSave.revision,
});
const canvasOverview = ref(false);
watch(() => flow.viewport.value.zoom, zoom => {
  if (zoom < 0.35) canvasOverview.value = true;
  else if (zoom > 0.45) canvasOverview.value = false;
}, { immediate: true });
provide("canvasOverview", canvasOverview);
provide("canvasZoom", zoomCanvas);
const navigation = useCanvasNavigation(flow, () =>
  project.value?.directory && canvasId.value ? JSON.stringify([project.value.directory, canvasId.value]) : "",
  () => props.active && !props.settingsVisible,
);
const canvasDirty = ref(false);
const canvasSaveError = ref("");
let dragCopy: ReturnType<InstanceType<typeof selectionToolbar>["startDragCopy"]>;
flow.onNodeDragStart(({ event, nodes }) => {
  dragCopy = undefined;
  if (!props.active || props.settingsVisible) return;
  const shortcuts = generalSettings.value.canvasShortcuts;
  const withEdges = shortcutPressed(event, shortcuts.duplicateOnDrag, pressedCodes);
  if (withEdges || shortcutPressed(event, shortcuts.copyOnDrag, pressedCodes)) {
    dragCopy = selectionToolbarRef.value?.startDragCopy(nodes, withEdges);
  }
});
flow.onNodeDrag(() => dragCopy?.update());
flow.onNodeDragStop(({ nodes }) => {
  const copy = dragCopy;
  dragCopy = undefined;
  if (copy) copy.finish();
  else finishGroupDrag(flow.getNodes.value, nodes);
});
const canvasHistory = useCanvasHistory(flow, () =>
  project.value?.directory && canvasId.value ? JSON.stringify([project.value.directory, canvasId.value]) : ""
);
const { canUndo, canRedo } = canvasHistory;
const canvasSync = useCanvasSync(flow, () => project.value?.directory && canvasId.value ? { directory: project.value.directory, path: canvasId.value } : undefined,
  canvasHistory, (disk, dirty) => {
    canvasMenuRef.value?.updateCanvasSnapshot(disk);
    canvasDirty.value = dirty;
    if (canvasDirty.value) scheduleCanvasSave();
  });
const canvasSave = useCanvasSave(flow, canvasSync, {
  directory: () => project.value?.directory, path: () => canvasId.value, ready: () => !!canvasMenuRef.value, dirty: canvasDirty, error: canvasSaveError,
});
const { scheduleCanvasSave, resetSavedState, cancelCanvasSave } = canvasSave;
function flushCanvasSave(action?: () => Promise<void>) {
  canvasView.flush();
  return canvasSave.flushCanvasSave(action);
}
watch([canvasSync.conflict, canvasSync.recoveryError], ([conflict, recoveryError]) => {
  if (conflict || recoveryError) canvasSaveError.value = `${canvasId.value}：${recoveryError || conflict?.message}`;
  else { canvasSaveError.value = ""; canvasSave.clearError(); }
});
provide("batchCanvasHistory", canvasHistory.batch);
const { addEdges, removeEdges, findEdge, findNode, viewport } = flow;
provide("retainNodeFiles", true);
provide("selectionConnection", shallowRef<NodeConnectionFeedback>());
provide("saveNodeToAssets", (label: string, outputs: { label: string; output: NodeOutput }[]) => assetLibraryRef.value?.openSave(label, outputs));
let canvasController = new AbortController();
let workspaceController = new AbortController();
const createCanvasContext = useCanvasTools({
  availableNodes,
  ensureNodeType,
  flushSave: flushCanvasSave,
  batchHistory: canvasHistory.batch,
  arrangeCanvas: signal => {
    if (!canvasControlsRef.value) throw new Error("画布尚未就绪");
    return canvasControlsRef.value.requestArrange(signal);
  },
  menu() {
    if (!canvasMenuRef.value) throw new Error("画布菜单尚未就绪");
    return canvasMenuRef.value;
  },
  getCanvasBinding: () => ({ id: canvasId.value, signal: canvasController.signal }),
  isRefreshing: () => workspaceRefreshing.value,
  resolveCanvasContext: id => props.resolveCanvasContext?.(id),
});
function getCanvasContext() {
  return canvasId.value ? createCanvasContext(canvasId.value, canvasController.signal, workspaceController.signal) : undefined;
}
const canvasReady = computed(() => !!canvasId.value && !nodeListLoading.value && nodeLoads.size === 0);
const canCreate = computed(() => props.active && !props.settingsVisible && canvasReady.value && !!project.value?.directory && !workspaceRefreshing.value && !creatingNode.value);
const nodeCreation = useNodeCreation(flow, {
  availableNodes, ensureNodeType, batchHistory: canvasHistory.batch, focusNodes: navigation.focusNodes, signal: () => canvasController.signal,
});
const placingNode = computed(() => nodeCreation.nodeOptions.value.find(node => node.type === placingType.value));
watch([canCreate, canvasId, canvasReloading], cancelNodePlacement, { flush: "sync" });
const { copySelectedNodes, pasteNodeAtCenter, pasteClipboardNode } = useCanvasClipboard(flow, {
  active: () => props.active, settingsVisible: () => props.settingsVisible, canvasId, directory: () => project.value?.directory,
  canvasElement, pointer: () => pointerPosition, signal: () => canvasController.signal, availableNodes, batchHistory: canvasHistory.batch,
});
const searchHint = computed(() => {
  const binding = shortcutLabel(generalSettings.value.canvasShortcuts.search);
  return binding ? `${translate("搜索节点与分组")}（${binding}）` : translate("搜索节点与分组");
});
const canvasView = useCanvasView(flow, navigation, {
  directory: () => project.value?.directory, path: () => canvasId.value,
  active: () => props.active && !props.settingsVisible, loaded: () => canvasReady.value && !canvasReloading.value,
  showMap, snapEnabled, showEdges,
});
watch([() => props.active, () => flow.getSelectedNodes.value.length, () => flow.userSelectionActive.value, canvasView.selectionReady], ([active, count, selecting, ready]) => {
  if (active && !selecting) workspaceLayout.inspectorAvailable.value = ready && count > 0;
}, { immediate: true });
function showInspector() {
  if (props.active && !creatingNode.value && flow.getSelectedNodes.value.length) workspaceLayout.inspectorVisible.value = true;
}
flow.onNodeClick(showInspector);
flow.onSelectionEnd(showInspector);
watch(() => flow.getSelectedNodes.value.map(node => node.id).join(","), showInspector);
provide("canvas", getCanvasContext);
const { readDocumentNode, saveDocumentNode, mountDocumentNode, observeDocumentNode } = useDocumentNodes({
  directory: () => project.value?.directory, canvasId, findNode, canvasDirty, canvasSaveError, nodeErrors, flushCanvasSave,
  signal: () => canvasController.signal,
  syncDocumentNode: (...args) => canvasMenuRef.value?.syncDocumentNode(...args),
});
defineExpose({ canvasId, canvasReady, getCanvasContext, readDocumentNode, saveDocumentNode, mountDocumentNode, observeDocumentNode, prepareCanvasDelete, flushSave: flushCanvasSave, cancelSave: cancelCanvasSave,
  prepareRefresh, refreshCanvas, refreshCanvasList: (beforeApply?: () => void) => canvasMenuRef.value?.refreshCanvasList(beforeApply),
  receiveCanvasUpdate: (event?: CanvasUpdate) => canvasSync.sync(event), showSaveConflict: () => { canvasSync.dialogVisible.value = true; },
  get revision() { return canvasSave.revision; },
  syncCanvasPath: (previous: string, target: string) => canvasMenuRef.value?.syncCanvasPath(previous, target),
  getMentionNodes: () => flow.nodes.value, findMentionNode: flow.findNode,
  getRetainedNodes: canvasHistory.getRetainedNodes,
  get saveBusy() { return canvasSave.paused; }, get loadError() { return canvasMenuRef.value?.loadError ?? ""; }, saveError: canvasSaveError,
});

async function prepareCanvasDelete() {
  const directory = project.value?.directory;
  const fileName = canvasId.value;
  const nodes = [...flow.getNodes.value];
  const signal = AbortSignal.any([workspaceController.signal, canvasController.signal]);
  function checkCanvas() {
    signal.throwIfAborted();
    if (!directory || directory !== project.value?.directory || !fileName || fileName !== canvasId.value) {
      throw new Error("工作区或画布已切换，请重新删除");
    }
  }
  checkCanvas();
  await nextTick();
  checkCanvas();
  // 宿主已暂停画布保存；这里只执行节点生命周期，文件删除成功后由宿主取消保存并卸载。
  for (const node of nodes) {
    if (flow.findNode(node.id) !== node) throw new Error("画布节点已变化，请重新删除");
    await useNodeEvent(node.id, flow).emit("delete");
    checkCanvas();
    if (flow.findNode(node.id) !== node) throw new Error("画布节点已变化，请重新删除");
  }
  if (flow.getNodes.value.length !== nodes.length || nodes.some(node => flow.findNode(node.id) !== node)) {
    throw new Error("画布节点已变化，请重新删除");
  }
}

function showEdgeDisconnect({ event, edge }: EdgeMouseEvent) {
  if (!(event instanceof MouseEvent)) return;
  event.stopPropagation();
  edgeDisconnect.value = { id: edge.id, x: event.clientX, y: event.clientY };
}

function dragFilesOver(event: DragEvent) {
  if (!props.active || props.settingsVisible || !canvasId.value || !project.value?.directory) return;
  if (!nodeCreation.isNodeDrag(event) && !isCanvasFileDrag(event)) return;
  if (!(event.target instanceof Element) || !event.target.closest(".vue-flow__pane, .nodePlacement")) return;
  event.preventDefault();
  event.dataTransfer!.dropEffect = "copy";
  return true;
}

async function dropFiles(event: DragEvent) {
  const directory = project.value?.directory;
  if (!directory || !dragFilesOver(event)) return;
  cancelNodePlacement();
  try {
    if (nodeCreation.isNodeDrag(event)) await nodeCreation.dropNode(event);
    else await canvasHistory.batch(() => dropCanvasFiles(event, { directory, availableNodes: availableNodes.value, signal: canvasController.signal, flow }));
  } catch (error) {
    if (!canvasController.signal.aborted) ElMessage.error(error instanceof Error ? error.message : "画布内容添加失败");
  }
}

function selectFiles(position: { x: number; y: number }) {
  const directory = project.value?.directory;
  if (!props.active || props.settingsVisible || !canvasId.value || !directory) return;
  const context = { directory, availableNodes: availableNodes.value, signal: canvasController.signal, flow };
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.onchange = async () => {
    const files = Array.from(input.files ?? []);
    if (!files.length || context.signal.aborted) return;
    try {
      await canvasHistory.batch(() => importCanvasFiles(files, position, context));
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : "文件导入失败");
    }
  };
  input.click();
}

function cancelNodePlacement() {
  placingType.value = "";
  placementPoint.value = undefined;
}

function selectNodePlacement(type: string) {
  if (!canCreate.value) return;
  placingType.value = placingType.value === type ? "" : type;
  placementPoint.value = undefined;
  selectedTool.value = "move";
  assetsVisible.value = false;
  if (placingType.value) workspaceLayout.inspectorVisible.value = false;
  cancelCanvasZoom();
}

function startNodeDrag(event: DragEvent, type: string) {
  if (!canCreate.value) return;
  cancelNodePlacement();
  nodeCreation.startNodeDrag(event, type);
}

async function placeNode(event: MouseEvent) {
  if (!canCreate.value || !placingNode.value || handMode.value || event.ctrlKey || event.button !== 0) return;
  const type = placingNode.value.type;
  const position = flow.screenToFlowCoordinate({ x: event.clientX, y: event.clientY });
  cancelNodePlacement();
  creatingNode.value = true;
  try {
    await nodeCreation.addNode(type, position);
  } catch (error) {
    if (!canvasController.signal.aborted) ElMessage.error(error instanceof Error ? error.message : "节点插件加载失败");
  } finally {
    creatingNode.value = false;
  }
}

async function createFromStarter(id: string) {
  if (!canCreate.value) return;
  cancelNodePlacement();
  try {
    await nodeCreation.addStarter(id);
  } catch (error) {
    if (!canvasController.signal.aborted) ElMessage.error(error instanceof Error ? error.message : "画布操作失败");
  }
}

function uploadAtCenter() {
  cancelNodePlacement();
  const position = nodeCreation.viewportCenter();
  if (canCreate.value && position) selectFiles(position);
}

function openNodeMenu(event: MouseEvent) {
  if (event.target instanceof Element && event.target.classList.contains("vue-flow__pane")) nodeMenuRef.value?.openMenu(event, true);
}

function addNodeAtPointer() {
  const rect = canvasElement.value?.getBoundingClientRect();
  if (!rect) return;
  const position = pointerPosition ?? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  void nodeMenuRef.value?.openMenu(new MouseEvent("contextmenu", { clientX: position.x, clientY: position.y }), true);
}

async function changeHistory(direction: "undo" | "redo") {
  try {
    await canvasHistory[direction]();
    edgeDisconnect.value = undefined;
  } catch (error) {
    ElMessage.error(
      axios.isAxiosError<{ message?: string }>(error)
        ? error.response?.data.message || "恢复画布失败"
        : error instanceof Error
        ? error.message
        : "恢复画布失败"
    );
  }
}

function scheduleCanvasChange() {
  if (canvasSync.applying.value) return;
  scheduleCanvasSave();
  canvasHistory.record();
}

const elementSaveWatchers = new Map<Node | Edge, () => void>();
const nodeRuntimeFields = new Set([
  "data",
  "computedPosition",
  "handleBounds",
  "selected",
  "dimensions",
  "isParent",
  "resizing",
  "dragging",
  "events",
  "initialized",
]);
const edgeRuntimeFields = new Set(["data", "selected", "sourceNode", "targetNode", "sourceX", "sourceY", "targetX", "targetY", "events", "initialized"]);
// ACT: 仅增删、替换元素时扫描列表；位移与 data 各自监听，单个节点变化不遍历其余节点。
watch(
  () => [...flow.nodes.value, ...flow.edges.value],
  (elements) => {
    const current = new Set<Node | Edge>(elements);
    for (const [element, stop] of elementSaveWatchers) {
      if (!current.has(element)) {
        stop();
        elementSaveWatchers.delete(element);
      }
    }
    for (const element of elements) {
      if (elementSaveWatchers.has(element)) continue;
      // 与 toObject 排除的运行态字段保持一致，其他自定义持久字段仍参与自动保存。
      const runtimeFields = isNode(element) ? nodeRuntimeFields : edgeRuntimeFields;
      const stopFields = watch(
        () =>
          Object.keys(element)
            .filter((key) => !runtimeFields.has(key))
            .map((key) => Reflect.get(element, key)),
        scheduleCanvasChange,
        { deep: true, flush: "post" }
      );
      const stopData = watch(() => element.data, scheduleCanvasSave, { deep: true, flush: "post" });
      const stopName = isNode(element)
        ? watch(
            () => element.data?.label,
            () => canvasHistory.record(),
            { flush: "post" }
          )
        : () => {};
      elementSaveWatchers.set(element, () => {
        stopFields();
        stopData();
        stopName();
      });
    }
    scheduleCanvasChange();
  },
  { immediate: true, flush: "post" }
);
onScopeDispose(() => elementSaveWatchers.forEach((stop) => stop()));
async function prepareRefresh() {
  if (!canvasReady.value && canvasId.value) throw new Error("画布正在加载，请稍后刷新");
  await canvasSync.sync();
  await flushCanvasSave();
}

async function refreshCanvas() {
  await prepareRefresh();
}

watch(
  [() => project.value?.directory, canvasId],
  ([directory, fileName], [previousDirectory, previousFileName]) => {
    if (directory !== previousDirectory) {
      workspaceController.abort(new Error("工作区已切换，本轮画布操作已停止"));
      workspaceController = new AbortController();
    }
    edgeDisconnect.value = undefined;
    dragCopy = undefined;
    pointerPosition = undefined;
    resetCanvasKeys();
    // 同一实例只在重新装载画布时失效；重命名仅更新保存路径。
    if (directory !== previousDirectory || !fileName || !previousFileName) {
      canvasController.abort(new Error("画布已重新加载，本次画布调用已停止"));
      canvasController = new AbortController();
    }
    if (!canvasSave.paused) canvasSave.flush();
  },
  { flush: "sync" }
);

// ACT: 切换显示面板不会卸载画布；仅清理交互，不中断本轮工具调用。
watch(() => props.active, (active) => {
  if (!active) assetsVisible.value = false;
  edgeDisconnect.value = undefined;
  dragCopy = undefined;
  pointerPosition = undefined;
  resetCanvasKeys();
}, { flush: "sync" });

let zoomFrame = 0;
let zoomDelta = 0;
let zoomPoint: XYPosition | undefined;
let zoomTime = 0;
let wheelGesture: { time: number; ctrlKey: boolean; deltaMode: number; pinching: boolean } | undefined;

function cancelCanvasZoom() {
  cancelAnimationFrame(zoomFrame);
  zoomFrame = 0;
  zoomDelta = 0;
  zoomPoint = undefined;
  wheelGesture = undefined;
  gestureScale = undefined;
}

function flushCanvasZoom(time: number) {
  zoomFrame = 0;
  const bounds = flow.d3Selection.value?.node()?.getBoundingClientRect();
  if (!bounds || !props.active || props.settingsVisible || document.fullscreenElement || flow.userSelectionActive.value) {
    cancelCanvasZoom();
    return;
  }
  // ACT: 按时间推进，60/120Hz 使用相同速度；卡顿后最多补 64ms，避免一次追赶全部输入。
  const delta = Math.sign(zoomDelta) * Math.min(Math.abs(zoomDelta), Math.max(0, Math.min(64, time - zoomTime)) * 0.0012);
  zoomTime = time;
  const current = viewport.value;
  const zoom = Math.min(flow.maxZoom.value, Math.max(flow.minZoom.value, current.zoom * 2 ** delta));
  const x = zoomPoint ? zoomPoint.x - bounds.left : bounds.width / 2;
  const y = zoomPoint ? zoomPoint.y - bounds.top : bounds.height / 2;
  zoomDelta -= delta;
  if (zoomDelta < 0 && zoom === flow.minZoom.value || zoomDelta > 0 && zoom === flow.maxZoom.value) zoomDelta = 0;
  void flow.setViewport({ x: x - (x - current.x) * zoom / current.zoom, y: y - (y - current.y) * zoom / current.zoom, zoom });
  if (zoomDelta) zoomFrame = requestAnimationFrame(flushCanvasZoom);
  else zoomPoint = undefined;
}

watch([() => props.active, () => props.settingsVisible, canvasId], cancelCanvasZoom, { flush: "sync" });
onScopeDispose(cancelCanvasZoom);

function zoomCanvas(event: WheelEvent | (Event & { scale: number }), fromMap = false) {
  if (event.type === "gestureend") gestureScale = undefined;
  if (!props.active || props.settingsVisible || document.fullscreenElement || flow.userSelectionActive.value) return;
  if (!fromMap && (!(event.target instanceof Element) || !event.target.closest(".vue-flow__pane, .vue-flow__node, .vue-flow__edge, .vue-flow__nodesselection, .nodePlacement"))) return;
  let delta: number;
  let point = pointerPosition;
  if ("scale" in event) {
    if (!Number.isFinite(event.scale) || event.scale <= 0) return;
    delta = event.type === "gesturechange" && gestureScale !== undefined ? Math.log2(event.scale / gestureScale) : 0;
    gestureScale = event.type === "gestureend" ? undefined : event.scale;
  } else {
    const time = performance.now();
    const controlPressed = pressedCodes.has("ControlLeft") || pressedCodes.has("ControlRight");
    if (event.deltaY && (!wheelGesture || time - wheelGesture.time > 200 || wheelGesture.ctrlKey !== event.ctrlKey
      || wheelGesture.deltaMode !== event.deltaMode || controlPressed)) {
      // ACT: Chromium 不提供设备类型；仅以起始小幅小数像素识别捏合，整数输入按滚轮处理，原生来源可用时再替换。
      const pinching = event.ctrlKey && !controlPressed && event.deltaMode === 0 && Math.abs(event.deltaY) < 4 && !Number.isInteger(event.deltaY);
      wheelGesture = { time, ctrlKey: event.ctrlKey, deltaMode: event.deltaMode, pinching };
    }
    if (wheelGesture) wheelGesture.time = time;
    if (!fromMap && !wheelGesture?.pinching && !shortcutPressed(event, generalSettings.value.canvasShortcuts.zoom, pressedCodes)) {
      if (!event.ctrlKey) return;
      // 实体 Ctrl 未绑定缩放时，阻止 Vue Flow 和节点骨架将它误判为捏合。
      delta = 0;
    } else {
      const pixels = event.deltaY * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? flow.dimensions.value.height : 1);
      delta = gestureScale === undefined ? -pixels * (wheelGesture?.pinching ? 0.02 : 0.0005) : 0;
    }
    point = fromMap ? undefined : { x: event.clientX, y: event.clientY };
  }
  const zoom = flow.d3Zoom.value;
  const selection = flow.d3Selection.value;
  if (!zoom || !selection) return;
  event.preventDefault();
  event.stopPropagation();
  if (!delta) return;
  if (zoomDelta * delta < 0) zoomDelta = 0;
  // 最多保留约 100ms 的缩放，反向输入直接取消旧方向余量，不积累长尾动画。
  zoomDelta = Math.max(-0.12, Math.min(0.12, zoomDelta + Math.max(-0.08, Math.min(0.08, delta))));
  zoomPoint = point;
  if (!zoomFrame) {
    zoomTime = performance.now();
    zoomFrame = requestAnimationFrame(flushCanvasZoom);
  }
}

function preventMiddleClick(event: MouseEvent) {
  if (event.button === 1) event.preventDefault();
}

function updateCanvasModifiers(event: KeyboardEvent | MouseEvent) {
  const target = event.target;
  const shortcuts = generalSettings.value.canvasShortcuts;
  const inCanvas =
    target instanceof Element &&
    !target.closest("[role='dialog'], #agentPanel") &&
    (target === document.body || target === document.documentElement || canvasElement.value?.contains(target));
  const composing = "isComposing" in event && event.isComposing;
  zoomKeyPressed.value = props.active && !props.settingsVisible && !composing && shortcutPressed(event, shortcuts.zoom, pressedCodes);
  const editing =
    !(target instanceof Element) ||
    !!target.closest("input, textarea, select, button, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='slider']");
  panKeyPressed.value = props.active && !props.settingsVisible && !!inCanvas && !composing
    && (shortcutPressed(event, "Ctrl", pressedCodes) || !editing && shortcutPressed(event, shortcuts.pan, pressedCodes));
  return { inCanvas, editing };
}

function updateCanvasPointer(event: PointerEvent) {
  pointerPosition = { x: event.clientX, y: event.clientY };
  if (!event.buttons) updateCanvasModifiers(event);
  const bounds = placingNode.value && flow.vueFlowRef.value?.getBoundingClientRect();
  placementPoint.value = bounds && event.target instanceof Element && event.target.closest(".nodePlacement")
    ? { x: event.clientX - bounds.left, y: event.clientY - bounds.top } : undefined;
}

function startCanvasPointer(event: PointerEvent) {
  cancelCanvasZoom();
  updateCanvasModifiers(event);
  // 先阻止框选；后续 mousedown 交给 Vue Flow 的抓手，避免抢占同一次拖动。
  if (handMode.value && event.button === 0 && event.target instanceof Element
    && event.target.closest(".vue-flow__pane, .vue-flow__node, .vue-flow__edge, .vue-flow__nodesselection, .nodePlacement")) event.stopPropagation();
}

function panCanvas(event: MouseEvent) {
  updateCanvasModifiers(event);
  if (!handMode.value || event.button !== 0 || flow.userSelectionActive.value || flow.connectionStartHandle.value
    || !(event.target instanceof Element)
    || !event.target.closest(".vue-flow__pane, .vue-flow__node, .vue-flow__edge, .vue-flow__nodesselection, .nodePlacement")) return;
  const zoom = flow.d3Zoom.value;
  const selection = flow.d3Selection.value;
  const element = selection?.node();
  const startPan = selection?.on("mousedown.zoom");
  if (!zoom || !selection || !element || !startPan) return;
  event.preventDefault();
  // 抓手优先于节点的 nopan 和 stop 修饰符，仍由画布库处理整次拖动及结束事件。
  const filter = zoom.filter();
  zoom.filter(() => true);
  try { startPan.call(element, event, selection.datum()); }
  finally { zoom.filter(filter); }
}

function updateCanvasKeys(event: KeyboardEvent) {
  if (event.type === "keydown") {
    pressedCodes.add(event.code);
  } else pressedCodes.delete(event.code);
  if (!props.active || props.settingsVisible) return resetCanvasKeys();
  const { inCanvas, editing } = updateCanvasModifiers(event);
  const target = event.target;
  const shortcuts = generalSettings.value.canvasShortcuts;
  const navigationAction = target instanceof Element && target.closest("button") && target.closest(".canvasControlStack, .canvasMap")
    ? (["search", "fitView", "focusSelection", "returnView", "toggleMap"] as const).find(action => shortcutMatches(event, shortcuts[action]))
    : undefined;
  if (event.type === "keydown" && inCanvas && placingNode.value && event.key === "Escape") {
    event.preventDefault();
    cancelNodePlacement();
    return;
  }
  if (event.type === "keydown" && inCanvas && placingNode.value && event.key === "Enter" && !event.isComposing
    && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    const bounds = flow.vueFlowRef.value?.getBoundingClientRect();
    if (bounds) void placeNode(new MouseEvent("click", { clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 }));
    return;
  }
  if (target instanceof Element && target.closest(".mapViewport") && !event.ctrlKey && !event.metaKey && !event.altKey
    && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape"].includes(event.key)) {
    cancelCanvasZoom();
    return;
  }
  if (event.type === "keyup" || event.defaultPrevented || event.isComposing || !inCanvas || (editing && !navigationAction)) return;
  const action = navigationAction ?? ([
    "group", "mergeGroup", "ungroup", "addNode", "moveTool", "handTool", "arrange", "search",
    "delete", "copy", "paste", "undo", "redo", "zoomIn", "zoomOut", "fitView", "focusSelection", "returnView", "toggleMap",
  ] as const).find((action) =>
    shortcutMatches(event, shortcuts[action])
  );
  if (!action) {
    const nativeClipboardKey = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
      && (event.code === "KeyV" || event.code === "KeyC" && flow.getSelectedNodes.value.length && !window.getSelection()?.toString());
    if (panKeyPressed.value || nativeClipboardKey) event.preventDefault();
    return;
  }
  if (!canvasId.value || !project.value?.directory) return;
  if (action === "copy" && (!flow.getSelectedNodes.value.length || window.getSelection()?.toString())) return;
  // 桌面快捷键直接复用原生剪贴板桥接；浏览器 Ctrl/Cmd+V 保留原生事件，避免额外读取权限。
  if (!isDesktop && action === "paste" && event.code === "KeyV" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) return;
  event.preventDefault();
  if (event.repeat) return;
  cancelCanvasZoom();
  if (action === "delete") {
    const nodes = [...flow.getSelectedNodes.value];
    const menu = nodeMenuRef.value;
    if (!menu || !nodes.some((node) => node.deletable !== false)) return;
    void canvasHistory
      .batch(() => menu.deleteSelection(nodes))
      .catch((error) => {
        ElMessage.error(error instanceof Error ? error.message : "节点删除失败");
      });
    return;
  }
  if (action === "copy") void copySelectedNodes();
  else if (action === "paste") void pasteNodeAtCenter();
  else if (action === "undo" || action === "redo") void changeHistory(action);
  else if (action === "group" || action === "mergeGroup" || action === "ungroup") {
    void selectionToolbarRef.value?.operate(action);
  } else if (action === "addNode") addNodeAtPointer();
  else if (action === "moveTool" || action === "handTool") {
    cancelNodePlacement();
    selectedTool.value = action === "handTool" ? "hand" : "move";
  }
  else if (action === "arrange") void canvasControlsRef.value?.arrangeNodes();
  else if (action === "search") nodeSearchRef.value?.open();
  else if (action === "fitView") void navigation.showAll();
  else if (action === "focusSelection") void navigation.focusNodes(flow.getSelectedNodes.value.map(node => node.id));
  else if (action === "returnView") void navigation.goBack();
  else if (action === "toggleMap") showMap.value = !showMap.value;
  else void flow[action]();
}

function resetCanvasKeys() {
  cancelCanvasZoom();
  pressedCodes.clear();
  gestureScale = undefined;
  zoomKeyPressed.value = false;
  panKeyPressed.value = false;
}

watch([() => props.active, () => props.settingsVisible, () => generalSettings.value.canvasShortcuts], resetCanvasKeys, { deep: true, flush: "sync" });

onMounted(() => {
  // 在捕获阶段同步修饰键，避免节点编辑器截断 keydown/keyup 后缩放状态丢失或卡住。
  window.addEventListener("keydown", updateCanvasKeys, true);
  window.addEventListener("keyup", updateCanvasKeys, true);
  window.addEventListener("blur", resetCanvasKeys);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", updateCanvasKeys, true);
  window.removeEventListener("keyup", updateCanvasKeys, true);
  window.removeEventListener("blur", resetCanvasKeys);
  workspaceController.abort(new Error("工作区已关闭"));
  canvasController.abort(new Error("画布已关闭"));
  canvasSave.flush();
});

provide("workspaceFiles", () => {
  const directory = project.value?.directory;
  if (!directory) throw new Error("请先选择工作目录");
  return useWorkspaceFiles(directory);
});
provide("workspaceDirectory", () => {
  const directory = project.value?.directory;
  if (!directory) throw new Error("请先选择工作目录");
  return directory;
});
const defaultEdgeOptions = markRaw({
  type: "simple-bezier",
  animated: false,
  class: ({ sourceNode, targetNode }: GraphEdge) => {
    if (!sourceNode.selected && !sourceNode.dragging && !targetNode.selected && !targetNode.dragging) return "";
    return ["edgeNodeActive", generalSettings.value.canvasEdgeColorMode !== "none" && "edgeActive", generalSettings.value.canvasEdgeAnimationEnabled && "animated"].filter(Boolean).join(" ");
  },
  focusable: false,
  selectable: false,
  updatable: false,
  interactionWidth: 40,
});
</script>

<style lang="scss" scoped>
.canvas {
  position: relative;
  background: var(--el-bg-color-page);
  width: 100%;
  height: 100%;
  container-type: inline-size;

  > .vue-flow { width: calc(100% - var(--inspectorWidth)); }

  &.compositingEnabled :deep(.vue-flow__transformationpane) {
    will-change: transform;
  }

  &.handMode :deep(.vue-flow__transformationpane),
  &.handMode :deep(.vue-flow__transformationpane *) {
    pointer-events: none !important;
  }

  &.handMode :deep(.vue-flow__pane) {
    cursor: grab;
  }

  .nodePlacement {
    position: absolute;
    inset: 0;
    z-index: 4;
    overflow: hidden;
    cursor: crosshair;

    .nodePlacementHint {
      position: absolute;
      top: 16px;
      left: 50%;
      display: flex;
      align-items: center;
      gap: 8px;
      max-width: calc(100% - 96px);
      padding: 6px 8px 6px 14px;
      border: 1px solid var(--el-border-color-light);
      border-radius: var(--ui-radius-large);
      background: var(--el-bg-color-overlay);
      box-shadow: var(--floatingShadow);
      color: var(--el-text-color-regular);
      font-size: 13px;
      transform: translateX(-50%);
      cursor: default;

      .el-button { flex-shrink: 0; width: 28px; height: 28px; padding: 0; }
    }

    .nodePlacementPreview {
      position: absolute;
      top: 0;
      left: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      border: 1px dashed var(--el-color-primary);
      border-radius: var(--ui-radius-large);
      background: var(--el-bg-color-overlay);
      color: var(--el-color-primary);
      box-shadow: var(--floatingShadow);
      pointer-events: none;
    }
  }

  &.handMode .nodePlacement { cursor: grab; }

  &.edgesHidden :deep(.vue-flow__edges:not(:has(.edgeNodeActive))) {
    display: none;
  }
  &.edgesHidden :deep(.vue-flow__handle:not(.connectedNodeActive)) {
    display: none !important;
  }

  :deep(.vue-flow__edge-path) {
    stroke: var(--el-text-color-secondary);
    stroke-width: 1.25;
    stroke-opacity: 0.65;
    vector-effect: non-scaling-stroke;
  }

  :deep(.vue-flow__edge.edgeNodeActive .vue-flow__edge-path),
  :deep(.vue-flow__edge:hover .vue-flow__edge-path) {
    stroke-width: 2;
    stroke-opacity: 1;
  }

  :deep(.vue-flow__edge.edgeActive .vue-flow__edge-path) {
    stroke: var(--canvasEdgeColor);
  }

  &:has(.selectionConnection) :deep(.vue-flow__node:not(.selected) .nodeHandle.target .handleIcon) {
    opacity: 1;
  }

  :deep(.vue-flow__nodesselection-rect) {
    box-sizing: content-box;
    padding: 8px;
    margin: -8px;
    border-radius: 4px;
  }

  .canvasNavPanel {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
    margin: 12px;
  }

  .assetPanel {
    position: absolute;
    top: 12px;
    left: 156px;
    z-index: 6;

    @container (max-width: 700px) { left: 64px; }
    @media (max-width: 480px) { left: 56px; }
  }
}
.canvasMenuHost {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;

  .searchButton {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    margin: 0;
    padding: 0;
    border-radius: var(--ui-radius);
    color: var(--el-text-color-regular);

    &:hover:not(.is-disabled) {
      background: var(--el-fill-color-light);
      color: var(--el-text-color-primary);
    }
  }
}
.edgeDisconnect {
  position: fixed;
  z-index: 1000;
  width: 32px;
  height: 32px;
  padding: 0;
  transform: translate(-50%, -50%);
}
</style>
