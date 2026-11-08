<template>
  <nodeSkeleton
    v-bind="nodeProps"
    v-model:bottomVisible="node.selected"
    :topVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :overviewSrc="posterUrl"
    :overviewLabel="videoTask ? taskPhaseLabel : ''"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    fullscreenLabel="预览视频"
    @fullscreen="player?.enterFullscreen()"
    :bottomWidth="660"
    :style="{ width: videoWidth ? `${videoWidth + 18}px` : undefined }">
    <template #topActions>
      <el-button :icon="IconMusic" text :disabled="!outputFile || generating || deleting || uploading || actions?.processing" @click.stop="actions?.open('extractAudio')">提取音轨</el-button>
      <el-button :icon="IconLayersSubtract" text :disabled="!outputFile || generating || deleting || uploading || actions?.processing" @click.stop="actions?.open('separate')">分离音视频</el-button>
      <el-button :icon="IconScissors" text :disabled="!outputFile || generating || deleting || uploading || actions?.processing" @click.stop="actions?.open('trim')">截取片段</el-button>
      <mediaHistory mediaType="video" :current="outputFile" :disabled="generating || deleting || uploading" @select="outputs.video = { dataType: 'VIDEO', value: $event }" />
      <el-button :icon="IconTransfer" :loading="uploading" :disabled="generating || deleting" text title="替换视频" aria-label="替换视频" @click.stop="fileInput?.click()">替换视频</el-button>
      <input ref="fileInput" type="file" accept="video/*" hidden aria-label="选择替换视频" :disabled="generating || deleting || uploading" @change="replaceOutput" />
    </template>
    <template #sideActions>
      <el-dropdown trigger="click" placement="bottom-end" :disabled="!previewUrl || (player && !player.ready) || player?.capturing || generating || deleting || uploading" @command="player?.captureFrame($event)">
        <el-button :icon="IconPhotoScan" :loading="player?.capturing" :disabled="!previewUrl || (player && !player.ready) || player?.capturing || generating || deleting || uploading" text title="截取视频帧" aria-label="截取视频帧" />
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="current" :icon="IconPhotoScan">截取当前帧</el-dropdown-item>
            <el-dropdown-item command="first" :icon="IconPlayerSkipBack">截取首帧</el-dropdown-item>
            <el-dropdown-item command="last" :icon="IconPlayerSkipForward">截取尾帧</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </template>
    <div v-loading="taskRunning || uploading" class="videoContent nopan" :aria-busy="taskRunning || uploading">
      <videoPlayer
        v-if="previewUrl"
        ref="player"
        :src="previewUrl"
        :file="outputFile"
        :previewSrc="posterUrl"
        :metadata="mediaInfo"
        label="生成视频"
        @loadedmetadata="resizeVideo" />
      <div v-else class="videoEmpty" role="img" aria-label="暂无生成视频">
        <icon-camera-ai :size="48" stroke="1.25" aria-hidden="true" />
      </div>
      <mediaPreviewStatus :preview="mediaPreview" />
    </div>
    <div class="promptReviewStatusRow nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop>
      <el-button text size="small" :type="reviewStatus === 'pass' ? 'success' : ['needs_revision', 'needs_clarification'].includes(reviewStatus) ? 'warning' : 'info'" :title="`编辑稿 · ${reviewLabel}`" @click.stop="reviewPanelVisible = true"><span class="reviewBadgeText">编辑稿 · {{ reviewLabel }}</span></el-button>
    </div>
    <template #bottom>
      <el-card class="promptCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <referenceItem
          v-if="refList.length && !isH3Prompt"
          v-model="refList"
          :disabled="uploadingReferences || zealmanEnqueuing"
          @preview="setReferencePreview"
          @remove="removeReference" />
        <div v-if="frameMode" class="referenceHint">
          {{ selectedMode === "startFrameOptional" ? "仅一张图片时作为尾帧；两张图片按顺序作为首帧、尾帧" : "图片引用按顺序作为首帧、尾帧" }}<template v-if="selectedModel?.referenceImageInput === 'url'">，图片节点在前、下方链接在后</template>
        </div>
        <h3PromptEditor v-if="isH3Prompt" v-model="data.h3Prompt" v-model:prompt="data.prompt" v-model:promptModel="data.promptModel" v-model:duration="data.duration"
          :references="h3ReferenceList" :voices="isZealmanU06 ? zealmanOptions?.voices : undefined" :remoteLibrary="isZealmanU06"
          :disabled="deleting || uploadingReferences || taskChecking || zealmanEnqueuing || (!isZealmanU06 && generating)"
          @upload="uploadReferences()" @replaceReference="uploadReferences" @clearReferences="clearReferences" @openLibrary="libraryVisible = true"
          @swapReferences="swapH3References" @removeReference="removeH3Reference" @referencePreview="(item, url, original) => item.input && setReferencePreview(item.input, url, original)" />
        <promptInput v-else-if="selectedModel || !data.model" v-model="data.promptModel" v-model:text="data.prompt" :references="referenceMentions" expandable />
        <zealmanSettings
          v-if="isZealmanU06"
          v-model="data.zealmanSettings"
          v-model:duration="data.duration"
          v-model:resolution="data.resolution"
          v-model:ratio="data.ratio"
          v-model:seed="data.seed"
          :options="zealmanOptions"
          :loading="zealmanLoading"
          :error="zealmanError"
          :disabled="deleting || taskChecking || zealmanLoading"
          @refresh="ensureZealmanOptions(true).catch(error => showNodeError(error, '面板选项读取失败'))" />
        <template v-if="selectedModel?.referenceImageInput === 'url'">
          <div class="referenceHint">本地图片连线会通过「设置 → 素材存储」中的阿里云 OSS 自动上传；也可在下方每行填写一个 HTTPS 图片直链。<template v-if="frameMode">先按上方图片顺序，再按链接顺序作为首帧、尾帧，{{ selectedMode === "startEndRequired" ? "合计必须为两张" : "合计最多两张" }}。</template><template v-else>先按上方图片顺序，再按链接顺序对应 @Image1、@Image2，合计最多 9 张。</template><template v-if="selectedModel.mode?.includes('text')">没有图片和链接时为文生视频。</template></div>
          <el-input v-model="data.referenceImageUrlsText" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" :disabled="generating || deleting || pendingTask || taskChecking || uploadingReferences" placeholder="https://example.com/reference.png" aria-label="参考图片 HTTPS 直链" />
        </template>
        <div v-if="selectedModel?.referenceAudioInput === 'url'" class="referenceHint">连接音频节点作为参考音频，按上方音频引用顺序使用；本地音频会通过「设置 → 素材存储」中的阿里云 OSS 自动上传。</div>
        <div class="promptReviewTools" role="status" aria-live="polite">
          <el-button text size="small" @click="reviewPanelVisible = true">编辑稿 · {{ reviewLabel }}</el-button>
          <el-button v-if="reviewing" size="small" @click="cancelPromptReview">停止等待审查</el-button>
          <el-button v-else size="small" :disabled="deleting || !generationPrompt.trim()" @click="openPromptReview()">审查</el-button>
          <el-button v-if="reviewStatus !== 'pass'" size="small" type="primary" plain :icon="IconSparkles" :loading="reviewing" :disabled="!reviewEditable || !generationPrompt.trim()"
            title="最多 3 轮审查、自动局部修改与复审；遇到待确认项即停止，每轮按用量计费" @click="openPromptReview(true)">AI 一键审查</el-button>
          <span>按用量计费 · 可直接生成</span>
        </div>
        <p v-if="data.model && !selectedModel && !modelsLoading" role="alert">模型不可用，请选择其他模型</p>
        <div class="promptFooter">
          <el-select
            v-model="data.model"
            class="modelSelect"
            filterable
            :loading="modelsLoading"
            :disabled="generating || deleting || pendingTask || taskChecking || zealmanLoading || zealmanEnqueuing || uploadingReferences || !!data.zealmanQueue.length"
            placeholder="选择模型"
            aria-label="生成模型"
            noDataText="请登录 UnionAIGC 账户并刷新模型"
            @change="rememberPreferences"
            placement="top-start"
            @visibleChange="(visible: boolean) => visible && loadModels().catch((error) => showNodeError(error, '模型读取失败'))">
            <template #prefix><icon-sparkles :size="17" /></template>
            <template #label="{ label }"><span class="modelLabel" :title="`${selectedModel?.providerLabel ?? ''} · ${label}`"><span class="providerName">{{ selectedModel?.providerLabel }}</span><span class="modelName">{{ label }}</span></span></template>
            <el-option-group v-for="provider in modelGroups" :key="provider.id" :label="provider.label">
              <el-option
                v-for="item in provider.models"
                :key="item.modelId"
                :label="item.label"
                :value="JSON.stringify([item.providerId, item.modelId])" />
            </el-option-group>
          </el-select>
          <div class="generationActions">
            <generationSettings
              v-if="!isZealmanU06"
              v-model:duration="data.duration"
              v-model:resolution="data.resolution"
              v-model:ratio="data.ratio"
              v-model:mode="data.mode"
              v-model:generateAudio="data.generateAudio"
              v-model:seed="data.seed"
              @update:duration="rememberPreferences"
              @update:resolution="rememberPreferences"
              @update:ratio="rememberPreferences"
              @update:mode="rememberPreferences"
              @update:generateAudio="rememberPreferences"
              :ratios="ratioOptions"
              :model="selectedModel"
              :disabled="generating || deleting || pendingTask || taskChecking || !selectedModel" />
            <el-button
              v-if="!isZealmanU06"
              class="sendButton"
              :icon="generating ? IconPlayerStop : IconArrowUp"
              :disabled="deleting || uploading || uploadingReferences || taskChecking || (!generating && submissionUnconfirmed) || (!generating && !pendingTask && (!generationPrompt || !selectedModel))"
              :title="generating ? '停止本地等待' : submissionUnconfirmed ? '提交状态待核查，可在新节点继续' : pendingTask ? '恢复原视频任务' : '生成视频'"
              :aria-label="generating ? '停止本地等待' : submissionUnconfirmed ? '提交状态待核查' : pendingTask ? '恢复原视频任务' : '生成视频'"
              @click="generating ? stopGeneration() : startGeneration().catch((error) => showNodeError(error, '视频生成失败'))">{{ generating ? '停止等待' : submissionUnconfirmed ? '待核查' : pendingTask ? '恢复任务' : '生成' }}</el-button>
            <template v-else>
              <el-button v-if="generating || activeQueueId" @click="stopGeneration">停止等待</el-button>
              <el-button v-else-if="pendingTask || data.zealmanQueue.length" :disabled="taskChecking || deleting" @click="continueZealmanQueue().catch(error => showNodeError(error, '恢复队列失败'))">{{ pendingTask ? '恢复任务' : '继续队列' }}</el-button>
              <el-button class="sendButton" :icon="IconArrowUp" :disabled="deleting || uploading || uploadingReferences || taskChecking || !generationPrompt || zealmanEnqueuing" :loading="zealmanEnqueuing" @click="startGeneration().catch(error => showNodeError(error, '加入队列失败'))">{{ generating || pendingTask || data.zealmanQueue.length ? `加入队列 (${data.zealmanQueue.length})` : '生成' }}</el-button>
            </template>
          </div>
        </div>
        <div v-if="isZealmanU06 && data.zealmanQueue.length" class="queuedItems" aria-label="U06 生成队列">
          <div v-for="item in data.zealmanQueue" :key="item.input.operationId" class="queuedItem">
            <span :title="item.promptReview ? `提交时编辑稿审查：${item.promptReview.label}` : '提交时未记录编辑稿审查'">{{ item.input.operationId === videoTask?.operationId || item.input.operationId === activeQueueId ? '当前任务' : '等待中' }} · {{ item.title }}<template v-if="item.promptReview"> · {{ item.promptReview.label }}</template></span>
            <el-button v-if="item.input.operationId !== videoTask?.operationId && item.input.operationId !== activeQueueId" text size="small" @click="data.zealmanQueue = data.zealmanQueue.filter(entry => entry !== item)">移除</el-button>
          </div>
        </div>
        <generationTiming :timing="data.generationTiming" :running="taskRunning" />
        <div v-if="videoTask || taskStatusError" class="taskStatus" role="status" aria-live="polite">
          <div v-if="videoTask">{{ taskPhaseLabel }}<span v-if="videoTask.phase === 'in_progress' && videoTask.progress !== undefined"> · {{ videoTask.progress }}%</span></div>
          <div v-if="videoTask?.taskId">任务编号：{{ videoTask.taskId }}</div>
          <div v-if="videoTask && !videoTask.taskId">本地操作编号：{{ videoTask.operationId }}</div>
          <div v-if="pendingTask && !generating">
            {{ submissionUnconfirmed
              ? '提交结果尚未确认，请到视频专栏核查；原任务会保留，可在新节点继续创作。'
              : '原任务已保存，点击“恢复任务”按原参数恢复；也可在新节点继续其他创作。' }}
          </div>
          <div v-if="videoTask?.error || taskStatusError" class="taskError">{{ taskStatusError || videoTask?.error }}</div>
        </div>
        <el-button
          v-if="duplicateCanvasNode && (generating || pendingTask || taskStatusError)"
          :loading="creatingGeneration"
          :disabled="deleting || uploadingReferences"
          title="复制配置和参考连线到新节点，保留原任务；点击生成后才会提交新任务"
          @click="createNewGeneration().catch(error => showNodeError(error, '创建新节点失败'))">在新节点继续</el-button>
      </el-card>
    </template>
  </nodeSkeleton>
  <videoActions ref="actions" :file="outputFile" :src="previewUrl" :disabled="generating || deleting || uploading" />
  <h3MediaLibrary v-if="isZealmanU06" v-model="libraryVisible" :importReferences="importPanelReferences" />
  <promptReviewPanel v-model="reviewPanelVisible" :record="reviewRecord" :run="reviewRun" :current="reviewCurrent" :reviewing="reviewing" :status="reviewStatus" :label="reviewLabel" :error="reviewError"
    :editable="reviewEditable" :canReview="!deleting && !!generationPrompt.trim()" @review="force => reviewPrompt(force)" @cancel="cancelPromptReview" @apply="applyReviewEdits" />
</template>

<script setup lang="ts">
import { validateReferenceSelection } from "@toonflow/node-shared/mediaLimits";
import { computed, inject, nextTick, onMounted, onScopeDispose, ref, watch, watchEffect } from "vue";
import { useVueFlow } from "@vue-flow/core";
import { ElButton, ElCard, ElSelect, ElOption, ElOptionGroup, ElLoading, ElDropdown, ElDropdownMenu, ElDropdownItem, ElInput, ElMessage, ElMessageBox } from "element-plus";
import { IconCameraAi, IconSparkles, IconArrowUp, IconPlayerStop, IconTransfer, IconMusic, IconLayersSubtract, IconScissors, IconPhotoScan, IconPlayerSkipBack, IconPlayerSkipForward } from "@tabler/icons-vue";
import { nodeSkeleton, nodeTools, useNode, z, type NodeMediaModel, type NodeVideoRequest, type NodeHandle, type VideoTaskStatus, type NodeInputValue } from "@toonflow/nodes-scaffold/runtime";
import { registerGenerationTools } from "@toonflow/node-shared/generationTools";
import { assetIdentitySchema } from "@toonflow/node-shared/assetIdentity";
import { useMediaModels } from "@toonflow/node-shared/useMediaModels";
import { useMediaPreview } from "@toonflow/node-shared/useMediaPreview";
import mediaPreviewStatus from "@toonflow/node-shared/mediaPreviewStatus";
import { useOutputReplace } from "@toonflow/node-shared/useOutputReplace";
import { showNodeError } from "@toonflow/node-shared/showNodeError";
import { useNodeGeneration, type GenerationTiming } from "@toonflow/node-shared/useNodeGeneration";
import generationTiming from "@toonflow/node-shared/generationTiming";
import { useGenerationPreferences } from "@toonflow/node-shared/useGenerationPreferences";
import { useNodeReferences, referenceKey } from "@toonflow/node-shared/useNodeReferences";
import promptInput from "@toonflow/node-shared/promptInput";
import videoPlayer from "@toonflow/node-video/videoPlayer";
import videoActions from "@toonflow/node-video/videoActions";
import referenceItem from "@toonflow/node-shared/referenceItem";
import mediaHistory from "@toonflow/node-shared/mediaHistory";
import generationSettings from "./components/generationSettings.vue";
import zealmanSettings from "./components/zealmanSettings.vue";
import h3PromptEditor from "./components/h3PromptEditor.vue";
import h3MediaLibrary from "./components/h3MediaLibrary.vue";
import promptReviewPanel from "./components/promptReviewPanel.vue";
import { usePromptReview, samePromptReviewInput, applyPromptReviewEdits, type PromptReviewInput, type PromptReviewRecord, type PromptReviewRun, type PromptReviewEdit, type PromptReviewSubmission } from "./promptReview";
import { h3CameraTagLike, h3GenerationPrompt, h3References, h3ReferenceGroup, h3PromptIssues, h3Sections, reconcileH3References, type H3PromptState, type H3Reference } from "./h3Prompt";
import { getCameraPresets } from "./cameraPresets";
import { loadZealmanOptions, validateZealmanSettings, zealmanAssetUrl, type ZealmanOptions, type ZealmanAsset } from "./zealmanOptions";

defineOptions({
  inheritAttrs: false,
  icon: IconCameraAi,
  handles: [
    { id: "in", type: "target", dataType: ["IMAGE", "VIDEO", "AUDIO", "STRING"], label: "图片、视频、音频、文本输入" },
    { id: "video", type: "source", dataType: "VIDEO", label: "视频输出" },
  ] satisfies NodeHandle[],
});
const vLoading = ElLoading.directive;
const { findNode } = useVueFlow();
const { id, node, nodeProps, nodeEvent, outputs, files, ai, updateNodeInternals, retainPreview } = useNode({
  label: "视频生成",
});
const duplicateCanvasNode = inject<(nodeId: string, dataPatch?: Record<string, unknown>) => Promise<string>>("duplicateCanvasNode");
const creatingGeneration = ref(false);
type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
const data = computed(() => node.data as { prompt: string; promptModel: PromptModel; model: string; duration?: number; resolution: string; ratio: string; mode: string; generateAudio: boolean; seed?: number | null; appliedVideoTaskId?: string; referenceImageUrlsText: string; generationTiming?: GenerationTiming; zealmanSettings: Record<string, unknown>; zealmanQueue: { input: NodeVideoRequest; title: string; promptReview?: PromptReviewSubmission }[]; h3Prompt: H3PromptState; promptReview?: PromptReviewRecord; promptReviewRun?: PromptReviewRun; submittedPromptReview?: PromptReviewSubmission });
const rememberPreferences = useGenerationPreferences("video", () => data.value);
data.value.prompt ??= "";
data.value.promptModel ??= [];
data.value.model ??= "";
data.value.resolution ??= "";
data.value.mode ??= "";
data.value.generateAudio ??= true;
data.value.ratio ??= "9:16";
data.value.referenceImageUrlsText ??= "";
data.value.zealmanSettings ??= {};
data.value.zealmanQueue ??= [];
data.value.h3Prompt ??= { subjects: [], audioBindings: {}, voices: [], attachments: [], editorMode: "tags" };
const uploadingReferences = ref(false);
const libraryVisible = ref(false);
const zealmanOptions = ref<ZealmanOptions>();
const zealmanLoading = ref(false);
const zealmanError = ref("");
const zealmanEnqueuing = ref(false);
const activeQueueId = ref("");
let queuePaused = true;
const { refList, referenceMentions, setReferencePreview, removeReference: disconnectReference } = useNodeReferences("in", () => data.value.h3Prompt.attachments.map(item => ({ dataType: item.dataType, value: item.value, source: item.source ?? `h3:${item.id}`, sourceHandle: item.sourceHandle ?? "out" })));
const { models, modelsLoading, modelGroups, loadModels } = useMediaModels("video", data, () => generating.value || deleting.value, ai.getMediaModels);
const { uploading, replaceOutput } = useOutputReplace("video", files, () => generating.value || deleting.value,
  value => { outputs.value.video = { dataType: "VIDEO", value }; });
const fileInput = ref<HTMLInputElement>();
let disposed = false;
const deleting = ref(false);
const player = ref<InstanceType<typeof videoPlayer>>();
const actions = ref<InstanceType<typeof videoActions>>();
const videoWidth = ref(0);
let generationController: AbortController | undefined;
const generationState = useNodeGeneration(outputs, stopGeneration, "已停止本地等待；已提交的视频任务及费用不会因此取消");
const { generating } = generationState;
let generation: Promise<void> | undefined;
const videoTask = ref<VideoTaskStatus | null>(null);
const taskRunning = computed(() => generating.value || !!videoTask.value?.running);
const taskChecking = ref(true);
const taskStatusError = ref("");
const pendingTask = computed(() => !!videoTask.value && !["completed", "failed"].includes(videoTask.value.phase));
const submissionUnconfirmed = computed(() => videoTask.value?.phase === "submitting" && !videoTask.value.taskId && !videoTask.value.running);
const taskPhaseLabel = computed(() => videoTask.value ? ({ prepared: "准备提交", submitting: "确认提交回执", queued: "排队中", in_progress: "生成中", downloading: "保存原片中", completed: "原片已保存", failed: "原任务失败" })[videoTask.value.phase] : "");
let taskTimer: ReturnType<typeof setTimeout> | undefined;
let taskWorkspaceDirectory = "";
let resumeWhenReady = false;
const defaultRatios = ["16:9", "9:16", "1:1", "4:3", "3:4"];
const selectedModel = computed(() => models.value.find((item) => JSON.stringify([item.providerId, item.modelId]) === data.value.model));
const isZealmanU06 = computed(() => selectedModel.value?.providerId === "zealmanH3" && selectedModel.value.modelId === "u06");
const isH3Prompt = computed(() => selectedModel.value?.providerId === "yixianVideo" && selectedModel.value.modelId.startsWith("yixian-h3-"));
const h3VideoReferenceLimit = computed(() => Math.max(0, ...(selectedModel.value?.mode ?? []).filter(Array.isArray).flat().filter(item => item.startsWith("videoReference:")).map(item => Number(item.split(":")[1]))));
const h3ReferenceList = computed(() => h3References([...refList.value, ...referenceUrls(selectedModel.value).map(url => ({ source: `url:${url}`, sourceHandle: "out", dataType: "IMAGE" as const, value: { url, mimeType: "image/jpeg" } }))], data.value.h3Prompt, isZealmanU06.value ? zealmanOptions.value?.voices ?? [] : undefined, referenceMentions.value));
watch(() => isH3Prompt.value ? h3ReferenceList.value.map(item => ({ ...item })) : undefined, (references, previous) => {
  if (!references) return;
  if (previous?.length === references.length && references.every((item, index) => item.id === previous[index].id && item.value === previous[index].value)) return;
  const prompt = reconcileH3References(data.value.prompt, references, data.value.h3Prompt, previous);
  if (prompt !== data.value.prompt) {
    data.value.prompt = prompt;
    data.value.promptModel = prompt.split("\n").map(text => [{ type: "Write", text }]);
  }
}, { immediate: true });
const h3MaxDuration = computed(() => isZealmanU06.value ? zealmanOptions.value?.maxDuration ?? 30 : Math.max(1, ...(selectedModel.value?.durationResolutionMap ?? []).flatMap(item => item.duration)));
const ratioOptions = computed(() => selectedModel.value?.videoRatios?.length ? selectedModel.value.videoRatios : defaultRatios);
const selectedMode = computed(() => selectedModel.value?.mode?.find((item) => JSON.stringify(item) === data.value.mode) as NodeVideoRequest["mode"]);
const frameMode = computed(() => ["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(String(selectedMode.value)));
const mediaCounts = computed(() => ({
  image: refList.value.filter((item) => item.dataType === "IMAGE").length,
  video: refList.value.filter((item) => item.dataType === "VIDEO").length,
  audio: refList.value.filter((item) => item.dataType === "AUDIO").length + (isZealmanU06.value ? data.value.h3Prompt.voices.length : 0),
}));
const matchingModes = computed(() => getMatchingModes(selectedModel.value));

function zealmanDefaults(options: ZealmanOptions) {
  const defaults = options.defaults;
  return { modelKey: defaults.modelKey, clipKey: defaults.clipKey, loraKey: defaults.loraKey, loraStrength: defaults.loraStrength,
    extraLoraKey: defaults.extraLoraKey, extraLoraStrength: defaults.extraLoraStrength, accelerated: true,
    steps: options.acceleratedSteps, upscale: options.rtxSupported, forceVramCleanupBeforeVae: defaults.forceVramCleanupBeforeVae };
}

async function ensureZealmanOptions(refresh = false) {
  zealmanLoading.value = true;
  zealmanError.value = "";
  try {
    const options = await loadZealmanOptions(refresh);
    if (disposed || !isZealmanU06.value) return options;
    zealmanOptions.value = options;
    const initial = Object.keys(data.value.zealmanSettings).length === 0;
    data.value.zealmanSettings = { ...zealmanDefaults(options), ...data.value.zealmanSettings };
    if (initial) { data.value.ratio = "16:9"; data.value.resolution = "0.98MP"; data.value.duration = options.defaults.duration; }
    return options;
  } catch (error) {
    if (!disposed) zealmanError.value = error instanceof Error ? error.message : "读取 U06 面板选项失败";
    throw error;
  } finally { if (!disposed) zealmanLoading.value = false; }
}
watch(isZealmanU06, value => { if (value) void ensureZealmanOptions().catch(() => { /* 设置区显示读取错误，允许手动刷新。 */ }); });

function referenceUrls(choice?: NodeMediaModel) {
  return choice?.referenceImageInput === "url" ? data.value.referenceImageUrlsText.split(/\r?\n/).map(value => value.trim()).filter(Boolean) : [];
}

function validateReferenceUrls(urls: string[]) {
  if (urls.length > 9) throw new Error("最多使用 9 张参考图片");
  for (const value of urls) {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("每行须填写一个有效的 HTTPS 图片直链"); }
    if (value.length > 8192 || url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("参考图须为不含账号密码或片段的公网 HTTPS 图片直链");
  }
}

function getMatchingModes(choice?: NodeMediaModel, urls = referenceUrls(choice)) {
  const counts = { ...mediaCounts.value, image: mediaCounts.value.image + urls.length };
  return (choice?.mode ?? []).filter((mode) => {
    const { image, video, audio } = counts;
    if (Array.isArray(mode)) return image + video + audio > 0 && Object.entries(counts).every(([type, count]) =>
      count <= Number(mode.find((item) => item.startsWith(`${type}Reference:`))?.split(":")[1] ?? 0)
    );
    if (mode === "text") return image + video + audio === 0;
    if (video || audio) return false;
    if (mode === "singleImage") return image === 1;
    if (mode === "startEndRequired") return image === 2;
    return ["endFrameOptional", "startFrameOptional"].includes(mode) && image >= 1 && image <= 2;
  });
}

function getDurations(choice: NodeMediaModel) {
  return [...new Set((choice.durationResolutionMap ?? []).flatMap((item) => item.duration))].sort((a, b) => a - b);
}

function getResolutions(choice: NodeMediaModel, duration?: number) {
  // ACT: 当前视频分辨率使用 p 单位；出现其他单位时再统一换算。
  return [...new Set((choice.durationResolutionMap ?? []).filter((item) => item.duration.includes(duration!)).flatMap((item) => item.resolution))]
    .sort((left, right) => (Number.parseFloat(left) || Infinity) - (Number.parseFloat(right) || Infinity));
}
// ACT: 引用改变时只替换不适用的模式；普通媒体优先作为参考，避免自动变成首尾帧。
watch([selectedModel, matchingModes, () => data.value.mode], ([choice, matches]) => {
  if (!choice || matches.some((item) => JSON.stringify(item) === data.value.mode)) return;
  const modes = choice.mode ?? [];
  const mode = matches.find(Array.isArray) ?? matches.find((item) => item === "singleImage")
    ?? matches.find((item) => item === "endFrameOptional") ?? matches[0]
    ?? modes.find((item) => JSON.stringify(item) === data.value.mode) ?? modes.find(Array.isArray) ?? modes[0];
  data.value.mode = mode === undefined ? "" : JSON.stringify(mode);
}, { flush: "sync" });
// ACT: 参数在节点内归一化，未选中、未挂载底部设置时也可由 Agent 直接生成。
watch([selectedModel, () => data.value.duration], ([choice]) => {
  if (!choice) return;
  if (choice.providerId === "zealmanH3" && choice.modelId === "u06") return;
  const durations = getDurations(choice);
  if (!durations.includes(data.value.duration!)) data.value.duration = durations.includes(choice.defaultDuration!) ? choice.defaultDuration : durations[0];
  const resolutions = getResolutions(choice, data.value.duration);
  if (!resolutions.includes(data.value.resolution)) data.value.resolution = resolutions.includes(choice.defaultResolution!) ? choice.defaultResolution! : resolutions[0] ?? "";
  if (!ratioOptions.value.includes(data.value.ratio)) data.value.ratio = ratioOptions.value.includes("9:16") ? "9:16" : ratioOptions.value[0]!;
  if (choice.audio !== "optional") data.value.generateAudio = choice.audio === true;
}, { flush: "sync" });
const generationPrompt = computed(() => {
  const prompt = [
    selectedModel.value?.taskRecovery ? data.value.prompt : data.value.prompt.trim(),
    ...refList.value.flatMap((item, index) => (item.dataType === "STRING" && item.value?.trim() ? [`参考 ${index + 1}：\n${item.value.trim()}`] : [])),
  ]
    .filter(Boolean)
    .join("\n\n");
  return isH3Prompt.value ? h3GenerationPrompt(prompt, h3ReferenceList.value, data.value.h3Prompt) : prompt;
});

const reviewPanelVisible = ref(false);
const reviewInput = computed<PromptReviewInput>(() => ({
  content: generationPrompt.value,
  editorPrompt: data.value.prompt,
  context: ["审查范围：当前视频节点的编辑稿。未提供图片、视频或音频的实际内容，只核对可见文字及素材约束。",
    `生成模型：${selectedModel.value?.label ?? '未选择'}；画幅：${data.value.ratio}；生成声音：${selectedModel.value?.audio === 'optional' ? data.value.generateAudio : selectedModel.value?.audio === true}。`,
    `素材数量：图片 ${mediaCounts.value.image}，视频 ${mediaCounts.value.video}，音频 ${mediaCounts.value.audio}。`,
    ...(isH3Prompt.value ? [`引用名称与标签：${JSON.stringify(h3ReferenceList.value.map(item => ({ name: item.name, tag: item.value, category: item.category })))}`] : []),
    "CameraPreset 运镜标签由后端展开，本次未提供其隐藏指令，不推断隐藏内容；后端可能继续优化提示词。"].join("\n"),
  ...(data.value.duration ? { durationSeconds: data.value.duration } : {}),
  dependencies: JSON.stringify({ model: data.value.model, mode: data.value.mode, resolution: data.value.resolution,
    referenceImageUrlsText: data.value.referenceImageUrlsText, references: refList.value.map(item => ({ source: item.source, sourceHandle: item.sourceHandle, dataType: item.dataType, value: item.value })),
    voices: data.value.h3Prompt.voices }),
}));
const { record: reviewRecord, run: reviewRun, current: reviewCurrent, reviewing, status: reviewStatus, label: reviewLabel, error: reviewError,
  review: reviewPrompt, reviewAutomatically: reviewPromptAutomatically, cancel: cancelPromptReview, submission: promptReviewSubmission } = usePromptReview({
    input: () => reviewInput.value, record: () => data.value.promptReview, save: record => { data.value.promptReview = record; },
    run: () => data.value.promptReviewRun, saveRun: run => { data.value.promptReviewRun = run; },
    editable: () => reviewEditable.value, apply: setReviewPrompt,
  });
const reviewEditable = computed(() => !deleting.value && !uploadingReferences.value && !zealmanEnqueuing.value && (isZealmanU06.value || !generating.value && !pendingTask.value));

function openPromptReview(oneClick = false) {
  reviewPanelVisible.value = true;
  if (oneClick) void reviewPromptAutomatically().catch(() => {});
}

function setReviewPrompt(prompt: string) {
  data.value.prompt = prompt;
  data.value.promptModel = prompt.split("\n").map(text => [{ type: "Write", text }]);
}

function getPromptReviewState() {
  return { status: reviewStatus.value, label: reviewLabel.value, current: reviewCurrent.value, error: reviewError.value || undefined,
    record: reviewRecord.value, run: reviewRun.value };
}

async function applyReviewEdits(edits: PromptReviewEdit[]) {
  try {
    if (!reviewCurrent.value || !reviewRecord.value || !reviewEditable.value || reviewing.value) throw new Error("当前编辑稿已变化或正在处理，请稍后核对并重新审查");
    const input = reviewRecord.value.input;
    const prompt = applyPromptReviewEdits(input, edits);
    await ElMessageBox.confirm("将采用详情中展示的这组局部修改。请确认符合创作意图，采用后审查状态会变为待重审。", "确认修改提示词", { confirmButtonText: "采用修改", cancelButtonText: "保留原文", type: "warning" });
    if (!reviewCurrent.value || !reviewEditable.value || reviewing.value || !samePromptReviewInput(input, reviewInput.value)) throw new Error("确认期间编辑稿已变化，请重新核对修改建议");
    setReviewPrompt(prompt);
  } catch (failure) {
    if (failure !== "cancel" && failure !== "close") ElMessage.warning(failure instanceof Error ? failure.message : "未能采用修改，请手动修改提示词");
  }
}

function removeReference(item: NodeInputValue) {
  if (uploadingReferences.value) return;
  data.value.h3Prompt.attachments = data.value.h3Prompt.attachments.filter(attachment => (attachment.source ?? `h3:${attachment.id}`) !== item.source || (attachment.sourceHandle ?? "out") !== item.sourceHandle);
  disconnectReference(item);
}
function removeH3Reference(item: H3Reference) {
  if (uploadingReferences.value || deleting.value || zealmanEnqueuing.value) return;
  if (item.id.startsWith("voice:")) data.value.h3Prompt.voices = data.value.h3Prompt.voices.filter(path => `voice:${path}` !== item.id);
  else if (h3ReferenceGroup(item).endsWith(":url")) data.value.referenceImageUrlsText = referenceUrls(selectedModel.value).filter(url => `url:${url}` !== item.input!.source).join("\n");
  else if (item.input) removeReference(item.input);
}
function swapH3References(first: H3Reference, second: H3Reference) {
  if (uploadingReferences.value || deleting.value || zealmanEnqueuing.value) return;
  const current = h3ReferenceList.value;
  const left = current.find(item => item.id === first.id);
  const right = current.find(item => item.id === second.id);
  if (!left || !right || left.category === "text" || left.id === right.id || h3ReferenceGroup(left) !== h3ReferenceGroup(right)) return;
  if (left.id.startsWith("voice:")) {
    const voices = [...data.value.h3Prompt.voices];
    const from = voices.indexOf(left.id.slice(6));
    const to = voices.indexOf(right.id.slice(6));
    if (from < 0 || to < 0) return;
    [voices[from], voices[to]] = [voices[to], voices[from]];
    data.value.h3Prompt.voices = voices;
  } else if (h3ReferenceGroup(left).endsWith(":url")) {
    const urls = referenceUrls(selectedModel.value);
    const from = urls.findIndex(url => `url:${url}` === left.input!.source);
    const to = urls.findIndex(url => `url:${url}` === right.input!.source);
    if (from < 0 || to < 0) return;
    [urls[from], urls[to]] = [urls[to], urls[from]];
    data.value.referenceImageUrlsText = urls.join("\n");
  } else {
    const items = [...refList.value];
    const from = items.findIndex(item => referenceKey(item) === left.id);
    const to = items.findIndex(item => referenceKey(item) === right.id);
    if (from < 0 || to < 0) return;
    [items[from], items[to]] = [items[to], items[from]];
    refList.value = items;
  }
}
function clearReferences() {
  for (const item of [...refList.value]) removeReference(item);
  data.value.h3Prompt.voices = [];
  data.value.h3Prompt.audioBindings = {};
  data.value.referenceImageUrlsText = "";
}
async function validateReferenceFiles(uploads: { type: string; size: number }[], replacement?: H3Reference) {
  const limits = Object.fromEntries(["image", "video", "audio"].map(type => [type, Math.max(0, ...(selectedModel.value?.mode ?? []).filter(Array.isArray).flat().filter(item => item.startsWith(type + "Reference:")).map(item => Number(item.split(":")[1])))])) as Record<"image" | "video" | "audio", number>;
  const counts = { ...mediaCounts.value, image: mediaCounts.value.image + referenceUrls(selectedModel.value).length };
  if (replacement) counts[replacement.category === "picture" ? "image" : replacement.category as "video" | "audio"]--;
  for (const file of uploads) {
    const kind = file.type.split("/")[0];
    if (!["image", "video", "audio"].includes(kind) || !limits[kind as keyof typeof limits] || replacement && kind !== (replacement.category === "picture" ? "image" : replacement.category)) throw new Error("当前模型或替换位置不支持此素材类型");
    if (++counts[kind as keyof typeof counts] > limits[kind as keyof typeof limits]) throw new Error("参考素材超过当前模型的数量上限");
  }
  const references = refList.value.filter(item => typeof item.dataType === "string" && ["IMAGE", "VIDEO", "AUDIO"].includes(item.dataType) && (!replacement?.input || item.source !== replacement.input.source || item.sourceHandle !== replacement.input.sourceHandle)).map(item => ({ path: (item.value as { url: string }).url, mimeType: (item.value as { mimeType: string }).mimeType, mediaType: String(item.dataType).toLowerCase() }));
  await validateReferenceSelection(files.getWorkspaceDirectory(), references, uploads);
}

async function importPanelReferences(source: "input" | "output", items: ZealmanAsset[], signal: AbortSignal) {
  if (uploadingReferences.value || deleting.value) throw new Error("节点正在处理，请稍后导入素材");
  await validateReferenceFiles(items.map(item => ({ type: item.mimeType, size: item.size })));
  const directory = files.getWorkspaceDirectory();
  uploadingReferences.value = true;
  try {
    for (const item of items) {
      signal.throwIfAborted();
      const response = await fetch(zealmanAssetUrl(source, item.path), { signal });
      if (!response.ok) { const result = await response.json(); throw new Error(result.message || "面板素材下载失败"); }
      const blob = await response.blob();
      signal.throwIfAborted();
      if (disposed || directory !== files.getWorkspaceDirectory()) throw new Error("工作区已切换，导入已停止");
      const mimeType = blob.type.split(";")[0];
      const file = new File([blob], item.name, { type: mimeType });
      await validateReferenceFiles([file]);
      const path = await files.uploadFile(file);
      signal.throwIfAborted();
      if (disposed || directory !== files.getWorkspaceDirectory()) throw new Error("工作区已切换，导入已停止");
      data.value.h3Prompt.attachments.push({ id: crypto.randomUUID(), name: item.name, dataType: mimeType.split("/")[0].toUpperCase() as "IMAGE" | "VIDEO" | "AUDIO", value: { url: path, mimeType } });
    }
  } finally { uploadingReferences.value = false; }
}

function uploadReferences(replacement?: H3Reference) {
  if (uploadingReferences.value || deleting.value) return;
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = !replacement;
  const limits = Object.fromEntries(["image", "video", "audio"].map(type => [type, Math.max(0, ...(selectedModel.value?.mode ?? []).filter(Array.isArray).flat().filter(item => item.startsWith(type + "Reference:")).map(item => Number(item.split(":")[1])))])) as Record<"image" | "video" | "audio", number>;
  input.accept = replacement ? `${replacement.category === "picture" ? "image" : replacement.category}/*` : Object.entries(limits).filter(([, count]) => count).map(([kind]) => `${kind}/*`).join(",");
  const directory = files.getWorkspaceDirectory();
  const model = data.value.model;
  input.onchange = async () => {
    uploadingReferences.value = true;
    try {
      const uploads = Array.from(input.files ?? []);
      await validateReferenceFiles(uploads, replacement);
      for (const file of uploads) {
        if (disposed || directory !== files.getWorkspaceDirectory() || model !== data.value.model) throw new Error("工作区或模型已切换，上传已停止");
        const path = await files.uploadFile(file);
        if (disposed || directory !== files.getWorkspaceDirectory() || model !== data.value.model) return;
        const local = replacement?.input && data.value.h3Prompt.attachments.find(item => (item.source ?? `h3:${item.id}`) === replacement.input!.source && (item.sourceHandle ?? "out") === replacement.input!.sourceHandle);
        if (local) { local.value = { url: path, mimeType: file.type }; local.name = file.name; }
        else {
          const attachment = { id: crypto.randomUUID(), name: file.name, dataType: file.type.split("/")[0].toUpperCase() as "IMAGE" | "VIDEO" | "AUDIO", value: { url: path, mimeType: file.type }, source: replacement?.input?.source, sourceHandle: replacement?.input?.sourceHandle };
          data.value.h3Prompt.attachments.push(attachment);
          if (replacement?.input) {
            if (replacement.input.source.startsWith("url:")) data.value.referenceImageUrlsText = referenceUrls(selectedModel.value).filter(url => `url:${url}` !== replacement.input!.source).join("\n");
            disconnectReference(replacement.input);
          }
        }
      }
    } catch (cause) { showNodeError(cause, "参考素材上传失败"); }
    finally { uploadingReferences.value = false; }
  };
  input.click();
}
const outputFile = computed(() => outputs.value.video?.dataType === "VIDEO" ? outputs.value.video.value : undefined);
const mediaPreview = useMediaPreview(outputFile);
const previewUrl = mediaPreview.url;
const posterUrl = files.useFileUrl(outputFile, error => showNodeError(error, "视频封面读取失败"), true);
const mediaInfo = files.useMediaInfo(outputFile, error => showNodeError(error, "视频信息读取失败"));
watchEffect(() => { if (mediaInfo.value?.width && mediaInfo.value.height) videoWidth.value = Math.max(180, 240 * mediaInfo.value.width / mediaInfo.value.height); });
watchEffect(() => { retainPreview.value = taskRunning.value || uploading.value || !!player.value?.playing || !!player.value?.fullscreen || !!actions.value?.visible || !!actions.value?.processing; });

onMounted(async () => {
  try {
    await loadModels();
    await refreshVideoTask();
    if (pendingTask.value && videoTask.value && (videoTask.value.running || videoTask.value.taskId)) {
      resumeWhenReady = true;
      if (videoTask.value.running) pollVideoTask();
      else await resumeGeneration();
    }
  } catch (error) {
    taskStatusError.value = error instanceof Error ? error.message : "视频任务读取失败";
    showNodeError(error, "视频任务读取失败");
  }
  finally { taskChecking.value = false; }
});
onScopeDispose(() => {
  disposed = true;
  generationController?.abort();
  clearTimeout(taskTimer);
});



async function startGeneration() {
  if (uploadingReferences.value) throw new Error("请等待素材上传完成");
  if (zealmanEnqueuing.value) throw new Error("正在加入队列，请稍候");
  const shouldResume = pendingTask.value && !isZealmanU06.value;
  if (!generating.value) await refreshVideoTask();
  // 保留点击时的恢复意图，原任务在刷新期间完成或失败也不能转成新生成。
  if (shouldResume || pendingTask.value && !isZealmanU06.value) return resumeGeneration();
  const choice = selectedModel.value;
  if (generating.value && !isZealmanU06.value) throw new Error("视频正在生成，请等待完成");
  if (uploading.value) throw new Error("视频正在替换，请等待完成");
  if (deleting.value) throw new Error("节点正在删除");
  if (!choice) throw new Error("请先选择视频模型");
  if (!generationPrompt.value) throw new Error("请输入生成提示词");
  if (isH3Prompt.value) {
    const cameraPresets = h3CameraTagLike.test(generationPrompt.value) ? await getCameraPresets().catch(() => undefined) : undefined;
    const issues = h3PromptIssues(generationPrompt.value, h3ReferenceList.value, data.value.duration ?? 10, cameraPresets).filter(issue => !issue.startsWith("分镜正文"));
    if (issues.length) throw new Error(issues.join("；"));
  } else if (h3CameraTagLike.test(generationPrompt.value)) throw new Error("运镜标签仅支持 H3 模型，请删除后再生成");
  if (isZealmanU06.value) {
    const options = await ensureZealmanOptions();
    validateZealmanSettings(data.value.zealmanSettings, options);
    if (!Number.isInteger(data.value.duration) || data.value.duration! < 1 || data.value.duration! > options.maxDuration) throw new Error(`时长须为 1～${options.maxDuration} 秒`);
    if (!options.ratios.includes(data.value.ratio) || !options.resolutions.some(value => `${value}MP` === data.value.resolution)) throw new Error("请选择有效的比例和分辨率");
    if (data.value.seed != null && data.value.seed < 0) throw new Error("U06 种子须为非负安全整数");
    if (/\{\{ref\s+\d+\}\}/.test(generationPrompt.value)) throw new Error("U06 提示词中存在无效引用，请重新选择图片或音频引用");
  }
  if (choice.supportsSeed === true && data.value.seed != null && (!Number.isSafeInteger(data.value.seed) || data.value.seed < 0)) throw new Error("seed 必须为 JavaScript 安全范围内的非负整数");
  if (refList.value.some(item => item.value === undefined)) throw new Error("引用节点暂无内容，请先补充引用内容");
  const images = refList.value.flatMap((item) => item.dataType === "IMAGE" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []);
  const referenceImageUrls = referenceUrls(choice);
  validateReferenceUrls(referenceImageUrls);
  const imageCount = images.length + referenceImageUrls.length;
  const frames = [...images, ...referenceImageUrls.map(url => ({ url }))];
  if (choice.minReferenceImages !== undefined && imageCount < choice.minReferenceImages) throw new Error(`当前模型至少需要 ${choice.minReferenceImages} 张参考图片`);
  if (choice.referenceImageInput === "url" && imageCount > 9) throw new Error("本地参考图与 HTTPS 链接合计最多 9 张");
  if (choice.mode?.length && !matchingModes.value.length) throw new Error("当前模型没有适合这些参考素材的生成模式，请更换模型或调整引用");
  const input: Omit<NodeVideoRequest, "directory"> = {
    providerId: choice.providerId,
    ...(choice.taskRecovery ? { operationId: crypto.randomUUID() } : {}),
    modelId: choice.modelId,
    prompt: generationPrompt.value,
    mode: selectedMode.value,
    duration: data.value.duration,
    resolution: data.value.resolution || undefined,
    ratio: data.value.ratio,
    generateAudio: choice.audio === "optional" ? data.value.generateAudio : choice.audio,
    ...(choice.supportsSeed === true && data.value.seed != null ? { seed: data.value.seed } : {}),
    ...(isZealmanU06.value ? { other: { ...JSON.parse(JSON.stringify(data.value.zealmanSettings)), voiceReferences: [...data.value.h3Prompt.voices] } } : {}),
    outputDirectory: `assets/${id}`,
    images: frameMode.value ? undefined : images,
    ...(choice.referenceImageInput === "url" && !frameMode.value ? { referenceImageUrls } : {}),
    firstFrame: frameMode.value && (selectedMode.value !== "startFrameOptional" || frames.length > 1) ? frames[0] : undefined,
    lastFrame: frameMode.value ? frames[selectedMode.value === "startFrameOptional" && frames.length === 1 ? 0 : 1] : undefined,
    videos: refList.value.flatMap((item) => item.dataType === "VIDEO" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []),
    audios: refList.value.flatMap((item) => item.dataType === "AUDIO" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []),
  };
  const reviewAtSubmission = promptReviewSubmission();
  if (isZealmanU06.value) {
    if (zealmanEnqueuing.value) throw new Error("正在加入队列，请稍候");
    const limit = zealmanOptions.value!.queueLimit;
    if (data.value.zealmanQueue.length >= limit) throw new Error(`U06 队列最多保存 ${limit} 条任务`);
    zealmanEnqueuing.value = true;
    try {
      const workspaceFiles = files.getWorkspaceFiles();
      const originalDirectory = files.getWorkspaceDirectory();
      if (input.videos?.length) {
        if (!workspaceFiles.getMediaInfo) throw new Error("当前应用未提供视频尺寸读取能力，请更新 Toonflow 后再使用视频参考");
        const sizes = await Promise.all(input.videos.map(video => workspaceFiles.getMediaInfo!(video.path!)));
        if (sizes.some(info => !info.width || !info.height)) throw new Error("无法读取参考视频尺寸，请检查文件");
        input.other = { ...input.other, videoReferenceSizes: sizes.map(info => ({ width: info.width!, height: info.height! })) };
      }
      const { directory } = await workspaceFiles.list();
      if (disposed || deleting.value) throw new Error("节点已关闭或正在删除");
      if (originalDirectory !== files.getWorkspaceDirectory()) throw new Error("工作区已切换，任务没有加入队列");
      const saved = JSON.parse(JSON.stringify({ ...input, directory })) as NodeVideoRequest;
      data.value.zealmanQueue.push({ input: saved, title: `${saved.duration} 秒 · ${saved.prompt.replace(/\s+/g, " ").slice(0, 50)}`, promptReview: reviewAtSubmission });
      if (!generating.value && !pendingTask.value && data.value.zealmanQueue.length === 1) { queuePaused = false; await runNextZealmanTask(); }
      return { status: "queued", count: data.value.zealmanQueue.length };
    } finally { zealmanEnqueuing.value = false; }
  }
  const { directory } = await files.getWorkspaceFiles().list();
  data.value.submittedPromptReview = reviewAtSubmission;
  return runVideoInput({ ...input, directory }, choice.taskRecovery === true);
}

function runVideoInput(input: NodeVideoRequest, taskRecovery: boolean) {
  if (disposed || deleting.value) throw new Error("节点已关闭或正在删除");
  if (generating.value) throw new Error("视频正在生成，请等待完成");
  const controller = new AbortController();
  const queued = data.value.zealmanQueue.some(item => item.input.operationId === input.operationId);
  if (queued) activeQueueId.value = input.operationId!;
  taskWorkspaceDirectory = input.directory;
  let succeeded = false;
  generationController = controller;
  if (taskRecovery) pollVideoTask();
  // ACT: 工具立即返回，任务由节点持有，停止或卸载时取消。
  generation = generationState.run(() => ai.generateVideo(input, controller.signal)
    .then(([result]) => {
      controller.signal.throwIfAborted();
      if (!result) throw new Error("供应商未返回视频");
      outputs.value.video = { dataType: "VIDEO", value: { url: result.path, mimeType: result.mimeType } };
      if (input.operationId) data.value.appliedVideoTaskId = input.operationId;
      succeeded = true;
    }), { operationId: input.operationId })
    .catch((error) => showNodeError(error, "视频生成失败"))
    .finally(async () => {
      generationController = undefined;
      clearTimeout(taskTimer);
      if (disposed) return;
      if (!succeeded && queued) queuePaused = true;
      try {
        if (taskRecovery) await refreshVideoTask();
        if (queued && succeeded) data.value.zealmanQueue = data.value.zealmanQueue.filter(item => item.input.operationId !== input.operationId);
        activeQueueId.value = "";
        if (queued && !queuePaused && !pendingTask.value) await runNextZealmanTask();
      } catch (error) { activeQueueId.value = ""; queuePaused = true; taskStatusError.value = error instanceof Error ? error.message : "队列已暂停"; }
    });
  return { status: "generating" };
}

async function runNextZealmanTask() {
  if (disposed || deleting.value || generating.value || pendingTask.value || activeQueueId.value || queuePaused) return;
  const next = data.value.zealmanQueue[0];
  if (!next) return;
  activeQueueId.value = next.input.operationId!;
  try {
    const { directory } = await files.getWorkspaceFiles().list();
    if (directory !== next.input.directory || next.input.outputDirectory !== `assets/${id}`) throw new Error("队列属于原工作区或原节点，请移除旧条目后重新加入");
    if (!disposed && !deleting.value && !generating.value && !pendingTask.value && !queuePaused) runVideoInput(next.input, true);
  } catch (error) { queuePaused = true; throw error; }
  finally { if (!generating.value) activeQueueId.value = ""; }
}

async function continueZealmanQueue() {
  await refreshVideoTask();
  queuePaused = false;
  if (pendingTask.value) return resumeGeneration();
  return runNextZealmanTask();
}

async function refreshVideoTask() {
  const directory = taskWorkspaceDirectory ||= files.getWorkspaceDirectory();
  const task = await ai.getVideoTask({ directory, outputDirectory: `assets/${id}` });
  if (disposed) return;
  videoTask.value = task;
  if (task) generationState.syncTask(task);
  if (task && ["completed", "failed"].includes(task.phase)) data.value.zealmanQueue = data.value.zealmanQueue.filter(item => item.input.operationId !== task.operationId);
  taskStatusError.value = "";
  if (task?.phase === "completed" && task.operationId !== data.value.appliedVideoTaskId) {
    const result = task.result?.[0];
    if (result) {
      outputs.value.video = { dataType: "VIDEO", value: { url: result.path, mimeType: result.mimeType } };
      data.value.appliedVideoTaskId = task.operationId;
    }
  }
  if (task?.running && !generating.value) pollVideoTask();
}

function pollVideoTask() {
  clearTimeout(taskTimer);
  taskTimer = setTimeout(async () => {
    try { await refreshVideoTask(); }
    catch (error) { if (!disposed) taskStatusError.value = error instanceof Error ? error.message : "进度查询暂时不可用，原任务仍保留"; }
    if (disposed) return;
    if (!pendingTask.value) {
      const wasResuming = resumeWhenReady;
      resumeWhenReady = false;
      if (videoTask.value?.phase === "failed") queuePaused = true;
      if (wasResuming && !generating.value && !queuePaused) {
        try { await runNextZealmanTask(); }
        catch (error) { taskStatusError.value = error instanceof Error ? error.message : "恢复队列失败"; }
      }
    }
    if (resumeWhenReady && !generating.value && !videoTask.value?.running) {
      try { await resumeGeneration(); }
      catch (error) { taskStatusError.value = error instanceof Error ? error.message : "恢复暂时不可用，请手动恢复原任务"; resumeWhenReady = false; }
    } else if (generating.value || videoTask.value?.running) pollVideoTask();
  }, 5000);
}

async function resumeGeneration() {
  if (generating.value) throw new Error("视频任务仍在等待，请勿重复恢复");
  const task = videoTask.value;
  if (!task) throw new Error("没有可恢复的视频任务");
  if (task.running) { resumeWhenReady = true; pollVideoTask(); return { status: "generating" }; }
  if (submissionUnconfirmed.value) throw new Error("提交结果尚未确认且没有任务编号，请到视频专栏核查；可在新节点继续，原任务会保留");
  resumeWhenReady = false;
  const directory = taskWorkspaceDirectory || files.getWorkspaceDirectory();
  const controller = new AbortController();
  generationController = controller;
  pollVideoTask();
  generation = generationState.run(() => ai.resumeVideoTask({ directory, outputDirectory: `assets/${id}`, operationId: task.operationId }, controller.signal), { operationId: task.operationId, startedAt: task.startedAt })
    .then(([result]) => {
      if (!result || disposed) return;
      outputs.value.video = { dataType: "VIDEO", value: { url: result.path, mimeType: result.mimeType } };
      data.value.appliedVideoTaskId = task.operationId;
    })
    .catch(error => { queuePaused = true; showNodeError(error, "原视频任务恢复中断"); })
    .finally(async () => {
      generationController = undefined;
      clearTimeout(taskTimer);
      if (disposed) return;
      try { await refreshVideoTask(); if (!queuePaused && !pendingTask.value) await runNextZealmanTask(); }
      catch (error) { queuePaused = true; taskStatusError.value = error instanceof Error ? error.message : "恢复队列失败"; }
    });
  return { status: "generating" };
}

function stopGeneration() {
  queuePaused = true;
  resumeWhenReady = false;
  generationController?.abort();
}

async function createNewGeneration() {
  if (!duplicateCanvasNode) throw new Error("当前画布不支持创建副本");
  if (disposed || deleting.value) throw new Error("节点已关闭或正在删除");
  if (creatingGeneration.value || uploadingReferences.value) throw new Error("节点正在处理，请稍后创建");
  creatingGeneration.value = true;
  try {
    const nodeId = await duplicateCanvasNode(id, {
      outputs: {},
      generationTiming: undefined,
      appliedVideoTaskId: undefined,
      submittedPromptReview: undefined,
      zealmanQueue: [],
    });
    return { status: "ready", nodeId, message: "已保留原节点和任务，新节点可编辑并生成；尚未提交新的视频生成" };
  } finally {
    creatingGeneration.value = false;
  }
}

nodeEvent.on("save", (reason) => {
  if (reason === "reload" && (generating.value || uploading.value || deleting.value || uploadingReferences.value)) throw new Error("视频处理中，请完成后再刷新节点");
});
nodeEvent.on("delete", async () => {
  if (generating.value) throw new Error("请先停止等待再删除节点；已经提交的生成任务和素材记录会保留");
  if (uploading.value || uploadingReferences.value) throw new Error("素材正在处理，请完成后再删除节点");
  deleting.value = true;
  cancelPromptReview();
  stopGeneration();
  try {
    await generation;
    await files.removeNodeFiles();
  } finally {
    deleting.value = false;
  }
});

async function resizeVideo(event: Event) {
  const video = event.currentTarget as HTMLVideoElement;
  if (!video.videoWidth || !video.videoHeight) return;
  videoWidth.value = Math.max(180, (240 * video.videoWidth) / video.videoHeight);
  await nextTick();
  updateNodeInternals();
}

async function getConfig() {
  if (isZealmanU06.value) await ensureZealmanOptions();
  return {
    config: {
      providerId: selectedModel.value?.providerId ?? "",
      modelId: selectedModel.value?.modelId ?? "",
      duration: data.value.duration,
      resolution: data.value.resolution,
      ratio: data.value.ratio,
      mode: selectedMode.value,
      generateAudio: data.value.generateAudio,
      seed: data.value.seed ?? null,
      ...(isZealmanU06.value ? { other: { ...data.value.zealmanSettings, voiceReferences: data.value.h3Prompt.voices }, queueLength: data.value.zealmanQueue.length } : {}),
      ...(isH3Prompt.value ? { subjects: data.value.h3Prompt.subjects, audioBindings: data.value.h3Prompt.audioBindings, references: h3ReferenceList.value.map(item => ({
        id: item.id, label: item.name, tag: item.value, sourceNodeId: item.input?.source,
        assetIdentity: item.input ? findNode(item.input.source)?.data.assetIdentity : undefined,
      })) } : {}),
      referenceImageUrls: referenceUrls(selectedModel.value),
    },
    models: models.value,
    cameraLibrary: { supported: isH3Prompt.value, queryTool: "node:getCameraPresets" },
    ...(isZealmanU06.value ? { videoOptions: zealmanOptions.value } : {}),
    ratios: ratioOptions.value,
    matchingModes: matchingModes.value,
  };
}

nodeTools.register({
  name: "getCameraPresets",
  description: "读取当前账户真实可用的运镜库，返回每项 id、name 和可直接写入提示词的 tag（{{CameraPreset ID}}），无需先选择模型。向用户展示 name；使用前通过 getConfig 确认 cameraLibrary.supported 为 true，按名称选择并用 setPrompt 将原样 tag 放入 detailed_description 对应镜头。目录为空或读取失败时如实说明，不猜 ID，不获取或展开服务端私有运镜提示词；查询和写入提示词均不启动视频生成",
  parameters: z.strictObject({}),
  execute(_args, { signal }) {
    return getCameraPresets(signal);
  },
});

nodeTools.register({
  name: "reviewPrompt",
  description: "仅对当前视频节点编辑稿做一次辅助审查，不修改原文、不启动视频生成，按文本模型用量计费。用户要求「AI 一键审查」或自动修改并复审时使用 autoReviewPrompt。返回 reviewing 后可继续其他工作，按需用 getPromptReview 查询报告；同一内容已有有效报告时复用，force=true 会重新计费审查。审查失败或未通过不妨碍生成、排队和恢复原任务，不循环重试",
  parameters: z.strictObject({ force: z.boolean().optional() }),
  execute({ force }) {
    if (deleting.value) throw new Error("节点正在删除，请稍后审查");
    void reviewPrompt(force).catch(() => {});
    return getPromptReviewState();
  },
});
nodeTools.register({
  name: "autoReviewPrompt",
  description: "执行视频节点「AI 一键审查」：仅在用户要求一键审查或自动修改并复审时使用，最多 3 轮审查，每轮按文本模型用量计费。自动采用报告中可安全应用的局部修改并复审；遇到创作意图待确认、修改无法安全定位、编辑稿变化或请求失败即停止，不自动重试。保留原稿、修改和每轮报告，审查通过后隐藏按钮。不启动视频生成、不阻塞生成或队列。立即返回状态，按需用 getPromptReview 查看轮次、报告和停止原因；不得循环调用或查询，取消用 cancelPromptReview",
  parameters: z.strictObject({}),
  execute() {
    if (deleting.value) throw new Error("节点正在删除，请稍后审查");
    void reviewPromptAutomatically().catch(() => {});
    return getPromptReviewState();
  },
});
nodeTools.register({
  name: "getPromptReview",
  description: "按需读取当前编辑稿的辅助审查状态、报告及原文快照，run 包含多轮审查的原稿、逐轮报告、已采用的修改和停止原因。current=false 表示当前报告已失效；未发现文字问题也不保证生成效果。reviewing 时继续其他工作，不循环查询，不会启动审查或视频生成",
  parameters: z.strictObject({}),
  execute: getPromptReviewState,
});
nodeTools.register({
  name: "cancelPromptReview",
  description: "用户要求停止审查时，停止本节点单次或多轮审查的本地等待及后续自动修改，保留已完成的修改和报告；已发出的请求可能产生费用。不会停止视频生成或队列",
  parameters: z.strictObject({}),
  execute() { cancelPromptReview(); return getPromptReviewState(); },
});

registerGenerationTools({
  configDescription: "读取视频节点配置、模型能力、比例、引用模式和运镜库支持状态 cameraLibrary，不含密钥；运镜目录使用 getCameraPresets 查询。U06 另返回面板 videoOptions（主模型、CLIP、LoRA、默认值和时长限制），专属参数位于 config.other",
  promptDescription: "修改此节点的视频生成提示词，支持 {{ref 1}} 等参考标记；cameraLibrary.supported 为 true 时可使用运镜库，先用 getCameraPresets 查询并逐字保留返回的 tag，放在 detailed_description 对应镜头中，不猜测 ID 或展开私有提示词；只修改提示词，不启动生成",
  loadModels, getConfig,
  setPrompt(value) {
    if (deleting.value) throw new Error("节点正在删除，请稍后修改");
    if (!isZealmanU06.value && (generating.value || pendingTask.value)) throw new Error("节点存在未完成任务，请先查询或恢复原视频任务；其他创作可使用 createNewGeneration");
    setReviewPrompt(value);
  },
  updateDescription: "修改视频配置，不启动生成。H3 的 subjects 使用 getConfig 返回的 references.id 绑定主体；同一人物的多个形态放在同一主体，referenceNotes 按引用 id 写清每个形态适用的镜头和状态。providerId 与 modelId 同时提供。seed 为非负安全整数，null 随机；U06 专属参数取自 videoOptions。mode 使用 matchingModes 原值，referenceImageUrls 须有实际能力支持",
  configSchema: z.strictObject({
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    duration: z.number().positive().optional(),
    resolution: z.string().min(1).optional(),
    ratio: z.string().regex(/^[1-9]\d{0,3}:[1-9]\d{0,3}$/).optional(),
    mode: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    generateAudio: z.boolean().optional(),
    seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
    other: z.strictObject({
      modelKey: z.string().min(1).optional(), clipKey: z.string().min(1).optional(), loraKey: z.string().min(1).optional(), extraLoraKey: z.string().min(1).optional(),
      loraStrength: z.number().min(0).max(2).optional(), extraLoraStrength: z.number().min(0).max(2).optional(),
      accelerated: z.boolean().optional(), steps: z.number().int().min(1).max(99).optional(), upscale: z.boolean().optional(), forceVramCleanupBeforeVae: z.boolean().optional(),
    }).optional(),
    referenceImageUrls: z.array(z.string().min(1).max(8192)).max(9).optional(),
    subjects: z.array(z.strictObject({
      id: z.number().int().min(1).max(128), name: z.string().trim().min(1).max(200),
      references: z.array(z.string().min(1).max(2048)).min(1).max(12),
      speaker: z.number().int().min(1).max(128).optional(),
      referenceNotes: z.record(z.string().min(1).max(2048), z.string().trim().min(1).max(1000)).optional(),
    })).max(32).optional(),
  }).refine((args) => (args.providerId === undefined) === (args.modelId === undefined), "providerId 与 modelId 必须同时提供"),
  async setConfig(args, signal) {
    signal?.throwIfAborted();
    if (generating.value || deleting.value || pendingTask.value || taskChecking.value || uploadingReferences.value || zealmanEnqueuing.value) throw new Error("节点正在处理或有待恢复任务，请稍后修改配置");
    await loadModels();
    signal?.throwIfAborted();
    if (generating.value || deleting.value || pendingTask.value || taskChecking.value || uploadingReferences.value || zealmanEnqueuing.value) throw new Error("节点正在处理或有待恢复任务，请稍后修改配置");
    const choice = args.modelId === undefined ? selectedModel.value
      : models.value.find((item) => item.providerId === args.providerId && item.modelId === args.modelId);
    if (!choice) throw new Error("请选择 getConfig 返回的有效视频模型");
    if (data.value.zealmanQueue.length && JSON.stringify([choice.providerId, choice.modelId]) !== data.value.model) throw new Error("请先完成或移除队列，再切换模型");
    const u06 = choice.providerId === "zealmanH3" && choice.modelId === "u06";
    if (args.other && !u06) throw new Error("当前模型不支持 U06 专属参数");
    if (u06 && args.seed != null && args.seed < 0) throw new Error("U06 种子须为非负安全整数");
    const options = u06 ? await loadZealmanOptions() : undefined;
    signal?.throwIfAborted();
    if (generating.value || deleting.value || pendingTask.value || taskChecking.value || uploadingReferences.value || zealmanEnqueuing.value) throw new Error("节点正在处理或有待恢复任务，请稍后修改配置");
    const initialU06 = options && Object.keys(data.value.zealmanSettings).length === 0;
    const other = options ? { ...zealmanDefaults(options), ...data.value.zealmanSettings, ...args.other } : undefined;
    if (options && other) {
      if (args.other?.accelerated !== undefined && args.other.steps === undefined) other.steps = args.other.accelerated ? options.acceleratedSteps : options.originalSteps;
      validateZealmanSettings(other, options);
    }
    if (args.seed != null && choice.supportsSeed !== true) throw new Error("当前模型不支持设置 seed，请查看 getConfig 返回的 supportsSeed 能力");
    if (args.referenceImageUrls?.length && choice.referenceImageInput !== "url") throw new Error("当前模型没有参考图链接输入，请使用画布素材连线");
    const urls = args.referenceImageUrls ?? referenceUrls(choice);
    validateReferenceUrls(urls);
    const ratios = choice.videoRatios?.length ? choice.videoRatios : defaultRatios;
    if (args.ratio !== undefined && !ratios.includes(args.ratio)) throw new Error(`当前模型不支持比例 ${args.ratio}，可选：${ratios.join("、")}`);
    const durations = options ? Array.from({ length: options.maxDuration }, (_, index) => index + 1) : getDurations(choice);
    if (args.duration !== undefined && !durations.includes(args.duration)) throw new Error(`当前模型不支持时长 ${args.duration}，可选：${durations.join("、")}`);
    const duration = args.duration ?? (initialU06 ? options.defaults.duration : durations.includes(data.value.duration!) ? data.value.duration : durations.includes(choice.defaultDuration!) ? choice.defaultDuration : durations[0]);
    const resolutions = options ? options.resolutions.map(value => `${value}MP`) : getResolutions(choice, duration);
    if (args.resolution !== undefined && !resolutions.includes(args.resolution)) throw new Error(`当前时长不支持分辨率 ${args.resolution}，可选：${resolutions.join("、")}`);
    const resolution = args.resolution ?? (initialU06 ? "0.98MP" : resolutions.includes(data.value.resolution) ? data.value.resolution : resolutions.includes(choice.defaultResolution!) ? choice.defaultResolution! : resolutions[0] ?? "");
    let mode = args.mode;
    if (typeof mode === "string" && mode.trim().startsWith("[")) {
      try { mode = z.array(z.string().min(1)).min(1).parse(JSON.parse(mode)); }
      catch { throw new Error("mode 数组格式无效，请使用 getConfig 返回的 matchingModes 中的原始值"); }
    }
    const modes = getMatchingModes(choice, urls);
    if (mode !== undefined && !modes.some(item => JSON.stringify(item) === JSON.stringify(mode))) throw new Error(`当前素材不支持所选 mode，可选：${modes.map(item => JSON.stringify(item)).join("、") || "无，请先调整参考素材"}`);
    if (args.generateAudio !== undefined && choice.audio !== "optional" && args.generateAudio !== (choice.audio === true)) throw new Error("当前模型不支持切换声音，请查看 getConfig 返回的 audio 能力");
    if (args.subjects) {
      if (!(choice.providerId === "yixianVideo" && choice.modelId.startsWith("yixian-h3-") || u06)) throw new Error("subjects 仅用于 H3 主体绑定");
      if (new Set(args.subjects.map(subject => subject.id)).size !== args.subjects.length) throw new Error("主体 id 不能重复");
      const references = new Map(h3ReferenceList.value.map(reference => [reference.id, reference]));
      const owners = new Set<string>();
      for (const subject of args.subjects) {
        for (const referenceId of subject.references) {
          const reference = references.get(referenceId);
          if (!reference || !["picture", "video"].includes(reference.category)) throw new Error("主体引用必须使用 getConfig 返回的真实图片或视频 references.id；空输出先等待素材就绪");
          if (owners.has(referenceId)) throw new Error("同一参考素材不能分配给多个不同主体");
          owners.add(referenceId);
        }
        if (Object.keys(subject.referenceNotes ?? {}).some(referenceId => !subject.references.includes(referenceId))) throw new Error("referenceNotes 只能说明该主体实际绑定的参考");
      }
    }
    data.value.model = JSON.stringify([choice.providerId, choice.modelId]);
    if (options && other) {
      zealmanOptions.value = options;
      data.value.zealmanSettings = other;
      if (initialU06) data.value.ratio = "16:9";
    }
    if (args.referenceImageUrls !== undefined) data.value.referenceImageUrlsText = args.referenceImageUrls.join("\n");
    data.value.duration = duration;
    data.value.resolution = resolution;
    if (args.ratio !== undefined) data.value.ratio = args.ratio;
    if (mode !== undefined) data.value.mode = JSON.stringify(mode);
    if (args.generateAudio !== undefined) data.value.generateAudio = args.generateAudio;
    if (args.seed !== undefined) data.value.seed = args.seed;
    if (args.subjects) data.value.h3Prompt.subjects = args.subjects;
    return getConfig();
  },
  generate: {
    name: "generateVideo",
    description: "启动此节点的后台视频生成，使用当前提示词、模型、模式、时长、分辨率、比例和参考素材；立即返回已开始，默认不轮询等待。提示词审查为可选辅助，无需先审查，审查失败或有问题也可生成。用户查询进度或后续需要结果时用 getGenerationStatus 查询，cancelGeneration 仅停止本地等待，不能保证取消远端任务或费用。有旧任务时恢复原任务；如用户要继续其他创作，可用 createNewGeneration 在新节点继续",
    execute: () => {
      if (generating.value && !isZealmanU06.value) return { status: "generating" };
      if (!pendingTask.value && isH3Prompt.value) {
        const prompt = generationPrompt.value;
        if (h3Sections.some(([key]) => !new RegExp(`(?:^|\\n)\\s*${key}\\s*:`).test(prompt))) throw new Error("AI 生成 H3 前须按已装载技能填写六段正文；不能把普通镜头描述当作已完成的 H3 提示词");
        const identities = new Map<string, { subjectId: number; references: string[] }>();
        for (const reference of h3ReferenceList.value.filter(item => item.category === "picture")) {
          if (!prompt.includes(reference.value)) throw new Error(`参考 ${reference.value} 尚未说明用途，请在提示词中绑定真实素材，不能只接连线`);
          const asset = assetIdentitySchema.safeParse(reference.input && findNode(reference.input.source)?.data.assetIdentity);
          if (!asset.success || asset.data.kind !== "character") continue;
          const subject = data.value.h3Prompt.subjects.find(subject => subject.references.includes(reference.id));
          if (!subject) throw new Error(`人物 ${asset.data.identity} 尚未绑定主体，请用 setConfig.subjects 绑定真实 references.id`);
          const previous = identities.get(asset.data.identity);
          if (previous && previous.subjectId !== subject.id) throw new Error(`人物 ${asset.data.identity} 的不同形态必须属于同一主体，不能拆成两个人`);
          identities.set(asset.data.identity, { subjectId: subject.id, references: [...previous?.references ?? [], reference.id] });
        }
        for (const [identity, binding] of identities) {
          const subject = data.value.h3Prompt.subjects.find(subject => subject.id === binding.subjectId)!;
          if (binding.references.length > 1 && binding.references.some(id => !subject.referenceNotes?.[id]?.trim())) throw new Error(`人物 ${identity} 引用了多张形态图，请用 subjects.referenceNotes 逐一说明适用镜头与状态`);
        }
      }
      return startGeneration();
    },
  },
});
if (duplicateCanvasNode) nodeTools.register({
  name: "createNewGeneration",
  description: "复制此视频节点的提示词、配置和输入参考连线到新节点，清空新节点的历史输出与任务状态。保留原节点和原任务，不提交视频生成；用户要继续其他创作而旧任务未完成时可用，然后在返回的新节点上编辑和生成",
  parameters: z.strictObject({}),
  execute(_args, { signal }) {
    signal?.throwIfAborted();
    return createNewGeneration();
  },
});
</script>

<style scoped lang="scss">
.promptReviewStatusRow {
  display: flex; min-width: 0; padding-top: 4px;
  :deep(.el-button) { max-width: 100%; margin: 0; }
  .reviewBadgeText { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
.promptReviewTools {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 8px 0;
  :deep(.el-button + .el-button) { margin-left: 0; }
  > span { color: var(--el-text-color-secondary); font-size: 12px; }
}
.videoContent {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 144px;
  overflow: hidden;
  border-radius: var(--el-border-radius-base);

  .videoEmpty {
    display: grid;
    place-items: center;
    min-height: 144px;
    color: var(--el-text-color-placeholder);
  }

  :deep(.el-loading-mask) {
    pointer-events: none;
  }

}

.promptCard {
  .queuedItems {
    display: grid; gap: 4px; margin-top: 10px; max-height: 160px; overflow-y: auto;
    .queuedItem { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--el-text-color-secondary); span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } }
  }
  .docked & {
    overflow: visible;
    :deep(> .el-card__body) { padding: 12px !important; }
    :deep(.promptInputWrap) { margin: 0 0 12px; padding: 10px; border: 1px solid var(--el-border-color-light); border-radius: 8px; }
    :deep(.chat-rich-text > [contenteditable]) { min-height: 120px !important; }
    .promptFooter {
      position: sticky;
      bottom: -12px;
      z-index: 2;
      padding: 8px 0;
      background: var(--el-bg-color-overlay);
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      .modelSelect { min-width: 0; width: 100%; }
      .generationActions { margin-left: 0; justify-content: space-between; gap: 8px; }
    }
  }
  .referenceHint {
    margin: 8px 0;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .promptFooter {
    display: flex;
    flex-wrap: wrap;
    align-items: stretch;
    justify-content: flex-start;
    gap: 10px;

    .generationActions { display: flex; flex: 0 1 auto; flex-wrap: wrap; margin-left: auto; justify-content: flex-end; align-items: stretch; gap: 8px; }

    .modelSelect {
      flex: 1 1 260px;
      min-width: min(260px, 100%);

      &:deep(.el-select__wrapper) {
        gap: 6px;
        min-height: 48px;
        height: 100%;
        padding: 6px 10px;
        box-shadow: 0 0 0 1px var(--el-border-color-lighter) inset;
        background: var(--el-fill-color-light);
      }
      :deep(.el-select__selection) { display: grid; grid-template-columns: minmax(0, 1fr); align-items: center; gap: 0; }
      :deep(.el-select__input-wrapper) { grid-area: 1 / 1; min-width: 0; }
      :deep(.el-select__placeholder) { grid-area: 1 / 1; position: static; transform: none; width: 100%; white-space: normal; }
      .modelLabel { display: grid; gap: 2px; min-width: 0; line-height: 1.35; }
      .providerName { color: var(--el-text-color-secondary); font-size: 11px; }
      .modelName { overflow-wrap: anywhere; color: var(--el-text-color-primary); font-size: 13px; }
    }

    .sendButton {
      min-width: 88px;
      min-height: 48px;
      height: auto;
      margin: 0;
      padding: 0 14px;
      --el-button-bg-color: var(--el-text-color-primary);
      --el-button-border-color: transparent;
      --el-button-text-color: var(--el-bg-color);
      --el-button-hover-bg-color: var(--el-text-color-regular);
      --el-button-hover-border-color: transparent;
      --el-button-hover-text-color: var(--el-bg-color);
    }
  }
  .taskStatus {
    margin-top: 10px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--el-text-color-secondary);
    overflow-wrap: anywhere;
    .taskError { color: var(--el-color-warning); }
  }
}
</style>
