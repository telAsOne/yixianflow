<template>
  <section class="conversationWorkspace">
    <aside class="historySidebar">
      <div class="historyHeading">
        <strong>对话记录</strong>
        <span>{{ sessions.length }}</span>
      </div>
      <button class="newChatButton" :disabled="!authorized || running" @click="$emit('newChat')">
        <icon-plus :size="17" />
        新建对话
        <span>+</span>
      </button>
      <label class="historySearch">
        <icon-search :size="15" />
        <input v-model="query" aria-label="搜索历史会话" placeholder="搜索对话…" />
      </label>
      <div class="sessionList">
        <div v-if="!filtered.length" class="historyEmpty">{{ query ? "没有匹配的历史会话" : "新对话会自动保存在这里" }}</div>
        <template v-for="(session, index) in filtered" :key="session.id">
          <div v-if="!index || day(session.updatedAt) !== day(filtered[index - 1].updatedAt)" class="historyDay">
            {{ day(session.updatedAt) }}
          </div>
          <div class="sessionItem" :class="{ active: session.id === activeId }">
            <button class="sessionSelect" :disabled="running" @click="$emit('selectChat', session.id)">
              <icon-message-circle :size="16" />
              <div>
                <strong>{{ session.title }}</strong>
                <small>{{ session.preview || "开始一段新的对话" }}</small>
              </div>
            </button>
            <div class="sessionActions">
              <button aria-label="重命名会话" :disabled="running" @click="renameSession = session"><icon-pencil :size="13" /></button>
              <button aria-label="删除会话" :disabled="running" @click="deleteSession = session"><icon-trash :size="13" /></button>
            </div>
          </div>
        </template>
      </div>
      <div class="historyFoot">
        <icon-lock :size="13" />
        <span>保存在本机 · 按绑定账户隔离</span>
      </div>
    </aside>
    <div class="conversationMain">
      <header>
        <div class="conversationTitle">
          <span class="assistantIcon"><icon-sparkles :size="19" /></span>
          <div>
            <h2>{{ activeSession?.title || "本机 AI 助手" }}</h2>
            <p>
              <span :class="{ ready }"></span>
              {{ owner || "尚未绑定账户" }}
              <i>·</i>
              {{ ready ? "本机已就绪" : "等待连接或授权" }}
            </p>
          </div>
        </div>
        <span class="savedState">
          <icon-device-floppy :size="14" />
          自动保存
        </span>
      </header>
      <div ref="scrollArea" class="messagesArea">
        <div class="messageColumn">
          <div v-if="!entries.length" class="chatWelcome">
            <span><icon-sparkles :size="31" :strokeWidth="1.5" /></span>
            <h2>在本机，把想法变成行动</h2>
            <p>
              从一段对话开始，协助你处理本机文件和工具。
              <br />
              需要授权的操作，会先在这里与你确认。
            </p>
          </div>
          <chatMessage
            v-for="(entry, index) in entries"
            :key="index"
            :entry="entry"
            @copy="$emit('copy', $event)"
            @openLink="$emit('openLink', $event)" />
          <div v-if="running" class="workingState">
            <span></span>
            <span></span>
            <span></span>
            <p>正在响应或执行本机工具</p>
          </div>
        </div>
      </div>
      <div class="composerArea">
        <form @submit.prevent="submit">
          <textarea
            ref="composer"
            v-model="draft"
            :disabled="!ready || running"
            :maxlength="32000"
            rows="2"
            aria-label="发送给本机智能体的消息"
            :placeholder="ready ? '发送消息，或描述你想在本机完成的任务…' : '连接并授权本机后开始对话…'"
            @input="resizeComposer"
            @keydown="composerKeydown"></textarea>
          <div class="composerActions">
            <span>
              <icon-device-desktop :size="14" />
              在当前设备执行
            </span>
            <button v-if="running" type="button" class="stopButton" @click="$emit('stop')">
              <icon-player-stop :size="15" />
              停止
            </button>
            <button v-else class="sendButton" :disabled="!ready || !draft.trim()" aria-label="发送消息">
              <icon-arrow-up :size="18" />
            </button>
          </div>
        </form>
        <p class="composerHint">
          Enter 发送 · Shift + Enter 换行
          <span>文件和命令仍受本机授权约束</span>
        </p>
      </div>
    </div>
    <actionDialog
      :open="!!renameSession"
      title="重命名对话"
      description="为这段会话设置一个方便查找的名称。"
      input
      :initialValue="renameSession?.title"
      confirmLabel="保存名称"
      @close="renameSession = undefined"
      @confirm="renameChat" />
    <actionDialog
      :open="!!deleteSession"
      title="删除这段对话？"
      description="会删除这段会话的本机聊天记录；已执行的文件和命令不会撤销，诊断日志继续保留。"
      :details="deleteSession?.title"
      confirmLabel="删除会话"
      danger
      @close="deleteSession = undefined"
      @confirm="removeChat" />
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import {
  IconArrowUp,
  IconDeviceDesktop,
  IconDeviceFloppy,
  IconLock,
  IconMessageCircle,
  IconPencil,
  IconPlayerStop,
  IconPlus,
  IconSearch,
  IconSparkles,
  IconTrash,
} from "@tabler/icons-vue";
import type { HelperChatEntry, HelperConversation } from "../src/controlProtocol";
import chatMessage from "./chatMessage.vue";
import actionDialog from "./actionDialog.vue";
const props = defineProps<{
  entries: HelperChatEntry[];
  sessions: HelperConversation[];
  activeId?: string | null;
  running: boolean;
  ready: boolean;
  authorized: boolean;
  owner?: string;
}>();
const emit = defineEmits<{
  send: [text: string];
  stop: [];
  newChat: [];
  selectChat: [id: string];
  renameChat: [id: string, title: string];
  deleteChat: [id: string];
  copy: [text: string];
  openLink: [url: string];
}>();
const draft = ref("");
const query = ref("");
const scrollArea = ref<HTMLElement>();
const composer = ref<HTMLTextAreaElement>();
const renameSession = ref<HelperConversation>();
const deleteSession = ref<HelperConversation>();
const activeSession = computed(() => props.sessions.find((item) => item.id === props.activeId));
const filtered = computed(() =>
  props.sessions.filter((item) => `${item.title} ${item.preview}`.toLowerCase().includes(query.value.toLowerCase())),
);
function day(value: number) {
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString() ? "今天" : date.toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}
function submit() {
  if (!props.ready || props.running || !draft.value.trim()) return;
  emit("send", draft.value.trim());
  draft.value = "";
  nextTick(resizeComposer);
}
function composerKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
}
function resizeComposer() {
  if (composer.value) {
    composer.value.style.height = "auto";
    composer.value.style.height = `${Math.min(160, composer.value.scrollHeight)}px`;
  }
}
function renameChat(value: string) {
  if (renameSession.value) emit("renameChat", renameSession.value.id, value);
  renameSession.value = undefined;
}
function removeChat() {
  if (deleteSession.value) emit("deleteChat", deleteSession.value.id);
  deleteSession.value = undefined;
}
watch(
  () => [props.entries.length, props.running, props.activeId],
  async () => {
    await nextTick();
    if (scrollArea.value) scrollArea.value.scrollTop = scrollArea.value.scrollHeight;
  },
);
</script>
<style scoped lang="scss">
.conversationWorkspace {
  display: grid;
  grid-template-columns: 238px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border: 1px solid #e4dfec;
  border-radius: 15px;
  background: #fff;
  box-shadow: 0 6px 20px #2f174704;
  .historySidebar {
    background: #faf8fd;
    border-right: 1px solid #e9e3f0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 22px 12px 0;
    .historyHeading {
      display: flex;
      justify-content: space-between;
      padding: 0 9px 18px;
      font-size: 13px;
      strong {
        font-weight: 600;
        color: #4c425f;
      }
      span {
        color: #8c7d9f;
        background: #eee8f7;
        border-radius: 5px;
        padding: 1px 6px;
        font-size: 11px;
      }
    }
    .newChatButton {
      display: flex;
      align-items: center;
      gap: 8px;
      background: #fff;
      border: 1px solid #dcd1ed;
      color: #7953b7;
      padding: 10px 11px;
      border-radius: 8px;
      font-size: 12px;
      box-shadow: 0 2px 4px #7654a807;
      span {
        margin-left: auto;
        color: #ae9bc8;
      }
    }
    .historySearch {
      display: flex;
      align-items: center;
      gap: 7px;
      margin: 18px 7px 8px;
      color: #9588a5;
      input {
        border: 0;
        background: transparent;
        min-width: 0;
        width: 100%;
        outline: none;
        font-size: 11px;
        color: #6f617f;
        &::placeholder {
          color: #8d809e;
        }
      }
    }
    .sessionList {
      flex: 1;
      overflow: auto;
      padding-bottom: 20px;
      .historyEmpty {
        color: #8c7b9c;
        font-size: 11px;
        text-align: center;
        line-height: 1.8;
        padding: 30px 5px;
      }
      .historyDay {
        font-size: 10px;
        letter-spacing: 0.5px;
        color: #8a7e99;
        padding: 19px 8px 8px;
      }
      .sessionItem {
        position: relative;
        border: 1px solid transparent;
        border-radius: 9px;
        margin: 3px 0;
        .sessionSelect {
          border: 0;
          background: transparent;
          display: flex;
          align-items: flex-start;
          gap: 9px;
          padding: 12px 9px;
          width: 100%;
          text-align: left;
          color: #8e7aa4;
          > svg {
            flex-shrink: 0;
            margin-top: 2px;
          }
          div {
            min-width: 0;
            flex: 1;
            strong {
              display: block;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
              font-size: 12px;
              color: #61556f;
              font-weight: 500;
              padding-right: 28px;
            }
            small {
              display: block;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
              font-size: 10px;
              color: #8e819e;
              margin-top: 7px;
            }
          }
        }
        .sessionActions {
          position: absolute;
          top: 12px;
          right: 6px;
          display: none;
          gap: 1px;
          button {
            display: flex;
            border: 0;
            background: #eee7f8;
            color: #8e72af;
            padding: 3px;
            border-radius: 4px;
          }
        }
        &:hover,
        &:focus-within {
          background: #f0eaf8;
          .sessionActions {
            display: flex;
          }
        }
        &.active {
          background: #ede5f9;
          border-color: #e0d3f0;
          .sessionSelect strong {
            color: #7550a8;
          }
        }
      }
    }
    .historyFoot {
      font-size: 10px;
      color: #8b7f9a;
      display: flex;
      align-items: center;
      gap: 5px;
      border-top: 1px solid #e9e3f0;
      padding: 17px 5px;
      white-space: nowrap;
    }
  }
  .conversationMain {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    > header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 27px;
      border-bottom: 1px solid #eee9f4;
      min-height: 80px;
      .conversationTitle {
        display: flex;
        align-items: center;
        gap: 11px;
        min-width: 0;
        .assistantIcon {
          display: flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, #8e6bd2, #6950b8);
          color: #fff;
          width: 36px;
          height: 36px;
          border-radius: 12px;
        }
        > div {
          min-width: 0;
        }
        h2 {
          font-size: 14px;
          color: #44384f;
          margin: 0;
          font-weight: 600;
          text-overflow: ellipsis;
          white-space: nowrap;
          overflow: hidden;
          max-width: 330px;
        }
        p {
          display: flex;
          align-items: center;
          gap: 7px;
          color: #85768f;
          font-size: 10px;
          margin: 7px 0 0;
          span {
            width: 5px;
            height: 5px;
            background: #b2a6bf;
            border-radius: 50%;
            &.ready {
              background: #4aab89;
            }
          }
          i {
            font-style: normal;
            color: #b5a7c2;
          }
        }
      }
      .savedState {
        display: flex;
        align-items: center;
        gap: 5px;
        color: #8b7d9a;
        font-size: 10px;
        white-space: nowrap;
      }
    }
    .messagesArea {
      min-height: 0;
      flex: 1;
      overflow: auto;
      overscroll-behavior: contain;
      .messageColumn {
        max-width: 850px;
        padding: 0 28px 22px;
        margin: 0 auto;
        .chatWelcome {
          padding: 62px 20px;
          text-align: center;
          > span {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 65px;
            height: 65px;
            color: #8761c2;
            background: #f1ebfa;
            border-radius: 23px;
            margin-bottom: 22px;
          }
          h2 {
            font-size: 22px;
            font-weight: 550;
            color: #52415f;
            letter-spacing: -0.5px;
            margin: 0 0 14px;
          }
          p {
            font-size: 12px;
            color: #8c7a9c;
            line-height: 2;
          }
        }
        .workingState {
          display: flex;
          align-items: center;
          gap: 4px;
          margin: 25px 0 18px 45px;
          > span {
            width: 5px;
            height: 5px;
            background: #af96cb;
            border-radius: 50%;
            animation: breathe 1.2s infinite;
            &:nth-child(2) {
              animation-delay: 0.15s;
            }
            &:nth-child(3) {
              animation-delay: 0.3s;
            }
          }
          p {
            margin: 0 0 0 8px;
            color: #8b779f;
            font-size: 11px;
          }
        }
      }
    }
    .composerArea {
      padding: 14px 27px 16px;
      max-width: 906px;
      margin: 0 auto;
      width: 100%;
      background: linear-gradient(#fff9, #fff 25%);
      form {
        border: 1px solid #dcd0ed;
        border-radius: 13px;
        box-shadow: 0 3px 12px #5b357008;
        padding: 13px 14px 10px;
        transition: box-shadow 0.15s;
        &:focus-within {
          border-color: #aa8ad3;
          box-shadow: 0 0 0 3px #e9dff74a;
        }
        textarea {
          width: 100%;
          resize: none;
          border: 0;
          background: transparent;
          outline: none;
          font-size: 13px;
          line-height: 1.8;
          color: #51425e;
          max-height: 160px;
          min-height: 50px;
          &::placeholder {
            color: #8a7d98;
          }
        }
        .composerActions {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-top: 6px;
          > span {
            display: flex;
            align-items: center;
            gap: 5px;
            color: #9a8ba6;
            font-size: 10px;
          }
          button {
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 8px;
            border: 0;
          }
          .sendButton {
            background: #8055be;
            color: white;
            width: 32px;
            height: 32px;
            &:disabled {
              background: #e5dbef;
              color: #ad97c5;
            }
          }
          .stopButton {
            gap: 6px;
            border: 1px solid #e3d8ed;
            color: #8e6aac;
            background: #fff;
            padding: 8px 10px;
            font-size: 11px;
          }
        }
      }
      .composerHint {
        display: flex;
        justify-content: space-between;
        color: #95879f;
        font-size: 9px;
        margin: 11px 2px 0;
      }
    }
  }
}
@keyframes breathe {
  50% {
    opacity: 0.25;
  }
}
@media (max-width: 1080px) {
  .conversationWorkspace {
    grid-template-columns: 205px minmax(0, 1fr);
    .conversationMain {
      > header {
        padding: 17px 20px;
        .savedState {
          display: none;
        }
      }
      .messagesArea .messageColumn {
        padding-right: 20px;
        padding-left: 20px;
      }
      .composerArea {
        padding-right: 20px;
        padding-left: 20px;
        .composerHint span {
          display: none;
        }
      }
    }
  }
}
@media (prefers-reduced-motion: reduce) {
  * {
    animation: none !important;
  }
}
</style>
