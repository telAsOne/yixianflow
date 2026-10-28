<template>
  <aside class="nodeInspector" :style="{ width: `${actualWidth}px` }" aria-label="节点面板" @pointerdown.stop @mousedown.stop @click.stop @dblclick.stop @keydown.stop @wheel.stop @contextmenu.stop>
    <div class="resizeHandle" role="separator" aria-label="调整节点面板宽度" aria-orientation="vertical" :aria-valuemin="Math.min(320, maxWidth)" :aria-valuemax="maxWidth" :aria-valuenow="actualWidth" tabindex="0"
      @pointerdown="startResize" @pointermove="resize" @pointerup="stopResize" @pointercancel="stopResize" @lostpointercapture="stopResize" @keydown="resizeWithKeyboard" />
    <div class="inspectorHeader">
      <span class="inspectorTitle" :title="title">{{ title }}</span>
      <el-button text :icon="IconX" aria-label="收起节点面板" title="收起节点面板" @click="emit('close')" />
    </div>
    <div class="inspectorContent">
      <el-alert v-if="requiresModel && !accountView?.authenticated" class="modelNotice" title="登录逸仙账户后使用生成模型" type="info" :closable="false" showIcon>
        <el-button text type="primary" @click="signInVisible = true">登录 / 注册</el-button>
      </el-alert>
      <slot />
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from "vue";
import { IconX } from "@tabler/icons-vue";
import { ElButton } from "element-plus";
import { accountView, signInVisible } from "@/stores/account";

const props = defineProps<{ title: string; maxWidth: number; requiresModel?: boolean }>();
const width = defineModel<number>("width", { required: true });
const emit = defineEmits<{ close: [] }>();
const actualWidth = computed(() => Math.min(width.value, props.maxWidth));
const interaction = shallowRef<{ x: number; width: number; pointerId: number; element: HTMLElement }>();
function setWidth(value: number) { width.value = Math.min(props.maxWidth, Math.max(Math.min(320, props.maxWidth), value)); }
function startResize(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  const element = event.currentTarget as HTMLElement;
  element.setPointerCapture(event.pointerId);
  interaction.value = { x: event.clientX, width: actualWidth.value, pointerId: event.pointerId, element };
}
function resize(event: PointerEvent) {
  if (interaction.value?.pointerId === event.pointerId) setWidth(interaction.value.width + interaction.value.x - event.clientX);
}
function stopResize() {
  const current = interaction.value;
  interaction.value = undefined;
  if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
}
function resizeWithKeyboard(event: KeyboardEvent) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  setWidth(actualWidth.value + (event.key === "ArrowLeft" ? 16 : -16));
}
watch(() => props.maxWidth, stopResize);
onBeforeUnmount(stopResize);
</script>

<style scoped lang="scss">
.nodeInspector {
  position: absolute;
  inset: 0 0 0 auto;
  z-index: 8;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  max-width: 100%;
  background: var(--el-bg-color-overlay);
  border-left: 1px solid var(--el-border-color-light);

  .resizeHandle {
    position: absolute;
    inset: 0 auto 0 -3px;
    width: 6px;
    z-index: 1;
    touch-action: none;
    cursor: ew-resize;
    &:hover, &:focus-visible { background: var(--el-color-primary-light-5); }
  }
  .inspectorHeader {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--el-border-color-lighter);
    .inspectorTitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; }
    .el-button { margin: 0; padding: 8px; }
  }
  .inspectorContent {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    padding: 12px;
    background: var(--el-fill-color-extra-light);

    .modelNotice { margin-bottom: 12px; }

    :deep(.nodeDock) { display: flex; flex-direction: column; gap: 12px; }
    :deep(.dockSlot:empty) { display: none; }
    :deep(.dockSlot) { min-width: 0; }
    :deep(.floatingSlot) { width: 100% !important; min-width: 0; }
    :deep(.floatingSlot > .el-card) { border: 1px solid var(--el-border-color-lighter); box-shadow: none; border-radius: 10px; }
  }
}
</style>
