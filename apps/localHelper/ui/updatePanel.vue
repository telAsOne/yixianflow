<template>
  <section class="updatesPanel">
    <div class="updateSummary">
      <span class="updateIcon"><icon-refresh :size="27" :strokeWidth="1.7" /></span>
      <div>
        <span class="updateEyebrow">应用更新</span>
        <h2>
          UnionFlow 本地助手
          <span>{{ version }}</span>
        </h2>
        <p>{{ phaseText }}</p>
      </div>
      <button class="checkButton" :disabled="!online || busy" @click="$emit('check')">
        <icon-refresh :size="15" :class="{ spinning: update?.phase === 'checking' }" />
        {{ update?.phase === "checking" ? "检查中…" : "检查更新" }}
      </button>
    </div>
    <div class="accountConnection">
      <span>{{ bound ? "更新使用本机绑定的 UnionAIGC 账户。" : "登录 UnionAIGC 账户并绑定本机后，即可检查更新。" }}</span>
      <button :disabled="!online" @click="$emit('account')">
        {{ bound ? "管理账户与绑定" : "登录 UnionAIGC / 绑定本机" }}
        <icon-arrow-up-right :size="15" />
      </button>
    </div>
    <div v-if="update?.version && ['available', 'downloading', 'ready', 'installing'].includes(update.phase)" class="releaseCard">
      <div>
        <span>新版本 {{ update.version }}</span>
        <strong>
          {{
            update.phase === "ready" ? "已下载并通过完整校验" : update.phase === "installing" ? "正在保存状态并重启" : "有新的版本可以更新"
          }}
        </strong>
      </div>
      <p v-if="update.notes">{{ update.notes }}</p>
      <div v-if="update.phase === 'downloading'" class="downloadProgress">
        <progress :value="update.bytes" :max="update.total || 1"></progress>
        <span>
          {{ size(update.bytes) }} / {{ size(update.total) }} · {{ update.bytes >= update.total ? "校验更新包与程序文件" : "正在下载" }}
        </span>
      </div>
      <button v-if="update.phase === 'available'" class="updateButton" @click="$emit('download')">
        <icon-download :size="16" />
        下载更新
      </button>
      <button v-if="update.phase === 'ready'" class="updateButton" @click="installDialog = true">
        <icon-arrow-up-right :size="16" />
        安装并重启
      </button>
    </div>
    <p v-if="update?.error" class="updateError">
      <icon-alert-circle :size="15" />
      {{ update.error }}
    </p>
    <div class="updatePreference">
      <div>
        <strong>自动检查新版本</strong>
        <p>连接平台后每小时检查一次，发现更新时在这里提示。</p>
      </div>
      <button
        class="preferenceSwitch"
        :class="{ enabled: update?.autoCheck }"
        :disabled="!online"
        role="switch"
        :aria-checked="update?.autoCheck === true"
        aria-label="自动检查新版本"
        @click="$emit('preferences', !update?.autoCheck, update?.autoInstall === true)">
        <span></span>
      </button>
    </div>
    <div class="updatePreference">
      <div>
        <strong>空闲时自动更新</strong>
        <p>自动下载、校验并重启；有运行任务或待回传结果时等待。</p>
      </div>
      <button
        class="preferenceSwitch"
        :class="{ enabled: update?.autoInstall }"
        :disabled="!online"
        role="switch"
        :aria-checked="update?.autoInstall === true"
        aria-label="空闲时自动更新"
        @click="toggleAutomatic">
        <span></span>
      </button>
    </div>
    <footer>
      <icon-shield-check :size="14" />
      <span>校验 SHA-256 · 保留绑定、聊天和日志 · 启动失败恢复原程序</span>
      <time v-if="update?.checkedAt">上次检查 {{ new Date(update.checkedAt).toLocaleTimeString("zh-CN", { hour12: false }) }}</time>
    </footer>
    <actionDialog
      :open="installDialog"
      title="安装更新并重启？"
      description="将在当前任务全部完成后替换程序文件。设备绑定、历史聊天和日志保存在原数据目录，新版本启动失败时会恢复原程序。"
      :details="`当前版本 ${version} → 新版本 ${update?.version || ''}`"
      confirmLabel="安装并重启"
      @close="installDialog = false"
      @confirm="
        installDialog = false;
        $emit('install');
      " />
    <actionDialog
      :open="automaticDialog"
      title="开启空闲时自动更新？"
      description="之后发现新版本时，助手会在没有任务和对话运行时自动下载、校验、安装并重启。你可以随时在这里关闭。"
      confirmLabel="开启自动更新"
      @close="automaticDialog = false"
      @confirm="
        automaticDialog = false;
        $emit('preferences', true, true);
      " />
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from "vue";
import { IconAlertCircle, IconArrowUpRight, IconDownload, IconRefresh, IconShieldCheck } from "@tabler/icons-vue";
import type { HelperUpdateState } from "../src/controlProtocol";
import actionDialog from "./actionDialog.vue";
const props = defineProps<{ update?: HelperUpdateState; version: string; online: boolean; bound: boolean }>();
const emit = defineEmits<{ account: []; check: []; download: []; install: []; preferences: [autoCheck: boolean, autoInstall: boolean] }>();
const installDialog = ref(false);
const automaticDialog = ref(false);
const busy = computed(() => !!props.update && ["checking", "downloading", "installing"].includes(props.update.phase));
const phaseText = computed(
  () =>
    ({
      idle: "更新通过当前绑定的平台提供。",
      checking: "正在读取平台最新发布版本…",
      available: "发现新版本，可以下载并安装。",
      downloading: "正在下载并验证更新，请稍候。",
      ready: "新版本已准备好，安装后会重启托盘。",
      installing: "更新器正在接管，任务不会自动重新执行。",
      current: "当前已是最新发布版本。",
      failed: "更新未完成，现有程序继续保留。",
    })[props.update?.phase || "idle"],
);
function size(value: number) {
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
function toggleAutomatic() {
  if (props.update?.autoInstall) emit("preferences", props.update.autoCheck, false);
  else automaticDialog.value = true;
}
</script>
<style scoped lang="scss">
.updatesPanel {
  background: white;
  border: 1px solid #e4dfed;
  border-radius: 13px;
  margin-bottom: 22px;
  overflow: hidden;
  .updateSummary {
    display: flex;
    gap: 17px;
    align-items: center;
    padding: 27px;
    .updateIcon {
      width: 53px;
      height: 53px;
      border: 1px solid #e6ddf2;
      background: #f3edf9;
      color: #8a65b7;
      border-radius: 17px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    > div {
      flex: 1;
      .updateEyebrow {
        font-size: 10px;
        color: #8e7d9d;
        letter-spacing: 1px;
      }
      h2 {
        font-size: 17px;
        font-weight: 550;
        color: #4f3e5e;
        margin: 7px 0 9px;
        span {
          font:
            12px Consolas,
            monospace;
          margin-left: 7px;
          color: #9e81b7;
        }
      }
      p {
        font-size: 11px;
        color: #8b7b99;
        margin: 0;
      }
    }
    .checkButton {
      display: flex;
      align-items: center;
      gap: 7px;
      border: 1px solid #dfd5e9;
      background: #fff;
      color: #856798;
      border-radius: 8px;
      padding: 10px 13px;
      font-size: 11px;
      white-space: nowrap;
      &:disabled {
        opacity: 0.5;
      }
    }
  }
  .accountConnection {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 0 27px 20px;
    font-size: 12px;
    color: #8b7b99;
    button {
      display: flex;
      align-items: center;
      gap: 6px;
      border: 1px solid #dfd5e9;
      border-radius: 8px;
      background: #fff;
      color: #856798;
      padding: 9px 12px;
      &:disabled { opacity: 0.5; }
    }
  }
  .releaseCard {
    margin: 0 27px 24px;
    padding: 21px;
    background: #f7f2fc;
    border: 1px solid #e8dbf2;
    border-radius: 11px;
    > div:first-child {
      display: flex;
      gap: 14px;
      align-items: center;
      > span {
        color: #9571b3;
        font-size: 11px;
      }
      strong {
        color: #705482;
        font-size: 12px;
        font-weight: 500;
      }
    }
    p {
      font-size: 12px;
      color: #8c749d;
      white-space: pre-wrap;
      line-height: 1.8;
    }
    .updateButton {
      display: flex;
      align-items: center;
      gap: 8px;
      background: #8158b6;
      color: white;
      border: 0;
      border-radius: 8px;
      padding: 10px 13px;
      margin-top: 19px;
      font-size: 11px;
    }
    .downloadProgress {
      margin-top: 20px;
      progress {
        width: 100%;
        height: 6px;
        accent-color: #9470bb;
      }
      span {
        display: block;
        color: #8b729d;
        font-size: 10px;
        margin-top: 8px;
      }
    }
  }
  .updateError {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    color: #b37255;
    font-size: 12px;
    line-height: 1.8;
    background: #fff8f1;
    border: 1px solid #f2e0ce;
    padding: 13px 16px;
    margin: 0 27px 20px;
    border-radius: 8px;
  }
  .updatePreference {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 21px 27px;
    border-top: 1px solid #f0eaf4;
    strong {
      font-size: 12px;
      font-weight: 500;
      color: #5b4a68;
    }
    p {
      font-size: 11px;
      color: #91819e;
      margin: 8px 0 0;
      line-height: 1.7;
    }
    .preferenceSwitch {
      width: 35px;
      height: 21px;
      padding: 3px;
      border: 0;
      background: #e1d9e9;
      border-radius: 12px;
      flex-shrink: 0;
      span {
        display: block;
        width: 15px;
        height: 15px;
        background: #fff;
        border-radius: 50%;
        box-shadow: 0 1px 3px #0002;
        transition: transform 0.15s;
      }
      &.enabled {
        background: #9570bf;
        span {
          transform: translateX(14px);
        }
      }
    }
  }
  > footer {
    display: flex;
    align-items: center;
    gap: 7px;
    color: #8a7a99;
    font-size: 10px;
    padding: 16px 27px;
    background: #fcfafe;
    border-top: 1px solid #f1eaf7;
    time {
      margin-left: auto;
      font-size: 9px;
    }
  }
}
.spinning {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinning {
    animation: none;
  }
}
</style>
