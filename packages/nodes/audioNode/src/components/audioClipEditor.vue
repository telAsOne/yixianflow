<template>
  <div class="audioClipEditor nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.capture="handleKeydown" @keydown.stop>
    <div class="editorHint"><span>拖动左右边界，选择需要的音频；点击波形定位。</span><span>原音频 {{ formatTime(duration) }}</span></div>
    <audioPlayer ref="player" :src="src" label="音频截取预览" playLabel="试听选中片段" :inert="disabled || !valid" @loadedmetadata="readDuration" @play="startPlayback" @error="emit('error', $event)" @retry="emit('retry')">
      <template #track="{ peaks }">
        <div class="timeline">
          <div class="timeRuler"><span v-for="tick in 6" :key="tick" :style="{ left: `${(tick - 1) * 20}%` }">{{ formatTime((tick - 1) * duration / 5) }}</span></div>
          <div ref="track" class="sourceTrack" @pointerdown="seekTrack">
            <svg v-if="peaks.length" class="waveform" viewBox="0 0 512 100" preserveAspectRatio="none" aria-hidden="true"><rect v-for="(peak, bar) in peaks" :key="bar" :x="bar * 4 + 1" :y="50 - Math.max(2, peak * 78) / 2" width="2" :height="Math.max(2, peak * 78)" rx="1" /></svg>
            <template v-if="activeSegment">
              <span class="discardedArea" :style="{ left: 0, width: `${startPercent}%` }" />
              <span class="discardedArea" :style="{ left: `${endPercent}%`, right: 0 }" />
              <span class="selectedArea" :style="{ left: `${startPercent}%`, width: `${endPercent - startPercent}%` }" />
              <button v-for="edge in boundaryNames" :key="edge" class="trimHandle" :class="{ startHandle: edge === 'start', endHandle: edge === 'end', dragging: dragging === edge }" :style="{ left: `${edge === 'start' ? startPercent : endPercent}%` }" type="button" role="slider" :disabled="disabled" :aria-label="edge === 'start' ? '截取起点' : '截取终点'" :aria-valuemin="edge === 'start' ? 0 : activeSegment.start + minimumLength" :aria-valuemax="edge === 'start' ? activeSegment.end - minimumLength : duration" :aria-valuenow="activeSegment[edge]" :aria-valuetext="formatTime(activeSegment[edge])" @pointerdown.stop.prevent="beginDrag($event, edge)" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="cancelDrag" @lostpointercapture="endDrag" @keydown="changeBoundary($event, edge)"><span /></button>
            </template>
            <span class="playhead" :style="{ left: `${duration ? currentTime / duration * 100 : 0}%` }" aria-hidden="true" />
            <input class="cursorInput" type="range" min="0" :max="duration || 1" step="0.01" :value="currentTime" :disabled="disabled || !valid" aria-label="原音频播放位置" :aria-valuetext="formatTime(currentTime)" @pointerdown.stop @input="seekAt(($event.target as HTMLInputElement).valueAsNumber)" />
          </div>
        </div>
      </template>
      <template #time><span>{{ formatTime(currentTime) }}</span><span>/</span><span>{{ formatTime(duration) }}</span></template>
    </audioPlayer>
    <div v-if="activeSegment" class="rangeControls">
      <label>开始（秒）<input v-model="boundaryInputs.start" class="timeInput" type="number" min="0" :max="activeSegment.end - minimumLength" step="0.01" :disabled="disabled" aria-label="截取开始时间（秒）" @focus="pause" @change="readBoundary($event, 'start')" /></label>
      <label>结束（秒）<input v-model="boundaryInputs.end" class="timeInput" type="number" :min="activeSegment.start + minimumLength" :max="duration" step="0.01" :disabled="disabled" aria-label="截取结束时间（秒）" @focus="pause" @change="readBoundary($event, 'end')" /></label>
      <span class="selectionDuration" role="status">选中 {{ selectedDuration.toFixed(2) }} 秒</span>
      <div class="boundaryActions">
        <el-button size="small" :disabled="disabled || currentTime >= activeSegment.end" @click="setBoundary('start', currentTime)">当前位置设为起点</el-button>
        <el-button size="small" :disabled="disabled || currentTime <= activeSegment.start" @click="setBoundary('end', currentTime)">当前位置设为终点</el-button>
        <el-button size="small" :disabled="disabled" @click="resetRange">恢复整段</el-button>
      </div>
    </div>
    <div class="segmentHeader"><span>片段列表 · 点击选择要试听和导出的片段</span><span>{{ segments.length }} 段 · 共 {{ totalDuration.toFixed(2) }} 秒</span></div>
    <div class="segmentList" role="group" aria-label="音频片段列表">
      <button v-for="(segment, index) in segments" :key="index" class="segmentItem" :class="{ selected: selectedIndex === index }" type="button" :disabled="disabled" :aria-pressed="selectedIndex === index" :aria-label="`片段 ${index + 1}，${formatTime(segment.start)} 至 ${formatTime(segment.end)}`" @click="selectSegment(index)" @keydown.delete.prevent="removeSegment(index)">
        <span class="segmentName">片段 {{ index + 1 }}</span><span>{{ formatTime(segment.start) }} — {{ formatTime(segment.end) }}</span><span>{{ (segment.end - segment.start).toFixed(2) }} 秒</span>
      </button>
    </div>
    <div class="editActions">
      <el-button :icon="IconArrowBackUp" :disabled="disabled || !undoStack.length" title="撤销（Ctrl+Z）" @click="undo">撤销</el-button>
      <el-button :icon="IconArrowForwardUp" :disabled="disabled || !redoStack.length" title="恢复（Ctrl+Y）" @click="redo">恢复</el-button>
      <el-button :icon="IconScissors" :disabled="disabled || !canSplit" @click="splitSegment">在当前位置分割</el-button>
      <el-button :icon="IconTrash" :disabled="disabled || !activeSegment" @click="removeSegment(selectedIndex)">删除选中片段</el-button>
      <el-button v-if="!segments.length" :disabled="disabled || !duration" @click="resetRange">恢复整段</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ElButton } from "element-plus";
import { IconArrowBackUp, IconArrowForwardUp, IconScissors, IconTrash } from "@tabler/icons-vue";
import type { AudioSegment } from "../audioProcessing";
import audioPlayer from "./audioPlayer.vue";

type EditState = { segments: AudioSegment[]; selectedIndex: number; time: number };
const props = defineProps<{ src: string; sourceKey?: string; disabled?: boolean }>();
const emit = defineEmits<{ error: [event: Event]; retry: [] }>();
const segments = defineModel<AudioSegment[]>({ required: true });
const player = ref<InstanceType<typeof audioPlayer>>();
const track = ref<HTMLElement>();
const duration = ref(0);
const selectedIndex = ref(0);
const undoStack = ref<EditState[]>([]);
const redoStack = ref<EditState[]>([]);
const boundaryNames = ["start", "end"] as const;
const dragging = ref<"start" | "end">();
const activeSegment = computed(() => segments.value[selectedIndex.value]);
const boundaryInputs = ref<{ start: string | number; end: string | number }>({ start: 0, end: 0 });
const selectedSegments = computed(() => activeSegment.value ? [{ ...activeSegment.value }] : []);
const selectedDuration = computed(() => activeSegment.value ? activeSegment.value.end - activeSegment.value.start : 0);
const totalDuration = computed(() => segments.value.reduce((total, segment) => total + segment.end - segment.start, 0));
const currentTime = computed(() => player.value?.currentTime ?? 0);
const minimumLength = computed(() => Math.min(0.01, duration.value));
const startPercent = computed(() => duration.value && activeSegment.value ? activeSegment.value.start / duration.value * 100 : 0);
const endPercent = computed(() => duration.value && activeSegment.value ? activeSegment.value.end / duration.value * 100 : 100);
const valid = computed(() => duration.value > 0 && !!activeSegment.value && segments.value.every(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start >= 0 && segment.end > segment.start && segment.end <= duration.value));
const canSplit = computed(() => activeSegment.value && currentTime.value - activeSegment.value.start >= minimumLength.value && activeSegment.value.end - currentTime.value >= minimumLength.value);
let initialized = false;
let drag: { pointerId: number; target: HTMLElement; x: number; time: number; width: number; state: EditState } | undefined;

for (const edge of boundaryNames) watch(() => activeSegment.value?.[edge], value => {
  if (value !== undefined) boundaryInputs.value[edge] = Number(value.toFixed(2));
}, { immediate: true, flush: "sync" });
watch(() => props.sourceKey ?? props.src, () => {
  endDrag();
  initialized = false;
  duration.value = 0;
  undoStack.value = redoStack.value = [];
  segments.value = [];
  selectedIndex.value = 0;
});
watch(() => props.disabled, value => { if (value) { endDrag(); pause(); } });
watch(currentTime, time => {
  if (player.value?.playing && activeSegment.value && time >= activeSegment.value.end) {
    pause();
    player.value.seekTo(activeSegment.value.end);
  }
});
onBeforeUnmount(() => { endDrag(); pause(); });
defineExpose({ valid, pause, selectedSegments, selectedDuration, totalDuration });

function formatTime(value: number) {
  const safe = Math.round(Math.max(0, Number.isFinite(value) ? value : 0) * 100);
  return `${Math.floor(safe / 6000)}:${(safe % 6000 / 100).toFixed(2).padStart(5, "0")}`;
}

function pause() { player.value?.pause(); }

function readDuration(event: Event) {
  const value = (event.currentTarget as HTMLAudioElement).duration;
  duration.value = Number.isFinite(value) && value > 0 ? value : 0;
  if (duration.value && !initialized) {
    initialized = true;
    if (!segments.value.length) segments.value = [{ start: 0, end: duration.value }];
    selectSegment(0);
  }
}

function snapshot(): EditState {
  return { segments: segments.value.map(segment => ({ ...segment })), selectedIndex: selectedIndex.value, time: currentTime.value };
}

function applyState(state: EditState) {
  pause();
  segments.value = state.segments;
  selectedIndex.value = state.selectedIndex;
  player.value?.seekTo(state.time);
}

function remember(state = snapshot()) {
  undoStack.value.push(state);
  redoStack.value = [];
}

function undo() {
  if (props.disabled || !undoStack.value.length) return;
  redoStack.value.push(snapshot());
  applyState(undoStack.value.pop()!);
}

function redo() {
  if (props.disabled || !redoStack.value.length) return;
  undoStack.value.push(snapshot());
  applyState(redoStack.value.pop()!);
}

function handleKeydown(event: KeyboardEvent) {
  if ((event.target as HTMLElement).closest("input, textarea, [contenteditable='true']")) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === "z" || key === "y")) {
    event.preventDefault();
    if (key === "y" || event.shiftKey) redo();
    else undo();
  } else if (event.code === "Space" && !(event.target as HTMLElement).closest("button") && !event.repeat && !props.disabled && valid.value) {
    event.preventDefault();
    player.value?.togglePlayback();
  }
}

function selectSegment(index: number) {
  if (props.disabled || !segments.value[index]) return;
  selectedIndex.value = index;
  seekAt(segments.value[index]!.start);
}

function seekAt(time: number) {
  if (props.disabled || !Number.isFinite(time)) return;
  pause();
  player.value?.seekTo(time);
}

function seekTrack(event: PointerEvent) {
  if (event.button !== 0 || !track.value || !valid.value) return;
  const rect = track.value.getBoundingClientRect();
  if (rect.width) seekAt((event.clientX - rect.left) / rect.width * duration.value);
}

function startPlayback() {
  if (props.disabled || !valid.value) return pause();
  const segment = activeSegment.value!;
  if (currentTime.value < segment.start || currentTime.value >= segment.end) player.value?.seekTo(segment.start);
}

function setBoundary(edge: "start" | "end", value: number, record = true) {
  const segment = activeSegment.value;
  if (props.disabled || !segment || !Number.isFinite(value)) return;
  const rounded = Math.round(value * 100) / 100;
  const time = edge === "start" ? Math.max(0, Math.min(segment.end - minimumLength.value, rounded)) : Math.min(duration.value, Math.max(segment.start + minimumLength.value, rounded));
  if (time === segment[edge]) return time;
  if (record) remember();
  segments.value = segments.value.map((item, index) => index === selectedIndex.value ? { ...item, [edge]: time } : item);
  seekAt(time);
  return time;
}

function readBoundary(event: Event, edge: "start" | "end") {
  const input = event.target as HTMLInputElement;
  const time = setBoundary(edge, input.valueAsNumber) ?? activeSegment.value![edge];
  boundaryInputs.value[edge] = Number(time.toFixed(2));
}

function beginDrag(event: PointerEvent, edge: "start" | "end") {
  const width = track.value?.getBoundingClientRect().width;
  if (event.button !== 0 || drag || !width || props.disabled || !activeSegment.value) return;
  const target = event.currentTarget as HTMLElement;
  target.focus({ preventScroll: true });
  drag = { pointerId: event.pointerId, target, x: event.clientX, time: activeSegment.value[edge], width, state: snapshot() };
  dragging.value = edge;
  target.setPointerCapture(event.pointerId);
  seekAt(drag.time);
}

function moveDrag(event: PointerEvent) {
  if (!drag || !dragging.value || event.pointerId !== drag.pointerId) return;
  setBoundary(dragging.value, drag.time + (event.clientX - drag.x) / drag.width * duration.value, false);
}

function endDrag(event?: PointerEvent) {
  if (!drag || event && event.pointerId !== drag.pointerId) return;
  const previous = drag;
  drag = undefined;
  dragging.value = undefined;
  const before = previous.state.segments[previous.state.selectedIndex]!;
  if (activeSegment.value && (before.start !== activeSegment.value.start || before.end !== activeSegment.value.end)) remember(previous.state);
  if (previous.target.hasPointerCapture(previous.pointerId)) previous.target.releasePointerCapture(previous.pointerId);
}

function cancelDrag(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  applyState(drag.state);
  endDrag(event);
}

function changeBoundary(event: KeyboardEvent, edge: "start" | "end") {
  if (!activeSegment.value) return;
  const step = event.shiftKey ? 1 : 0.01;
  const time = activeSegment.value[edge];
  const values: Record<string, number> = { ArrowLeft: time - step, ArrowDown: time - step, ArrowRight: time + step, ArrowUp: time + step, Home: 0, End: duration.value };
  if (!(event.key in values)) return;
  event.preventDefault();
  setBoundary(edge, values[event.key]!);
}

function splitSegment() {
  if (props.disabled || !canSplit.value) return;
  remember();
  const segment = activeSegment.value!;
  const next = [...segments.value];
  next.splice(selectedIndex.value, 1, { start: segment.start, end: currentTime.value }, { start: currentTime.value, end: segment.end });
  applyState({ segments: next, selectedIndex: selectedIndex.value + 1, time: currentTime.value });
}

function removeSegment(index: number) {
  if (props.disabled || !segments.value[index]) return;
  remember();
  const next = segments.value.filter((_, current) => current !== index);
  const selected = Math.max(0, Math.min(index, next.length - 1));
  applyState({ segments: next, selectedIndex: selected, time: next[selected]?.start ?? 0 });
}

function resetRange() {
  if (props.disabled || !duration.value) return;
  remember();
  const next = segments.value.length ? segments.value.map((segment, index) => index === selectedIndex.value ? { start: 0, end: duration.value } : segment)
    : [{ start: 0, end: duration.value }];
  applyState({ segments: next, selectedIndex: selectedIndex.value, time: 0 });
}
</script>

<style scoped lang="scss">
.audioClipEditor {
  min-width: 0;
  .editorHint, .segmentHeader { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; font-size: 12px; color: var(--el-text-color-secondary); }
  .editorHint { margin-bottom: 14px; }
  :deep(.audioPlayer .waveformPanel) { padding-inline: 28px; }
  :deep(.audioPlayer .waveformPanel .waveformTrack) { height: 156px; }
  .timeline {
    position: absolute; inset: 0;
    .timeRuler { position: relative; height: 28px; span { position: absolute; top: 2px; transform: translateX(-50%); color: var(--el-text-color-secondary); font-size: 10px; font-variant-numeric: tabular-nums; &:first-child { transform: none; } &:last-child { transform: translateX(-100%); } } }
    .sourceTrack {
      position: relative; height: 128px; background: var(--el-color-primary-light-9); border-radius: 4px; cursor: crosshair; touch-action: none;
      .waveform { position: absolute; inset: 0; width: 100%; height: 100%; fill: var(--el-color-primary); opacity: 0.7; pointer-events: none; }
      .discardedArea { position: absolute; top: 0; bottom: 0; background: var(--el-fill-color-darker); opacity: 0.8; pointer-events: none; }
      .selectedArea { position: absolute; top: 0; bottom: 0; border-block: 2px solid var(--el-color-primary); box-sizing: border-box; pointer-events: none; }
      .trimHandle {
        position: absolute; z-index: 3; top: 0; display: grid; place-items: center; width: 16px; height: 100%; padding: 0; border: 0; color: #fff; background: var(--el-color-primary); cursor: ew-resize; touch-action: none;
        &.startHandle { transform: translateX(-100%); border-radius: 5px 0 0 5px; } &.endHandle { border-radius: 0 5px 5px 0; }
        &:hover, &.dragging { filter: brightness(1.15); } &:focus-visible { outline: 2px solid var(--el-text-color-primary); outline-offset: 3px; }
        &:disabled { cursor: default; } span { width: 3px; height: 24px; border-radius: 2px; background: currentColor; }
      }
      .playhead { position: absolute; z-index: 2; top: -4px; bottom: -4px; width: 2px; background: var(--el-color-danger); pointer-events: none; &::before { content: ""; position: absolute; left: -3px; width: 8px; height: 8px; background: inherit; clip-path: polygon(0 0, 100% 0, 50% 100%); } }
      .cursorInput { position: absolute; z-index: 2; inset: 0 -6px; width: calc(100% + 12px); height: 100%; margin: 0; opacity: 0; appearance: none; pointer-events: none; touch-action: none; &::-webkit-slider-thumb { appearance: none; width: 12px; height: 128px; pointer-events: auto; cursor: ew-resize; } &::-moz-range-thumb { width: 12px; height: 128px; border: 0; pointer-events: auto; cursor: ew-resize; } }
      &:has(.cursorInput:focus-visible) { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
    }
  }
  .rangeControls {
    display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; margin-top: 18px;
    label { display: flex; align-items: center; gap: 8px; color: var(--el-text-color-secondary); font-size: 12px; .timeInput { box-sizing: border-box; width: 110px; height: 34px; padding: 0 8px; border: 1px solid var(--el-border-color); border-radius: var(--el-border-radius-base); color: var(--el-text-color-primary); background: var(--el-bg-color); font: inherit; font-variant-numeric: tabular-nums; &:focus { outline: 1px solid var(--el-color-primary); } } }
    .selectionDuration { margin-left: auto; color: var(--el-color-primary); font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .boundaryActions { display: flex; flex-wrap: wrap; gap: 8px; width: 100%; .el-button { margin: 0; } }
  }
  .segmentHeader { margin: 24px 0 10px; }
  .segmentList { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 6px; .segmentItem { display: grid; flex-shrink: 0; gap: 6px; padding: 10px 14px; border: 1px solid var(--el-border-color); border-radius: 8px; text-align: left; background: var(--el-fill-color-light); color: var(--el-text-color-secondary); font-size: 12px; font-variant-numeric: tabular-nums; cursor: pointer; .segmentName { color: var(--el-text-color-primary); font-weight: 600; } &.selected { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); color: var(--el-color-primary); } &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -3px; } } }
  .editActions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; .el-button { margin: 0; } }
}
</style>
