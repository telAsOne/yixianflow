<template>
  <div class="workspacePresence" role="group" aria-label="项目刷新与协作状态">
    <el-tooltip v-if="saveError" :content="saveError" placement="bottom" :trigger="['hover', 'focus']" :popperStyle="{ maxWidth: 'min(400px, calc(100vw - 24px))', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }" :showArrow="false" :hideAfter="0">
      <el-button class="saveWarning" text :aria-label="'处理保存问题：' + saveError" @click="emit('resolveSave')"><icon-alert-triangle :size="15" aria-hidden="true" /><span class="saveWarningText">保存受阻</span></el-button>
    </el-tooltip>
    <el-tooltip content="刷新项目" placement="bottom" :showArrow="false" :hideAfter="0">
      <el-button class="refreshButton" text :icon="IconRefresh" :loading="refreshing" :disabled="!directory" aria-label="刷新项目" @click="refreshProject" />
    </el-tooltip>
    <el-popover v-if="!webMode" v-model:visible="membersVisible" trigger="click" placement="bottom-end" :width="320" :popperStyle="{ maxWidth: 'calc(100vw - 24px)' }" :showArrow="false" :disabled="!directory" @show="retryPresence">
      <template #reference>
        <el-button class="presenceButton" :class="{ unavailable: status === 'error' || status === 'unsupported' }" text :disabled="!directory" :aria-expanded="membersVisible" aria-label="查看在线与操作人数，点击重试连接">
          <icon-users :size="15" aria-hidden="true" />
          <span class="presenceSummary" aria-live="polite">
            <template v-if="status === 'ready'">在线 {{ members.length }} 人 / 操作 {{ activeCount }} 人</template>
            <template v-else-if="!directory">未打开项目</template>
            <template v-else-if="status === 'unsupported'">协作状态需升级</template>
            <template v-else-if="status === 'error'">协作连接失败</template>
            <template v-else>协作连接中</template>
          </span>
        </el-button>
      </template>
      <div class="presenceDetails" @keydown.esc="membersVisible = false">
        <div class="presenceTitle">协作状态</div>
        <p v-if="status === 'unsupported'" class="connectionMessage" role="status">服务端暂不支持协作状态，请升级服务端后点击人数或刷新重试。</p>
        <p v-else-if="status === 'error'" class="connectionMessage" role="status">{{ connectionError || '无法获取协作状态' }}（稍后自动重试，也可点击人数或刷新重试）</p>
        <p v-else-if="status !== 'ready'" class="connectionMessage" role="status">正在获取在线成员…</p>
        <ul v-else class="memberList" aria-label="在线成员">
          <li v-for="member in members" :key="member.id" class="memberRow">
            <div class="memberInfo">
              <div class="memberName"><span>{{ member.name }}</span><span v-if="member.id === selfId" class="selfLabel">我</span></div>
              <div class="memberLocation" :title="member.path">{{ member.panel === 'canvas' ? '画布' : '文档' }}<template v-if="member.path"> · {{ member.path }}</template></div>
            </div>
            <span class="memberState" :class="{ operating: member.active && member.visible, away: !member.visible }">{{ !member.visible ? '暂离' : member.active ? '操作中' : '浏览中' }}</span>
          </li>
        </ul>
        <p class="presenceNote">人数包含自己，按设备和浏览器身份统计；同一浏览器的多个标签页合并计算。</p>
        <p class="presenceNote">操作中指前台最近 30 秒内有键盘、点击、拖动或滚轮输入，不代表正在保存修改。</p>
        <p v-if="!identityStored" class="presenceNote">浏览器未允许保存身份，当前页面单独计数。</p>
      </div>
    </el-popover>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import axios from "axios";
import { IconAlertTriangle, IconRefresh, IconUsers } from "@tabler/icons-vue";
import { locale } from "@toonflow/i18n/vue";
import { webMode } from "@/lib/webRuntime";

type PresenceMember = { id: string; name: string; active: boolean; visible: boolean; panel: "canvas" | "document"; path: string };
type PresencePayload = { directory: string; clientId: string; sessionId: string; panel: "canvas" | "document"; path: string; active: boolean; visible: boolean };
const props = defineProps<{ directory: string; canvasId?: string; panel: "canvas" | "document"; refreshing?: boolean; saveError?: string }>();
const emit = defineEmits<{ refresh: []; resolveSave: [] }>();
const membersVisible = ref(false);
const members = shallowRef<PresenceMember[]>([]);
const selfId = ref("");
const status = ref<"connecting" | "ready" | "error" | "unsupported">("connecting");
const connectionError = ref("");
const activeCount = computed(() => members.value.filter(member => member.active && member.visible).length);
const presenceUrl = "/api/workspaces/presence/update";
const sessionId = crypto.randomUUID();
let identityStored = true;
const clientId = getClientId();
let mounted = false;
let suspended = false;
let pollTimer: number | undefined;
let requestController: AbortController | undefined;
let lastPayload: PresencePayload | undefined;
let lastActivityAt = -30000;
let lastRequestAt = -10000;
let retryAt = 0;
let failures = 0;
let pendingUpdate = true;
const listeners = new AbortController();

function getClientId() {
  const key = "toonflowWorkspacePresenceClientId";
  try {
    const stored = localStorage.getItem(key);
    if (stored && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(stored)) return stored;
    const id = crypto.randomUUID();
    localStorage.setItem(key, id);
    return id;
  } catch {
    identityStored = false;
    return crypto.randomUUID();
  }
}

function isForeground() {
  return document.visibilityState === "visible" && document.hasFocus();
}

function isPresenceMember(value: unknown): value is PresenceMember {
  if (!value || typeof value !== "object") return false;
  const member = value as Partial<PresenceMember>;
  return typeof member.id === "string" && typeof member.name === "string" && typeof member.path === "string"
    && typeof member.active === "boolean" && typeof member.visible === "boolean" && (member.panel === "canvas" || member.panel === "document");
}

async function updatePresence() {
  if (webMode.value) return;
  if (!mounted || suspended || !props.directory || requestController || status.value === "unsupported") return;
  const now = performance.now();
  const visible = isForeground();
  const active = visible && now - lastActivityAt < 30000;
  if (now < retryAt || now - lastRequestAt < 1000) return;
  if (!pendingUpdate && lastPayload?.active === active && lastPayload.visible === visible && now - lastRequestAt < 10000) return;
  const payload: PresencePayload = { directory: props.directory, clientId, sessionId, panel: props.panel, path: props.panel === "canvas" ? props.canvasId || "" : "", active, visible };
  const controller = new AbortController();
  requestController = controller;
  lastPayload = payload;
  lastRequestAt = now;
  pendingUpdate = false;
  try {
    const { data } = await axios.post<{ code: number; message?: string; data: { selfId: string; members: PresenceMember[] } }>(presenceUrl, payload, {
      headers: { "x-toonflow-workspace": "1" }, signal: controller.signal, timeout: 10000,
    });
    if (requestController !== controller || payload.directory !== props.directory) return;
    if (data?.code !== 200) throw new Error(typeof data?.message === "string" ? data.message : "协作状态响应无效");
    if (typeof data.data?.selfId !== "string" || !Array.isArray(data.data.members)
      || !data.data.members.every(isPresenceMember) || !data.data.members.some(member => member.id === data.data.selfId)) throw new Error("协作状态响应无效");
    members.value = data.data.members;
    selfId.value = data.data.selfId;
    status.value = "ready";
    connectionError.value = "";
    failures = 0;
    retryAt = 0;
  } catch (error) {
    if (requestController !== controller || controller.signal.aborted) return;
    const response = axios.isAxiosError(error) ? error.response : undefined;
    const responseData = response?.data;
    const businessMessage = responseData && typeof responseData === "object" && typeof responseData.code === "number" && typeof responseData.message === "string"
      ? responseData.message as string : undefined;
    if (response?.status === 404 && businessMessage === undefined) {
      status.value = "unsupported";
      lastPayload = undefined;
      stopPolling();
    } else {
      status.value = "error";
      connectionError.value = businessMessage ?? (error instanceof Error && !axios.isAxiosError(error) ? error.message : "无法获取协作状态");
      failures++;
      retryAt = performance.now() + Math.min(60000, 10000 * 2 ** Math.min(failures - 1, 3));
    }
  } finally {
    if (requestController === controller) requestController = undefined;
  }
}

function startPolling() {
  if (!mounted || suspended || !props.directory || status.value === "unsupported") return;
  // 本地每秒检查活动过期；正常网络心跳为 10 秒，状态变化最多每秒发送一次。
  pollTimer ??= window.setInterval(() => void updatePresence(), 1000);
  void updatePresence();
}

function stopPolling() {
  window.clearInterval(pollTimer);
  pollTimer = undefined;
}

function leavePresence() {
  stopPolling();
  requestController?.abort();
  requestController = undefined;
  const payload = lastPayload;
  lastPayload = undefined;
  if (!payload) return;
  void fetch(presenceUrl, {
    method: "POST", keepalive: true,
    headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1", "Accept-Language": locale.value },
    body: JSON.stringify({ ...payload, active: false, visible: false, leave: true }),
  }).catch(() => {});
}

function handleActivity() {
  if (suspended || !isForeground()) return;
  const now = performance.now();
  const wasActive = now - lastActivityAt < 30000;
  lastActivityAt = now;
  if (!wasActive) void updatePresence();
}

function handlePointerMove(event: PointerEvent) {
  if (event.buttons) handleActivity();
}

function handleVisibility() {
  if (suspended) return;
  if (!isForeground()) lastActivityAt = -30000;
  else if (status.value !== "unsupported") {
    retryAt = 0;
    if (performance.now() - lastRequestAt >= 10000 && requestController) {
      requestController.abort();
      requestController = undefined;
    }
  }
  pendingUpdate = true;
  void updatePresence();
}

function retryPresence() {
  if (status.value !== "ready") status.value = "connecting";
  failures = 0;
  retryAt = 0;
  pendingUpdate = true;
  startPolling();
}

function refreshProject() {
  retryPresence();
  emit("refresh");
}

function handlePageHide() {
  suspended = true;
  lastActivityAt = -30000;
  leavePresence();
}

function handlePageShow() {
  if (!suspended) return;
  suspended = false;
  lastRequestAt = -10000;
  retryAt = 0;
  pendingUpdate = true;
  if (status.value !== "unsupported") status.value = "connecting";
  startPolling();
}

watch(() => props.directory, () => {
  leavePresence();
  members.value = [];
  selfId.value = "";
  membersVisible.value = false;
  status.value = "connecting";
  connectionError.value = "";
  lastActivityAt = -30000;
  lastRequestAt = -10000;
  retryAt = 0;
  failures = 0;
  pendingUpdate = true;
  startPolling();
}, { flush: "sync" });

watch([() => props.panel, () => props.canvasId], () => {
  pendingUpdate = true;
  void updatePresence();
});

onMounted(() => {
  if (webMode.value) return;
  mounted = true;
  const options = { capture: true, passive: true, signal: listeners.signal };
  for (const event of ["pointerdown", "keydown", "wheel"]) window.addEventListener(event, handleActivity, options);
  window.addEventListener("pointermove", handlePointerMove, options);
  window.addEventListener("focus", handleVisibility, { signal: listeners.signal });
  window.addEventListener("blur", handleVisibility, { signal: listeners.signal });
  window.addEventListener("online", handleVisibility, { signal: listeners.signal });
  window.addEventListener("pagehide", handlePageHide, { signal: listeners.signal });
  window.addEventListener("pageshow", handlePageShow, { signal: listeners.signal });
  document.addEventListener("visibilitychange", handleVisibility, { signal: listeners.signal });
  startPolling();
});

onBeforeUnmount(() => {
  mounted = false;
  listeners.abort();
  leavePresence();
});
</script>

<style scoped lang="scss">
.workspacePresence {
  display: flex;
  align-items: center;
  gap: 2px;
  max-width: calc(100vw - 30px);
  height: 38px;
  padding: 3px;
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--ui-radius-large);
  background: var(--el-bg-color-overlay);
  box-shadow: var(--floatingShadow);

  .el-button {
    border-radius: var(--ui-radius);
    color: var(--el-text-color-regular);
  }

  .saveWarning {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    gap: 4px;
    padding: 0 6px;
    color: var(--el-color-warning);
    font-size: 12px;

    &:focus-visible {
      outline: 2px solid var(--el-color-primary);
      outline-offset: 2px;
    }
  }

  .refreshButton {
    width: 30px;
    height: 30px;
    margin: 0;
    padding: 0;
    flex-shrink: 0;
  }

  .presenceButton {
    min-width: 0;
    flex-shrink: 1;
    height: 30px;
    margin: 0;
    padding: 0 8px;
    font-size: 12px;

    &.unavailable {
      color: var(--el-color-warning);
    }

    .presenceSummary {
      min-width: 0;
      margin-inline-start: 5px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    :deep(> span) {
      min-width: 0;
    }
  }

  @media (max-width: 600px) {
    padding: 4px;

    .saveWarning {
      padding: 0 4px;

      .saveWarningText {
        display: none;
      }
    }

    .presenceButton {
      padding: 0 4px;
      font-size: 11px;
    }
  }
}

.presenceDetails {
  .presenceTitle {
    margin-bottom: 8px;
    color: var(--el-text-color-primary);
    font-weight: 600;
  }

  .connectionMessage {
    margin: 12px 0;
    line-height: 1.6;
    color: var(--el-text-color-secondary);
  }

  .memberList {
    max-height: min(280px, 45dvh);
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;

    .memberRow {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 0;

      .memberInfo {
        min-width: 0;

        .memberName {
          display: flex;
          align-items: center;
          gap: 6px;
          color: var(--el-text-color-primary);

          > span:first-child {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }

          .selfLabel {
            flex-shrink: 0;
            color: var(--el-color-primary);
            font-size: 11px;
          }
        }

        .memberLocation {
          margin-top: 3px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--el-text-color-secondary);
          font-size: 11px;
        }
      }

      .memberState {
        flex-shrink: 0;
        color: var(--el-text-color-secondary);
        font-size: 12px;

        &.operating {
          color: var(--el-color-success);
        }

        &.away {
          color: var(--el-text-color-placeholder);
        }
      }
    }
  }

  .presenceNote {
    margin: 8px 0 0;
    color: var(--el-text-color-secondary);
    font-size: 11px;
    line-height: 1.6;
  }
}
</style>
