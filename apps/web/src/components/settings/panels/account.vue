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
    </template>
    <el-button v-else type="primary" @click="signInVisible = true">登录 / 注册</el-button>
  </div>
</template>

<script setup lang="ts">
import { t } from "@toonflow/i18n/vue";
import { computed, ref, watch } from "vue";
import { accountView, signInVisible, refreshAccount, refreshModels, refreshingModels, logout } from "@/stores/account";
import { errorMessage } from "@/lib/api";
const { visible = true } = defineProps<{ visible?: boolean }>();
const message = ref("");
const loggingOut = ref(false);
const storagePercentage = computed(() => {
  const storage = accountView.value?.account?.storage;
  return storage?.quota_bytes ? Math.min(100, Math.round(storage.used_bytes / storage.quota_bytes * 100)) : 0;
});
const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
watch(() => visible, async value => {
  if (value) try { await refreshAccount(); message.value = ""; } catch (error) { message.value = errorMessage(error, t`读取账户失败`); }
}, { immediate: true });
async function refresh() {
  try { await refreshModels(); message.value = ""; } catch (error) { message.value = errorMessage(error, t`刷新模型失败`); }
}
async function signOut() {
  loggingOut.value = true;
  try { await logout(); message.value = ""; } catch (error) { message.value = errorMessage(error, t`退出登录失败`); }
  finally { loggingOut.value = false; }
}
</script>

<style scoped lang="scss">
.accountPanel {
  display: grid;
  gap: 16px;
  p { margin: 0; }
  .accountActions { display: flex; flex-wrap: wrap; gap: 8px; }
}
</style>
