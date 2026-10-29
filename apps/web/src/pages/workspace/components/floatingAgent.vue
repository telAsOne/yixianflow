<template>
  <teleport to="body">
    <aside
      v-show="visible"
      id="agentPanel"
      class="floatingAgent"
      :inert="props.inert"
      :class="{ docked, dragging: interaction?.mode === 'move' }"
      :style="panelStyle"
      aria-label="AI 对话"
      @pointerdown="startMenuMove"
      @pointermove="moveInteraction"
      @pointerup="stopInteraction"
      @pointercancel="stopInteraction"
      @lostpointercapture="stopInteraction">
      <div
        v-for="handle in resizeHandles"
        :key="handle.edge"
        class="resizeHandle"
        :class="handle.edge"
        role="separator"
        :aria-label="handle.label"
        :aria-orientation="handle.edge === 'bottom' ? 'horizontal' : 'vertical'"
        :aria-valuemin="Math.min(handle.edge === 'bottom' ? 240 : 320, resizeLimit(handle.edge))"
        :aria-valuemax="resizeLimit(handle.edge)"
        :aria-valuenow="handle.edge === 'bottom' ? height : width"
        tabindex="0"
        @pointerdown.stop="startInteraction($event, handle.edge)"
        @keydown="resizeWithKeyboard($event, handle.edge)" />
      <agent v-model="visible">
        <template #menuActions>
          <el-button
            text
            circle
            :aria-label="docked ? '切换为悬浮' : '停靠到左侧'"
            :title="docked ? '切换为悬浮' : '停靠到左侧'"
            @click="docked = !docked">
            <icon-app-window-bottom-right v-if="docked" :size="17" aria-hidden="true" />
            <icon-layout-sidebar v-else :size="17" aria-hidden="true" />
          </el-button>
        </template>
      </agent>
    </aside>
  </teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, shallowRef, toRef, watch } from "vue";
import { IconLayoutSidebar, IconAppWindowBottomRight } from "@tabler/icons-vue";
import agent from "@/components/agent/index.vue";
import type { AgentLayout } from "../useWorkspaceView";

const visible = defineModel<boolean>({ default: false });
const layout = defineModel<AgentLayout>("layout", { required: true });
const props = defineProps<{ topOffset: number; maxDockedWidth: number; inert?: boolean }>();
const docked = toRef(layout.value, "docked");
const viewport = reactive({ width: window.innerWidth, height: window.innerHeight });
const gap = computed(() => Math.min(15, viewport.width / 2, viewport.height / 2));
const maxWidth = computed(() => Math.max(0, docked.value ? Math.min(props.maxDockedWidth, viewport.width) : viewport.width - gap.value * 2));
const preferredWidth = toRef(layout.value, "width");
const width = computed(() => Math.min(preferredWidth.value, maxWidth.value));
const preferredHeight = toRef(layout.value, "height");
const floatingHeight = computed(() => Math.min(preferredHeight.value ?? viewport.height * 0.8, viewport.height - gap.value * 2));
const height = computed(() => (docked.value ? Math.max(0, viewport.height - props.topOffset) : floatingHeight.value));
const resizeHandles = computed(
  () =>
    [
      { edge: "right", label: "从右侧调整对话宽度" },
      ...(docked.value
        ? []
        : [
            { edge: "left", label: "从左侧调整对话宽度" },
            { edge: "bottom", label: "从下方调整对话高度" },
          ]),
    ] as { edge: ResizeEdge; label: string }[]
);
const left = toRef(layout.value, "left", gap.value);
const top = toRef(layout.value, "top", viewport.height - floatingHeight.value - gap.value);
const panelStyle = computed(() => ({
  left: `${docked.value ? 0 : left.value}px`,
  top: `${docked.value ? props.topOffset : top.value}px`,
  width: `${width.value}px`,
  height: `${height.value}px`,
}));
const interaction = shallowRef<{
  mode: "move" | ResizeEdge;
  pointerId: number;
  element: HTMLElement;
  x: number;
  y: number;
  left: number;
  top: number;
  right: number;
  width: number;
  height: number;
}>();
type ResizeEdge = "left" | "right" | "bottom";

function movePanel(x: number, y: number) {
  left.value = Math.max(gap.value, Math.min(x, viewport.width - gap.value - width.value));
  top.value = Math.max(gap.value, Math.min(y, viewport.height - gap.value - height.value));
}

function resizeAnchor(edge: ResizeEdge) {
  if (docked.value) return 0;
  return edge === "left" ? left.value + width.value : edge === "right" ? left.value : top.value;
}

function resizeLimit(edge: ResizeEdge, anchor = resizeAnchor(edge)) {
  if (docked.value) return maxWidth.value;
  if (edge === "left") return Math.min(maxWidth.value, anchor - (docked.value ? 0 : gap.value));
  return Math.max(0, (edge === "right" ? viewport.width : viewport.height) - gap.value - anchor);
}

function resizePanel(edge: ResizeEdge, value: number, anchor = resizeAnchor(edge)) {
  const limit = resizeLimit(edge, anchor);
  const size = Math.min(limit, Math.max(Math.min(edge === "bottom" ? 240 : 320, limit), value));
  if (edge === "bottom") preferredHeight.value = size;
  else preferredWidth.value = size;
  if (!docked.value && edge === "left") movePanel(anchor - width.value, top.value);
}

function resizeWithKeyboard(event: KeyboardEvent, edge: ResizeEdge) {
  const keys = edge === "bottom" ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
  const direction = keys.indexOf(event.key);
  if (direction < 0) return;
  event.preventDefault();
  const delta = (direction === 0 ? -16 : 16) * (edge === "left" ? -1 : 1);
  resizePanel(edge, (edge === "bottom" ? height.value : width.value) + delta);
}

function startMenuMove(event: PointerEvent) {
  const target = event.target as HTMLElement;
  if (!target.closest(".agentMenu") || target.closest("button, input, textarea, select, a, [contenteditable], .el-input, .conversationTitle")) return;
  startInteraction(event, "move");
}

function startInteraction(event: PointerEvent, mode: "move" | ResizeEdge) {
  if (event.button !== 0 || interaction.value || (docked.value && mode !== "right")) return;
  event.preventDefault();
  const element = event.currentTarget as HTMLElement;
  element.setPointerCapture(event.pointerId);
  interaction.value = {
    mode,
    pointerId: event.pointerId,
    element,
    x: event.clientX,
    y: event.clientY,
    left: docked.value ? 0 : left.value,
    top: top.value,
    right: docked.value ? width.value : left.value + width.value,
    width: width.value,
    height: height.value,
  };
}

function moveInteraction(event: PointerEvent) {
  const current = interaction.value;
  if (!current || current.pointerId !== event.pointerId) return;
  if (current.mode === "move") movePanel(current.left + event.clientX - current.x, current.top + event.clientY - current.y);
  else if (current.mode === "left") resizePanel("left", current.width + current.x - event.clientX, current.right);
  else if (current.mode === "right") resizePanel("right", current.width + event.clientX - current.x, current.left);
  else resizePanel("bottom", current.height + event.clientY - current.y, current.top);
}

function stopInteraction(event?: PointerEvent) {
  const current = interaction.value;
  if (event && current?.pointerId !== event.pointerId) return;
  interaction.value = undefined;
  if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
  if (current?.element === document.activeElement) current.element.blur();
}

function resizeViewport() {
  stopInteraction();
  viewport.width = window.innerWidth;
  viewport.height = window.innerHeight;
}

watch([visible, docked], () => stopInteraction());
watch(
  [width, height, () => viewport.width, () => viewport.height, docked],
  () => {
    if (!docked.value) movePanel(left.value, top.value);
  },
  { immediate: true, flush: "sync" }
);
window.addEventListener("resize", resizeViewport);
onBeforeUnmount(() => {
  stopInteraction();
  window.removeEventListener("resize", resizeViewport);
});
</script>

<style scoped lang="scss">
.floatingAgent {
  position: fixed;
  z-index: 1001;
  box-sizing: border-box;
  max-width: 100vw;
  max-height: 100dvh;
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--ui-radius-large, 12px);
  background: color-mix(in srgb, var(--el-bg-color-overlay) 70%, transparent);
  backdrop-filter: blur(6px);
  box-shadow: var(--el-box-shadow-light);

  &.docked {
    border-width: 0 1px 0 0;
    border-radius: 0;
    background: var(--el-bg-color-overlay);
    box-shadow: none;
  }

  :deep(.agent) {
    border-radius: inherit;
  }
  &:not(.docked) :deep(.agentMenu) {
    cursor: grab;
    touch-action: none;
  }

  &.dragging {
    user-select: none;
    :deep(.agentMenu) {
      cursor: grabbing;
    }
  }

  .resizeHandle {
    position: absolute;
    z-index: 1;
    touch-action: none;

    &.left,
    &.right {
      top: 0;
      bottom: 5px;
      width: 5px;
      cursor: ew-resize;
    }

    &.left {
      left: 0;
    }
    &.right {
      right: 0;
    }
    &.bottom {
      right: 0;
      bottom: 0;
      left: 0;
      height: 5px;
      cursor: ns-resize;
    }

    &:hover,
    &:focus-visible {
      background: var(--el-color-primary-light-5);
    }
  }
}
</style>
