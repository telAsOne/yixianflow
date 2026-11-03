<template>
  <div v-if="previewing" class="videoPlaceholder" :style="{ height: `${previewHeight}px` }" />
  <teleport :to="previewTarget ?? 'body'" :disabled="!previewing || !previewTarget">
  <div ref="playerElement" class="videoPlayer" :class="{ previewing }" @fullscreenchange="readFullscreen">
    <div v-if="previewing" class="previewHeader" @pointerdown.stop @mousedown.stop @click.stop @dblclick.stop>
      <el-button text :icon="IconArrowLeft" @click="closePreview">返回画布</el-button>
      <span class="previewTitle" :title="node.data.label || label">{{ node.data.label || label }}</span>
      <el-button text :icon="fullscreen ? IconMinimize : IconMaximize" :aria-label="fullscreen ? '退出全屏' : '进入全屏'" @click="toggleFullscreen">{{ fullscreen ? '退出全屏' : '全屏' }}</el-button>
      <el-button text :icon="IconX" aria-label="关闭视频预览" @click="closePreview">关闭预览</el-button>
    </div>
    <video
      ref="video"
      class="videoPreview"
      :class="{ nodrag: previewing }"
      :src="playbackSrc"
      :poster="cachedPoster || poster"
      :controls="previewing"
      controlsList="nofullscreen"
      playsinline
      :preload="metadata?.duration && metadata.width && metadata.height ? 'none' : 'metadata'"
      draggable="false"
      :aria-label="label"
      @click="playFromSurface"
      @loadedmetadata="readMetadata"
      @loadeddata="readPreview"
      @timeupdate="currentTime = video?.currentTime ?? 0"
      @play="playing = true; ended = false"
      @pause="playing = false"
      @ended="playing = false; ended = true"
      @volumechange="readVolume"
      @error="mediaError" />
    <div v-if="previewing && (ended || failed)" class="playbackEnded">
      <el-button type="primary" :icon="IconPlayerPlay" :loading="reloading" @click="failed ? togglePlayback() : replay()">{{ failed ? '重试播放' : '重新播放' }}</el-button>
      <el-button @click="closePreview">返回画布</el-button>
    </div>
    <div v-show="!previewing" class="playerControls nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop>
      <el-button class="playerButton playButton" text circle :icon="playing ? IconPlayerPause : IconPlayerPlay" :loading="reloading" :disabled="!playbackSrc || reloading" :aria-label="failed ? '重试播放视频' : playing ? '暂停视频' : '播放视频'" :title="failed ? '重试播放' : playing ? '暂停' : '播放'" @click="togglePlayback" />
      <span class="currentTime">{{ formatTime(currentTime) }}</span>
      <el-slider class="progressSlider" :modelValue="currentTime" :min="0" :max="duration || 1" :step="0.01" :disabled="!ready || !duration" :formatTooltip="formatTime" aria-label="视频播放进度" @input="seek" />
      <span class="durationLabel"><span class="timeSeparator">/</span>{{ formatTime(duration) }}</span>
      <div class="volumeControl">
        <el-popover trigger="hover" placement="top" :width="40" :popperStyle="{ minWidth: '40px', padding: '8px 0', borderRadius: 'var(--el-border-radius-base)' }" :showArrow="false" :showAfter="80" :hideAfter="150" :disabled="!ready">
          <template #reference>
            <el-button class="playerButton volumeButton" text circle :icon="muted || !volume ? IconVolumeOff : IconVolume" :disabled="!ready" :aria-pressed="muted || !volume" :aria-label="muted || !volume ? '取消静音' : '静音视频'" title="音量 · 点击切换静音" @click="toggleMute" />
          </template>
          <div class="volumePanel nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop>
            <span class="volumeValue">{{ muted ? 0 : volume }}%</span>
            <el-slider class="volumeSlider" :modelValue="muted ? 0 : volume" vertical height="60px" :min="0" :max="100" :showTooltip="false" aria-label="视频音量" @input="setVolume" />
          </div>
        </el-popover>
      </div>
      <el-dropdown class="captureMenu" trigger="click" placement="top-end" :disabled="!ready || capturing" @visibleChange="captureMenuVisible = $event" @command="captureFrame">
        <el-button class="playerButton" text circle :icon="IconPhotoScan" :loading="capturing" :disabled="!ready || capturing" :aria-expanded="captureMenuVisible" aria-label="截取视频帧" title="截取视频帧" />
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="current" :icon="IconPhotoScan">截取当前帧</el-dropdown-item>
            <el-dropdown-item command="first" :icon="IconPlayerSkipBack">截取首帧</el-dropdown-item>
            <el-dropdown-item command="last" :icon="IconPlayerSkipForward">截取尾帧</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </div>
  </teleport>
  <el-dialog v-model="previewing" class="videoPreviewDialog" width="min(1440px, calc(100vw - 48px))" top="24px" appendToBody :showClose="false" :closeOnClickModal="false" :closeOnPressEscape="false" :style="{ padding: '0', background: 'var(--el-bg-color-overlay)' }" aria-label="视频预览" @closed="restoreFocus">
    <div ref="previewTarget" class="previewTarget" />
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch, type Ref, type ShallowRef } from "vue";
import { useNode, useVueFlow } from "@vue-flow/core";
import { ElButton, ElDialog, ElDropdown, ElDropdownMenu, ElDropdownItem, ElMessage, ElPopover, ElSlider } from "element-plus";
import { IconPlayerPlay, IconPlayerPause, IconVolume, IconVolumeOff, IconPhotoScan, IconPlayerSkipBack, IconPlayerSkipForward, IconArrowLeft, IconX, IconMinimize, IconMaximize } from "@tabler/icons-vue";
import { useNodeFiles, type NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import type { NodeDocumentContext } from "@toonflow/nodes-scaffold/nodeDocument";

const { src, file, previewSrc, metadata, label = "节点视频" } = defineProps<{ src: string; file?: NodeMediaValue; previewSrc?: string; metadata?: { width?: number; height?: number; duration?: number }; label?: string }>();
const emit = defineEmits<{ loadedmetadata: [event: Event] }>();
const video = ref<HTMLVideoElement>();
const fullscreen = ref(false);
const previewing = ref(false);
const ended = ref(false);
const playerElement = ref<HTMLElement>();
const previewTarget = ref<HTMLElement>();
const previewHeight = ref(144);
const closeMediaPreview = inject<ShallowRef<(() => Promise<void>) | undefined> | undefined>("closeMediaPreview", undefined);
let previousFocus: HTMLElement | undefined;
let fullscreenExitTime = -Infinity;
const ready = ref(false);
const playbackSrc = ref(src);
const failed = ref(false);
const reloading = ref(false);
let sourceRevision = 0;
let refreshedMedia: { release(): void } | undefined;
let pendingReload: Promise<void> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let automaticallyRetried = false;
let resumeTime = 0;
const poster = ref("");
const cachedPoster = ref("");
watch(() => previewSrc, (value, _previous, onCleanup) => {
  cachedPoster.value = "";
  if (!value) return;
  const image = new Image();
  image.onload = () => { cachedPoster.value = value; };
  image.src = value;
  onCleanup(() => { image.onload = null; image.src = ""; });
}, { immediate: true });
const playing = ref(false);
const muted = ref(false);
const volume = ref(100);
let lastVolume = 100;
const currentTime = ref(0);
const duration = ref(0);
const capturing = ref(false);
const captureMenuVisible = ref(false);
const { node } = useNode();
const { addNodes, findNode, getNodes, nodeTypes } = useVueFlow();
const files = useNodeFiles();
const getCanvas = inject<(() => { id: string } | undefined) | undefined>("canvas", undefined);
const canvasActive = inject<Readonly<Ref<boolean>> | undefined>("canvasActive", undefined);
const documentContext = inject<NodeDocumentContext | undefined>("nodeDocument", undefined);
let captureController: AbortController | undefined;

watch(() => getCanvas?.()?.id, () => captureController?.abort(), { flush: "sync" });
watch(() => src, () => {
  captureController?.abort();
  sourceRevision++;
  clearTimeout(retryTimer);
  refreshedMedia?.release();
  refreshedMedia = undefined;
  pendingReload = undefined;
  playbackSrc.value = src;
  failed.value = false;
  reloading.value = false;
  automaticallyRetried = false;
  resumeTime = 0;
  ready.value = false;
  poster.value = "";
  playing.value = false;
  currentTime.value = 0;
  duration.value = 0;
  ended.value = false;
}, { flush: "sync" });
watch([() => src, () => metadata], () => {
  if (metadata?.duration && metadata.width && metadata.height) { ready.value = true; duration.value = metadata.duration; }
}, { immediate: true });
onBeforeUnmount(() => {
  captureController?.abort();
  sourceRevision++;
  clearTimeout(retryTimer);
  refreshedMedia?.release();
  video.value?.pause();
  video.value?.removeAttribute("src");
  video.value?.load();
  if (closeMediaPreview?.value === closePreview) closeMediaPreview.value = undefined;
});
watch(() => canvasActive?.value !== false || documentContext?.targets.has(node.id), visible => {
  const element = video.value;
  if (!visible && previewing.value) void closePreview();
  if (!visible && element && document.pictureInPictureElement !== element) element.pause();
}, { flush: "post" });
watch(video, (element, _previous, onCleanup) => {
  if (!element || typeof IntersectionObserver === "undefined") return;
  const observer = new IntersectionObserver(entries => {
    const entry = entries.at(-1);
    if (!entry || entry.isIntersecting || previewing.value || document.pictureInPictureElement === element) return;
    // ACT: 离屏仅暂停，保留进度和节点状态；全屏及画中画继续播放。
    element.pause();
  });
  observer.observe(element);
  onCleanup(() => observer.disconnect());
}, { flush: "post" });

async function enterFullscreen() {
  if (!video.value) return;
  if (closeMediaPreview?.value && closeMediaPreview.value !== closePreview) await closeMediaPreview.value();
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  previewHeight.value = playerElement.value?.offsetHeight ?? 144;
  previewing.value = true;
  await nextTick();
}

async function toggleFullscreen() {
  try {
    if (fullscreen.value) await document.exitFullscreen();
    else await playerElement.value?.requestFullscreen();
  } catch {
    ElMessage.error("无法切换视频全屏");
  }
}

function readFullscreen() {
  const active = document.fullscreenElement === playerElement.value;
  if (fullscreen.value && !active) fullscreenExitTime = performance.now();
  fullscreen.value = active;
}

async function closePreview() {
  if (document.fullscreenElement === playerElement.value) {
    try { await document.exitFullscreen(); }
    catch { ElMessage.error("无法退出全屏，请先按 Esc 再关闭预览"); return; }
  }
  video.value?.pause();
  previewing.value = false;
}

function restoreFocus() { if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); }

async function replay() {
  if (!video.value) return;
  video.value.currentTime = 0;
  await togglePlayback();
}

watch(previewing, (visible, _previous, onCleanup) => {
  if (!visible) {
    video.value?.pause();
    if (closeMediaPreview?.value === closePreview) closeMediaPreview.value = undefined;
    return;
  }
  if (closeMediaPreview) closeMediaPreview.value = closePreview;
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing || fullscreen.value || performance.now() - fullscreenExitTime < 250) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void closePreview();
  };
  window.addEventListener("keydown", escape, true);
  onCleanup(() => window.removeEventListener("keydown", escape, true));
}, { flush: "sync" });

defineExpose({ enterFullscreen, ready, capturing, captureFrame, playing, fullscreen: computed(() => previewing.value || fullscreen.value) });

function formatTime(value: number) {
  const seconds = Math.floor(Number.isFinite(value) ? Math.max(0, value) : 0);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function readMetadata(event: Event) {
  const source = event.currentTarget as HTMLVideoElement;
  if (source.currentSrc !== playbackSrc.value) return;
  ready.value = true;
  const value = source.duration;
  duration.value = Number.isFinite(value) ? value : 0;
  if (resumeTime && duration.value) source.currentTime = Math.min(resumeTime, Math.max(0, duration.value - 0.001));
  resumeTime = 0;
  emit("loadedmetadata", event);
}

function readPreview(event: Event) {
  const source = event.currentTarget as HTMLVideoElement;
  if (source.currentSrc !== playbackSrc.value) return;
  ready.value = true;
  failed.value = false;
  if (cachedPoster.value || poster.value || !source.videoWidth || !source.videoHeight) return;
  try {
    const canvas = document.createElement("canvas");
    // ACT: 复用已解码帧，封面最长边限制为 640px；更高清画面由视频播放提供。
    const scale = Math.min(1, 640 / Math.max(source.videoWidth, source.videoHeight));
    canvas.width = Math.max(1, Math.round(source.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(source.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    poster.value = canvas.toDataURL("image/jpeg", 0.8);
  } catch (error) {
    console.warn("视频封面生成失败", error);
  }
}

async function reloadVideo() {
  if (pendingReload) return pendingReload;
  const source = video.value;
  if (!source) return Promise.resolve();
  const revision = sourceRevision;
  const currentFile = file;
  const workspace = currentFile ? files.getWorkspaceFiles() : undefined;
  const time = source.currentTime;
  clearTimeout(retryTimer);
  reloading.value = true;
  const operation = Promise.resolve().then(async () => {
    let media = currentFile ? workspace?.acquireUrl?.(currentFile.url, currentFile.mimeType, false, true) : undefined;
    try {
      const url = media ? await media.url : src;
      if (revision !== sourceRevision) return;
      refreshedMedia?.release();
      refreshedMedia = media;
      media = undefined;
      playbackSrc.value = url;
      await nextTick();
      if (revision !== sourceRevision) return;
      resumeTime = time;
      ready.value = false;
      failed.value = false;
      source.load();
    } finally { media?.release(); }
  });
  pendingReload = operation.finally(() => {
    if (revision !== sourceRevision) return;
    reloading.value = false;
    pendingReload = undefined;
  });
  return pendingReload;
}

function mediaError(event: Event) {
  const source = event.currentTarget as HTMLVideoElement;
  if (!source.error || source.currentSrc && source.currentSrc !== playbackSrc.value) return;
  ready.value = false;
  playing.value = false;
  failed.value = true;
  // ACT: 每个源只自动恢复一次；后续由用户点击重试，避免损坏文件反复请求。
  if (!automaticallyRetried) {
    automaticallyRetried = true;
    const revision = sourceRevision;
    retryTimer = setTimeout(() => {
      void reloadVideo().catch(() => { if (revision === sourceRevision) ElMessage.error("无法预览该视频"); });
    }, 800);
    return;
  }
  ElMessage.error("无法预览该视频");
}

async function togglePlayback() {
  const source = video.value;
  if (!source || reloading.value) return;
  const revision = sourceRevision;
  if (playing.value) source.pause();
  else {
    try {
      if (failed.value || source.error) await reloadVideo();
      if (revision === sourceRevision) await source.play();
    }
    catch (error) { if (revision === sourceRevision && !(error instanceof DOMException && error.name === "AbortError")) ElMessage.error("视频播放失败"); }
  }
}

function playFromSurface(event: MouseEvent) {
  if (previewing.value || event.defaultPrevented || event.detail > 1) return;
  void togglePlayback();
}

function seek(value: number | number[]) {
  if (!video.value || !Number.isFinite(value)) return;
  video.value.currentTime = Math.min(duration.value, Math.max(0, Number(value)));
  currentTime.value = video.value.currentTime;
}

function readVolume() {
  if (!video.value) return;
  volume.value = Math.round(video.value.volume * 100);
  muted.value = video.value.muted;
  if (volume.value > 0) lastVolume = volume.value;
}

function setVolume(value: number | number[]) {
  if (!video.value || typeof value !== "number" || !Number.isFinite(value)) return;
  video.value.volume = Math.min(100, Math.max(0, value)) / 100;
  video.value.muted = video.value.volume === 0;
  readVolume();
}

function toggleMute() {
  if (!video.value) return;
  const silent = video.value.muted || video.value.volume === 0;
  if (video.value.volume === 0) video.value.volume = lastVolume / 100;
  video.value.muted = !silent;
  readVolume();
}

function loadFrame(source: HTMLVideoElement, time: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error("视频帧读取超时")), 15000);
    function finish(error?: unknown) {
      clearTimeout(timer);
      source.onloadeddata = null;
      source.onseeked = null;
      source.onerror = null;
      signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve();
    }
    function abort() { finish(signal.reason); }
    source.onloadeddata = () => {
      if (time === 0) finish();
      else source.currentTime = time;
    };
    source.onseeked = () => finish();
    source.onerror = () => finish(new Error("无法读取视频帧"));
    signal.addEventListener("abort", abort, { once: true });
    source.src = playbackSrc.value;
    source.load();
    if (signal.aborted) abort();
  });
}

async function captureFrame(command: "current" | "first" | "last") {
  if (!video.value || !ready.value || capturing.value) return;
  if (!nodeTypes?.value?.["remote-imageNode"]) return void ElMessage.error("请先启用图片节点插件");
  capturing.value = true;
  const controller = captureController = new AbortController();
  const id = crypto.randomUUID();
  let frameVideo: HTMLVideoElement | undefined;
  let uploadStarted = false;
  let committed = false;
  let workspace: ReturnType<typeof files.getWorkspaceFiles> | undefined;
  try {
    let source = video.value;
    if (command !== "current" || source.seeking || source.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      frameVideo = document.createElement("video");
      frameVideo.muted = true;
      frameVideo.preload = "auto";
      // 用独立视频按需解码，不改变播放器当前进度；尾帧定位到结束前。
      const time = command === "current" ? source.currentTime : command === "first" ? 0 : Math.max(0, duration.value - 0.001);
      await loadFrame(frameVideo, time, controller.signal);
      source = frameVideo;
    }
    controller.signal.throwIfAborted();
    const canvas = document.createElement("canvas");
    canvas.width = source.videoWidth;
    canvas.height = source.videoHeight;
    const context = canvas.getContext("2d");
    if (!context || !canvas.width || !canvas.height) throw new Error("视频帧尚未就绪");
    context.drawImage(source, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("截图生成失败")), "image/png"));
    controller.signal.throwIfAborted();
    const frameLabel = { current: "当前帧", first: "首帧", last: "尾帧" }[command];
    const name = `${node.data.label || label} · ${frameLabel}`;
    if (findNode(node.id) !== node) throw new Error("画布节点已变化，请重新截帧");
    workspace = files.getWorkspaceFiles();
    uploadStarted = true;
    const path = await files.uploadFile(id, new File([blob], "frame.png", { type: "image/png" }));
    controller.signal.throwIfAborted();
    if (findNode(node.id) !== node || !nodeTypes?.value?.["remote-imageNode"]) throw new Error("画布节点已变化，请重新截帧");
    const x = node.computedPosition.x + node.dimensions.width + 40;
    let y = node.computedPosition.y;
    const width = 240 * canvas.width / canvas.height + 18;
    for (const other of [...getNodes.value].sort((a, b) => a.computedPosition.y - b.computedPosition.y)) {
      const position = other.computedPosition;
      if (position.x < x + width && position.x + other.dimensions.width > x && position.y < y + 300 && position.y + other.dimensions.height > y) y = position.y + other.dimensions.height + 24;
    }
    addNodes({ id, type: "remote-imageNode", position: { x, y }, data: { label: name, outputs: { image: { dataType: "IMAGE", value: { url: path, mimeType: "image/png" } } } } });
    committed = true;
    ElMessage.success("已截取为图片节点");
  } catch (error) {
    if (!controller.signal.aborted) ElMessage.error(error instanceof Error ? error.message : "截帧失败");
  } finally {
    if (frameVideo) { frameVideo.removeAttribute("src"); frameVideo.load(); }
    if (uploadStarted && !committed) {
      await workspace!.remove(`assets/${id}`, true).catch(error => {
        if (error?.response?.data?.data?.code !== "ENOENT") ElMessage.error("截帧中断，临时图片清理失败");
      });
    }
    capturing.value = false;
    captureController = undefined;
  }
}
</script>

<style scoped lang="scss">
.videoPlayer {
  position: relative;
  width: 100%;
  min-width: 180px;
  container-type: inline-size;
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-darker);
  cursor: grab;

  &:active { cursor: grabbing; }
  &.previewing {
    display: flex;
    flex-direction: column;
    height: min(900px, calc(100dvh - 72px));
    min-width: 0;
    background: #000;
    cursor: default;
    &:fullscreen { height: 100%; border-radius: 0; }

    .previewHeader {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      padding: 10px 12px;
      background: var(--el-bg-color-overlay);
      color: var(--el-text-color-primary);
      .el-button { margin: 0; }
      .previewTitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    }
    .videoPreview { flex: 1; min-height: 0; max-height: none; pointer-events: auto; }
    .playbackEnded {
      position: absolute;
      top: 50%;
      left: 50%;
      display: flex;
      gap: 8px;
      transform: translate(-50%, -50%);
      padding: 16px;
      border-radius: var(--el-border-radius-base);
      background: var(--el-bg-color-overlay);
      white-space: nowrap;
      .el-button { margin: 0; }
    }
  }
  .videoPreview {
    display: block;
    width: 100%;
    max-height: 240px;
    object-fit: contain;
    border-radius: var(--el-border-radius-base);
    cursor: pointer;

    &:fullscreen {
      height: 100%;
      max-height: none;
      border-radius: 0;
      background: #000;
      pointer-events: auto;
      cursor: default;
    }
  }
  .playerControls {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    display: grid;
    grid-template-columns: 28px auto minmax(0, 1fr) 28px 28px;
    grid-template-areas: "progress progress progress progress progress" "play current duration volume capture";
    align-items: center;
    gap: 2px 3px;
    padding: 8px 8px 4px;
    border-radius: 0 0 var(--el-border-radius-base) var(--el-border-radius-base);
    background: linear-gradient(transparent, color-mix(in srgb, var(--el-bg-color-overlay) 85%, transparent));
    color: var(--el-text-color-primary);
    cursor: default;
    opacity: 0;
    pointer-events: none;
    transition: opacity 120ms ease;

    .playerButton {
      width: 28px;
      height: 28px;
      margin: 0;
      padding: 0;
      font-size: 15px;
      &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
    }
    .playButton { grid-area: play; }
    .volumeControl {
      grid-area: volume;
      .volumeButton { color: var(--el-text-color-regular); }
    }
    .captureMenu { grid-area: capture; }
    .currentTime, .durationLabel {
      white-space: nowrap;
      font-size: 10px;
      line-height: 16px;
      font-variant-numeric: tabular-nums;
    }
    .currentTime { grid-area: current; text-align: right; }
    .durationLabel {
      grid-area: duration;
      color: var(--el-text-color-secondary);
      .timeSeparator { margin-right: 3px; color: var(--el-text-color-placeholder); }
    }
    .progressSlider {
      grid-area: progress;
      min-width: 0;
      width: calc(100% - 8px);
      justify-self: center;
      height: 16px;
      --el-slider-height: 2px;
      --el-slider-button-size: 8px;
      --el-slider-button-wrapper-size: 22px;

      :deep(.el-slider__button-wrapper) {
        top: 50%;
        display: grid;
        place-items: center;
        transform: translate(-50%, -50%);

        &::after { display: none; }
      }
    }

    @container (min-width: 320px) {
      grid-template-columns: 28px auto minmax(32px, 1fr) auto 28px 28px;
      grid-template-areas: "play current progress duration volume capture";
      gap: 6px;
      padding: 8px 8px 4px;
      .currentTime, .durationLabel { font-size: 11px; }
      .durationLabel .timeSeparator { display: none; }
    }
    @media (prefers-reduced-motion: reduce) { transition: none; }
  }
  &:hover .playerControls, .playerControls:has(:focus-visible) {
    opacity: 1;
    pointer-events: auto;
  }
}
.previewTarget { min-width: 0; }
:global(.videoPreviewDialog .el-dialog__header) { display: none; }
.volumePanel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding-bottom: 4px;

  .volumeValue { color: var(--el-text-color-secondary); font-size: 10px; line-height: 14px; font-variant-numeric: tabular-nums; }
  .volumeSlider {
    --el-slider-height: 2px;
    --el-slider-button-size: 8px;
    --el-slider-button-wrapper-size: 22px;

    :deep(.el-slider__button-wrapper) {
      left: 50%;
      display: grid;
      place-items: center;
      transform: translate(-50%, 50%);

      &::after { display: none; }
    }
  }
}
</style>
