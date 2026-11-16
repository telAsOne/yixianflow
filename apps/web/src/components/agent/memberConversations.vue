<template>
  <section class="memberConversations" aria-label="成员 AI 对话记录">
    <header class="agentMenu">
      <div class="recordTitle"><icon-users :size="17" aria-hidden="true" /><span>成员对话</span><span class="readOnlyBadge"><icon-eye :size="12" aria-hidden="true" />只读</span></div>
      <div class="menuActions"><slot name="actions" /></div>
    </header>
    <div class="recordSelectors">
      <div class="recordField">
        <span>成员</span>
        <el-select v-model="userId" aria-label="选择成员" :loading="membersLoading">
          <el-option v-for="member in members" :key="member.userId" :value="member.userId" :label="member.name || `用户 ${member.userId}`" />
        </el-select>
      </div>
      <div class="recordField">
        <span>对话</span>
        <el-select v-model="sessionFile" aria-label="选择历史对话" :loading="historyLoading">
          <el-option v-for="item in history" :key="item.file" :value="item.file" :label="`${item.name} · ${new Date(item.modified).toLocaleString()}`" />
        </el-select>
      </div>
      <div class="recordActions">
        <el-button text size="small" :loading="historyLoading" @click="refresh"><icon-refresh :size="14" aria-hidden="true" />刷新记录</el-button>
        <el-button v-if="historyOffset !== undefined" text size="small" :loading="historyLoading" @click="loadHistory(true)"><icon-history :size="14" aria-hidden="true" />更多历史</el-button>
        <span v-if="session?.running" class="runningStatus" role="status"><i aria-hidden="true" />正在回复 · 自动更新</span>
      </div>
    </div>
    <p v-if="error" class="recordError" role="alert">{{ error }}</p>
    <div v-if="session" class="recordNavigation">
      <div class="sessionTitle"><icon-message-circle :size="15" aria-hidden="true" /><strong>{{ session.name }}</strong></div>
      <el-button v-if="session.parentFile" text size="small" @click="sessionFile = session.parentFile">返回主对话</el-button>
      <el-button v-for="child in session.subAgents" :key="child.file" text size="small" @click="sessionFile = child.file">{{ child.name }}</el-button>
    </div>
    <div ref="transcript" class="recordMessages" role="region" aria-label="成员对话内容" tabindex="0">
      <el-button v-if="before" text :loading="earlierLoading" @click="loadEarlier">加载更早的消息</el-button>
      <article v-for="message in messages" :key="message.id" class="recordMessage" :class="{ userMessage: message.role === 'user' }">
        <div class="messageIdentity"><span class="messageAvatar" aria-hidden="true"><icon-user v-if="message.role === 'user'" :size="13" /><icon-sparkles v-else :size="13" /></span><strong>{{ message.role === 'user' ? members.find(member => member.userId === userId)?.name || `用户 ${userId}` : 'AI' }}</strong></div>
        <div class="recordContent">
          <mentionContent v-if="message.role === 'user'" :content="message.content" :mentions="message.mentions" :directory="directory" />
          <template v-for="part in message.parts" :key="part.id">
            <messageMarkdown v-if="part.type === 'text' && part.content" :content="part.content" :directory="directory" :streaming="!!message.streaming" />
            <details v-else-if="part.type === 'thinking' && part.content"><summary>思考</summary><messageMarkdown :content="part.content" :directory="directory" /></details>
            <toolMessage v-else-if="part.type === 'tool'" :tool="part.tool" :directory="directory" :readOnly="true" @copy="copyRecord" />
          </template>
          <attachmentList v-if="message.attachments?.length" :attachments="message.attachments" :directory="directory" />
          <p v-if="message.error" class="recordError">{{ message.error }}</p>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import axios from "axios";
import api, { errorMessage } from "@/lib/api";
import { useCollaborationStore } from "@/stores/collaboration";
import { webUserId } from "@/lib/webRuntime";
import { writeClipboardText } from "@/lib/clipboard";
import messageMarkdown from "@/components/messageMarkdown.vue";
import mentionContent from "./mentionContent.vue";
import attachmentList from "./attachmentList.vue";
import toolMessage from "./toolMessage.vue";
import type { AgentConversation, AgentHistory, AgentMessage } from "./types";

const props = defineProps<{ active: boolean }>();
const collaboration = useCollaborationStore();
const directory = computed(() => collaboration.projectId);
const members = ref<{ userId: number; name: string }[]>([]);
const membersLoading = ref(false);
const userId = ref<number>();
const history = ref<AgentHistory[]>([]);
const historyOffset = ref<number>();
const historySnapshot = ref<string>();
const historyLoading = ref(false);
const sessionFile = ref("");
const session = ref<AgentConversation>();
const earlier = ref<AgentMessage[]>([]);
const before = ref<string>();
const earlierLoading = ref(false);
const error = ref("");
const transcript = ref<HTMLElement>();
const refreshVersion = ref(0);
const messages = computed(() => {
  const latest = session.value?.messages ?? [];
  const ids = new Set(latest.map(message => message.id));
  return [...earlier.value.filter(message => !ids.has(message.id)), ...latest];
});
let historyController: AbortController | undefined;
let sessionController: AbortController | undefined;

watch([() => props.active, directory], async ([active, id], previous, onCleanup) => {
  if (id !== previous?.[1]) { members.value = []; userId.value = undefined; }
  if (!active || !id) return;
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  membersLoading.value = true;
  try {
    const { data } = await api.get<{ data: typeof members.value }>("/api/agent/members", { params: { directory: id }, signal: controller.signal });
    if (controller.signal.aborted) return;
    members.value = data.data;
    if (!members.value.some(member => member.userId === userId.value)) userId.value = members.value.find(member => member.userId === webUserId.value)?.userId ?? members.value[0]?.userId;
  } catch (cause) { if (!controller.signal.aborted) error.value = errorMessage(cause, "读取成员失败"); }
  finally { if (!controller.signal.aborted) membersLoading.value = false; }
}, { immediate: true });

async function loadHistory(more = false) {
  const controller = historyController;
  if (!controller || controller.signal.aborted || !userId.value || historyLoading.value) return;
  historyLoading.value = true;
  try {
    const { data } = await api.get<{ data: { items: AgentHistory[]; nextOffset?: number; snapshot?: string } }>("/api/agent/list", {
      params: { directory: directory.value, userId: userId.value, offset: more ? historyOffset.value : 0, snapshot: more ? historySnapshot.value : undefined }, signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    history.value = more ? [...history.value, ...data.data.items.filter(item => !history.value.some(known => known.file === item.file))] : data.data.items;
    historyOffset.value = data.data.nextOffset;
    historySnapshot.value = data.data.snapshot;
    if (!sessionFile.value) sessionFile.value = history.value[0]?.file ?? "";
    error.value = "";
  } catch (cause) { if (!controller.signal.aborted) error.value = errorMessage(cause, "读取历史对话失败"); }
  finally { if (!controller.signal.aborted) historyLoading.value = false; }
}

watch([() => props.active, directory, userId], ([active, id, member], _previous, onCleanup) => {
  history.value = []; sessionFile.value = ""; historyOffset.value = undefined; historySnapshot.value = undefined; historyLoading.value = false; error.value = "";
  historyController = undefined;
  if (!active || !id || !member) return;
  const controller = new AbortController();
  historyController = controller;
  onCleanup(() => controller.abort());
  void loadHistory();
}, { immediate: true });

watch([() => props.active, directory, userId, sessionFile, refreshVersion], ([active, id, member, file], _previous, onCleanup) => {
  session.value = undefined; earlier.value = []; before.value = undefined; earlierLoading.value = false;
  sessionController = undefined;
  if (!active || !id || !member || !file) return;
  const controller = new AbortController();
  sessionController = controller;
  let timer: ReturnType<typeof setTimeout>;
  onCleanup(() => { controller.abort(); clearTimeout(timer); });
  const update = async () => {
    try {
      const element = transcript.value;
      const followLatest = !element || element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      const { data } = await api.get<{ data: AgentConversation }>("/api/agent/get", { params: { directory: id, userId: member, sessionFile: file, page: true }, signal: controller.signal });
      if (controller.signal.aborted) return;
      session.value = data.data;
      if (!earlier.value.length) before.value = data.data.before;
      error.value = "";
      await nextTick();
      if (!controller.signal.aborted && followLatest && element) element.scrollTop = element.scrollHeight;
    } catch (cause) {
      if (controller.signal.aborted) return;
      error.value = errorMessage(cause, "读取成员对话失败");
      if (axios.isAxiosError(cause) && [401, 403, 404].includes(cause.response?.status ?? 0)) { session.value = undefined; earlier.value = []; return; }
    }
    if (!controller.signal.aborted) timer = setTimeout(update, session.value?.running ? 2000 : 10000);
  };
  void update();
}, { immediate: true });

async function loadEarlier() {
  const controller = sessionController;
  if (!controller || controller.signal.aborted || !before.value || earlierLoading.value) return;
  earlierLoading.value = true;
  try {
    const { data } = await api.get<{ data: AgentConversation }>("/api/agent/get", {
      params: { directory: directory.value, userId: userId.value, sessionFile: sessionFile.value, page: true, before: before.value }, signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    const ids = new Set(earlier.value.map(message => message.id));
    earlier.value = [...data.data.messages.filter(message => !ids.has(message.id)), ...earlier.value];
    before.value = data.data.before;
  } catch (cause) { if (!controller.signal.aborted) error.value = errorMessage(cause, "读取更早的消息失败"); }
  finally { if (!controller.signal.aborted) earlierLoading.value = false; }
}

function refresh() { void loadHistory(); refreshVersion.value++; }
async function copyRecord(content: string) {
  try { await writeClipboardText(content); }
  catch (cause) { error.value = errorMessage(cause, "复制记录失败"); }
}
</script>

<style scoped lang="scss">
.memberConversations {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;

  .agentMenu {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 48px;
    padding: 8px 14px;

    .recordTitle {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 7px;
      min-width: 0;
      font-size: 13px;
      font-weight: 500;
      > svg { color: var(--el-text-color-secondary); }
      .readOnlyBadge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 6px; border-radius: var(--ui-radius-small); background: var(--el-fill-color-light); color: var(--el-text-color-secondary); font-size: 10px; font-weight: 400; }
    }

    .menuActions { display: flex; align-items: center; flex-shrink: 0; gap: 2px; :deep(.el-button) { width: 28px; height: 28px; margin: 0; padding: 0; color: var(--el-text-color-secondary); } }
  }

  .recordSelectors {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: 10px;
    padding: 14px;
    border-block: 1px solid var(--el-border-color-lighter);
    background: var(--el-fill-color-extra-light);

    .recordField {
      display: grid;
      grid-template-columns: 30px minmax(0, 1fr);
      align-items: center;
      gap: 10px;
      > span { color: var(--el-text-color-secondary); font-size: 12px; }
      > .el-select { min-width: 0; }
    }

    .recordActions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 4px;
      margin-left: 34px;
      > .el-button { height: 24px; margin: 0; padding: 0 6px; color: var(--el-text-color-secondary); :deep(> span) { gap: 5px; } }
      .runningStatus { display: inline-flex; align-items: center; gap: 5px; margin-left: auto; color: var(--el-text-color-secondary); font-size: 11px; > i { width: 5px; height: 5px; border-radius: 50%; background: var(--el-color-success); } }
    }
  }

  .recordNavigation {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    flex-wrap: wrap;
    gap: 8px;
    padding: 16px 16px 0;
    .sessionTitle { display: flex; align-items: flex-start; gap: 7px; min-width: 0; color: var(--el-text-color-secondary); > svg { flex-shrink: 0; margin-top: 2px; } > strong { font-size: 12px; font-weight: 500; line-height: 1.6; overflow-wrap: anywhere; } }
    > .el-button { margin: 0; }
  }

  .recordMessages {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 4px 16px 20px;

    .recordMessage {
      display: flex;
      flex-direction: column;
      gap: 9px;
      padding: 18px 0 8px;
      overflow-wrap: anywhere;

      .messageIdentity {
        display: flex;
        align-items: center;
        gap: 7px;
        color: var(--el-text-color-secondary);
        .messageAvatar { display: grid; place-items: center; width: 23px; height: 23px; border: 1px solid var(--el-border-color-lighter); border-radius: var(--ui-radius); background: var(--el-fill-color-extra-light); }
        > strong { min-width: 0; font-size: 11px; font-weight: 500; }
      }

      .recordContent {
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-width: 0;
        font-size: 13px;
        line-height: 1.75;
        > details { color: var(--el-text-color-secondary); font-size: 12px; > summary { cursor: pointer; padding: 4px 0; } }
      }

      &.userMessage {
        align-items: flex-end;
        .messageIdentity { flex-direction: row-reverse; }
        .recordContent { max-width: 100%; padding: 10px 14px; border-radius: var(--ui-radius-large); background: var(--el-fill-color-light); }
      }
    }
  }

  .recordError { margin: 10px 14px; padding: 9px 12px; border-radius: var(--ui-radius); background: var(--el-color-danger-light-9); color: var(--el-color-danger); font-size: 12px; line-height: 1.6; }
}
</style>
