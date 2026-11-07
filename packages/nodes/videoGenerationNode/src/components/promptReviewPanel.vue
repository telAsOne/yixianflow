<template>
  <el-dialog v-model="visible" title="视频提示词审查" width="min(780px, 94vw)" appendToBody alignCenter :closeOnClickModal="false">
    <section class="promptReviewPanel nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop @wheel.stop>
      <div class="reviewHeading" role="status" aria-live="polite">
        <el-tag :type="status === 'pass' ? 'success' : ['needs_revision', 'needs_clarification'].includes(status) ? 'warning' : 'info'">编辑稿 · {{ label }}</el-tag>
        <span v-if="record">{{ new Date(record.finishedAt).toLocaleString() }}</span>
      </div>
      <p class="scopeHint">检查当前节点的文字、连接文本和文字描述的素材约束。图片与视频内容、后端优化和运镜标签展开后的文本不在本次审查范围内。生成按钮可随时使用。</p>
      <p v-if="reviewing" class="scopeHint">正在审查本次快照，期间可以继续编辑或生成。</p>
      <el-alert v-if="error" :title="error" type="warning" :closable="false" showIcon />
      <el-alert v-if="record && !current" title="当前内容已变化，以下报告仅对应此前的编辑稿。采用建议前请重新审查。" type="info" :closable="false" />
      <template v-if="record?.result">
        <p class="reviewSummary">{{ record.result.summary }}</p>
        <div class="reviewTrace">审查记录 #{{ record.result.review_id }} · {{ record.result.model }}</div>
        <article v-for="issue in record.result.issues" :key="issue.id" class="reviewIssue">
          <div class="issueHeading"><el-tag size="small" :type="issue.kind === 'conflict' ? 'warning' : 'info'">{{ categoryLabels[issue.category] ?? issue.category }} · {{ issue.kind === 'conflict' ? '文字冲突' : issue.kind === 'risk' ? '生成风险' : '待确认' }}</el-tag></div>
          <button v-for="(target, index) in issue.targets" :key="`${target.source_id}:${index}`" type="button" class="sourceQuote" @click="selectedTarget = target; sourceVisible = true">{{ target.field === 'context' ? '审查背景' : '提示词' }}：{{ target.quote }} <span>查看原文</span></button>
          <p>{{ issue.reason }}</p><p class="issueImpact">可能影响：{{ issue.impact }}</p><p>建议：{{ issue.suggestion }}</p>
          <details v-if="issue.edits.length" class="editPreview">
            <summary>查看修改建议</summary>
            <div v-for="(edit, index) in issue.edits" :key="index" class="editPair"><del>{{ edit.original }}</del><ins>{{ edit.replacement || '（删除此处）' }}</ins></div>
            <el-button size="small" :disabled="!current || !editable || reviewing || issue.next_action !== 'revise'" @click="emit('apply', issue.edits)">确认采用这组修改</el-button>
          </details>
          <p v-else class="scopeHint">请确认创作意图后手动修改，也可保留原文继续生成。</p>
        </article>
      </template>
      <p v-else-if="!error && !reviewing" class="scopeHint">点击审查后生成参考报告。审查按文本模型实际用量计费。</p>
      <p class="scopeHint">审查建议需结合创作意图核对；重试会发起新的审查请求，可能产生费用。</p>
    </section>
    <template #footer>
      <el-button @click="visible = false">返回创作</el-button>
      <el-button v-if="reviewing" @click="emit('cancel')">停止等待审查</el-button>
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
import { ElAlert, ElButton, ElDialog, ElTag } from "element-plus";
import type { PromptReviewEdit, PromptReviewRecord, PromptReviewTarget } from "../promptReview";

const visible = defineModel<boolean>({ default: false });
const props = defineProps<{ record?: PromptReviewRecord; current: boolean; reviewing: boolean; status: string; label: string; error: string; editable: boolean; canReview: boolean }>();
const emit = defineEmits<{ review: [force: boolean]; cancel: []; apply: [edits: PromptReviewEdit[]] }>();
const sourceVisible = ref(false);
const selectedTarget = ref<PromptReviewTarget>();
const highlightedQuote = ref<HTMLElement>();
const categoryLabels: Record<string, string> = { editing: "切镜", camera: "运镜", lighting: "光影", motion: "动作", continuity: "连续性", voiceover: "配音", visual: "画面", audio: "声音", timing: "时长", reference: "素材约束" };
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
