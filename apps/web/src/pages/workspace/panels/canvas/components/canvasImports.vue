<template>
  <div class="canvasImports" :style="{ transform: `translate(${flow.viewport.value.x}px, ${flow.viewport.value.y}px) scale(${flow.viewport.value.zoom})` }">
    <article v-for="item in imports.values()" :key="item.id" class="importCard nodrag nopan" :class="{ failed: item.status === 'error' }"
      :style="{ transform: `translate(${item.position.x}px, ${item.position.y}px)` }" :aria-busy="item.status !== 'error'"
      @pointerdown.stop="startDrag($event, item)" @pointermove="moveCard($event, item)" @pointerup="drag = undefined" @pointercancel="drag = undefined" @mousedown.stop @dblclick.stop @contextmenu.stop.prevent>
      <div class="importHeader"><component :is="icons[item.kind]" :size="16" aria-hidden="true" /><span :title="item.name">{{ item.name }}</span></div>
      <div class="importPreview">
        <img v-if="item.previewUrl" :src="item.previewUrl" alt="" draggable="false" @error="item.previewUrl = ''" />
        <component v-else :is="icons[item.kind]" class="fileIcon" :size="42" stroke="1.25" aria-hidden="true" />
        <div class="importStatus" role="status">
          <icon-alert-circle v-if="item.status === 'error'" :size="18" aria-hidden="true" />
          <icon-loader2 v-else class="loadingIcon" :size="18" aria-hidden="true" />
          <span>{{ item.status === 'error' ? '导入失败' : item.status === 'queued' ? '等待上传' : item.status === 'reading' ? '正在读取素材…' : item.progress === 100 ? '正在保存…' : `上传中 ${item.progress}%` }}</span>
        </div>
      </div>
      <div v-if="item.status !== 'error'" class="importProgress" :class="{ indeterminate: item.status !== 'uploading' || item.progress === 100 }"
        role="progressbar" :aria-label="`${item.name}上传进度`" :aria-valuenow="item.status === 'uploading' ? item.progress : undefined" :aria-valuemin="0" :aria-valuemax="100">
        <div :style="{ width: `${item.progress}%` }" />
      </div>
      <div v-else class="importError">
        <p role="alert">{{ item.error }}</p>
        <div class="errorActions"><el-button size="small" type="primary" plain @click="item.retry()">重试</el-button><el-button size="small" text @click="item.remove()">移除</el-button></div>
      </div>
    </article>
  </div>
</template>

<script setup lang="ts">
import { useVueFlow } from "@vue-flow/core";
import { ElButton } from "element-plus";
import { IconAlertCircle, IconFileText, IconLoader2, IconMusic, IconPhoto, IconVideo } from "@tabler/icons-vue";
import type { CanvasFileImport } from "../canvasDrop";

defineProps<{ imports: Map<string, CanvasFileImport> }>();
const icons = { image: IconPhoto, video: IconVideo, audio: IconMusic, text: IconFileText };
const flow = useVueFlow();
let drag: { id: string; pointerId: number; x: number; y: number } | undefined;

function startDrag(event: PointerEvent, item: CanvasFileImport) {
  if (event.button !== 0 || (event.target as Element).closest("button")) return;
  const point = flow.screenToFlowCoordinate({ x: event.clientX, y: event.clientY });
  drag = { id: item.id, pointerId: event.pointerId, x: point.x - item.position.x, y: point.y - item.position.y };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}

function moveCard(event: PointerEvent, item: CanvasFileImport) {
  if (drag?.id !== item.id || drag.pointerId !== event.pointerId) return;
  const point = flow.screenToFlowCoordinate({ x: event.clientX, y: event.clientY });
  item.position = { x: point.x - drag.x, y: point.y - drag.y };
}
</script>

<style scoped lang="scss">
.canvasImports {
  position: absolute;
  inset: 0;
  pointer-events: none;
  transform-origin: 0 0;
  z-index: 5;

  .importCard {
    position: absolute;
    width: 280px;
    overflow: hidden;
    border: 1px solid var(--el-color-primary-light-5);
    border-radius: 12px;
    background: var(--el-bg-color);
    box-shadow: 0 8px 28px rgb(0 0 0 / 12%);
    color: var(--el-text-color-primary);
    pointer-events: auto;
    touch-action: none;
    cursor: grab;

    &:active { cursor: grabbing; }
    &.failed { border-color: var(--el-color-danger-light-5); }

    .importHeader {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 11px 14px;
      font-size: 12px;

      svg { flex-shrink: 0; color: var(--el-text-color-secondary); }
      span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    }

    .importPreview {
      position: relative;
      display: grid;
      place-items: center;
      height: 156px;
      background: var(--el-fill-color-light);

      img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; opacity: 0.7; }
      .fileIcon { color: var(--el-text-color-placeholder); margin-bottom: 18px; }
      .importStatus {
        position: absolute;
        bottom: 12px;
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 7px 11px;
        border-radius: 20px;
        background: var(--el-bg-color);
        box-shadow: 0 2px 10px rgb(0 0 0 / 8%);
        font-size: 12px;
        font-variant-numeric: tabular-nums;

        .loadingIcon { color: var(--el-color-primary); animation: importSpin 1s linear infinite; }
      }
    }

    .importProgress {
      height: 3px;
      overflow: hidden;
      background: var(--el-color-primary-light-9);

      > div { height: 100%; background: var(--el-color-primary); transition: width 160ms ease; }
      &.indeterminate > div { width: 35% !important; animation: importProgress 1.4s ease-in-out infinite; }
    }

    .importError {
      padding: 10px 14px 12px;
      cursor: default;

      p { margin: 0 0 10px; color: var(--el-color-danger); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
      .errorActions { display: flex; justify-content: flex-end; }
    }
    &.failed .importStatus { color: var(--el-color-danger); }
  }
}
@keyframes importSpin { to { transform: rotate(360deg); } }
@keyframes importProgress { from { transform: translateX(-100%); } to { transform: translateX(390%); } }
@media (prefers-reduced-motion: reduce) {
  .canvasImports .importCard {
    .importPreview .importStatus .loadingIcon { animation: none; }
    .importProgress > div { transition: none; }
    .importProgress.indeterminate > div { animation: none; }
  }
}
</style>
