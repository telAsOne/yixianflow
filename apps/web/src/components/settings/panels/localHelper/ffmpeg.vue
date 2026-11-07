<template>
  <div class="ffmpegPanel">
    <el-card shadow="never">
      <div class="componentHeader">
        <h3><icon-movie :size="18" aria-hidden="true" />FFmpeg · 本地助手</h3>
        <el-tag :type="ready ? 'success' : 'info'">{{ ready ? '本机已就绪' : '等待本地助手' }}</el-tag>
        <el-button :icon="IconRefresh" :loading="loading" :disabled="busy" @click="refreshStatus(true)">重新检测</el-button>
      </div>
      <p>音视频处理、媒体信息读取和缩略图统一由选定的本地助手执行，可直接处理本机路径。网页工作区素材按需下载，处理结果回传工作区。</p>
      <el-alert v-if="failure" :title="failure" type="warning" :closable="false" showIcon />
      <template v-if="status">
        <p>处理电脑：{{ status.device.name }} · {{ status.platform }} / {{ status.arch }}</p>
        <p>FFmpeg 和 ffprobe 随本地助手内置。需要修复时，可重新安装本机组件。</p>
        <div class="downloadActions">
          <el-select v-model="source" :disabled="busy || loading" aria-label="本地 FFmpeg 下载线路">
            <el-option v-for="item in status.sources.filter(item => item.available)" :key="item.id" :label="item.label" :value="item.id" />
          </el-select>
          <el-button type="primary" :icon="IconDownload" :loading="busy" :disabled="!source || loading" @click="install">重新安装本机组件</el-button>
          <el-button v-if="busy && download.phase !== 'installing'" @click="cancel">取消</el-button>
        </div>
        <div v-if="download.phase !== 'idle'" class="downloadProgress" aria-live="polite">
          {{ phaseLabels[download.phase] }}<template v-if="download.file"> · {{ download.file }}</template>
          <el-progress :percentage="percentage" :indeterminate="busy && !download.total" :showText="!!download.total || !busy"
            :status="download.phase === 'error' ? 'exception' : download.phase === 'completed' ? 'success' : undefined" />
          <p v-if="download.error">{{ download.error }}</p>
        </div>
        <div class="toolInfo">
          <p>本机组件目录：<code>{{ status.directory }}</code></p>
          <div v-for="name in toolNames" :key="name">
            <strong>{{ name }}</strong>
            <p>{{ status.tools[name].version || status.tools[name].error || '不可用' }}</p>
            <code>{{ status.tools[name].path }}</code>
          </div>
        </div>
      </template>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { IconDownload, IconRefresh } from "@tabler/icons-vue";
import type { LocalMediaStatus } from "@toonflow/local-helper/protocol";
import api, { errorMessage } from "@/lib/api";
import useLocalHelper from "@/stores/localHelper";

const props = withDefaults(defineProps<{ visible?: boolean }>(), { visible: true });
type FfmpegStatus = LocalMediaStatus & { device: { id: string; name: string }; config: { source: string };
  sources: { id: string; label: string; available: boolean }[] };
const status = ref<FfmpegStatus>();
const source = ref("");
const failure = ref("");
const loading = ref(false);
const download = ref<LocalMediaStatus["download"]>({ phase: "idle", received: 0 });
const toolNames = ["ffmpeg", "ffprobe"] as const;
const ready = computed(() => toolNames.every(name => !!status.value?.tools[name].version));
const busy = computed(() => ["downloading", "verifying", "installing"].includes(download.value.phase));
const percentage = computed(() => download.value.phase === "completed" ? 100 : download.value.total
  ? Math.min(100, Math.round(download.value.received / download.value.total * 100)) : busy.value ? 50 : 0);
const phaseLabels = { idle: "等待下载", downloading: "本机正在下载", verifying: "本机正在校验", installing: "本机正在安装",
  completed: "本机安装完成", error: "本机安装失败", cancelled: "已取消" };
const { status: helper } = useLocalHelper(() => props.visible);
let timer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;

async function refreshStatus(refresh = false) {
  controller?.abort();
  const active = controller = new AbortController();
  loading.value = true;
  try {
    const response = await api.get<{ data: FfmpegStatus }>("/api/ffmpeg/status", { params: { refresh: refresh ? "true" : undefined }, signal: active.signal });
    if (active.signal.aborted) return;
    status.value = response.data.data;
    download.value = status.value.download;
    if (!status.value.sources.some(item => item.id === source.value && item.available)) source.value = status.value.config.source;
    failure.value = "";
  } catch (error) {
    if (!active.signal.aborted) { status.value = undefined; failure.value = errorMessage(error, "请连接本地助手后重新检测"); }
  } finally { if (!active.signal.aborted) loading.value = false; }
}

function poll() {
  clearTimeout(timer);
  if (!props.visible || !busy.value) return;
  timer = setTimeout(async () => {
    try {
      const response = await api.get<{ data: LocalMediaStatus["download"] }>("/api/ffmpeg/progress");
      download.value = response.data.data;
      if (!busy.value) await refreshStatus();
    } catch (error) { failure.value = errorMessage(error, "无法读取本机安装进度"); }
    poll();
  }, 1000);
}

async function install() {
  if (busy.value) return;
  failure.value = "";
  try {
    const response = await api.post<{ data: LocalMediaStatus["download"] }>("/api/ffmpeg/download", { source: source.value });
    download.value = response.data.data;
    poll();
  } catch (error) { failure.value = errorMessage(error, "本机安装未开始"); }
}

async function cancel() {
  try { await api.post("/api/ffmpeg/cancel"); }
  catch (error) { failure.value = errorMessage(error, "取消失败"); }
}

watch(() => [props.visible, helper.value?.selectedId, helper.value?.devices.find(device => device.id === helper.value?.selectedId)?.approved,
  helper.value?.devices.find(device => device.id === helper.value?.selectedId)?.online,
  helper.value?.devices.find(device => device.id === helper.value?.selectedId)?.paused], () => {
  if (props.visible) void refreshStatus();
  else { controller?.abort(); clearTimeout(timer); }
}, { immediate: true });
watch(busy, poll);
onBeforeUnmount(() => { controller?.abort(); clearTimeout(timer); });
</script>

<style lang="scss" scoped>
.ffmpegPanel {
  display: flex;
  flex-direction: column;
  gap: 20px;

  p {
    line-height: 1.7;
    overflow-wrap: anywhere;
  }

  .componentHeader {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;

    h3 {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 0 auto 0 0;
    }
  }

  .downloadActions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;

    .el-select { flex: 1; min-width: 160px; }
  }

  .downloadProgress, .toolInfo { margin-top: 16px; }

  .toolInfo {
    color: var(--el-text-color-secondary);
    font-size: 12px;

    code { overflow-wrap: anywhere; }

    div { margin-top: 16px; }
  }
}
</style>
