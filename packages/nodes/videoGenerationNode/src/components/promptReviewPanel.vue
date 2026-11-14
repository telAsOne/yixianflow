<template>
  <el-dialog v-model="visible" title="视频提示词审查" width="min(780px, 94vw)" appendToBody alignCenter :closeOnClickModal="false">
    <section class="promptReviewPanel nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop @wheel.stop>
      <div class="reviewHeading" role="status" aria-live="polite">
        <el-tag :type="status === 'pass' ? 'success' : ['needs_revision', 'needs_clarification'].includes(status) ? 'warning' : 'info'">编辑稿 · {{ label }}</el-tag>
        <span v-if="record">{{ new Date(record.finishedAt).toLocaleString() }}</span>
      </div>
      <p class="scopeHint">检查当前编辑稿，可结合已连接的图片、视频关键帧和音频。报告会列出实际读取的素材；视频抽帧无法覆盖完整动作。后端优化与运镜标签的隐藏展开内容不在本次范围内。生成按钮可随时使用。</p>
      <div class="reviewOptions">
        <el-checkbox v-model="includeMedia" :disabled="reviewing">结合参考素材审查</el-checkbox>
        <el-checkbox v-model="audioInput" :disabled="reviewing || !includeMedia">听取参考音频原音</el-checkbox>
        <el-select v-model="model" :disabled="reviewing" clearable filterable placeholder="审查模型：平台默认" aria-label="审查模型">
          <el-option v-for="item in models" :key="item.modelId" :label="item.label" :value="item.modelId" />
        </el-select>
      </div>
      <p class="scopeHint">请先确认审查范围和模型，再开始审查。参考音频需勾选「听取参考音频原音」并使用支持音频输入的模型；未勾选时不判断音色、情绪或口音。素材按所选模型的实际用量计费。</p>
      <p class="scopeHint">AI 一键审查会自动采用可直接执行的局部修改并复审，最多 3 轮，每轮按用量计费；遇到待确认项即停止。</p>
      <p v-if="reviewing" class="scopeHint">正在审查本次快照，期间可以继续编辑或生成。</p>
      <p v-if="run" class="scopeHint" role="status" aria-live="polite">最近一次多轮审查：{{ run.message }}</p>
      <el-alert v-if="error" :title="error" type="warning" :closable="false" showIcon />
      <el-alert v-if="record && !current" title="当前内容已变化，以下报告仅对应此前的编辑稿。采用建议前请重新审查。" type="info" :closable="false" />
      <template v-if="record?.result">
        <el-alert v-if="record.result.media_input_complete === false" title="部分素材未读取或原音未听取，报告仅覆盖文字与已读取的素材，不能视为全部素材通过。" type="warning" :closable="false" showIcon />
        <p class="reviewSummary">{{ record.result.summary }}</p>
        <p v-if="record.input.continuation" class="scopeHint">续接审查仅覆盖本次新增片段；续接素材限定为原片末尾最多 3 秒及真实末帧，实际读取见素材清单，不代表完整原片已审查。采样时间以尾部片段起点为 0 秒。</p>
        <div class="reviewTrace">审查记录 #{{ record.result.review_id }} · {{ record.result.model }}</div>
        <details v-if="record.result.media_coverage?.length" class="mediaCoverage"><summary>实际审查素材 · {{ record.result.media_coverage.length }} 项</summary>
          <p v-for="media in record.result.media_coverage" :key="media.id">{{ media.id }} · {{ coverageLabels[media.status] ?? media.status }}<template v-if="media.frame_seconds?.length"> · 采样 {{ media.frame_seconds.join('、') }} 秒</template><template v-if="media.duration_seconds"> · {{ media.duration_seconds.toFixed(2) }} 秒</template><template v-if="media.status === 'reviewed_frames'"> · 未覆盖帧间动作和视频声音</template><template v-if="media.purpose"> · {{ media.purpose }}</template></p>
        </details>
        <article v-for="issue in record.result.issues" :key="issue.id" class="reviewIssue">
          <div class="issueHeading"><el-tag size="small" :type="issue.kind === 'conflict' ? 'warning' : 'info'">{{ categoryLabels[issue.category] ?? issue.category }} · {{ issue.kind === 'conflict' ? '约束冲突' : issue.kind === 'risk' ? '生成风险' : '待确认' }}</el-tag></div>
          <button v-for="(target, index) in issue.targets" :key="`${target.source_id}:${index}`" type="button" class="sourceQuote" @click="selectedTarget = target; sourceVisible = true">{{ target.field === 'context' ? '审查背景' : '提示词' }}：{{ target.quote }} <span>查看原文</span></button>
          <p>{{ issue.reason }}</p><p class="issueImpact">可能影响：{{ issue.impact }}</p><p>建议：{{ issue.suggestion }}</p>
          <p v-for="(evidence, index) in issue.media_evidence" :key="index" class="mediaEvidence">素材证据 {{ evidence.media_id }}<template v-if="evidence.frame_seconds !== undefined"> · {{ evidence.frame_seconds }} 秒</template><template v-if="evidence.audio_start_seconds !== undefined"> · {{ evidence.audio_start_seconds }}～{{ evidence.audio_end_seconds }} 秒</template>：{{ evidence.observation }}</p>
          <details v-if="issue.edits.length" class="editPreview">
            <summary>查看修改建议</summary>
            <div v-for="(edit, index) in issue.edits" :key="index" class="editPair"><del>{{ edit.original }}</del><ins>{{ edit.replacement || '（删除此处）' }}</ins></div>
            <el-button size="small" :disabled="!current || !editable || reviewing || issue.next_action !== 'revise'" @click="emit('apply', issue.edits)">确认采用这组修改</el-button>
          </details>
          <p v-else class="scopeHint">请确认创作意图后手动修改，也可保留原文继续生成。</p>
        </article>
      </template>
      <details v-if="run" class="reviewRun">
        <summary>最近一次多轮审查记录 · {{ run.rounds.length }}/3 轮</summary>
        <details class="runRound"><summary>开始前的原稿</summary><pre>{{ run.input.editorPrompt }}</pre></details>
        <details v-for="(round, index) in run.rounds" :key="index" class="runRound">
          <summary>第 {{ index + 1 }} 轮 · {{ round.record.error ? '未完成' : round.record.result?.status === 'pass' ? '通过' : round.record.result?.status === 'needs_clarification' ? '待确认' : '有待处理项' }}</summary>
          <p v-if="round.record.result || round.record.reviewId" class="reviewTrace">审查记录 #{{ round.record.result?.review_id ?? round.record.reviewId }}<template v-if="round.record.result"> · {{ round.record.result.model }}</template></p>
          <p>{{ round.record.error || round.record.result?.summary }}</p>
          <ul v-if="round.record.result?.issues.length"><li v-for="issue in round.record.result.issues" :key="issue.id">{{ issue.reason }} 建议：{{ issue.suggestion }}</li></ul>
          <details><summary>送审提示词</summary><pre>{{ round.record.input.content }}</pre></details>
          <template v-if="round.appliedPrompt !== undefined"><p>采用修改后的节点提示词</p><pre>{{ round.appliedPrompt }}</pre></template>
        </details>
      </details>
      <p v-if="!record?.result && !error && !reviewing" class="scopeHint">点击审查后生成参考报告。审查按文本模型实际用量计费。</p>
      <p class="scopeHint">审查建议需结合创作意图核对；重试会发起新的审查请求，可能产生费用。</p>
    </section>
    <template #footer>
      <el-button @click="visible = false">返回创作</el-button>
      <el-button v-if="reviewing" @click="emit('cancel')">停止等待审查</el-button>
      <el-button v-else-if="automatic" type="primary" :disabled="!canReview || !editable" @click="emit('reviewAutomatically')">开始 AI 一键审查（按用量计费）</el-button>
      <el-button v-else type="primary" :disabled="!canReview" @click="emit('review', !!record)">{{ record ? '重新审查（按用量计费）' : '审查（按用量计费）' }}</el-button>
    </template>
  </el-dialog>
  <el-dialog v-model="sourceVisible" title="审查快照原文" width="min(780px, 94vw)" appendToBody alignCenter @opened="highlightedQuote?.scrollIntoView({ block: 'center' })">
    <p class="sourceScope">{{ current ? '报告对应当前编辑稿' : '这是此前送审的快照，当前内容可能已变化' }}</p>
    <pre class="reviewSource">{{ sourceParts.before }}<mark ref="highlightedQuote">{{ sourceParts.quote }}</mark>{{ sourceParts.after }}</pre>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { ElAlert, ElButton, ElCheckbox, ElDialog, ElOption, ElSelect, ElTag } from "element-plus";
import type { PromptReviewEdit, PromptReviewRecord, PromptReviewRun, PromptReviewTarget } from "../promptReview";

const visible = defineModel<boolean>({ default: false });
const includeMedia = defineModel<boolean>("includeMedia", { default: true });
const audioInput = defineModel<boolean>("audioInput", { default: false });
const model = defineModel<string>("model", { default: "" });
const props = defineProps<{ models: { modelId: string; label: string }[]; record?: PromptReviewRecord; run?: PromptReviewRun; automatic: boolean; current: boolean; reviewing: boolean; status: string; label: string; error: string; editable: boolean; canReview: boolean }>();
const emit = defineEmits<{ review: [force: boolean]; reviewAutomatically: []; cancel: []; apply: [edits: PromptReviewEdit[]] }>();
const sourceVisible = ref(false);
const selectedTarget = ref<PromptReviewTarget>();
const highlightedQuote = ref<HTMLElement>();
const categoryLabels: Record<string, string> = { editing: "切镜", camera: "运镜", lighting: "光影", motion: "动作", continuity: "连续性", voiceover: "配音", visual: "画面", audio: "声音", timing: "时长", reference: "素材约束" };
const coverageLabels: Record<string, string> = { reviewed_image: "已读取图片", reviewed_frames: "已读取视频关键帧", reviewed_audio: "已送入原音", audio_metadata: "未听取原音", transcript_only: "仅转写文本", unavailable: "素材未读取" };
const sourceParts = computed(() => {
  const target = selectedTarget.value;
  const source = target && props.record ? props.record.input[target.field] : "";
  const chars = Array.from(source);
  if (!target || chars.slice(target.start_char, target.end_char).join("") !== target.quote) return { before: source, quote: "", after: "" };
  return { before: chars.slice(0, target.start_char).join(""), quote: target.quote, after: chars.slice(target.end_char).join("") };
});
</script>

<style scoped lang="scss">
.promptReviewPanel {
  display: grid; gap: 12px; min-width: 0; overflow-wrap: anywhere;
  .reviewHeading { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; span { color: var(--el-text-color-secondary); font-size: 12px; } }
  .scopeHint, .reviewTrace, .issueImpact { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.65; margin: 0; }
  .reviewSummary { margin: 0; white-space: pre-wrap; line-height: 1.7; }
  .reviewOptions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; .el-select { width: 240px; max-width: 100%; } }
  .mediaCoverage { font-size: 12px; line-height: 1.7; p { margin: 6px 0; } }
  .mediaEvidence { padding: 8px; background: var(--el-fill-color-light); border-radius: 4px; font-size: 12px; }
  .reviewRun {
    border-top: 1px solid var(--el-border-color-lighter); padding-top: 12px; line-height: 1.7;
    summary { cursor: pointer; color: var(--el-color-primary); }
    .runRound { margin-top: 10px; }
    p, li { white-space: pre-wrap; overflow-wrap: anywhere; }
    pre { max-height: 240px; overflow: auto; padding: 10px; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; background: var(--el-fill-color-light); border-radius: 4px; }
  }
  .reviewIssue { border-top: 1px solid var(--el-border-color-lighter); padding-top: 14px; display: grid; gap: 10px;
    p { margin: 0; white-space: pre-wrap; line-height: 1.7; }
    .sourceQuote { display: block; width: 100%; text-align: start; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.7; padding: 8px 10px; border: 0; border-left: 3px solid var(--el-color-warning); border-radius: 4px; background: var(--el-fill-color-light); color: var(--el-text-color-primary); cursor: pointer;
      span { color: var(--el-color-primary); font-size: 12px; }
    }
    .editPreview { summary { color: var(--el-color-primary); cursor: pointer; } .editPair { display: grid; gap: 8px; margin: 10px 0; white-space: pre-wrap; del { color: var(--el-color-danger); } ins { color: var(--el-color-success); text-decoration: none; } } }
  }
}
.sourceScope { color: var(--el-text-color-secondary); font-size: 12px; }
.reviewSource { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.8; max-height: 55vh; overflow-y: auto; mark { background: var(--el-color-warning-light-7); color: var(--el-text-color-primary); } }
</style>
