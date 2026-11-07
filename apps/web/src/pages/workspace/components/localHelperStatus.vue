<template>
  <el-tooltip :content="description" placement="bottom-end" :trigger="['hover', 'focus']" :showArrow="false" :hideAfter="0" :popperStyle="{ maxWidth: 'min(360px, calc(100vw - 24px))', whiteSpace: 'pre-line', overflowWrap: 'anywhere' }">
    <el-button class="localHelperStatus" :class="indicator.tone" text :aria-label="`本地助手：${indicator.label}，打开本地助手设置`" aria-haspopup="dialog" @click="emit('openSettings')">
      <span class="helperIcon" aria-hidden="true">
        <icon-device-desktop :size="16" />
        <span class="statusDot" />
      </span>
      <span class="helperLabel">本地助手</span>
      <span class="helperState" role="status">{{ indicator.label }}</span>
    </el-button>
  </el-tooltip>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { IconDeviceDesktop } from "@tabler/icons-vue";
import useLocalHelper from "@/stores/localHelper";

const emit = defineEmits<{ openSettings: [] }>();
const { status, failure } = useLocalHelper();
const selectedDevice = computed(() => status.value?.devices.find(device => device.id === status.value?.selectedId));
const indicator = computed(() => {
  if (failure.value) return { tone: "danger", label: "状态异常", detail: failure.value };
  if (!status.value) return { tone: "neutral", label: "检测中", detail: "正在读取本地助手状态" };
  if (!status.value.devices.length) return { tone: "neutral", label: "未绑定", detail: "绑定电脑后，AI 助手可协助处理本机文件" };
  if (!status.value.selectedId) return { tone: "neutral", label: "已关闭", detail: "当前会话已关闭本机工具，可在设置中选择电脑" };
  const device = selectedDevice.value;
  if (!device) return { tone: "danger", label: "设备不可用", detail: "当前选择的电脑已不可用，请重新选择或绑定" };
  if (!device.online) return { tone: "danger", label: "已离线", detail: "请在电脑上启动本地助手并检查网络连接" };
  if (device.paused) return { tone: "warning", label: "已暂停", detail: "请在本机助手中恢复连接" };
  if (!device.approved) return { tone: "warning", label: "待确认", detail: "请在本机助手中确认连接" };
  return { tone: "success", label: "已连接", detail: "当前会话可使用这台电脑的本机工具" };
});
const description = computed(() => [
  selectedDevice.value?.name,
  indicator.value.detail,
  "点击打开本地助手设置",
].filter(Boolean).join("\n"));
</script>

<style scoped lang="scss">
.localHelperStatus {
  --helperStatusColor: var(--el-text-color-secondary);
  height: 30px;
  margin: 0;
  padding: 0 9px;
  border-radius: var(--ui-radius);
  color: var(--el-text-color-regular);
  font-size: 12px;

  &.success { --helperStatusColor: var(--el-color-success); }
  &.warning { --helperStatusColor: var(--el-color-warning); }
  &.danger { --helperStatusColor: var(--el-color-danger); }

  &:focus-visible {
    outline: 2px solid var(--el-color-primary);
    outline-offset: 2px;
  }

  :deep(> span) {
    gap: 7px;
  }

  .helperIcon {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;

    .statusDot {
      position: absolute;
      top: -2px;
      right: -3px;
      width: 6px;
      height: 6px;
      border: 2px solid var(--el-bg-color-overlay);
      border-radius: 50%;
      background: var(--helperStatusColor);
    }
  }

  .helperState {
    color: var(--helperStatusColor);
  }

  @media (max-width: 1100px) {
    width: 30px;
    padding: 0;

    .helperLabel,
    .helperState {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  }
}
</style>
