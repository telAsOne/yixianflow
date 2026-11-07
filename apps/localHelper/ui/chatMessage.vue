<template>
  <details v-if="entry.role === 'tool'" class="toolCard">
    <summary>
      <icon-terminal-2 :size="16" />
      <span>{{ entry.text.startsWith("正在执行：") ? "调用本机工具 · " + entry.text.slice(5) : "工具执行结果" }}</span>
      <icon-chevron-down :size="14" />
    </summary>
    <pre>{{ entry.text }}</pre>
  </details>
  <article v-else class="messageItem" :class="entry.role">
    <div v-if="entry.role !== 'user'" class="messageAvatar">
      <icon-sparkles v-if="entry.role === 'assistant'" :size="19" />
      <icon-alert-circle v-else :size="19" />
    </div>
    <div class="messageContent">
      <div class="messageMeta">
        <strong>{{ entry.role === "user" ? "你" : entry.role === "assistant" ? "UnionFlow" : "执行提示" }}</strong>
        <time>{{ new Date(entry.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) }}</time>
        <button aria-label="复制消息" @click="$emit('copy', entry.text)"><icon-copy :size="14" /></button>
      </div>
      <div v-if="entry.role === 'assistant'" class="markdownBody" @click="openLink" v-html="html"></div>
      <div v-else class="plainText">{{ entry.text }}</div>
    </div>
  </article>
</template>
<script setup lang="ts">
import { computed } from "vue";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { IconAlertCircle, IconChevronDown, IconCopy, IconSparkles, IconTerminal2 } from "@tabler/icons-vue";
import type { HelperChatEntry } from "../src/controlProtocol";
const props = defineProps<{ entry: HelperChatEntry }>();
const emit = defineEmits<{ copy: [text: string]; openLink: [url: string] }>();
const html = computed(() =>
  DOMPurify.sanitize(marked.parse(props.entry.text, { async: false, breaks: true }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img", "video", "audio", "iframe", "style", "form", "input", "button"],
    FORBID_ATTR: ["style", "src", "srcset", "target"],
  }),
);
function openLink(event: MouseEvent) {
  const link = event.target instanceof Element ? event.target.closest("a") : null;
  if (!link) return;
  event.preventDefault();
  if (/^https?:\/\//i.test(link.href)) emit("openLink", link.href);
}
</script>
<style scoped lang="scss">
.messageItem {
  display: flex;
  gap: 13px;
  margin: 26px 0;
  .messageAvatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    border-radius: 11px;
    color: #7857c4;
    background: #eee8fb;
    margin-top: 2px;
  }
  .messageContent {
    min-width: 0;
    max-width: calc(100% - 45px);
    .messageMeta {
      display: flex;
      gap: 10px;
      align-items: center;
      margin-bottom: 10px;
      font-size: 12px;
      strong {
        font-weight: 600;
        color: #454056;
      }
      time {
        font-size: 11px;
        color: #8e879c;
      }
      button {
        display: flex;
        border: 0;
        background: transparent;
        color: #8c839c;
        opacity: 0;
        margin-left: auto;
      }
    }
    .plainText {
      font-size: 14px;
      line-height: 1.85;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: #4d465b;
    }
    .markdownBody {
      font-size: 14px;
      line-height: 1.95;
      color: #4e485c;
      overflow-wrap: anywhere;
      :deep(p) {
        margin: 0 0 13px;
        &:last-child {
          margin-bottom: 0;
        }
      }
      :deep(h1),
      :deep(h2),
      :deep(h3) {
        color: #302c3c;
        line-height: 1.6;
        margin: 20px 0 12px;
        font-size: 17px;
      }
      :deep(ul),
      :deep(ol) {
        padding-left: 24px;
      }
      :deep(code) {
        background: #f1edf8;
        color: #7850a7;
        padding: 2px 6px;
        border-radius: 5px;
        font:
          0.88em/1.8 Consolas,
          monospace;
      }
      :deep(pre) {
        background: #262333;
        color: #e8e0f7;
        border-radius: 11px;
        padding: 17px 19px;
        overflow: auto;
        font-size: 12px;
        code {
          background: transparent;
          color: inherit;
          padding: 0;
        }
      }
      :deep(table) {
        display: block;
        max-width: 100%;
        overflow: auto;
        border-collapse: collapse;
        font-size: 12px;
        th,
        td {
          padding: 9px 13px;
          border: 1px solid #e7e1ee;
          text-align: left;
        }
        th {
          background: #f5f1fa;
        }
      }
      :deep(blockquote) {
        margin-left: 0;
        padding-left: 15px;
        border-left: 3px solid #b49adf;
        color: #7c708e;
      }
      :deep(a) {
        color: #7950c6;
        text-decoration-color: #c3b0e5;
        text-underline-offset: 3px;
      }
    }
  }
  &:hover,
  &:focus-within {
    .messageMeta button {
      opacity: 1;
    }
  }
  &.user {
    justify-content: flex-end;
    .messageContent {
      max-width: 83%;
      background: #eee8fb;
      border: 1px solid #e5daf7;
      border-radius: 15px 15px 4px 15px;
      padding: 15px 19px;
      .messageMeta {
        strong {
          color: #7653ad;
        }
      }
    }
  }
  &.error {
    .messageAvatar {
      background: #fff0e9;
      color: #b87542;
    }
    .messageContent {
      background: #fff8f1;
      border: 1px solid #f4e5d7;
      border-radius: 11px;
      padding: 13px 16px;
      .plainText {
        color: #946942;
        font-size: 13px;
      }
    }
  }
}
.toolCard {
  margin: 10px 0 10px 45px;
  border: 1px solid #e9e4f0;
  border-radius: 9px;
  background: #fcfbfe;
  summary {
    display: flex;
    gap: 9px;
    align-items: center;
    list-style: none;
    cursor: pointer;
    color: #7c6e93;
    font-size: 12px;
    padding: 12px 14px;
    span {
      flex: 1;
    }
  }
  pre {
    margin: 0;
    padding: 15px;
    font:
      11px/1.8 Consolas,
      "Microsoft YaHei UI",
      monospace;
    background: #f6f3fa;
    max-height: 300px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: #696074;
    border-top: 1px solid #e9e4f0;
  }
}
</style>
