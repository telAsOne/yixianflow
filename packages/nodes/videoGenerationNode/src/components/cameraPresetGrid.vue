<template>
  <div class="cameraPresetGrid" :class="{ compact }">
    <div class="cameraPresetPicker" @keydown.stop="handleKey">
      <div v-if="!compact" class="pickerToolbar"><span>悬停预览，双击添加</span><el-input v-model="query" clearable placeholder="搜索运镜" aria-label="搜索运镜" :prefixIcon="IconSearch" /></div>
      <el-alert v-if="error" :title="error" type="error" :closable="false" showIcon><template #default><el-button size="small" @click="emit('retry')">重新加载</el-button></template></el-alert>
      <div v-if="loading" class="cameraGrid" aria-label="正在加载运镜"><div v-for="index in 10" :key="index" class="cardSkeleton" /></div>
      <div v-else-if="filtered.length" class="cameraGrid" role="listbox" aria-label="选择运镜">
        <button v-for="preset in filtered" :key="preset.id" type="button" class="cameraCard" :class="{ selected: selectedId === preset.id }" role="option" :aria-selected="selectedId === preset.id" :aria-label="preset.name" :disabled="disabled" @pointerenter="hover(preset, $event)" @pointerleave="hoveredId = ''" @focus="hoveredId = preset.id" @blur="hoveredId = ''" @click="select(preset)" @dblclick="confirm(preset)">
          <span class="cameraFrame">
            <img v-if="preset.preview?.cover && !failedCovers.has(preset.id)" class="cover" :src="preset.preview.cover" :alt="preset.name" loading="lazy" @error="failedCovers.add(preset.id)" />
            <span v-else class="cameraFallback"><icon-video :size="30" stroke="1.4" /><span>{{ preset.name }}</span></span>
            <video v-if="activeId === preset.id && preset.preview?.video && !failedVideos.has(preset.id)" :key="preset.preview.video" class="motion" :class="{ ready: readyVideos.has(preset.id) }" :src="preset.preview.video" muted loop playsinline autoplay preload="none" @loadeddata="play($event)" @playing="readyVideos.add(preset.id)" @error="failedVideos.add(preset.id)" />
            <img v-else-if="activeId === preset.id && preset.preview?.motion" class="motion" :src="preset.preview.motion" alt="" />
            <span v-if="selectedId === preset.id" class="selectionMark"><icon-check :size="14" /></span>
            <span v-else-if="preset.preview?.video || preset.preview?.motion" class="playMark"><icon-player-play-filled :size="14" /></span>
          </span>
          <span class="cameraName">{{ preset.name }}</span>
        </button>
      </div>
      <el-empty v-else-if="!error" :description="query ? '没有找到这个运镜' : '暂无可用运镜'" :imageSize="64" />
    </div>
    <div class="pickerFooter"><span>{{ selected?.name || '悬停或点击预览，双击直接添加' }}</span><div><el-button @click="emit('cancel')">取消</el-button><el-button type="primary" :disabled="disabled || !selected" @click="selected && confirm(selected)">确定</el-button></div></div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { ElAlert, ElButton, ElEmpty, ElInput } from "element-plus";
import { IconCheck, IconPlayerPlayFilled, IconSearch, IconVideo } from "@tabler/icons-vue";
import type { CameraPreset } from "../cameraPresets";

const props = defineProps<{ presets?: CameraPreset[]; loading: boolean; error?: string; disabled?: boolean; compact?: boolean }>();
const emit = defineEmits<{ confirm: [preset: CameraPreset]; retry: []; cancel: [] }>();
const query = ref("");
const selectedId = ref("");
const hoveredId = ref("");
const failedCovers = reactive(new Set<string>());
const failedVideos = reactive(new Set<string>());
const readyVideos = reactive(new Set<string>());
const filtered = computed(() => (props.presets ?? []).filter(item => `${item.name} ${item.id}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
const selected = computed(() => props.presets?.find(item => item.id === selectedId.value));
const activeId = computed(() => hoveredId.value || selectedId.value);
watch(() => props.presets, presets => { if (!presets?.some(item => item.id === selectedId.value)) selectedId.value = ""; });
function hover(preset: CameraPreset, event: PointerEvent) { if (event.pointerType !== "touch") hoveredId.value = preset.id; }
function select(preset: CameraPreset) { if (!props.disabled) selectedId.value = preset.id; }
function confirm(preset: CameraPreset) { if (!props.disabled && props.presets?.some(item => item.id === preset.id)) emit("confirm", preset); }
function play(event: Event) { const video = event.target as HTMLVideoElement; video.muted = true; void video.play().catch(() => failedVideos.add(activeId.value)); }
function handleKey(event: KeyboardEvent) {
  if (event.target instanceof HTMLInputElement) return;
  if (event.key === "Enter" && selected.value) { event.preventDefault(); confirm(selected.value); }
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) || !filtered.value.length) return;
  event.preventDefault();
  const grid = event.currentTarget instanceof HTMLElement ? event.currentTarget.querySelector(".cameraGrid") : null;
  const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 5;
  const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key] ?? 1;
  const index = filtered.value.findIndex(item => item.id === selectedId.value);
  const next = filtered.value[Math.max(0, Math.min(filtered.value.length - 1, index + offset))];
  selectedId.value = next.id;
  if (event.currentTarget instanceof HTMLElement) (event.currentTarget.querySelectorAll<HTMLButtonElement>(".cameraCard")[filtered.value.indexOf(next)])?.focus();
}
</script>

<style scoped lang="scss">
.cameraPresetPicker {
  .pickerToolbar { display: flex; justify-content: space-between; align-items: center; gap: 20px; margin-bottom: 20px; color: var(--el-text-color-secondary); font-size: 13px; .el-input { max-width: 220px; } }
  .cameraGrid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 20px 16px; max-height: min(60vh, 570px); overflow-y: auto; padding: 3px 5px 12px 3px; }
  .cameraCard { border: 0; padding: 0; background: transparent; color: var(--el-text-color-regular); cursor: pointer; min-width: 0; text-align: center; border-radius: 12px; &:disabled { opacity: .5; cursor: default; } &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; } .cameraFrame { display: block; position: relative; aspect-ratio: 16 / 10; border-radius: 12px; overflow: hidden; background: var(--el-fill-color-light); outline: 2px solid transparent; outline-offset: 2px; transition: outline-color .16s, box-shadow .16s; } &:hover .cameraFrame { outline-color: var(--el-border-color-darker); box-shadow: 0 6px 20px #00000012; } &.selected .cameraFrame { outline-color: var(--el-color-primary); box-shadow: 0 0 0 4px var(--el-color-primary-light-9); } .cover, .motion { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; } .motion { z-index: 1; } video.motion { opacity: 0; &.ready { opacity: 1; } } .cameraFallback { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--el-text-color-secondary); background: linear-gradient(145deg, var(--el-fill-color-light), var(--el-fill-color)); font-size: 11px; } .selectionMark, .playMark { position: absolute; z-index: 2; right: 8px; bottom: 8px; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; color: white; background: #17211d88; backdrop-filter: blur(6px); } .selectionMark { background: var(--el-color-primary); } .cameraName { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 10px 2px 0; font-size: 12px; } &.selected .cameraName { color: var(--el-color-primary); font-weight: 600; } }
  .cardSkeleton { aspect-ratio: 1; border-radius: 12px; background: linear-gradient(100deg, var(--el-fill-color) 30%, var(--el-fill-color-light) 50%, var(--el-fill-color) 70%); background-size: 220% 100%; animation: cameraLoading 1.4s infinite; }
}
.pickerFooter { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding-top: 14px; border-top: 1px solid var(--el-border-color-lighter); > span { color: var(--el-text-color-secondary); font-size: 12px; text-align: left; } > div { display: flex; gap: 8px; .el-button + .el-button { margin-left: 0; } } }
 .compact { width: 350px; .cameraPresetPicker { .pickerToolbar { margin-bottom: 12px; > span { display: none; } .el-input { max-width: none; } } .cameraGrid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px 10px; max-height: 340px; } .cameraCard .cameraName { font-size: 11px; padding-top: 7px; } } .pickerFooter { padding-top: 10px; > span { max-width: 45%; font-size: 11px; } } }
@keyframes cameraLoading { to { background-position: -220% 0; } }
@media (max-width: 760px) { .cameraPresetPicker { .cameraGrid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px 12px; } .pickerToolbar { align-items: flex-start; flex-direction: column; gap: 12px; .el-input { max-width: none; } } } }
@media (max-width: 480px) { .cameraPresetPicker .cameraGrid { grid-template-columns: repeat(3, minmax(0, 1fr)); } .pickerFooter > span { max-width: 48%; font-size: 11px; } }
@media (prefers-reduced-motion: reduce) { .cameraPresetPicker .cardSkeleton { animation: none; } }
</style>
