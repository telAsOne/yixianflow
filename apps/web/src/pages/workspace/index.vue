<template>
  <main class="workspacePage" :style="{ '--agentWidth': `${compact || !agentVisible ? 0 : agentWidth}px`, '--workspaceHeaderHeight': `${headerHeight}px` }">
    <canvasPanel
      :key="workspaceStore.project?.directory"
      ref="canvasPanelRef"
      class="canvasPanel"
      :class="{ backgroundPanel: activePanel !== 'canvas' }"
      :inert="activePanel !== 'canvas' || refreshing"
      :aria-hidden="activePanel !== 'canvas'"
      :active="activePanel === 'canvas'"
      :settingsVisible="settingsVisible" />
    <keep-alive :max="1">
      <documentPanel
        v-if="activePanel === 'document'"
        :key="workspaceStore.project?.directory"
        :ref="setDocumentPanel"
        :inert="refreshing"
        :readNode="readDocumentNode"
        :readNodes="readDocumentNodes"
        :mountNode="mountDocumentNode"
        :resolveNodeFile="resolveDocumentNodeFile"
        :observeNode="observeDocumentNode"
        :flushNodes="flushDocumentNodes"
        :fileAction="performFileAction"
        :saveNode="saveDocumentNode" />
    </keep-alive>
    <header ref="headerElement" class="workspaceChrome">
      <workspaceMenu class="workspaceMenu" @openSettings="settingsVisible = true" />
      <div v-show="activePanel === 'canvas'" ref="menuTarget" class="canvasMenuTarget" :inert="refreshing" />
      <div v-show="activePanel === 'canvas'" ref="controlsTarget" class="canvasControlsTarget" :inert="refreshing" />
      <div class="workspaceActions">
        <el-segmented :modelValue="activePanel" class="panelSwitcher" :options="panelOptions" aria-label="切换面板" @change="switchPanel">
          <template #default="{ item }">
            <span class="panelOption">
              <component :is="item.icon" :size="15" aria-hidden="true" />
              <span class="optionLabel">{{ item.label }}</span>
            </span>
          </template>
        </el-segmented>
        <workspacePresence
          v-if="workspaceStore.project"
          :directory="workspaceStore.project.directory"
          :canvasId="canvasPanelRef?.canvasId"
          :panel="activePanel"
          :refreshing="refreshing"
          :saveError="canvasPanelRef?.saveError"
          @resolveSave="canvasPanelRef?.showSaveConflict()"
          @refresh="refreshProject" />
        <el-tooltip content="AI 助手" placement="bottom-end" :showArrow="false" :hideAfter="0">
          <el-button
            class="agentButton"
            :type="agentVisible ? 'primary' : 'default'"
            :aria-expanded="agentVisible"
            aria-label="显示或收起 AI 助手"
            aria-controls="agentPanel"
            @click="agentVisible = !agentVisible">
            <icon-sparkles :size="18" aria-hidden="true" />
          </el-button>
        </el-tooltip>
        <el-button v-if="activePanel === 'canvas'" class="agentButton" :type="inspectorShown ? 'primary' : 'default'" :disabled="!inspectorAvailable" :aria-expanded="inspectorShown" aria-label="显示或收起节点面板" :title="inspectorAvailable ? '节点面板' : '选择节点后查看操作'" @click="inspectorVisible = !inspectorVisible">
          <icon-layout-sidebar-right :size="18" aria-hidden="true" />
        </el-button>
      </div>
    </header>
    <floatingAgent v-if="agentMounted" :key="workspaceStore.project?.directory" v-model="agentVisible" v-model:layout="agentLayout" :topOffset="headerHeight" :maxDockedWidth="agentMaxWidth" :inert="refreshing" />
    <settings v-model="settingsVisible" />
  </main>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onScopeDispose, provide, ref, shallowRef, toRefs, watch, type ComponentPublicInstance } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import axios from "axios";
import { IconLayoutDashboard, IconFileText, IconSparkles, IconLayoutSidebarRight } from "@tabler/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import settings from "@/components/settings/index.vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { flushSettings } from "@/stores/settings";
import { registerWorkspaceControl, waitForControlValue } from "@/lib/mcpControl";
import canvasPanel from "./panels/canvas/canvasHost.vue";
import type { DocumentNodeOptions } from "./panels/canvas/canvasFiles";
import workspaceMenu from "./components/workspaceMenu.vue";
import workspacePresence from "./components/workspacePresence.vue";
import { workspaceLayoutKey } from "./workspaceLayout";
import { useWorkspaceView } from "./useWorkspaceView";
const floatingAgent = defineAsyncComponent(() => import("./components/floatingAgent.vue"));
const documentPanel = defineAsyncComponent(() => import("./panels/document/index.vue"));

const workspaceStore = useWorkspaceStore();
const { activePanel, agentVisible, inspectorVisible, inspectorWidth, agent: agentLayout } = toRefs(useWorkspaceView(() => workspaceStore.project?.directory));
watch(() => workspaceStore.pendingAgentMessage, message => {
  if (message && message.directory === workspaceStore.project?.directory) agentVisible.value = true;
}, { immediate: true });
const agentMounted = ref(false);
watch([() => workspaceStore.project?.directory, agentVisible], ([directory, visible], previous) => {
  if (directory !== previous?.[0]) agentMounted.value = false;
  if (visible) agentMounted.value = true;
}, { immediate: true });
const panelOptions = [
  { label: "画布", value: "canvas", icon: IconLayoutDashboard },
  { label: "文档", value: "document", icon: IconFileText },
];
const headerElement = ref<HTMLElement>();
const headerHeight = ref(56);
const viewportWidth = ref(window.innerWidth);
const compact = computed(() => viewportWidth.value < 960);
const menuTarget = ref<HTMLElement>();
const controlsTarget = ref<HTMLElement>();
const inspectorAvailable = ref(false);
const inspectorShown = computed(() => activePanel.value === "canvas" && inspectorAvailable.value && inspectorVisible.value);
const agentMaxWidth = computed(() => compact.value ? Math.min(520, viewportWidth.value) : Math.min(520, viewportWidth.value - 320
  - (inspectorShown.value ? Math.min(inspectorWidth.value, viewportWidth.value - 640) : 0)));
const agentWidth = computed(() => agentVisible.value && agentLayout.value.docked ? Math.max(0, Math.min(agentLayout.value.width, agentMaxWidth.value)) : 0);
const inspectorMaxWidth = computed(() => compact.value ? Math.min(600, viewportWidth.value) : Math.min(600, viewportWidth.value - (agentVisible.value ? agentWidth.value : 0) - 320));
provide(workspaceLayoutKey, { menuTarget, controlsTarget, compact, inspectorAvailable, inspectorVisible, inspectorWidth, inspectorMaxWidth });
watch(inspectorShown, visible => { if (visible && compact.value) agentVisible.value = false; }, { immediate: true });
watch(agentVisible, visible => { if (visible && compact.value) inspectorVisible.value = false; });
watch(compact, value => { if (value && inspectorShown.value) agentVisible.value = false; });
onMounted(() => {
  const observer = new ResizeObserver(() => {
    headerHeight.value = headerElement.value?.offsetHeight ?? 56;
    viewportWidth.value = window.innerWidth;
  });
  observer.observe(headerElement.value!);
  onScopeDispose(() => observer.disconnect());
});
const settingsVisible = ref(false);
const refreshing = ref(false);
provide("workspaceRefreshing", refreshing);
const canvasPanelRef = ref<InstanceType<typeof canvasPanel>>();
const documentPanelCache = shallowRef<{ directory: string; instance: InstanceType<typeof documentPanel> }>();
const documentPanelRef = computed(() => documentPanelCache.value?.directory === workspaceStore.project?.directory ? documentPanelCache.value?.instance : undefined);
watch(() => workspaceStore.project?.directory, () => { documentPanelCache.value = undefined; }, { flush: "sync" });
function setDocumentPanel(value: Element | ComponentPublicInstance | null) {
  const directory = workspaceStore.project?.directory;
  // KeepAlive 失活会清空模板 ref，保留同一工作区实例以协调后台文档保存和文件操作。
  if (value && directory) documentPanelCache.value = { directory, instance: value as InstanceType<typeof documentPanel> };
}
provide("canvas", () => canvasPanelRef.value?.getCanvasContext());
provide("mentionCanvas", () => canvasPanelRef.value?.mentionSource);
provide("activateCanvasPanel", () => switchPanel("canvas"));
provide("performWorkspaceFileAction", (directory: string, action: "copy" | "rename" | "move" | "delete", path: string, target?: string, entryType: "canvas" | "directory" = "canvas") =>
  documentPanelRef.value ? documentPanelRef.value.performFileAction(directory, action, path, target, entryType) : performFileAction(directory, action, path, target));

const controlLifetime = new AbortController();
onScopeDispose(() => controlLifetime.abort(new Error("工作区已关闭")));
registerWorkspaceControl({
  getState: () => ({
    directory: workspaceStore.project?.directory ?? null,
    canvasId: canvasPanelRef.value?.canvasId || null,
    panel: activePanel.value,
    tools: canvasPanelRef.value?.canvasReady ? canvasPanelRef.value.getCanvasContext()?.tools ?? [] : [],
    document: documentPanelRef.value?.getDocument(false),
  }),
  flushSave,
  async call(request, signal) {
    if (refreshing.value) throw new Error("项目正在刷新，请稍后重试");
    const directory = workspaceStore.project?.directory;
    if (!directory) throw new Error("请先打开工作区");
    const callSignal = AbortSignal.any([signal, controlLifetime.signal]);
    const checkDirectory = () => {
      callSignal.throwIfAborted();
      if (directory !== workspaceStore.project?.directory) throw new Error("工作区已切换，本次调用已停止");
    };
    checkDirectory();
    if (request.name === "switchPanel") {
      if (request.args.panel !== "canvas" && request.args.panel !== "document") throw new Error("未知面板");
      if (!(await switchPanel(request.args.panel))) throw new Error("面板切换失败，请检查文档是否保存成功");
      checkDirectory();
      return { panel: activePanel.value };
    }
    if (["getDocument", "openDocument", "writeDocument"].includes(request.name)) {
      if (!(await switchPanel("document"))) throw new Error("文档面板无法打开");
      const panel = await waitForControlValue(() => documentPanelRef.value, callSignal);
      checkDirectory();
      if (request.name === "openDocument") await panel.openDocument(request.args, callSignal);
      if (request.name === "writeDocument") await panel.writeDocument(request.args, callSignal);
      checkDirectory();
      return panel.getDocument();
    }
    if (!(await switchPanel("canvas"))) throw new Error("画布面板无法打开");
    const context = await waitForControlValue(
      () => (canvasPanelRef.value?.canvasReady ? canvasPanelRef.value.getCanvasContext() : undefined),
      callSignal
    );
    checkDirectory();
    return context.call({ name: request.name, args: request.args }, callSignal);
  },
});

async function flushSave() {
  if (refreshing.value) throw new Error("项目正在刷新，请稍后重试");
  await documentPanelRef.value?.flushSave();
  await canvasPanelRef.value?.flushSave();
  await flushSettings();
}

async function refreshProject() {
  if (refreshing.value) return;
  const directory = workspaceStore.project?.directory;
  if (!directory || !canvasPanelRef.value) return;
  refreshing.value = true;
  try {
    const canvas = canvasPanelRef.value;
    if (documentPanelRef.value) await documentPanelRef.value.refreshProject(() => canvas.refreshProject());
    else await canvas.refreshProject();
    if (workspaceStore.project?.directory !== directory) return;
    ElMessage.success("项目已刷新");
  } catch (error) {
    ElMessage.error(axios.isAxiosError<{ message?: string }>(error)
      ? error.response?.data?.message || error.message
      : error instanceof Error ? error.message : "项目刷新失败，当前修改已保留");
  } finally { refreshing.value = false; }
}

onBeforeRouteLeave(async () => {
  if (refreshing.value || canvasPanelRef.value?.saveBusy) {
    ElMessage.warning("画布操作尚未完成，请稍后退出");
    return false;
  }
  try {
    await flushSave();
    return true;
  } catch (error) {
    const message = axios.isAxiosError<{ message?: string }>(error)
      ? error.response?.data?.message || error.message
      : error instanceof Error
      ? error.message
      : "项目保存失败";
    const leave = await ElMessageBox.confirm(`无法保存项目：${message}。文件或目录可能已被移动或删除。仍然退出将丢弃尚未保存的修改。`, "项目未保存", {
      type: "warning",
      confirmButtonText: "仍然退出",
      cancelButtonText: "留在项目",
      closeOnClickModal: false,
    }).then(
      () => true,
      () => false
    );
    if (leave) {
      documentPanelRef.value?.cancelSave();
      canvasPanelRef.value?.cancelSave();
    }
    return leave;
  }
});

async function switchPanel(value: string | number | boolean) {
  if (refreshing.value) return false;
  if (value !== "canvas" && value !== "document") return false;
  try {
    if (activePanel.value === "document") await documentPanelRef.value?.flushSave();
    activePanel.value = value;
    await nextTick();
    return true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "文本保存失败");
    return false;
  }
}

function readDocumentNode(directory: string, canvasPath: string, nodeId: string) {
  if (!canvasPanelRef.value) throw new Error("画布尚未就绪");
  return canvasPanelRef.value.readDocumentNode(directory, canvasPath, nodeId);
}

function readDocumentNodes(directory: string, options?: DocumentNodeOptions) {
  if (!canvasPanelRef.value) throw new Error("画布尚未就绪");
  return canvasPanelRef.value.readDocumentNodes(directory, options);
}

function mountDocumentNode(directory: string, canvasPath: string, nodeId: string, target: HTMLElement) {
  if (!canvasPanelRef.value) throw new Error("画布尚未就绪");
  return canvasPanelRef.value.mountDocumentNode(directory, canvasPath, nodeId, target);
}

function resolveDocumentNodeFile(directory: string, path: string) {
  if (!canvasPanelRef.value) throw new Error("画布尚未就绪");
  return canvasPanelRef.value.resolveDocumentNodeFile(directory, path);
}

function observeDocumentNode(directory: string, canvasPath: string, nodeId: string, onState: (state: { dirty: boolean; error: string; deleted: boolean }) => void) {
  if (!canvasPanelRef.value) throw new Error("画布尚未就绪");
  return canvasPanelRef.value.observeDocumentNode(directory, canvasPath, nodeId, onState);
}

async function flushDocumentNodes() {
  if (!canvasPanelRef.value) throw new Error("画布尚未就绪");
  await canvasPanelRef.value.flushSave();
}

function performFileAction(directory: string, action: "copy" | "rename" | "move" | "delete", path: string, target?: string, nodeId?: string) {
  if (!canvasPanelRef.value) throw new Error("画布尚未就绪");
  return canvasPanelRef.value.performFileAction(directory, action, path, target, nodeId);
}

function saveDocumentNode(directory: string, canvasPath: string, nodeId: string, handleId: string, text: string, expectedText?: string) {
  if (!canvasPanelRef.value) throw new Error("画布尚未就绪");
  return canvasPanelRef.value.saveDocumentNode(directory, canvasPath, nodeId, handleId, text, expectedText);
}
</script>

<style scoped lang="scss">
.workspacePage {
  position: relative;
  width: 100%;
  height: 100dvh;
  background-color: var(--el-bg-color);

  .canvasPanel {
    position: absolute;
    inset: var(--workspaceHeaderHeight) 0 0 var(--agentWidth);
    width: auto;
    height: auto;

    &.backgroundPanel {
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
    }
  }

  .workspaceChrome {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    z-index: 1002;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    min-height: 56px;
    box-sizing: border-box;
    padding: 8px 12px;
    border-bottom: 1px solid var(--el-border-color-light);
    background: var(--el-bg-color);

    .workspaceMenu { flex-shrink: 0; }
    .canvasMenuTarget { min-width: 0; }
    .canvasControlsTarget { flex: 1; min-width: 0; }

    .workspaceActions {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-left: auto;
    }

    .panelSwitcher {
      --el-segmented-bg-color: var(--el-fill-color);
      --el-segmented-color: var(--el-text-color-regular);
      height: 38px;
      padding: 3px;
      border: 1px solid var(--el-border-color-light);
      border-radius: var(--ui-radius-large);
      box-shadow: var(--floatingShadow);
      font-size: 13px;

      :deep(.el-segmented__item),
      :deep(.el-segmented__item-selected) {
        border-radius: var(--ui-radius);
      }

      .panelOption {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 0 4px;
        line-height: 30px;
      }
    }

    .agentButton {
      width: 38px;
      height: 38px;
      margin: 0;
      padding: 0;
      border-radius: var(--ui-radius-large);
      box-shadow: var(--floatingShadow);
      transition: transform 160ms ease, background-color 160ms ease;

      &:active {
        transform: scale(0.96);
      }

      &:focus-visible {
        outline: 2px solid var(--el-color-primary);
        outline-offset: 2px;
      }

      @media (prefers-reduced-motion: reduce) {
        transition: none;
      }
    }

    @media (max-width: 1500px) {
      .panelSwitcher .optionLabel,
      .workspaceActions :deep(.presenceSummary) {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
      }
    }

    @media (max-width: 760px) {
      .canvasControlsTarget { flex: 1 0 100%; order: 1; }
      .canvasMenuTarget { flex: 1 0 160px; }
      .workspaceActions { gap: 4px; }
    }
  }
}
</style>
