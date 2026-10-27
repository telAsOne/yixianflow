<template>
  <el-dialog v-model="visible" title="登录逸仙" width="420px" alignCenter appendToBody :showClose="!starting" :closeOnClickModal="!starting" :closeOnPressEscape="!starting" @close="waiting && cancel()" @closed="stopWaiting">
    <div class="signIn">
      <p>登录或注册以开始。</p>
      <p v-if="waiting" role="status">等待浏览器完成授权…</p>
      <el-alert v-if="message" :title="message" type="error" :closable="false" showIcon />
      <div class="signInActions">
        <el-button type="primary" :loading="starting" :disabled="waiting" @click="start('signin')">登录</el-button>
        <el-button :disabled="starting || waiting" @click="start('signup')">注册</el-button>
        <el-button v-if="waiting" @click="cancel">取消</el-button>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { t } from "@toonflow/i18n/vue";
import { onBeforeUnmount, ref } from "vue";
import api, { errorMessage } from "@/lib/api";
import { refreshAccount } from "@/stores/account";

const visible = defineModel<boolean>({ required: true });
const waiting = ref(false);
const starting = ref(false);
const message = ref("");
let timer: ReturnType<typeof setTimeout> | undefined;
let deadline = 0;
let generation = 0;

function stopWaiting() { generation++; waiting.value = false; clearTimeout(timer); }
onBeforeUnmount(stopWaiting);

async function poll(current: number) {
  if (current !== generation || !visible.value) return;
  try {
    const state = await refreshAccount();
    if (current !== generation) return;
    if (state.authenticated && state.loginStatus === "idle") {
      stopWaiting();
      visible.value = false;
      window.dispatchEvent(new Event("toonflow:signed-in"));
      return;
    }
    if (["cancelled", "failed", "expired"].includes(state.loginStatus) || Date.now() >= deadline) {
      message.value = state.message || t`登录已超时，请重新登录`;
      stopWaiting();
      return;
    }
    timer = setTimeout(() => { void poll(current); }, 2000);
  } catch (error) {
    if (current === generation) { message.value = errorMessage(error, t`读取登录状态失败`); stopWaiting(); }
  }
}

async function start(screen: "signin" | "signup") {
  starting.value = true;
  message.value = "";
  try {
    const { data } = await api.post<{ data: { url: string; browserOpened: boolean } }>("/api/account/start", { screen }, { timeout: 10000 });
    if (!data.data.browserOpened) window.open(data.data.url, "_blank", "noopener,noreferrer");
    waiting.value = true;
    deadline = Date.now() + 10 * 60_000;
    void poll(++generation);
  } catch (error) { message.value = errorMessage(error, t`无法发起登录`); }
  finally { starting.value = false; }
}

async function cancel() {
  try { await api.post("/api/account/logout"); stopWaiting(); }
  catch (error) { message.value = errorMessage(error, t`取消登录失败`); }
}
</script>

<style scoped lang="scss">
.signIn {
  display: grid;
  gap: 16px;
  p { margin: 0; }
  .signInActions { display: flex; gap: 8px; }
}
</style>
