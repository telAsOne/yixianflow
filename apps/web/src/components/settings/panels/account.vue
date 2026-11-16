<template>
  <div class="accountPanel">
    <el-alert v-if="message || accountView?.configError" :title="message || accountView?.configError" type="error" :closable="false" showIcon />
    <template v-if="accountView?.authenticated && accountView.account">
      <el-text tag="strong">{{ accountView.account.user.display_name || accountView.account.user.username }}</el-text>
      <p>余额：{{ accountView.account.balance.display }}</p>
      <p>存储：{{ formatBytes(accountView.account.storage.used_bytes) }} / {{ formatBytes(accountView.account.storage.quota_bytes) }}</p>
      <el-progress :percentage="storagePercentage" aria-label="存储使用量" />
      <div class="accountActions">
        <el-button tag="a" :href="accountView.account.topup_url" target="_blank" rel="noopener noreferrer">充值</el-button>
        <el-button :loading="refreshingModels" @click="refresh">刷新模型</el-button>
        <el-button :loading="loggingOut" @click="signOut">退出登录</el-button>
      </div>
      <section v-if="webMode" class="loginSessions" aria-label="登录设备">
        <h3><icon-devices :size="17" aria-hidden="true" />登录设备</h3>
        <article v-for="session in sessions" :key="session.id" :class="{ currentSession: session.current }">
          <span class="sessionIcon" aria-hidden="true"><icon-browser :size="19" /></span>
          <div class="sessionDetails"><strong>{{ browserName(session.userAgent) }}</strong><span>{{ session.current ? '当前浏览器' : `最近活动：${new Date(session.seenAt).toLocaleString()}` }}</span></div>
          <span v-if="session.current" class="currentBadge"><i aria-hidden="true" />当前</span>
          <el-button v-if="!session.current" text type="danger" :loading="revoking === session.id" :disabled="!!revoking" @click="revokeSession(session.id)">退出该登录</el-button>
        </article>
      </section>
    </template>
    <el-button v-else type="primary" @click="signInVisible = true">登录 / 注册</el-button>
  </div>
</template>

<script setup lang="ts">
import { t } from "@toonflow/i18n/vue";
import { computed, ref, watch } from "vue";
import { accountView, signInVisible, refreshAccount, refreshModels, refreshingModels, logout } from "@/stores/account";
import api, { errorMessage } from "@/lib/api";
import { webMode } from "@/lib/webRuntime";
const { visible = true } = defineProps<{ visible?: boolean }>();
const message = ref("");
const loggingOut = ref(false);
const sessions = ref<{ id: string; userAgent: string; seenAt: string; current: boolean }[]>([]);
const revoking = ref("");
const storagePercentage = computed(() => {
  const storage = accountView.value?.account?.storage;
  return storage?.quota_bytes ? Math.min(100, Math.round(storage.used_bytes / storage.quota_bytes * 100)) : 0;
});
const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
watch(() => visible, async value => {
  if (value) try { await refreshAccount(); if (webMode.value && accountView.value?.authenticated) await loadSessions(); message.value = ""; } catch (error) { message.value = errorMessage(error, t`读取账户失败`); }
}, { immediate: true });
async function refresh() {
  try { await refreshModels(); message.value = ""; } catch (error) { message.value = errorMessage(error, t`刷新模型失败`); }
}
async function signOut() {
  loggingOut.value = true;
  try { await logout(); message.value = ""; } catch (error) { message.value = errorMessage(error, t`退出登录失败`); }
  finally { loggingOut.value = false; }
}
async function loadSessions() {
  const { data } = await api.get<{ data: typeof sessions.value }>("/api/account/sessions/list");
  sessions.value = data.data;
}
async function revokeSession(id: string) {
  if (revoking.value) return;
  revoking.value = id;
  try { await api.delete("/api/account/sessions/revoke", { data: { id } }); await loadSessions(); message.value = ""; }
  catch (error) { message.value = errorMessage(error, "退出该登录失败"); }
  finally { revoking.value = ""; }
}
function browserName(userAgent: string) {
  const browser = /Edg\//.test(userAgent) ? "Edge" : /Firefox\//.test(userAgent) ? "Firefox" : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "浏览器";
  const device = /Android/.test(userAgent) ? "Android" : /iPhone|iPad/.test(userAgent) ? "iOS" : /Windows/.test(userAgent) ? "Windows" : /Macintosh/.test(userAgent) ? "macOS" : /Linux/.test(userAgent) ? "Linux" : "";
  return [browser, device].filter(Boolean).join(" · ");
}
</script>

<style scoped lang="scss">
.accountPanel {
  display: grid;
  gap: 16px;
  p { margin: 0; }
  .accountActions { display: flex; flex-wrap: wrap; gap: 8px; }
  .loginSessions {
    margin-top: 8px;
    > h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 14px; font-size: 13px; font-weight: 500; > svg { color: var(--el-text-color-secondary); } }
    > article {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      padding: 14px;
      margin-top: 8px;
      border: 1px solid var(--el-border-color-light);
      border-radius: var(--ui-radius-large);

      &.currentSession { background: var(--el-fill-color-extra-light); }
      .sessionIcon { display: grid; place-items: center; flex-shrink: 0; width: 34px; height: 34px; border: 1px solid var(--el-border-color-lighter); border-radius: var(--ui-radius); background: var(--el-bg-color); color: var(--el-text-color-secondary); }
      .sessionDetails { display: flex; flex: 1; flex-direction: column; gap: 5px; min-width: 120px; > strong { font-size: 13px; font-weight: 500; } > span { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; } }
      .currentBadge { display: inline-flex; align-items: center; gap: 5px; color: var(--el-text-color-secondary); font-size: 11px; > i { width: 5px; height: 5px; border-radius: 50%; background: var(--el-color-success); } }
      > .el-button { margin: 0; padding: 6px 8px; font-size: 12px; }
    }
  }
}
</style>
