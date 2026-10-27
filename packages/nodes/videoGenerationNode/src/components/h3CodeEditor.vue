<template>
  <div class="h3CodeEditor" :style="{ maxHeight }">
    <div ref="highlight" class="codeHighlight" aria-hidden="true"><template v-for="(part, index) in parts" :key="index"><span v-if="part.category" :data-category="part.category">{{ part.text }}</span><template v-else>{{ part.text }}</template></template>{{ '\n' }}</div>
    <textarea ref="input" v-model="prompt" :disabled="disabled" :rows="Math.min(24, Math.max(10, prompt.split('\n').length))" aria-label="H3 提示词代码" spellcheck="false" @scroll="syncScroll" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { h3PromptTokens } from "../h3Prompt";

defineProps<{ disabled?: boolean; maxHeight: string }>();
const prompt = defineModel<string>({ required: true });
const input = ref<HTMLTextAreaElement>();
const highlight = ref<HTMLElement>();
defineExpose({
  getSelection() {
    const element = input.value;
    if (!element) return;
    const { selectionStart: start, selectionEnd: end, selectionDirection } = element;
    return selectionDirection === "backward" ? { anchor: end, focus: start } : { anchor: start, focus: end };
  },
  restoreSelection({ anchor, focus }: { anchor: number; focus: number }) {
    input.value?.focus({ preventScroll: true });
    input.value?.setSelectionRange(Math.min(anchor, focus), Math.max(anchor, focus), anchor > focus ? "backward" : "forward");
    syncScroll();
  },
});
const parts = computed(() => {
  const result: { text: string; category?: string }[] = [];
  let offset = 0;
  for (const token of h3PromptTokens(prompt.value)) {
    result.push({ text: prompt.value.slice(offset, token.index) }, { text: token.value, category: token.category });
    offset = token.index + token.value.length;
  }
  result.push({ text: prompt.value.slice(offset) });
  return result;
});
function syncScroll() {
  if (!input.value || !highlight.value) return;
  highlight.value.scrollTop = input.value.scrollTop;
  highlight.value.scrollLeft = input.value.scrollLeft;
}
watch(prompt, () => nextTick(syncScroll));
</script>

<style scoped lang="scss">
.h3CodeEditor {
  position: relative; display: flex; min-height: 0; overflow: hidden;
  border: 1px solid var(--el-border-color-light); border-radius: 10px; background: var(--el-bg-color);
  &:focus-within { border-color: #a78bfa; box-shadow: 0 0 0 1px #a78bfa; }
  .codeHighlight, textarea {
    box-sizing: border-box; width: 100%; margin: 0; padding: 12px 16px; border: 0;
    font: 13px / 1.7 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", "Microsoft YaHei", monospace;
    white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; tab-size: 4; scrollbar-gutter: stable;
  }
  .codeHighlight {
    position: absolute; inset: 0; overflow: hidden; pointer-events: none; color: var(--el-text-color-primary);
    [data-category="picture"], [data-category="video"], [data-category="audio"] { color: var(--h3MediaColor); }
    [data-category="subject"] { color: var(--h3SubjectColor); }
    [data-category="dialogue"] { color: var(--h3DialogueColor); }
    [data-category="speaker"], [data-category="shot"], [data-category="task"], [data-category="transition"] { color: var(--h3SpecColor); }
    [data-category="section"] { color: var(--el-text-color-secondary); }
    [data-category="missing"] { color: var(--el-color-danger); }
  }
  textarea {
    position: relative; min-width: 0; min-height: 220px; max-height: inherit; overflow: auto; resize: none; outline: none;
    color: transparent; -webkit-text-fill-color: transparent; caret-color: var(--el-text-color-primary); background: transparent;
    &::selection { background: #a78bfa40; }
    &:disabled { cursor: not-allowed; }
  }
  @media (min-width: 1920px) { .codeHighlight, textarea { font-size: 15px; } }
}
</style>
