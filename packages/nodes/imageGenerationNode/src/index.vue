<template>
  <nodeSkeleton
    v-bind="nodeProps"
    sideActions
    v-model:bottomVisible="node.selected"
    :topVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :overviewSrc="thumbnailUrl"
    @overviewLoad="resizeImage"
    :overviewLabel="imageTask ? taskPhaseLabel : ''"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    @fullscreen="previewVisible = true"
    :bottomWidth="660"
    :style="{ width: imageWidth ? `${imageWidth + 18}px` : undefined }">
    <template v-if="editor?.mode" #top><div ref="paintToolbar" /></template>
    <template #topActions>
      <el-button :icon="IconPanoramaHorizontal" :disabled="generating || deleting || uploading || editor?.busy || lighting?.generating || multiAngle?.generating || gridSplit?.splitting || panorama?.busy || !previewUrl" text title="全景图" aria-label="全景图" @click.stop="panorama?.open($event)">全景图<icon-chevron-down :size="14" /></el-button>
      <el-button :icon="IconBrush" :disabled="generating || deleting || uploading || lighting?.generating || multiAngle?.generating || panorama?.busy || !previewUrl || gridSplit?.splitting" text title="局部重绘" aria-label="局部重绘" @click.stop="startEditor('inpaint')">局部重绘</el-button>
      <el-button :icon="IconSun" :disabled="generating || deleting || uploading || lighting?.generating || multiAngle?.generating || panorama?.busy || !previewUrl || gridSplit?.splitting" text title="打光" aria-label="打光" @click.stop="openLighting">打光</el-button>
      <el-button :icon="IconCameraRotate" :disabled="generating || deleting || uploading || lighting?.generating || multiAngle?.generating || panorama?.busy || !previewUrl || gridSplit?.splitting" text title="多角度" aria-label="多角度" @click.stop="openMultiAngle">多角度</el-button>
      <el-button :icon="IconLayoutGrid" :disabled="generating || deleting || uploading || lighting?.generating || multiAngle?.generating || panorama?.busy || !previewUrl" :loading="gridSplit?.splitting" text title="宫格切分" aria-label="宫格切分" @click.stop="gridSplit?.open($event)">宫格切分</el-button>
      <mediaHistory mediaType="image" :current="outputFile" :disabled="generating || deleting || uploading || lighting?.generating || multiAngle?.generating || panorama?.busy" @select="outputs.image = { dataType: 'IMAGE', value: $event }" />
      <el-button :icon="IconTransfer" :loading="uploading" :disabled="generating || deleting || lighting?.generating || multiAngle?.generating || panorama?.busy" text title="替换图片" aria-label="替换图片" @click.stop="fileInput?.click()">替换图片</el-button>
      <input ref="fileInput" type="file" accept="image/*" hidden aria-label="选择替换图片" :disabled="generating || deleting || uploading || lighting?.generating || multiAngle?.generating || panorama?.busy" @change="replaceOutput" />
    </template>
    <template #topRightActions>
      <el-button :icon="IconPencil" :disabled="generating || deleting || uploading || lighting?.generating || multiAngle?.generating || panorama?.busy || !previewUrl || gridSplit?.splitting" text title="标记" aria-label="标记" @click.stop="startEditor('mark')" />
    </template>
    <div v-loading="generating || uploading" class="imageContent nopan" :aria-busy="generating || uploading">
      <imageEditor
        v-if="previewUrl"
        ref="editor"
        :src="previewUrl"
        :previewSrc="thumbnailUrl"
        :toolbarTarget="paintToolbar"
        :disabled="generating || deleting || uploading || lighting?.generating || multiAngle?.generating || panorama?.busy"
        alt="生成图片"
        @load="resizeImage"
        @error="showNodeError('无法预览该图片', '图片预览失败')" />
      <div v-else-if="inpaintGuideUrl" class="inpaintGuide">
        <img :src="inpaintGuideUrl" alt="局部重绘标注图" draggable="false" @load="resizeImage" @error="showNodeError('无法读取重绘标注图', '重绘标注读取失败')" />
        <span>红色标注为重绘区域</span>
      </div>
      <div v-else class="imageEmpty" role="img" aria-label="暂无生成图片">
        <icon-photo-ai :size="48" stroke="1.25" aria-hidden="true" />
      </div>
    </div>
    <template v-if="editor?.mode !== 'mark'" #bottom>
      <div v-if="lightingVisible" ref="lightingTarget" />
      <div v-else-if="multiAngleVisible" ref="multiAngleTarget" />
      <el-card v-else class="promptCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <el-button v-if="inpaintGuideUrl && editor?.mode !== 'inpaint'" class="inpaintInfo" text :icon="IconBrush" @click="inpaintPreviewVisible = true">查看重绘标注</el-button>
        <referenceItem
          v-if="refList.length"
          v-model="refList"
          @preview="setReferencePreview"
          @remove="removeReference" />
        <promptInput v-if="editor?.mode === 'inpaint'" v-model="data.inpaintPromptModel" v-model:text="data.inpaintPrompt" :references="referenceMentions" expandable />
        <promptInput v-else v-model="data.promptModel" v-model:text="data.prompt" :references="referenceMentions" expandable />
        <p v-if="data.model && !selectedModel && !modelsLoading" role="alert">模型不可用，请选择其他模型</p>
        <div class="promptFooter">
          <el-select
            v-if="editor?.mode !== 'inpaint'"
            v-model="data.model"
            class="modelSelect"
            filterable
            :loading="modelsLoading"
            :disabled="generating || deleting || pendingTask"
            placeholder="选择模型"
            aria-label="生成模型"
            noDataText="请先在设置中添加图片模型"
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
              v-if="editor?.mode !== 'inpaint'"
              v-model:size="data.size"
              v-model:ratio="data.ratio"
              :sizes="sizeOptions"
              :ratios="ratioOptions"
              @update:size="rememberPreferences"
              @update:ratio="rememberPreferences"
              :disabled="generating || deleting || pendingTask || !selectedModel" />
            <el-button v-if="editor?.mode === 'inpaint'" class="confirmButton" type="primary" :icon="IconCheck" :loading="editor.busy" :disabled="deleting || uploading || !generationPrompt" @click="confirmInpaint().catch(error => showNodeError(error, '重绘节点创建失败'))">确认</el-button>
            <el-button
              v-else
              class="sendButton"
              :icon="generating ? IconPlayerStop : IconArrowUp"
              :disabled="deleting || uploading || taskChecking || (!generating && !pendingTask && (editor?.busy || !generationPrompt.trim() || !selectedModel))"
              :title="generating ? '停止本地等待' : pendingTask ? '恢复原图片任务' : imageTask?.phase === 'expired' ? '重新生成图片（另行计费）' : '生成图片'"
              :aria-label="generating ? '停止本地等待' : pendingTask ? '恢复原图片任务' : imageTask?.phase === 'expired' ? '重新生成图片（另行计费）' : '生成图片'"
              @click="generating ? stopGeneration() : startGeneration().catch((error) => showNodeError(error, '图片生成失败'))">{{ generating ? '停止等待' : pendingTask ? '恢复任务' : '生成' }}</el-button>
          </div>
        </div>
        <generationTiming :timing="data.generationTiming" :running="generating || !!imageTask?.running" />
        <div v-if="imageTask || taskStatusError" class="taskStatus" role="status" aria-live="polite">
          <div v-if="imageTask">{{ taskPhaseLabel }}</div>
          <div v-if="imageTask">操作编号：{{ imageTask.operationId }}</div>
          <div v-if="imageTask?.taskId">任务编号：{{ imageTask.taskId }}</div>
          <div v-if="pendingTask && !generating">点击“恢复任务”按原参数恢复；不会新建图片。{{ imageTask?.providerId === 'laoliImage' ? '渠道结果缓存为完成后 3 小时，请及时恢复。' : '结果链接有时效，请及时恢复并保存。' }}</div>
          <div v-if="imageTask?.result && imageTask.result.length > 1">本次 {{ imageTask.result.length }} 张图片已全部保存，可在「历史记录」中选择当前结果。</div>
          <div v-if="imageTask?.phase === 'expired'">过期不代表失败或退款；再次生成会创建新任务并另行计费。</div>
          <div v-if="imageTask?.error || taskStatusError" class="taskError">{{ taskStatusError || imageTask?.error }}</div>
        </div>
      </el-card>
    </template>
  </nodeSkeleton>
  <imageLighting v-if="lightingVisible" ref="lighting" :src="previewUrl" :source="outputFile" :target="lightingTarget" :disabled="generating || deleting || uploading || gridSplit?.splitting" @close="lightingVisible = false" />
  <imageMultiAngle v-if="multiAngleVisible" ref="multiAngle" :src="previewUrl" :source="outputFile" :target="multiAngleTarget" :disabled="generating || deleting || uploading || gridSplit?.splitting" @close="multiAngleVisible = false" />
  <imagePanorama ref="panorama" :src="previewUrl" :source="outputFile" :disabled="generating || deleting || uploading || editor?.busy || lighting?.generating || multiAngle?.generating || gridSplit?.splitting" @open="openPanorama" />
  <imageGridSplit ref="gridSplit" :src="previewUrl" :disabled="generating || deleting || uploading || lighting?.generating || multiAngle?.generating || panorama?.busy" :active="node.selected" />
  <el-image-viewer v-if="inpaintPreviewVisible && inpaintGuideUrl" :urlList="[inpaintGuideUrl]" teleported @close="inpaintPreviewVisible = false" />
  <el-image-viewer
    v-if="previewVisible && previewUrl"
    :urlList="[previewUrl]"
    teleported
    @close="previewVisible = false" />
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, watch, watchEffect } from "vue";
import { ElButton, ElCard, ElSelect, ElOption, ElOptionGroup, ElLoading, ElImageViewer } from "element-plus";
import { IconCheck, IconPhotoAi, IconSparkles, IconArrowUp, IconPlayerStop, IconTransfer, IconLayoutGrid, IconBrush, IconPencil, IconSun, IconCameraRotate, IconPanoramaHorizontal, IconChevronDown } from "@tabler/icons-vue";
import { nodeSkeleton, nodeTools, useNode, z, type NodeHandle, type NodeImageRequest, type NodeImageResult, type ImageTaskStatus } from "@toonflow/nodes-scaffold/runtime";
import { registerGenerationTools } from "@toonflow/node-shared/generationTools";
import { useMediaModels } from "@toonflow/node-shared/useMediaModels";
import { useOutputReplace } from "@toonflow/node-shared/useOutputReplace";
import { showNodeError } from "@toonflow/node-shared/showNodeError";
import { useNodeGeneration, type GenerationTiming } from "@toonflow/node-shared/useNodeGeneration";
import generationTiming from "@toonflow/node-shared/generationTiming";
import { useGenerationPreferences } from "@toonflow/node-shared/useGenerationPreferences";
import { useNodeReferences } from "@toonflow/node-shared/useNodeReferences";
import promptInput from "@toonflow/node-shared/promptInput";
import referenceItem from "@toonflow/node-shared/referenceItem";
import mediaHistory from "@toonflow/node-shared/mediaHistory";
import imageGridSplit from "@toonflow/node-image/imageGridSplit";
import imageEditor from "@toonflow/node-image/imageEditor";
import { useImageInpaint, type ImageInpaint } from "@toonflow/node-image/imageInpaint";
import imageLighting from "@toonflow/node-image/imageLighting";
import imagePanorama from "@toonflow/node-image/imagePanorama";
import imageMultiAngle from "@toonflow/node-image/imageMultiAngle";
import generationSettings from "./components/generationSettings.vue";

defineOptions({
  inheritAttrs: false,
  icon: IconPhotoAi,
  handles: [
    { id: "in", type: "target", dataType: ["IMAGE", "STRING"], label: "图片、文本输入" },
    { id: "image", type: "source", dataType: "IMAGE", label: "图片输出" },
  ] satisfies NodeHandle[],
});
const vLoading = ElLoading.directive;
const { id, node, nodeProps, nodeEvent, outputs, files, ai, updateNodeInternals, retainPreview } = useNode({
  label: "图片生成",
});
type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
const data = computed(() => node.data as { prompt: string; promptModel: PromptModel; inpaintPrompt: string; inpaintPromptModel: PromptModel; model: string; size: string; ratio: string; inpaint?: ImageInpaint; appliedImageTaskId?: string; generationTiming?: GenerationTiming });
const rememberPreferences = useGenerationPreferences("image", () => data.value);
data.value.prompt ??= "";
data.value.promptModel ??= [];
data.value.inpaintPrompt ??= "";
data.value.inpaintPromptModel ??= [];
data.value.model ??= "";
data.value.size ??= "";
data.value.ratio ??= "16:9";
const { refList, referenceMentions, setReferencePreview, removeReference } = useNodeReferences();
const { models, modelsLoading, modelGroups, loadModels } = useMediaModels("image", data, () => generating.value || deleting.value, ai.getMediaModels);
const { uploading, replaceOutput } = useOutputReplace("image", files, () => generating.value || deleting.value || !!lighting.value?.generating || !!multiAngle.value?.generating || !!panorama.value?.busy,
  value => { outputs.value.image = { dataType: "IMAGE", value }; });
const fileInput = ref<HTMLInputElement>();
const gridSplit = ref<InstanceType<typeof imageGridSplit>>();
const editor = ref<InstanceType<typeof imageEditor>>();
const generateInpaint = useImageInpaint();
const paintToolbar = ref<HTMLElement>();
const lighting = ref<InstanceType<typeof imageLighting>>();
const lightingTarget = ref<HTMLElement>();
const lightingVisible = ref(false);
const multiAngle = ref<InstanceType<typeof imageMultiAngle>>();
const multiAngleTarget = ref<HTMLElement>();
const multiAngleVisible = ref(false);
const panorama = ref<InstanceType<typeof imagePanorama>>();
let disposed = false;
const deleting = ref(false);
const previewVisible = ref(false);
const inpaintPreviewVisible = ref(false);
const imageWidth = ref(0);
let generationController: AbortController | undefined;
const generationState = useNodeGeneration(outputs, stopGeneration, "已停止本地等待；已提交的图片任务及费用不会因此取消");
const { generating } = generationState;
let generation: Promise<void> | undefined;
const imageTask = ref<ImageTaskStatus | null>(null);
const taskChecking = ref(true);
const taskStatusError = ref("");
const taskOutputDirectory = computed(() => `assets/${id}${data.value.inpaint ? "/inpaint" : ""}`);
const pendingTask = computed(() => !!imageTask.value && !["failed", "expired"].includes(imageTask.value.phase)
  && (imageTask.value.phase !== "completed" || imageTask.value.operationId !== data.value.appliedImageTaskId));
const taskPhaseLabel = computed(() => imageTask.value ? ({ prepared: "准备提交", submitting: "确认提交回执", accepted: "已受理", queued: "排队中", processing: "生成中", reconciling: "渠道核对结果中", settling: "原图已生成，结算确认中", downloading: "保存原图中", completed: "原图已保存", failed: "原任务已确认失败", expired: "渠道结果缓存已过期" })[imageTask.value.phase] : "");
let taskTimer: ReturnType<typeof setTimeout> | undefined;
let taskWorkspaceDirectory = "";
let resumeWhenReady = false;
const selectedModel = computed(() => models.value.find((item) => JSON.stringify([item.providerId, item.modelId]) === data.value.model));
const sizeOptions = computed(() => (selectedModel.value?.imageSizes?.length ? selectedModel.value.imageSizes : ["2K"]));
const ratioOptions = computed(() => (selectedModel.value?.imageRatios?.length ? selectedModel.value.imageRatios : ["16:9"]));
watch(
  selectedModel,
  (choice) => {
    if (!choice) return;
    // ACT: 现有分辨率使用 K 单位；出现其他单位时再统一换算，未知名称排在数值选项之后。
    if (!sizeOptions.value.includes(data.value.size)) data.value.size = sizeOptions.value.toSorted((left, right) =>
      (Number.parseFloat(left) || Infinity) - (Number.parseFloat(right) || Infinity)
    )[0]!;
    if (!ratioOptions.value.includes(data.value.ratio)) data.value.ratio = ratioOptions.value.includes("16:9") ? "16:9" : ratioOptions.value[0]!;
  },
  { flush: "sync" }
);
const generationPrompt = computed(() =>
  [
    selectedModel.value?.taskRecovery ? (editor.value?.mode === "inpaint" ? data.value.inpaintPrompt : data.value.prompt)
      : (editor.value?.mode === "inpaint" ? data.value.inpaintPrompt : data.value.prompt).trim(),
    ...refList.value.flatMap((item, index) => (item.dataType === "STRING" && item.value?.trim() ? [`参考 ${index + 1}：\n${item.value.trim()}`] : [])),
  ]
    .filter(Boolean)
    .join("\n\n")
);
const outputFile = computed(() => outputs.value.image?.dataType === "IMAGE" ? outputs.value.image.value : undefined);
const inpaintGuideUrl = files.useFileUrl(
  () => data.value.inpaint?.guide ? { url: data.value.inpaint.guide, mimeType: "image/png" } : undefined,
  error => showNodeError(error, "重绘标注读取失败")
);
const previewUrl = files.useFileUrl(
  outputFile,
  (error) => showNodeError(error, "图片读取失败")
);
const thumbnailUrl = files.useFileUrl(outputFile, error => showNodeError(error, "图片预览读取失败"), true);
watchEffect(() => { retainPreview.value = generating.value || uploading.value || previewVisible.value || !!editor.value?.mode || !!editor.value?.busy || !!lighting.value?.generating || !!multiAngle.value?.generating || !!panorama.value?.busy || !!gridSplit.value?.splitting; });

onMounted(async () => {
  try {
    await loadModels();
    await refreshImageTask();
    if (pendingTask.value && imageTask.value?.taskId) {
      resumeWhenReady = true;
      if (imageTask.value.running || (imageTask.value.retryAt ?? 0) > Date.now()) pollImageTask();
      else await resumeGeneration();
    }
  } catch (error) { showNodeError(error, "图片任务读取失败"); }
  finally { taskChecking.value = false; }
});
onScopeDispose(() => {
  disposed = true;
  generationController?.abort();
  clearTimeout(taskTimer);
});



async function confirmInpaint() {
  const inpaintEditor = editor.value;
  if (!inpaintEditor || inpaintEditor.mode !== "inpaint") throw new Error("请先进入局部重绘");
  if (inpaintEditor.busy || generating.value || deleting.value || uploading.value) return;
  if (!generationPrompt.value) throw new Error("请输入重绘提示词");
  if (refList.value.some(item => item.value === undefined)) throw new Error("引用节点暂无内容，请先补充引用内容");
  let prompt = generationPrompt.value.replace(/\{\{ref (\d+)\}\}/g, "重绘参考 $1").replace(/^参考 (\d+)：/gm, "重绘参考 $1：");
  const images = refList.value.flatMap(item => item.dataType === "IMAGE" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []);
  const imageReferences = refList.value.flatMap((item, index) => item.dataType === "IMAGE" && item.value ? [index + 1] : []);
  if (imageReferences.length) prompt += `\n重绘参考编号对应关系（前两张为原图和区域引导图）：${imageReferences.map((reference, index) => `重绘参考 ${reference} 对应第 ${index + 3} 张图`).join("；")}。`;
  await inpaintEditor.createInpaint({ prompt, images }, new AbortController().signal);
}

async function startGeneration() {
  const shouldResume = pendingTask.value;
  await refreshImageTask();
  if (shouldResume || pendingTask.value) return resumeGeneration();
  const choice = selectedModel.value;
  if (generating.value) throw new Error("图片正在生成，请等待完成");
  if (panorama.value?.visible) throw new Error("请先关闭全景图，再启动图片生成");
  if (uploading.value) throw new Error("图片正在替换，请等待完成");
  if (deleting.value) throw new Error("节点正在删除");
  if (lightingVisible.value) throw new Error("请先退出打光，再启动图片生成");
  if (multiAngleVisible.value) throw new Error("请先退出多角度，再启动图片生成");
  if (editor.value?.busy || editor.value?.mode === "mark") throw new Error("请先完成图片标记");
  if (editor.value?.mode === "inpaint") throw new Error("请先确认局部重绘，再到子节点生成");
  if (!generationPrompt.value.trim()) throw new Error("请输入生成提示词");
  const references = refList.value.filter(item => !data.value.inpaint || item.dataType !== "IMAGE" || item.value?.url !== data.value.inpaint.source);
  if (references.some(item => item.value === undefined)) throw new Error("引用节点暂无内容，请先补充引用内容");
  if (!choice) throw new Error("请先选择图片模型");
  const workspace = files.getWorkspaceFiles();
  const controller = new AbortController();
  const inpaintData = data.value.inpaint;
  const input: Omit<NodeImageRequest, "directory"> = {
    providerId: choice.providerId,
    ...(choice.taskRecovery ? { operationId: crypto.randomUUID() } : {}),
    modelId: choice.modelId,
    prompt: generationPrompt.value,
    size: data.value.size,
    ratio: data.value.ratio,
    outputDirectory: choice.taskRecovery ? taskOutputDirectory.value : `assets/${id}`,
    images: references.flatMap(item => item.dataType === "IMAGE" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []),
  };
  if (inpaintData) {
    let imageIndex = 3 + (inpaintData.images?.length ?? 0);
    const mapping = refList.value.flatMap((item, index) => item.dataType === "IMAGE" && item.value
      ? [`参考 ${index + 1} / {{ref ${index + 1}}} 对应第 ${item.value.url === inpaintData.source ? 1 : imageIndex++} 张图`] : []);
    if (mapping.length) input.prompt += `\n当前节点参考编号对应关系：${mapping.join("；")}。`;
  }
  generationController = controller;
  if (choice.taskRecovery) pollImageTask();
  // ACT: 工具立即返回，任务由节点持有，停止或卸载时取消。
  generation = generationState.run(() => workspace.list()
    .then(({ directory }) => {
      controller.signal.throwIfAborted();
      return inpaintData
        ? generateInpaint({ ...input, directory }, inpaintData, controller.signal)
        : ai.generateImage({ ...input, directory }, controller.signal);
    })
    .then(([result]) => {
      controller.signal.throwIfAborted();
      if (!result) throw new Error("供应商未返回图片");
      outputs.value.image = { dataType: "IMAGE", value: { url: result.path, mimeType: result.mimeType } };
      if (input.operationId) data.value.appliedImageTaskId = input.operationId;
    }), { operationId: input.operationId })
    .catch((error) => showNodeError(error, "图片生成失败"))
    .finally(() => {
      generationController = undefined;
      clearTimeout(taskTimer);
      if (choice.taskRecovery && !disposed) refreshImageTask().catch(error => { taskStatusError.value = error.message; });
    });
  return { status: "generating" };
}

async function refreshImageTask() {
  const directory = taskWorkspaceDirectory ||= files.getWorkspaceDirectory();
  const task = await ai.getImageTask({ directory, outputDirectory: taskOutputDirectory.value });
  if (disposed) return;
  imageTask.value = task;
  if (task) generationState.syncTask(task);
  taskStatusError.value = "";
}

function pollImageTask() {
  clearTimeout(taskTimer);
  taskTimer = setTimeout(async () => {
    try { await refreshImageTask(); }
    catch (error) { if (!disposed) taskStatusError.value = error instanceof Error ? error.message : "图片进度查询暂不可用"; }
    if (disposed) return;
    if (!pendingTask.value) resumeWhenReady = false;
    if (resumeWhenReady && !generating.value && !imageTask.value?.running && (imageTask.value?.retryAt ?? 0) <= Date.now()) {
      try { await resumeGeneration(); }
      catch (error) { taskStatusError.value = error instanceof Error ? error.message : "请手动恢复原图片任务"; resumeWhenReady = false; }
    } else if (generating.value || imageTask.value?.running || resumeWhenReady) pollImageTask();
  }, 5000);
}

async function resumeGeneration() {
  if (generating.value) throw new Error("图片任务仍在等待，请勿重复恢复");
  if (deleting.value || uploading.value || editor.value?.busy) throw new Error("图片正在处理，请稍后恢复");
  const task = imageTask.value;
  if (!task) throw new Error("没有可恢复的图片任务");
  if (task.running) { resumeWhenReady = true; pollImageTask(); return { status: "generating" }; }
  resumeWhenReady = false;
  const { directory } = await files.getWorkspaceFiles().list();
  const controller = new AbortController();
  const inpaintData = data.value.inpaint;
  const outputDirectory = taskOutputDirectory.value;
  generationController = controller;
  pollImageTask();
  generation = generationState.run(async () => {
    const results = task.phase === "completed" && task.result ? task.result : await ai.resumeImageTask({ directory, outputDirectory, operationId: task.operationId }, controller.signal);
    controller.signal.throwIfAborted();
    let result = results[0] as NodeImageResult | undefined;
    if (!result || result.mediaType !== "image") throw new Error("原任务未返回图片");
    if (inpaintData) [result] = await generateInpaint({ directory, outputDirectory, operationId: task.operationId, providerId: task.providerId, modelId: task.modelId, prompt: "" }, inpaintData, controller.signal, result);
    controller.signal.throwIfAborted();
    if (!result) throw new Error("重绘未返回图片");
    outputs.value.image = { dataType: "IMAGE", value: { url: result.path, mimeType: result.mimeType } };
    data.value.appliedImageTaskId = task.operationId;
  }, { operationId: task.operationId, startedAt: task.startedAt }).catch(error => showNodeError(error, "原图片任务恢复中断"))
    .finally(() => {
      generationController = undefined;
      clearTimeout(taskTimer);
      if (!disposed) refreshImageTask().catch(error => { taskStatusError.value = error.message; });
    });
  return { status: "generating" };
}

function stopGeneration() {
  resumeWhenReady = false;
  generationController?.abort();
}

nodeEvent.on("save", (reason) => {
  if (reason === "reload" && (generating.value || uploading.value || deleting.value || editor.value?.busy || lighting.value?.generating || multiAngle.value?.generating || panorama.value?.busy)) throw new Error("图片处理中，请完成后再刷新节点");
});
nodeEvent.on("delete", async () => {
  if (uploading.value || lighting.value?.generating || multiAngle.value?.generating || panorama.value?.busy || (editor.value?.busy && !generating.value)) throw new Error("图片处理中，请稍后删除节点");
  deleting.value = true;
  generationController?.abort();
  try {
    await generation;
    await files.removeNodeFiles();
  } finally {
    deleting.value = false;
  }
});

async function resizeImage(event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  if (!image.naturalWidth || !image.naturalHeight) return;
  imageWidth.value = (240 * image.naturalWidth) / image.naturalHeight;
  await nextTick();
  updateNodeInternals();
}

function openPanorama() {
  editor.value?.cancel();
  lightingVisible.value = false;
  multiAngleVisible.value = false;
}

function openLighting() {
  if (generating.value || deleting.value || uploading.value || editor.value?.busy || lighting.value?.generating || multiAngle.value?.generating || panorama.value?.busy || gridSplit.value?.splitting || !previewUrl.value) return;
  editor.value?.cancel();
  multiAngleVisible.value = false;
  lightingVisible.value = true;
}

function openMultiAngle() {
  if (generating.value || deleting.value || uploading.value || editor.value?.busy || lighting.value?.generating || multiAngle.value?.generating || panorama.value?.busy || gridSplit.value?.splitting || !previewUrl.value) return;
  editor.value?.cancel();
  lightingVisible.value = false;
  multiAngleVisible.value = true;
}

function startEditor(mode: "inpaint" | "mark") {
  if (generating.value || deleting.value || uploading.value || editor.value?.busy || lighting.value?.generating || multiAngle.value?.generating || panorama.value?.busy || gridSplit.value?.splitting) return;
  lightingVisible.value = false;
  multiAngleVisible.value = false;
  editor.value?.start(mode);
}

function getConfig() {
  return {
    config: {
      providerId: selectedModel.value?.providerId ?? "",
      modelId: selectedModel.value?.modelId ?? "",
      size: data.value.size,
      ratio: data.value.ratio,
    },
    models: models.value,
  };
}

registerGenerationTools({
  configDescription: "读取此图片生成节点的当前模型、分辨率、比例及可选图片模型能力，不含密钥；未声明分辨率或比例时分别使用 2K、16:9",
  promptDescription: "修改此节点的普通图片生成提示词，支持 {{ref 1}} 等参考标记；不修改局部重绘提示词，不启动生成",
  loadModels, getConfig,
  setPrompt(value) {
    if (deleting.value) throw new Error("节点正在删除，请稍后修改");
    data.value.prompt = value;
    data.value.promptModel = value.split("\n").map((text) => [{ type: "Write", text }]);
  },
});

nodeTools.register({
  name: "setConfig",
  description: "修改此图片生成节点的模型、分辨率或比例；先用 getConfig 查询可选能力，providerId 与 modelId 必须同时提供；不修改提示词、不启动生成",
  parameters: z.strictObject({
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    size: z.string().min(1).optional(),
    ratio: z.string().min(1).optional(),
  }).refine((args) => (args.providerId === undefined) === (args.modelId === undefined), "providerId 与 modelId 必须同时提供"),
  async execute(args, { signal }) {
    signal?.throwIfAborted();
    if (generating.value || deleting.value || pendingTask.value) throw new Error("节点存在未完成任务，请先恢复原图片任务");
    await loadModels();
    signal?.throwIfAborted();
    if (generating.value || deleting.value || pendingTask.value) throw new Error("节点存在未完成任务，请先恢复原图片任务");
    const choice = args.modelId === undefined ? selectedModel.value
      : models.value.find((item) => item.providerId === args.providerId && item.modelId === args.modelId);
    if (!choice) throw new Error("请选择 getConfig 返回的有效图片模型");
    const sizes = choice.imageSizes?.length ? choice.imageSizes : ["2K"];
    const ratios = choice.imageRatios?.length ? choice.imageRatios : ["16:9"];
    if (args.size !== undefined && !sizes.includes(args.size)) throw new Error(`当前模型不支持分辨率 ${args.size}，可选：${sizes.join("、")}`);
    if (args.ratio !== undefined && !ratios.includes(args.ratio)) throw new Error(`当前模型不支持比例 ${args.ratio}，可选：${ratios.join("、")}`);
    data.value.model = JSON.stringify([choice.providerId, choice.modelId]);
    if (args.size !== undefined) data.value.size = args.size;
    if (args.ratio !== undefined) data.value.ratio = args.ratio;
    return getConfig();
  },
});



nodeTools.register({
  name: "generateImage",
  description: "启动此节点的后台普通图片生成，使用普通生成提示词、模型、分辨率、比例和参考图片；局部重绘模式下须先退出；立即返回已开始，默认不轮询等待。用户查询进度或后续需要结果时用 getGenerationStatus 查询，cancelGeneration 停止生成",
  parameters: z.strictObject({}),
  execute(_args, { signal }) {
    signal?.throwIfAborted();
    return startGeneration();
  },
});
</script>

<style scoped lang="scss">
.imageContent {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 144px;
  overflow: hidden;
  border-radius: var(--el-border-radius-base);

  .inpaintGuide {
    position: relative;
    width: 100%;
    img { display: block; width: 100%; }
    span { position: absolute; bottom: 8px; left: 8px; padding: 4px 8px; border-radius: 4px; background: #0009; color: #fff; font-size: 12px; }
  }

  .imageEmpty {
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
  .taskStatus {
    margin-top: 10px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--el-text-color-secondary);
    overflow-wrap: anywhere;
    .taskError { color: var(--el-color-warning); }
  }
  .inpaintInfo { margin-bottom: 8px; }
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

    .confirmButton { margin-left: auto; }

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
}
</style>
