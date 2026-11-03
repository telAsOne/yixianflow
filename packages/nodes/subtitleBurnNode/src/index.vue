<template>
  <nodeSkeleton
    v-bind="nodeProps"
    :topVisible="node.selected || generating"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :downloadName="`${nodeProps.label || '字幕烧录'}.mp4`"
    :overviewSrc="posterUrl"
    :style="{ width: `${videoWidth + 18}px` }"
    fullscreenLabel="预览视频"
    @fullscreen="player?.enterFullscreen()">
    <template #topActions>
      <el-button :disabled="generating || deleting || disposed" @click="startBurn().catch(reportError)">烧录字幕</el-button>
      <el-button v-if="generating" :disabled="cancelling" @click="cancelJob">{{ cancelling ? '正在取消' : '取消' }}</el-button>
    </template>
    <div class="burnContent nodrag nopan">
      <div v-if="generating" class="burnProgress" role="status">
        <el-progress class="progressBar" :percentage="Math.round(progress)" :showText="true" />
        <span>{{ cancelling ? '正在取消烧录' : '正在烧录字幕' }}</span>
      </div>
      <p v-if="error" class="burnError" role="alert">{{ error }}</p>
      <videoPlayer v-if="previewUrl" ref="player" :src="previewUrl" :file="outputFile" :previewSrc="posterUrl" :metadata="mediaInfo" :label="nodeProps.label" @loadedmetadata="resizeVideo" />
      <mediaPreviewStatus :preview="mediaPreview" />
    </div>
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watchEffect } from "vue";
import { ElButton, ElProgress } from "element-plus";
import { getTargetValues, nodeSkeleton, nodeTools, useNode, z, type NodeHandle, type NodeInputValue } from "@toonflow/nodes-scaffold/runtime";
import { useNodeGeneration } from "@toonflow/node-shared/useNodeGeneration";
import { showNodeError } from "@toonflow/node-shared/showNodeError";
import { useMediaPreview } from "@toonflow/node-shared/useMediaPreview";
import mediaPreviewStatus from "@toonflow/node-shared/mediaPreviewStatus";
import videoPlayer from "@toonflow/node-video/videoPlayer";
import { burnVideo } from "./videoBurning";

defineOptions({
  inheritAttrs: false,
  handles: [
    { id: "videoInput", type: "target", dataType: "VIDEO", label: "一个视频" },
    { id: "subtitleInput", type: "target", dataType: "STRING", label: "一份 SRT 字幕" },
    { id: "video", type: "source", dataType: "VIDEO", label: "带字幕的视频" },
  ] satisfies NodeHandle[],
});
const { id, node, nodeProps, outputs, nodeEvent, files, ffmpeg, retainPreview, updateNodeInternals } = useNode({ label: "字幕烧录" });
const videoInputs = ref<NodeInputValue[]>([]);
const subtitleInputs = ref<NodeInputValue[]>([]);
const error = ref("");
const progress = ref(0);
const cancelling = ref(false);
const deleting = ref(false);
const disposed = ref(false);
const player = ref<InstanceType<typeof videoPlayer>>();
const videoWidth = ref(320);
let controller: AbortController | undefined;
let job: Promise<void> | undefined;
let cleanupFailed = false;
const generation = useNodeGeneration(outputs, cancelJob, "字幕烧录已取消");
const { generating } = generation;
const outputFile = computed(() => outputs.value.video?.dataType === "VIDEO" ? outputs.value.video.value : undefined);
const mediaPreview = useMediaPreview(outputFile);
const previewUrl = mediaPreview.url;
const posterUrl = files.useFileUrl(outputFile, failure => reportError(failure, "视频封面读取失败"), true);
const mediaInfo = files.useMediaInfo(outputFile, failure => reportError(failure, "视频信息读取失败"));
watchEffect(() => {
  const info = mediaInfo.value;
  if (info?.width && info.height) videoWidth.value = Math.max(180, 240 * info.width / info.height);
});
watchEffect(() => { retainPreview.value = generating.value || !!player.value?.playing || !!player.value?.fullscreen; });
nodeEvent.on("input:videoInput", values => { videoInputs.value = values; });
nodeEvent.on("input:subtitleInput", values => { subtitleInputs.value = values; });
nodeEvent.on("canConnect", (connection, context) => {
  const edges = context.edges.filter(edge => edge.source !== connection.source || edge.sourceHandle !== connection.sourceHandle
    || edge.target !== connection.target || edge.targetHandle !== connection.targetHandle);
  return ["videoInput", "subtitleInput"].every(handle => getTargetValues(id, handle, context.nodes, [...edges, connection]).length <= 1);
});

function reportError(failure: unknown, fallback = "字幕烧录失败") {
  error.value = (failure as { response?: { data?: { message?: string } } })?.response?.data?.message
    || (failure instanceof Error ? failure.message : fallback);
  showNodeError(failure, fallback);
}
function cancelJob() {
  if (!controller || controller.signal.aborted) return;
  cancelling.value = true;
  controller.abort(new DOMException("字幕烧录已取消", "AbortError"));
}
async function resizeVideo(event: Event) {
  const video = event.currentTarget as HTMLVideoElement;
  if (!video.videoWidth || !video.videoHeight) return;
  videoWidth.value = Math.max(180, 240 * video.videoWidth / video.videoHeight);
  await nextTick();
  updateNodeInternals();
}
async function startBurn() {
  if (generating.value || deleting.value || disposed.value) throw new Error("字幕正在烧录或节点已关闭");
  if (videoInputs.value.length !== 1 || subtitleInputs.value.length !== 1) throw new Error("字幕烧录需要恰好一个视频和一份 SRT 字幕输入");
  const video = videoInputs.value[0];
  const subtitle = subtitleInputs.value[0];
  if (video.dataType !== "VIDEO" || !video.value || typeof video.value !== "object" || !video.value.url) throw new Error("视频输入暂无可烧录内容");
  if (subtitle.dataType !== "STRING" || typeof subtitle.value !== "string" || !subtitle.value.trim()) throw new Error("字幕输入暂无已保存的 SRT 内容");
  const videoPath = video.value.url;
  const srt = subtitle.value;
  const workspace = files.getWorkspaceFiles();
  const current = controller = new AbortController();
  // 工厂与文件实例在开始时绑定同一工作区；后台任务不持有工具调用 signal。
  const factory = ffmpeg(current.signal);
  progress.value = 0;
  error.value = "";
  cancelling.value = false;
  cleanupFailed = false;
  job = generation.run(async () => {
    const result = await burnVideo(await factory, workspace, id, videoPath, srt, current.signal, value => { progress.value = value; });
    current.signal.throwIfAborted();
    outputs.value.video = { dataType: "VIDEO", value: { url: result.path, mimeType: "video/mp4" } };
  }).catch(failure => {
    cleanupFailed = failure instanceof Error && failure.cause instanceof AggregateError;
    if (failure instanceof Error && failure.name === "AbortError") error.value = "字幕烧录已取消";
    else reportError(failure);
  }).finally(() => {
    if (controller === current) controller = undefined;
    cancelling.value = false;
  });
  return { status: "generating" as const };
}

nodeEvent.on("save", reason => {
  if (reason === "reload" && generating.value) throw new Error("字幕烧录中，请完成或取消后再刷新节点");
});
nodeEvent.on("copy", () => ({ generationTiming: undefined }));
nodeEvent.on("delete", async () => {
  deleting.value = true;
  try {
    cancelJob();
    await job;
    if (cleanupFailed) throw new Error(error.value);
    await files.removeNodeFiles();
  } finally { deleting.value = false; }
});
onScopeDispose(() => { disposed.value = true; cancelJob(); });
nodeTools.register({
  name: "burnSubtitles",
  description: "从恰好一个视频和一份已保存 SRT 字符串启动字幕后台烧录，立即返回 generating。保留原视频和之前输出，成功后更新 VIDEO 输出。用 getGenerationStatus 按需查询；默认继续独立工作，不循环等待，除非用户明确要求。",
  parameters: z.strictObject({}),
  execute(_args, { signal }) { signal?.throwIfAborted(); return startBurn(); },
});
</script>

<style scoped lang="scss">
.burnContent {
  position: relative;
  min-height: 144px;
  .burnProgress {
    padding: 12px;
    font-size: 12px;
    .progressBar { margin-bottom: 8px; }
  }
  .burnError { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--el-color-danger); font-size: 12px; }
}
</style>
