<template>
  <dialog ref="modal" class="actionDialog" :aria-labelledby="titleId" @cancel.prevent="$emit('close')" @click.self="$emit('close')">
    <div class="dialogCard">
      <header>
        <span class="dialogIcon" :class="{ dangerous: danger }">
          <icon-shield-check v-if="permission" :size="25" />
          <icon-alert-circle v-else :size="25" />
        </span>
        <button aria-label="关闭弹框" @click="$emit('close')"><icon-x :size="19" /></button>
      </header>
      <div class="dialogEyebrow">
        {{ permission ? "本机授权" : "UNIONFLOW" }}
        <span v-if="countdown">{{ countdown }}</span>
      </div>
      <h2 :id="titleId">{{ title }}</h2>
      <p v-if="description" class="dialogDescription">{{ description }}</p>
      <pre v-if="details" class="dialogDetails">{{ details }}</pre>
      <input v-if="input" ref="inputElement" v-model="value" :maxlength="80" :aria-label="title" @keydown.enter.prevent="confirm" />
      <footer>
        <button ref="cancelButton" class="cancelButton" @click="$emit('close')">{{ cancelLabel || "取消" }}</button>
        <button class="confirmButton" :class="{ dangerous: danger }" :disabled="input && !value.trim()" @click="confirm">
          {{ confirmLabel || "确认" }}
          <icon-arrow-up-right :size="16" />
        </button>
      </footer>
      <div v-if="permission" class="permissionFoot">
        <icon-lock :size="13" />
        仅授权本次操作，超时或关闭视为拒绝
      </div>
    </div>
  </dialog>
</template>
<script setup lang="ts">
import { nextTick, ref, useId, watch } from "vue";
import { IconAlertCircle, IconArrowUpRight, IconLock, IconShieldCheck, IconX } from "@tabler/icons-vue";
const props = defineProps<{
  open: boolean;
  title: string;
  description?: string;
  details?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  permission?: boolean;
  countdown?: string;
  input?: boolean;
  initialValue?: string;
}>();
const emit = defineEmits<{ close: []; confirm: [value: string] }>();
const modal = ref<HTMLDialogElement>();
const inputElement = ref<HTMLInputElement>();
const cancelButton = ref<HTMLButtonElement>();
const titleId = useId();
const value = ref("");
function confirm() {
  if (!props.input || value.value.trim()) emit("confirm", value.value.trim());
}
watch(
  () => props.open,
  async (open) => {
    await nextTick();
    if (open) {
      value.value = props.initialValue || "";
      if (!modal.value?.open) modal.value?.showModal();
      await nextTick();
      (props.input ? inputElement.value : cancelButton.value)?.focus();
    } else modal.value?.close();
  },
  { immediate: true },
);
</script>
<style scoped lang="scss">
.actionDialog {
  padding: 0;
  margin: auto;
  border: 0;
  background: transparent;
  color: #242435;
  width: 520px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 64px);
  overflow: visible;
  &::backdrop {
    background: #16132866;
    backdrop-filter: blur(6px);
  }
  .dialogCard {
    background: #fff;
    border: 1px solid #ffffff99;
    border-radius: 20px;
    box-shadow: 0 28px 100px #21123940;
    padding: 28px;
    overflow: auto;
    max-height: calc(100vh - 64px);
    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      margin-bottom: 22px;
      .dialogIcon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 52px;
        height: 52px;
        border-radius: 16px;
        background: #eee9ff;
        color: #7351d7;
        &.dangerous {
          background: #fff0ed;
          color: #c95742;
        }
      }
      button {
        border: 0;
        background: #f5f5f9;
        color: #818191;
        padding: 7px;
        display: flex;
        border-radius: 8px;
      }
    }
    .dialogEyebrow {
      font-size: 11px;
      letter-spacing: 1.6px;
      color: #777189;
      display: flex;
      justify-content: space-between;
      span {
        letter-spacing: 0;
        color: #a47936;
      }
    }
    h2 {
      margin: 10px 0 14px;
      font-size: 23px;
      font-weight: 650;
      letter-spacing: -0.5px;
    }
    .dialogDescription {
      color: #717182;
      font-size: 13px;
      line-height: 1.9;
      margin: 0 0 18px;
    }
    .dialogDetails {
      border: 1px solid #e9e7f0;
      border-radius: 10px;
      background: #f8f7fb;
      color: #555266;
      padding: 17px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 280px;
      overflow: auto;
      font:
        12px/1.85 Consolas,
        "Microsoft YaHei UI",
        monospace;
    }
    input {
      width: 100%;
      padding: 12px;
      border: 1px solid #dcd4ef;
      border-radius: 9px;
      font-size: 14px;
      outline-color: #8665d7;
      margin: 5px 0 12px;
    }
    footer {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 26px;
      button {
        border-radius: 9px;
        padding: 11px 18px;
        font-size: 13px;
        font-weight: 500;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .cancelButton {
        background: #fff;
        border: 1px solid #e2e1e9;
        color: #656172;
      }
      .confirmButton {
        background: #7954cf;
        color: #fff;
        border: 1px solid #7954cf;
        box-shadow: 0 3px 8px #7954cf1f;
        &.dangerous {
          background: #c85c4b;
          border-color: #c85c4b;
        }
        &:disabled {
          opacity: 0.5;
        }
      }
    }
    .permissionFoot {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 19px;
      font-size: 11px;
      color: #898294;
    }
  }
}
</style>
