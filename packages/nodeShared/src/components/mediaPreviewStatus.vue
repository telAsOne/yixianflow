<template>
  <div v-if="loading || error && preview.canRetry.value" class="mediaPreviewStatus nodrag nopan nowheel" :class="{ compact }" role="status" aria-live="polite" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop>
    <span v-if="!compact">{{ error || '正在读取媒体…' }}</span>
    <el-button v-if="error" :disabled="loading" :size="compact ? 'small' : 'default'" :title="error" aria-label="重试媒体预览" @click.stop="preview.retry()">{{ compact ? '重试' : '重试预览' }}</el-button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ElButton } from "element-plus";
import type { MediaPreview } from "../useMediaPreview";

const props = defineProps<{ preview: MediaPreview; compact?: boolean }>();
const loading = computed(() => props.preview.loading.value);
const error = computed(() => props.preview.error.value);
</script>

<style scoped lang="scss">
.mediaPreviewStatus {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 12px;
  border-radius: inherit;
  background: var(--el-bg-color-overlay);
  color: var(--el-text-color-secondary);
  text-align: center;
  font-size: 12px;
  overflow-wrap: anywhere;
  cursor: default;
  pointer-events: none;

  .el-button { pointer-events: auto; }

  &.compact { padding: 2px; gap: 0; background: transparent; }
}
</style>
