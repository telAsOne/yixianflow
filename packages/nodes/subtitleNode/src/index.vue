<template>
  <nodeSkeleton v-bind="nodeProps" :topVisible="node.selected" topWidth="max-content" :fullscreenVisible="false" style="width: 740px">
    <template #top>
      <div class="subtitleToolbar">
        <el-button :disabled="!ready || busy || !validMedia || !!data.taskId" @click="startGeneration().catch(reportError)">AI生成</el-button>
        <el-button :disabled="!ready || busy" @click="fileInput?.click()">导入SRT</el-button>
        <el-button :disabled="!ready || busy || dirty" :title="dirty ? '请先保存字幕' : '导出已保存字幕'" @click="exportSubtitle">导出SRT</el-button>
        <el-button v-if="generating" :disabled="phase === 'writing'" @click="cancelJob">取消生成</el-button>
        <el-button v-else-if="data.taskId" :disabled="!ready || busy" @click="resumeGeneration().catch(reportError)">恢复任务</el-button>
        <el-button v-else-if="data.resultPath && phase === 'failed'" :disabled="!ready || busy" @click="recoverResult().catch(reportError)">读取生成结果</el-button>
        <input ref="fileInput" type="file" accept=".srt" hidden aria-label="导入字幕文件" @change="importSubtitle" />
      </div>
    </template>
    <div class="subtitleContent nodrag nopan nowheel" @keydown.stop>
      <p class="mediaSource">{{ sourceLabel }}</p>
      <div class="generationOptions">
        <label>Whisper 模型<select v-model="model" :disabled="!ready || busy"><option v-for="choice in models" :key="choice" :value="choice">{{ choice }}</option></select></label>
        <label>语言（留空自动识别）<input v-model="language" :disabled="!ready || busy" /></label>
      </div>
      <p class="taskStatus" role="status">{{ statusLabel }}</p>
      <p v-if="data.subtitleReview" class="taskStatus">AI 已修正 {{ data.subtitleReview.changed }} 处，记录 {{ data.subtitleReview.issueCount }} 条{{ data.subtitleReview.error ? '；审查未完成，已使用可用字幕继续处理' : '' }}</p>
      <p v-if="error" class="subtitleError" role="alert">{{ error }}</p>
      <segmentTable v-model="draft" :disabled="!ready || busy" />
      <div class="saveActions">
        <span>{{ dirty ? '草稿未保存，输出仍为已保存字幕' : '字幕已保存' }}</span>
        <el-button type="primary" :disabled="!ready || busy" :loading="saving" @click="saveSubtitle().catch(reportError)">保存字幕</el-button>
      </div>
    </div>
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from "vue";
import { ElButton } from "element-plus";
import { IconSubtitles } from "@tabler/icons-vue";
import { getTargetValues, nodeSkeleton, nodeTools, useNode, useNodeInputs, z, type NodeHandle, type NodeInputValue, type WorkspaceFiles } from "@toonflow/nodes-scaffold/runtime";
import { parseSrt, serializeSrt, parseSrtTime, formatSrtTime } from "@toonflow/node-shared/subtitleSrt";
import { showNodeError } from "@toonflow/node-shared/showNodeError";
import { useNodeGeneration } from "@toonflow/node-shared/useNodeGeneration";
import type { WhisperModel, WhisperTask } from "@toonflow/server/whisper/types";
import segmentTable from "./components/segmentTable.vue";
import { whisperClient, WhisperHttpError } from "./whisperClient";

defineOptions({
  inheritAttrs: false,
  icon: IconSubtitles,
  handles: [
    { id: "media", type: "target", dataType: ["VIDEO", "AUDIO"], label: "一个视频或音频" },
    { id: "subtitle", type: "source", dataType: "STRING", label: "已保存的 SRT 字幕" },
  ] satisfies NodeHandle[],
});
const { id, node, nodeProps, nodeEvent, outputs, files, config } = useNode({
  label: "字幕", outputs: { subtitle: { dataType: "STRING", value: "" } },
});
const { getTargetSources } = useNodeInputs();
type DraftSegment = { start: string; end: string; text: string };
type SubtitleData = {
  subtitlePath?: string; subtitleSnapshot?: string; subtitleDraft?: DraftSegment[];
  taskId?: string; taskDirectory?: string; resultPath?: string; subtitlePhase?: string; subtitleError?: string;
  subtitleModel?: WhisperModel; subtitleLanguage?: string;
  subtitleReview?: { changed: number; issueCount: number; error?: string };
};
const data = computed(() => node.data as typeof node.data & SubtitleData);
const subtitlePath = `assets/${id}/subtitle.srt`;
const models = ["auto", "tiny", "base", "small", "medium", "large", "turbo"] as const;
const model = computed({ get: () => data.value.subtitleModel ?? (models.includes(config.value.defaultModel as WhisperModel) ? config.value.defaultModel as WhisperModel : "auto"),
  set: (value: WhisperModel) => { data.value.subtitleModel = value; } });
const language = computed({ get: () => data.value.subtitleLanguage ?? "", set: (value: string) => { data.value.subtitleLanguage = value; } });
const inputs = ref<NodeInputValue[]>([]);
const ready = ref(false);
const saving = ref(false);
const importing = ref(false);
const deleting = ref(false);
const fileInput = ref<HTMLInputElement>();
const error = computed({ get: () => data.value.subtitleError ?? "", set: value => { data.value.subtitleError = value; } });
const phase = computed({ get: () => data.value.subtitlePhase ?? "idle", set: value => { data.value.subtitlePhase = value; } });
const draft = computed({ get: () => data.value.subtitleDraft ?? [], set: value => { data.value.subtitleDraft = value; } });
let workspace: WorkspaceFiles;
let snapshot: Awaited<ReturnType<WorkspaceFiles["readTextSnapshot"]>> | undefined;
let loading: Promise<void> | undefined;
let saveQueue = Promise.resolve();
let job: Promise<void> | undefined;
let disposed = false;
let currentJob: { cancelled: boolean; directory?: string; operationId?: string; cancelPromise?: Promise<WhisperTask> } | undefined;
const generationState = useNodeGeneration(outputs, cancelJob, "字幕生成已取消");
const { generating } = generationState;
const busy = computed(() => generating.value || saving.value || importing.value || deleting.value || disposed);
const validMedia = computed(() => inputs.value.length === 1 && ["VIDEO", "AUDIO"].includes(String(inputs.value[0].dataType)) && !!inputs.value[0].value);
const dirty = computed(() => {
  try { return draftText() !== outputs.value.subtitle.value; }
  catch { return true; }
});
const sourceLabel = computed(() => {
  if (inputs.value.length !== 1) return `媒体输入：${inputs.value.length} 个（需恰好一个）`;
  const source = getTargetSources(id, "media")[0]?.node;
  const title = source?.data?.label?.trim();
  const input = inputs.value[0].value;
  const fileName = input && typeof input === "object" ? input.url.split(/[\\/]/).at(-1) : "暂无内容";
  return `媒体输入：${title || fileName}`;
});
const statusLabel = computed(() => ({
  idle: "", preparing: "等待本地助手准备识别", downloadingModel: "正在下载 Whisper 模型", transcribing: "本地助手正在转录", reviewing: "AI 自动校对，疑问仅记录", writing: "正在回传并保存字幕结果",
  draft: "生成完成，草稿待保存", saved: "字幕已保存", cancelled: "生成已取消", failed: "生成或读取失败",
} as Record<string, string>)[phase.value] ?? phase.value);

nodeEvent.on("input:media", values => { inputs.value = values; });
nodeEvent.on("canConnect", (connection, context) => {
  const edges = context.edges.filter(edge => edge.source !== connection.source || edge.sourceHandle !== connection.sourceHandle
    || edge.target !== connection.target || edge.targetHandle !== connection.targetHandle);
  return getTargetValues(id, "media", context.nodes, [...edges, connection]).length <= 1;
});

function errorMessage(failure: unknown) {
  return (failure as { response?: { data?: { message?: string } } })?.response?.data?.message
    || (failure instanceof Error ? failure.message : "字幕操作失败");
}
function reportError(failure: unknown) {
  error.value = errorMessage(failure);
  showNodeError(failure, "字幕操作失败");
}
function draftText() {
  return serializeSrt(draft.value.map(segment => ({ start: parseSrtTime(segment.start.trim()), end: parseSrtTime(segment.end.trim()), text: segment.text })));
}
function setDraft(srt: string) {
  const segments = parseSrt(srt);
  draft.value = segments.map(segment => ({ start: formatSrtTime(segment.start), end: formatSrtTime(segment.end), text: segment.text }));
}
async function loadSubtitle() {
  if (!id || /[\\/]/.test(id) || id === "." || id === "..") throw new Error("节点 ID 不能作为文件夹名称");
  if (data.value.subtitlePath !== undefined && data.value.subtitlePath !== subtitlePath) throw new Error("字幕文件路径无效");
  workspace = files.getWorkspaceFiles();
  if (data.value.subtitlePath) snapshot = await workspace.readTextSnapshot(subtitlePath);
  else {
    const saved = data.value.subtitleSnapshot ?? outputs.value.subtitle.value;
    parseSrt(saved);
    for (const directory of ["assets", `assets/${id}`]) {
      await workspace.mkdir(directory).catch((failure: { response?: { data?: { data?: { code?: string } } } }) => {
        if (failure.response?.data?.data?.code !== "EEXIST") throw failure;
      });
    }
    await workspace.write(subtitlePath, saved, true);
    data.value.subtitlePath = subtitlePath;
    snapshot = await workspace.readTextSnapshot(subtitlePath);
  }
  parseSrt(snapshot.text);
  outputs.value.subtitle.value = snapshot.text;
  data.value.subtitlePath = subtitlePath;
  delete data.value.subtitleSnapshot;
  if (data.value.subtitleDraft === undefined) setDraft(snapshot.text);
  else if (!Array.isArray(data.value.subtitleDraft) || data.value.subtitleDraft.some(segment => !segment || typeof segment.start !== "string" || typeof segment.end !== "string" || typeof segment.text !== "string")) throw new Error("保存的字幕草稿结构无效");
  ready.value = true;
  if (data.value.taskId) await resumeGeneration();
}
onMounted(() => { loading = loadSubtitle().catch(reportError); });

async function requireReady() {
  await loading;
  if (!ready.value || !snapshot || disposed || deleting.value) throw new Error("字幕文件尚未加载或节点已关闭");
}
async function saveSubtitle() {
  await requireReady();
  if (generating.value || importing.value || saving.value) throw new Error("字幕处理中，请稍后保存");
  const value = draftText();
  saving.value = true;
  const pending = saveQueue.then(async () => {
    snapshot!.revision = await workspace.writeTextSnapshot(subtitlePath, value, snapshot!);
    snapshot!.text = value;
    outputs.value.subtitle.value = value;
    error.value = "";
    phase.value = "saved";
  });
  // 后续仅由明确保存动作入队；失败保留草稿和旧输出，不重试快照写入。
  saveQueue = pending.catch(() => {});
  try { await pending; }
  catch (failure) { error.value = errorMessage(failure); throw failure; }
  finally { saving.value = false; }
  return { status: "saved", path: subtitlePath, srt: value, segments: parseSrt(value).length };
}
async function importSubtitle(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || busy.value) return;
  importing.value = true;
  try { await requireReady(); setDraft(await file.text()); phase.value = "draft"; error.value = ""; }
  catch (failure) { reportError(failure); }
  finally { importing.value = false; }
}
async function exportSubtitle() {
  try {
    await requireReady(); await saveQueue;
    if (dirty.value || busy.value) throw new Error("请先保存字幕，再导出");
    const url = URL.createObjectURL(new Blob([outputs.value.subtitle.value], { type: "application/x-subrip;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `${nodeProps.value.label || '字幕'}.srt`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (failure) { reportError(failure); }
}

function cancelJob() {
  const current = currentJob;
  if (!current) return;
  current.cancelled = true;
  if (current.directory && current.operationId && !current.cancelPromise) {
    current.cancelPromise = whisperClient.cancel(current.directory, current.operationId);
    current.cancelPromise.catch(reportError);
  }
}
async function consumeResult(resultPath: string, resultFiles: WorkspaceFiles, current?: NonNullable<typeof currentJob>) {
  if (!resultPath.startsWith(`assets/${id}/`) || !resultPath.endsWith(".srt") || resultPath.split("/").some(part => part === ".." || part === ".") || resultPath.includes("\\")) throw new Error("生成结果不属于当前字幕节点");
  data.value.resultPath = resultPath;
  const srt = await resultFiles.readText(resultPath);
  if (current?.cancelled) {
    delete data.value.taskId;
    throw new DOMException("字幕生成已取消", "AbortError");
  }
  if (disposed || deleting.value) return;
  setDraft(srt);
  phase.value = "draft";
  error.value = "";
  delete data.value.taskId;
}
async function monitorTask(current: NonNullable<typeof currentJob>, resultFiles: WorkspaceFiles, initial: WhisperTask) {
  let task = initial;
  while (true) {
    if (disposed) return;
    if (current.cancelled) {
      cancelJob();
      if (current.cancelPromise) task = await current.cancelPromise;
    }
    phase.value = task.phase;
    if (task.review) data.value.subtitleReview = task.review;
    generationState.syncTask({ ...task, startedAt: ((node.data as Record<string, unknown>).generationTiming as { startedAt?: number } | undefined)?.startedAt ?? Date.now() });
    if (!task.running) break;
    await new Promise(resolve => setTimeout(resolve, 800));
    task = await whisperClient.task(current.directory!, task.operationId);
  }
  if (task.phase === "cancelled") {
    delete data.value.taskId;
    throw new DOMException("字幕生成已取消", "AbortError");
  }
  if (task.phase !== "completed" || !task.output) {
    delete data.value.taskId;
    throw new Error(task.error || "Whisper 未返回字幕结果");
  }
  // writing 阶段可能已经完成提交；取消请求后保留结果路径，避免覆盖用户草稿。
  data.value.resultPath = task.output;
  if (current.cancelled) { delete data.value.taskId; phase.value = "cancelled"; throw new DOMException("字幕生成已取消", "AbortError"); }
  await consumeResult(task.output, resultFiles, current);
}
function ownJob(task: (current: NonNullable<typeof currentJob>) => Promise<void>, operationId?: string) {
  const current: NonNullable<typeof currentJob> = { cancelled: false, operationId };
  currentJob = current;
  job = generationState.run(() => task(current), { operationId }).catch(failure => {
    if (failure instanceof Error && failure.name === "AbortError") { phase.value = "cancelled"; error.value = "字幕生成已取消"; }
    else {
      phase.value = "failed";
      if (failure instanceof WhisperHttpError && failure.code === "WHISPER_TASK_EXPIRED") delete data.value.taskId;
      reportError(failure);
    }
  }).finally(() => { if (currentJob === current) currentJob = undefined; });
}
async function startGeneration(args: { model?: WhisperModel; language?: string } = {}) {
  if (!ready.value || busy.value) throw new Error("字幕正在处理或尚未加载");
  if (data.value.taskId) throw new Error("存在尚未结束的字幕任务，请先恢复或取消");
  if (inputs.value.length !== 1) throw new Error("字幕生成需要恰好一个视频或音频输入");
  const input = inputs.value[0];
  if ((input.dataType !== "VIDEO" && input.dataType !== "AUDIO") || !input.value) throw new Error("媒体节点暂无可转录内容");
  const source = input.value.url;
  const choice = args.model ?? model.value;
  const selectedLanguage = (args.language ?? language.value).trim();
  if (!models.includes(choice) || selectedLanguage.length > 32 || !/^(?:[a-zA-Z][a-zA-Z -]*)?$/.test(selectedLanguage)) throw new Error("请选择有效模型，语言使用名称或代码（如 Chinese、zh），留空自动识别");
  model.value = choice; language.value = selectedLanguage;
  const resultFiles = files.getWorkspaceFiles();
  const output = `assets/${id}/${crypto.randomUUID()}.srt`;
  phase.value = "preparing"; error.value = "";
  ownJob(async current => {
    current.directory = (await resultFiles.list()).directory;
    if (current.cancelled) throw new DOMException("字幕生成已取消", "AbortError");
    const check = await whisperClient.check(current.directory);
    if (current.cancelled) throw new DOMException("字幕生成已取消", "AbortError");
    if (!check.ready) throw new Error(check.errors.join("\n") || "本地 Whisper 尚未就绪");
    data.value.resultPath = output;
    data.value.taskDirectory = current.directory;
    // start 发送后必须收取 operationId；取消不 abort 请求，以免任务成为孤儿。
    const task = await whisperClient.start({ directory: current.directory, source, output, model: choice, language: selectedLanguage }).catch(failure => {
      if (failure instanceof WhisperHttpError) throw failure;
      throw new Error(`启动响应未确认，任务可能仍在运行。结果路径已保留，可稍后读取结果；不会自动重新提交。\n${errorMessage(failure)}`, { cause: failure });
    });
    current.operationId = task.operationId;
    data.value.taskId = task.operationId;
    data.value.taskDirectory = current.directory;
    data.value.resultPath = output;
    await monitorTask(current, resultFiles, task);
  });
  return { status: "generating", output: "draft", saved: false, resultPath: output };
}
async function resumeGeneration() {
  if (!ready.value || busy.value || !data.value.taskId) throw new Error("字幕任务无法恢复");
  const operationId = data.value.taskId;
  const taskDirectory = data.value.taskDirectory;
  const resultFiles = files.getWorkspaceFiles();
  ownJob(async current => {
    current.directory = (await resultFiles.list()).directory;
    if (taskDirectory !== current.directory) throw new Error("字幕任务不属于当前工作区");
    const task = await whisperClient.task(current.directory, operationId);
    await monitorTask(current, resultFiles, task);
  }, operationId);
  return { status: "generating", output: "draft", saved: false, operationId };
}
async function recoverResult() {
  await requireReady();
  if (busy.value || !data.value.resultPath) throw new Error("当前没有可读取的生成结果");
  await consumeResult(data.value.resultPath, workspace);
}
async function cancelAndWait() {
  const current = currentJob;
  cancelJob();
  await job;
  // 取消网络失败时必须阻止清理文件；恢复后的任务同样先等待服务端释放。
  if (current?.cancelPromise) {
    try { await current.cancelPromise; }
    catch (failure) {
      if (!(failure instanceof WhisperHttpError) || failure.code !== "WHISPER_TASK_EXPIRED") throw failure;
      delete data.value.taskId;
    }
  }
  if (!data.value.taskId) return;
  const directory = (await files.getWorkspaceFiles().list()).directory;
  if (directory !== data.value.taskDirectory) throw new Error("字幕任务不属于当前工作区，无法取消");
  try {
    await whisperClient.cancel(directory, data.value.taskId);
    delete data.value.taskId;
  } catch (failure) {
    if (!(failure instanceof WhisperHttpError) || failure.code !== "WHISPER_TASK_EXPIRED") throw failure;
    delete data.value.taskId;
  }
}
nodeEvent.on("save", async reason => {
  if (reason === "reload" && (generating.value || importing.value)) throw new Error("字幕处理中，请完成或取消后再刷新节点");
  await loading; await saveQueue;
  if (reason === "reload" && generating.value) throw new Error("字幕生成中，请完成或取消后再刷新节点");
});
nodeEvent.on("copy", async () => {
  await requireReady(); await saveQueue;
  return { subtitlePath: undefined, subtitleSnapshot: outputs.value.subtitle.value, taskId: undefined, taskDirectory: undefined,
    resultPath: undefined, generationTiming: undefined, subtitlePhase: undefined, subtitleError: undefined };
});
nodeEvent.on("delete", async () => {
  deleting.value = true;
  try { await cancelAndWait(); await saveQueue; await files.removeNodeFiles(); }
  finally { deleting.value = false; }
});
onScopeDispose(() => {
  disposed = true;
});
function subtitleStatus() {
  let draftReady = ready.value;
  try { draftText(); } catch { draftReady = false; }
  return { draftReady, saved: ready.value && !dirty.value && !!snapshot && snapshot.text === outputs.value.subtitle.value,
    dirty: dirty.value, phase: phase.value, operationId: data.value.taskId, resultPath: data.value.resultPath, error: error.value || undefined };
}
nodeTools.register({
  name: "getSubtitleStatus", description: "查询字幕草稿和保存状态；生成成功只填草稿，saved 为 true 才表示当前草稿已写入字幕文件并同步输出。dirty 表示有未保存修改。", parameters: z.strictObject({}), execute: subtitleStatus,
});
nodeTools.register({
  name: "generateSubtitle", description: "从恰好一个视频或音频输入启动本地 Whisper 后台转录，立即返回 generating，不等待任务完成。可指定 model/language，省略则沿用节点配置（语言留空自动识别）。getGenerationStatus 的 succeeded 仅表示草稿生成完成，outputs 可能仍是旧字幕；用 getSubtitleStatus 查询草稿，确认后显式调用 saveSubtitle。不要循环等待，除非用户要求。",
  parameters: z.strictObject({ model: z.enum(models).optional(), language: z.string().trim().max(32).regex(/^(?:[a-zA-Z][a-zA-Z -]*)?$/).optional() }),
  execute(args, { signal }) { signal?.throwIfAborted(); return startGeneration(args); },
});
nodeTools.register({
  name: "setSubtitle", description: "解析给定 SRT 并明确保存到字幕节点文件，成功后更新 STRING 输出；拒绝无效时间、空文本和乱序分段。",
  parameters: z.strictObject({ srt: z.string() }),
  async execute({ srt }, { signal }) { await requireReady(); signal?.throwIfAborted(); if (busy.value) throw new Error("字幕处理中，请稍后修改"); setDraft(srt); return saveSubtitle(); },
});
nodeTools.register({ name: "saveSubtitle", description: "明确保存当前字幕草稿；写入成功才同步输出，文件冲突保留草稿与旧输出。", parameters: z.strictObject({}), execute: saveSubtitle });
nodeTools.register({ name: "getConfig", description: "检查本地 Whisper、PyTorch 与 FFmpeg 环境及可选模型，不启动转录。", parameters: z.strictObject({}),
  async execute() { const directory = (await files.getWorkspaceFiles().list()).directory; return { ...await whisperClient.check(directory), model: model.value, language: language.value }; } });
</script>

<style scoped lang="scss">
.subtitleToolbar { display: flex; gap: 8px; padding: 8px; background: var(--el-bg-color); border: 1px solid var(--el-border-color); border-radius: 6px; }
.subtitleContent {
  .mediaSource, .taskStatus { margin: 0 0 8px; font-size: 12px; overflow-wrap: anywhere; }
  .generationOptions {
    display: flex; gap: 12px; margin-bottom: 10px; font-size: 12px;
    label { display: flex; align-items: center; gap: 6px; }
    input, select { padding: 5px; color: var(--el-text-color-primary); background: var(--el-fill-color-blank); border: 1px solid var(--el-border-color); border-radius: 4px; }
  }
  .subtitleError { white-space: pre-wrap; color: var(--el-color-danger); }
  .saveActions { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; font-size: 12px; }
}
</style>
