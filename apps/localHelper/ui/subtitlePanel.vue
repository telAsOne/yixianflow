<template>
  <section class="subtitlePanel">
    <header class="panelHeading">
      <div><h2>批量字幕</h2><p>本机识别、自动校对、字幕编辑与视频合成</p></div>
      <button :disabled="!online || checking || installing" @click="send('subtitleEnvironment', { rescan: true })">{{ checking ? '正在检测本机环境' : '重新检测本机环境' }}</button>
    </header>
    <div class="environmentCard">
      <div class="cardTitle"><strong>识别环境</strong><span>{{ checking ? '正在自动检测' : environment?.ready && selectedModel?.cached && selectedModel?.allowed ? '环境与所选模型已就绪' : environment?.ready ? '识别环境可用，所选模型待准备' : '需要准备本机环境' }}</span></div>
      <p v-if="environment?.detection" role="status">{{ environment.detection.message }}</p>
      <p v-if="environment?.hardware">{{ environment.hardware.reason }}</p>
      <div v-if="environment?.hardware" class="hardwareGrid">
        <span>{{ environment.hardware.cpu }} · {{ environment.hardware.cores }} 线程</span>
        <span>可用内存 {{ bytes(environment.hardware.memoryFree) }} / {{ bytes(environment.hardware.memoryTotal) }}</span>
        <span v-for="gpu in environment.hardware.gpus" :key="gpu.name">{{ gpu.name }}<template v-if="gpu.memoryFree !== undefined"> · 可用显存 {{ bytes(gpu.memoryFree) }}</template></span>
        <span>缓存盘可用 {{ bytes(environment.hardware.storageFree) }}</span>
      </div>
      <div class="settingsGrid">
        <label class="storageSetting">识别环境与模型存储目录<div><input v-model="settings.directory" :disabled="installing" /><button :disabled="!online || installing" @click="pick('storage')">选择</button></div></label>
        <label>模型<select v-model="settings.model" :disabled="installing"><option value="auto">自动推荐{{ recommended ? `（${recommended}）` : '' }}</option><option v-for="model in environment?.models || []" :key="model.id" :value="model.id" :disabled="!model.allowed">{{ model.id }} · {{ bytes(model.bytes) }}{{ model.cached ? ' · 已缓存' : '' }}{{ model.allowed ? '' : ' · 资源不足' }}</option></select></label>
        <label>语言<input v-model="settings.language" placeholder="留空自动识别，如 zh" :disabled="installing" /></label>
        <label>加速方式<select v-model="settings.acceleration" :disabled="installing"><option value="auto">自动检测 CPU / CUDA</option><option value="cpu">仅 CPU</option></select></label>
        <label class="pythonSetting">已有 Python 路径（可选）<div><input v-model="settings.pythonPath" placeholder="留空自动查找本机 Python" :disabled="installing" /><button :disabled="!online || installing" @click="pick('python')">选择文件</button></div></label>
        <label class="modelSetting">已有 Whisper 模型目录（可选）<div><input v-model="settings.modelDirectory" placeholder="留空检测常用缓存目录，也可选择已有 .pt 模型所在文件夹" :disabled="installing" /><button :disabled="!online || installing" @click="pick('models')">选择文件夹</button></div></label>
      </div>
      <p v-if="environment?.pythonPath" class="detectedPath">已找到 Python {{ environment.pythonVersion }}：{{ environment.pythonPath }}</p>
      <p v-if="selectedModel?.path" class="detectedPath">已有模型：{{ selectedModel.path }}</p>
      <div class="environmentActions">
        <button :disabled="!online || checking || installing" @click="saveSettings">保存并检测</button>
        <button class="primaryButton" :disabled="!online || checking || installing || !selectedModel?.allowed || (environment?.ready && selectedModel?.cached)" @click="installDialog = true">{{ environment?.ready && selectedModel?.cached ? '环境与模型已就绪' : selectedModel?.cached ? '一键准备识别环境' : environment?.ready ? '下载所选模型' : '一键准备环境与模型' }}{{ selectedModel && !selectedModel.cached ? ` · 模型 ${bytes(selectedModel.bytes)}` : '' }}</button>
        <button v-if="installing" @click="send('subtitleInstallCancel')">取消安装</button>
      </div>
      <div v-if="environment?.download && environment.download.phase !== 'idle'" class="installProgress" role="status">
        <span>{{ environment.download.label }}</span><span v-if="environment.download.total">{{ bytes(environment.download.bytes) }} / {{ bytes(environment.download.total) }}</span>
        <progress v-if="environment.download.total" :value="environment.download.bytes" :max="environment.download.total"></progress>
        <p v-if="environment.download.error" class="errorText">{{ environment.download.error }}</p>
      </div>
      <p v-if="environment?.error" class="errorText">{{ environment.error }}</p>
    </div>

    <div class="importCard">
      <div class="importActions"><button class="primaryButton" :disabled="!online" @click="pick('videos')">选择视频</button><button :disabled="!online" @click="pick('folder')">扫描文件夹</button><label><input v-model="recursive" type="checkbox" /> 包含子文件夹</label><span>每批最多 {{ subtitleBatchLimit }} 个，源视频保留</span></div>
      <p class="chatHint">也可在本机对话输入：给 "F:\视频\片段.mp4" 生成字幕</p>
      <template v-if="scanId">
        <div class="scanSummary"><span>找到 {{ scanTotal }} 个视频，已选 {{ selected.length }} 个</span><button class="primaryButton" :disabled="!online || !selected.length || selected.length > subtitleBatchLimit" @click="start">开始本批处理</button></div>
        <label v-for="file in candidates" :key="file.path" class="candidateRow"><input type="checkbox" :checked="selected.includes(file.path)" :disabled="!!file.existingId || (!selected.includes(file.path) && selected.length >= subtitleBatchLimit)" @change="toggle(file.path)" /><span><strong>{{ file.name }}</strong><small>{{ file.path }}</small></span><b>{{ file.existingId ? '已有任务' : bytes(file.size) }}</b></label>
        <div v-if="scanTotal > 100" class="pagination"><button :disabled="scanOffset === 0" @click="send('subtitleScanPage', { scanId, offset: Math.max(0, scanOffset - 100) })">上一页</button><span>{{ scanOffset + 1 }}–{{ Math.min(scanOffset + 100, scanTotal) }}</span><button :disabled="scanOffset + 100 >= scanTotal" @click="send('subtitleScanPage', { scanId, offset: scanOffset + 100 })">下一页</button></div>
        <p v-for="message in scanErrors" :key="message" class="errorText">{{ message }}</p>
      </template>
    </div>

    <div class="tasksCard">
      <div class="cardTitle"><strong>字幕任务 · {{ snapshot?.total || 0 }}</strong><button :disabled="!online" @click="send('subtitlePause', { paused: !snapshot?.paused })">{{ snapshot?.paused ? '继续队列' : '暂停队列' }}</button></div>
      <div v-for="task in snapshot?.tasks || []" :key="task.id" class="subtitleTask">
        <button class="taskText" @click="openTask(task.id)"><strong>{{ filename(task.sourcePath) }}</strong><small>{{ task.sourcePath }}</small><small>{{ task.model || '自动选择模型' }} · {{ task.id }}</small></button>
        <div class="taskStatus"><span>{{ stateLabel(task.state) }} · {{ Math.round(task.progress) }}%</span><progress :value="task.progress" max="100"></progress><small>{{ reviewLabel(task) }}</small><p v-if="task.error" class="errorText">{{ task.error }}</p></div>
        <div class="taskActions"><button @click="openTask(task.id)">字幕 / 记录</button><button v-if="finished(task.state)" @click="send('subtitleRender', { id: task.id })">{{ task.segmentCount ? '重新合成' : '继续处理' }}</button><button v-else @click="send('subtitleCancel', { id: task.id })">取消</button><button @click="send('subtitleOpen', { id: task.id })">所在目录</button></div>
      </div>
      <div v-if="(snapshot?.total || 0) > 20" class="pagination"><button :disabled="!snapshot?.page" @click="send('subtitleSnapshot', { page: (snapshot?.page || 0) - 1 })">上一页</button><span>第 {{ (snapshot?.page || 0) + 1 }} 页</span><button :disabled="((snapshot?.page || 0) + 1) * 20 >= (snapshot?.total || 0)" @click="send('subtitleSnapshot', { page: (snapshot?.page || 0) + 1 })">下一页</button></div>
    </div>

    <dialog ref="editor" class="subtitleEditor" @cancel.prevent="closeEditor">
      <template v-if="detail">
        <header><div><h3>{{ filename(detail.task.sourcePath) }}</h3><span>字幕修订 {{ detail.task.subtitleRevision }} · {{ stateLabel(detail.task.state) }}</span></div><button aria-label="关闭字幕编辑" @click="closeEditor">×</button></header>
        <div class="editorToolbar"><button @click="send('subtitlePreview', { id: detail.task.id })">预览原视频</button><button v-if="detail.task.output" @click="send('subtitlePreview', { id: detail.task.id, output: true })">预览最近成片</button><button :disabled="!dirty || !finished(detail.task.state)" @click="save">保存本页字幕</button><button :disabled="dirty || !finished(detail.task.state)" @click="send('subtitleRender', { id: detail.task.id })">用已保存字幕重新合成</button><span v-if="dirty">本页修改未保存</span></div>
        <video v-if="previewUrl" ref="video" :src="previewUrl" controls preload="metadata" @error="showPreviewError"></video><p v-if="previewError" class="errorText">{{ previewError }}</p>
        <div class="segmentScroll"><table><thead><tr><th>编号</th><th>开始（秒）</th><th>结束（秒）</th><th>字幕</th></tr></thead><tbody><tr v-for="(segment, index) in segments" :key="index"><td><button @click="seek(segment.start)">{{ detail.offset + index + 1 }}</button></td><td><input v-model.number="segment.start" type="number" min="0" step="0.01" :disabled="!finished(detail.task.state)" :aria-label="`第 ${detail.offset + index + 1} 行开始时间`" @input="dirty = true" /></td><td><input v-model.number="segment.end" type="number" min="0" step="0.01" :disabled="!finished(detail.task.state)" :aria-label="`第 ${detail.offset + index + 1} 行结束时间`" @input="dirty = true" /></td><td><textarea v-model="segment.text" :disabled="!finished(detail.task.state)" :aria-label="`第 ${detail.offset + index + 1} 行字幕`" @input="dirty = true"></textarea></td></tr></tbody></table></div>
        <div class="pagination"><button :disabled="dirty || !detail.offset" @click="openTask(detail.task.id, Math.max(0, detail.offset - 50))">上一页</button><span>{{ detail.offset + 1 }}–{{ Math.min(detail.offset + 50, detail.task.segmentCount) }} / {{ detail.task.segmentCount }} 行</span><button :disabled="dirty || detail.offset + 50 >= detail.task.segmentCount" @click="openTask(detail.task.id, detail.offset + 50)">下一页</button></div>
        <div class="reviewRecords"><strong>本页审查记录</strong><p v-if="detail.task.review.error" class="errorText">{{ reviewErrorText(detail.task.review.error) }}；本次校对未完成，当前字幕已保留。</p><div v-for="(issue, index) in detail.issues" :key="index"><span>第 {{ issue.index + 1 }} 行 · {{ reviewErrorText(issue.reason) }}</span><del v-if="issue.before">{{ issue.before }}</del><ins v-if="issue.after">{{ issue.after }}</ins></div></div>
      </template>
    </dialog>
    <actionDialog :open="installDialog" title="准备本机识别环境与模型？" description="复用已检测到的可用环境和模型，缺少的部分从官方源下载到所选目录。" :details="`模型：${selectedModel?.id || '尚未检测'}${selectedModel?.cached ? '，使用本机已有模型' : `，约 ${bytes(selectedModel?.bytes || 0)}`}。${environment?.ready ? '使用已找到的 Python 环境。' : '独立 Python 与 PyTorch 等依赖需要额外下载。'}当前缓存目录：${settings.directory}`" confirmLabel="开始准备" @confirm="install" @close="installDialog = false" />
    <actionDialog :open="discardDialog" title="放弃本页未保存修改？" description="已经保存的字幕和成片不受影响。" confirmLabel="放弃修改" @confirm="discard" @close="discardDialog = false" />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { selectWhisperModel, subtitleBatchLimit } from "../src/subtitleProtocol";
import type { SubtitleCandidate, SubtitleSegment, SubtitleSettings, SubtitleSnapshot, SubtitleTask, SubtitleTaskSummary } from "../src/subtitleProtocol";
import actionDialog from "./actionDialog.vue";

const props = defineProps<{ online: boolean; snapshot?: SubtitleSnapshot }>();
const emit = defineEmits<{ command: [type: string, payload?: Record<string, unknown>] }>();
const environment = computed(() => props.snapshot?.environment);
const settings = ref<SubtitleSettings>({ directory: "", pythonPath: "", modelDirectory: "", model: "auto", language: "zh", acceleration: "auto" });
const recommended = computed(() => selectWhisperModel(environment.value, "auto"));
const selectedModel = computed(() => environment.value?.models.find(model => model.id === (settings.value.model === "auto" ? recommended.value : settings.value.model)));
const checking = computed(() => !!environment.value?.detection?.running);
const installing = computed(() => ["checking", "downloading", "installing", "verifying"].includes(environment.value?.download.phase || ""));
const installDialog = ref(false);
const discardDialog = ref(false);
const recursive = ref(false);
const scanId = ref("");
const candidates = ref<SubtitleCandidate[]>([]);
const selected = ref<string[]>([]);
const scanTotal = ref(0);
const scanOffset = ref(0);
const scanErrors = ref<string[]>([]);
const editor = ref<HTMLDialogElement>();
const video = ref<HTMLVideoElement>();
const previewUrl = ref("");
const previewError = ref("");
const dirty = ref(false);
const segments = ref<SubtitleSegment[]>([]);
const detail = ref<{ task: SubtitleTaskSummary; offset: number; segments: SubtitleSegment[]; issues: SubtitleTask["review"]["issues"] }>();
let loadedSettings = false;
watch(environment, value => { if (value && !loadedSettings) { settings.value = { ...value.settings }; loadedSettings = true; } }, { immediate: true });
function send(type: string, payload?: Record<string, unknown>) { emit("command", type, payload); }
function bytes(value: number) { return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`; }
function filename(path: string) { return path.split(/[\\/]/).at(-1) || path; }
function finished(state: string) { return ["completed", "noSpeech", "failed", "cancelled", "interrupted", "waitingEnvironment"].includes(state); }
function stateLabel(state: string) { return ({ queued: "排队中", probing: "探测视频", extracting: "提取音频", transcribing: "识别字幕", reviewing: "AI 自动校对", rendering: "合成视频", publishing: "保存成片", completed: "已完成", noSpeech: "无可识别字幕", failed: "失败", cancelled: "已取消", interrupted: "已中断", waitingEnvironment: "待安装环境" } as Record<string, string>)[state] || state; }
function reviewLabel(task: SubtitleTaskSummary) { return task.review.state === "pending" ? "尚未审查" : `已修正 ${task.review.changed} 处 · ${task.review.issueCount} 条审查记录${task.review.error ? '（审查未完成，沿用已有字幕）' : ''}`; }
function reviewErrorText(message: string) { return message.replace(/Failed to parse JSON/g, "校对接口未返回有效数据"); }
function pick(kind: string) { send("subtitlePick", { kind }); }
function toggle(path: string) { selected.value = selected.value.includes(path) ? selected.value.filter(item => item !== path) : [...selected.value, path]; }
function saveSettings() { send("subtitleSettings", { settings: { ...settings.value } }); }
function start() { send("subtitleStart", { scanId: scanId.value, paths: selected.value, requestId: crypto.randomUUID(), model: settings.value.model, language: settings.value.language }); }
function install() { installDialog.value = false; send("subtitleInstall", { model: settings.value.model, settings: { ...settings.value } }); }
function openTask(id: string, offset = 0) { if (dirty.value) return; send("subtitleDetail", { id, offset }); }
function save() { if (detail.value) send("subtitleSave", { id: detail.value.task.id, revision: detail.value.task.subtitleRevision, offset: detail.value.offset, segments: segments.value.map(segment => ({ ...segment })) }); }
function seek(time: number) { if (video.value) video.value.currentTime = time; }
function showPreviewError() {
  const code = video.value?.error?.code;
  previewError.value = code === 3 ? "视频解码失败，可从所在目录打开文件。" : code === 2
    ? "预览文件读取失败，请重新预览或从所在目录打开文件。" : "视频未能加载，请重新预览或从所在目录打开文件。";
}
function closeEditor() { if (dirty.value) discardDialog.value = true; else { editor.value?.close(); previewUrl.value = ""; } }
function discard() { discardDialog.value = false; dirty.value = false; editor.value?.close(); previewUrl.value = ""; }
const bridge = (window as Window & { chrome?: { webview?: { addEventListener: (type: string, handler: (event: MessageEvent) => void) => void; removeEventListener: (type: string, handler: (event: MessageEvent) => void) => void } } }).chrome?.webview;
function receive(event: MessageEvent) {
  const message = event.data;
  if (message?.type === "subtitlePickResult") {
    if (message.kind === "storage") { settings.value.directory = message.paths[0] || settings.value.directory; return; }
    if (message.kind === "python") { settings.value.pythonPath = message.paths[0] || settings.value.pythonPath; return; }
    if (message.kind === "models") { settings.value.modelDirectory = message.paths[0] || settings.value.modelDirectory; return; }
    if (message.paths?.length) send("subtitleScan", { paths: message.paths, recursive: recursive.value });
  }
  if (message?.type === "subtitleScanResult") {
    if (scanId.value !== message.scanId) selected.value = [];
    scanId.value = message.scanId; candidates.value = message.files; scanTotal.value = message.total; scanOffset.value = message.offset; scanErrors.value = message.errors;
  }
  if (message?.type === "subtitleDetail") {
    detail.value = message; segments.value = message.segments.map((segment: SubtitleSegment) => ({ ...segment })); dirty.value = false;
    void nextTick(() => { if (!editor.value?.open) editor.value?.showModal(); });
  }
  if (message?.type === "subtitlePreviewReady" && message.id === detail.value?.task.id) {
    previewUrl.value = message.url; previewError.value = "";
    void nextTick(() => video.value?.load());
  }
  if (message?.type === "subtitleAccepted") { selected.value = []; send("subtitleSnapshot"); }
}
onMounted(() => { bridge?.addEventListener("message", receive); send("subtitleSnapshot"); send("subtitleEnvironment"); });
onUnmounted(() => bridge?.removeEventListener("message", receive));
</script>

<style scoped lang="scss">
.subtitlePanel {
  display: grid; gap: 18px; color: #29354a;
  button { border: 1px solid #dce2ec; background: white; color: #354158; border-radius: 8px; padding: 8px 12px; cursor: pointer; font: inherit; font-size: 12px; }
  button:disabled { opacity: .45; cursor: default; }
  button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid #6b66db; outline-offset: 2px; }
  .primaryButton { background: #5c58ce; border-color: #5c58ce; color: white; }
  .panelHeading, .cardTitle, .scanSummary { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .panelHeading { h2 { margin: 0; font-size: 22px; } p { margin: 7px 0 0; color: #7b8496; font-size: 13px; } }
  .environmentCard, .importCard, .tasksCard { background: white; border: 1px solid #e2e7ef; border-radius: 13px; padding: 20px; }
  .environmentCard { > p { font-size: 12px; line-height: 1.8; } .cardTitle span { font-size: 12px; color: #647088; } }
  .hardwareGrid { display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: 11px; color: #788297; margin: 14px 0; }
  .settingsGrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; label { display: grid; gap: 7px; font-size: 12px; } .storageSetting, .pythonSetting, .modelSetting { grid-column: 1 / -1; div { display: flex; gap: 8px; input { flex: 1; } button { flex-shrink: 0; } } } }
  .detectedPath { overflow-wrap: anywhere; color: #647088; }
  input:not([type=checkbox]), select, textarea { min-width: 0; box-sizing: border-box; border: 1px solid #dce2ec; background: #fbfcfe; color: inherit; border-radius: 7px; padding: 9px; font: inherit; font-size: 12px; }
  .environmentActions, .importActions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 15px; }
  .importActions { margin-top: 0; label, > span { font-size: 12px; color: #7c8798; } }
  .installProgress { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; font-size: 12px; progress { width: 100%; } }
  .chatHint { font-size: 12px; color: #8790a1; }
  .errorText { color: #b3544f; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
  .scanSummary { margin: 20px 0 8px; font-size: 12px; }
  .candidateRow { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-top: 1px solid #f0f2f6; span { flex: 1; min-width: 0; } strong, small { display: block; overflow-wrap: anywhere; } strong { font-size: 12px; font-weight: 500; } small { margin-top: 4px; color: #8a93a3; font-size: 11px; } b { font-size: 11px; font-weight: 400; } }
  .subtitleTask { display: grid; grid-template-columns: minmax(0, 1fr) 180px; gap: 12px; padding: 16px 0; border-top: 1px solid #edf0f6; margin-top: 12px; .taskText { text-align: left; border: 0; padding: 0; strong, small { display: block; overflow-wrap: anywhere; } small { color: #8a94a5; font-size: 10px; margin-top: 5px; } } .taskStatus { font-size: 12px; progress { width: 100%; margin: 8px 0; } small { font-size: 10px; } } .taskActions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 8px; } }
  .pagination { display: flex; align-items: center; justify-content: center; gap: 15px; margin-top: 15px; font-size: 12px; }
  .subtitleEditor { width: min(1000px, 90vw); max-height: 88vh; border: 1px solid #dce2ec; border-radius: 14px; padding: 20px; color: inherit; &::backdrop { background: #18233870; } header { display: flex; justify-content: space-between; align-items: center; h3 { margin: 0 0 5px; } span { font-size: 12px; color: #8490a2; } } .editorToolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 15px 0; span { font-size: 12px; color: #a56c3b; } } video { width: 100%; max-height: 260px; background: #141a26; border-radius: 8px; } .segmentScroll { max-height: 40vh; overflow: auto; table { width: 100%; border-collapse: collapse; th, td { padding: 7px 5px; text-align: left; font-size: 11px; vertical-align: top; border-bottom: 1px solid #edf0f5; } input { width: 85px; } textarea { width: 100%; min-width: 240px; resize: vertical; } } } .reviewRecords { margin-top: 18px; font-size: 12px; > div { margin-top: 10px; padding: 10px; background: #f5f6fa; border-radius: 7px; } span, del, ins { display: block; margin-bottom: 4px; } del { color: #a56d68; } ins { color: #358168; text-decoration: none; } } }
}
</style>
