<template>
  <el-dialog v-model="visible" class="settingsDialog" title="设置" width="min(1080px, calc(100vw - 32px))" alignCenter appendToBody>
    <div class="settings">
      <aside class="sidebar" aria-label="设置分类">
        <template v-for="item in settingsPanels" :key="item.id">
          <h3 v-if="item.groupLabel" class="settingsGroupLabel">{{ item.groupLabel }}</h3>
          <button
            class="settingsItem"
            type="button"
            :aria-label="item.id === 'about' && hasDesktopUpdate ? `${item.label}，有新版本可用` : item.label"
            :aria-pressed="activePanel.id === item.id"
            @click="activePanel = item">
            <el-badge class="panelIcon" isDot :hidden="item.id !== 'about' || !hasDesktopUpdate">
              <component :is="item.icon" :size="18" aria-hidden="true" />
            </el-badge>
            <span>{{ item.label }}</span>
          </button>
        </template>
      </aside>
      <section class="content" :aria-label="activePanel.label" tabindex="0">
        <h2 class="panelTitle">{{ activePanel.label }}</h2>
        <div class="panelContent">
          <transition name="el-fade-in" mode="out-in">
            <keep-alive include="personalization">
              <component
                :is="activePanel.component"
                v-bind="
                  ['pluginMarket', 'languageModel', 'mediaModel', 'account', 'personalization', 'deviceLink'].includes(activePanel.id) ? { visible } : {}
                " />
            </keep-alive>
          </transition>
        </div>
      </section>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { defineAsyncComponent, shallowRef } from "vue";
import { hasDesktopUpdate } from "@/stores/desktopUpdate";
import { isMobile } from "@/lib/mobile";
import {
  IconPalette,
  IconSettings,
  IconPhotoVideo,
  IconBuildingStore,
  IconInfoCircle,
  IconCode,
  IconPlugConnected,
  IconUserCog,
  IconSubtitlesAi,
  IconDevices,
  IconUser,
} from "@tabler/icons-vue";

const settingsPanels = [
  { id: "ui", label: "界面设置", icon: IconPalette, component: defineAsyncComponent(() => import("./panels/ui.vue")) },
  { id: "general", label: "常规配置", icon: IconSettings, component: defineAsyncComponent(() => import("./panels/general/index.vue")) },
  {
    id: "languageModel",
    label: "文本模型",
    icon: IconSubtitlesAi,
    groupLabel: "模型",
    component: defineAsyncComponent(() => import("./panels/languageModel/index.vue")),
  },
  { id: "mediaModel", label: "媒体模型", icon: IconPhotoVideo, component: defineAsyncComponent(() => import("./panels/mediaModel/index.vue")) },
  { id: "account", label: "逸仙账户", icon: IconUser, component: defineAsyncComponent(() => import("./panels/account.vue")) },
  {
    id: "pluginMarket",
    label: "插件市场",
    icon: IconBuildingStore,
    groupLabel: "市场",
    component: defineAsyncComponent(() => import("./panels/pluginMarket/index.vue")),
  },
  { id: "mcp", label: "MCP", icon: IconPlugConnected, groupLabel: "通讯", component: defineAsyncComponent(() => import("./panels/mcp/index.vue")) },
  ...(!isMobile
    ? [{ id: "deviceLink", label: "设备互联", icon: IconDevices, component: defineAsyncComponent(() => import("./panels/deviceLink.vue")) }]
    : []),
  {
    id: "personalization",
    label: "个性化",
    icon: IconUserCog,
    groupLabel: "其他",
    component: defineAsyncComponent(() => import("./panels/personalization.vue")),
  },
  { id: "developer", label: "开发者选项", icon: IconCode, component: defineAsyncComponent(() => import("./panels/developer/index.vue")) },
  { id: "about", label: "关于", icon: IconInfoCircle, component: defineAsyncComponent(() => import("./panels/about.vue")) },
];
const activePanel = shallowRef(settingsPanels[0]!);
const visible = defineModel<boolean>({ default: false });
</script>

<style lang="scss" scoped>
// 对话框去掉内边距，侧栏通栏铺满；标题压在侧栏顶部，关闭按钮保留在右上角。选择器需高于 main.scss 的全局对话框变量。
:global(html .el-dialog.settingsDialog) {
  --el-dialog-padding-primary: 0px;
  overflow: hidden;
}

:global(.settingsDialog .el-dialog__header) {
  height: 0;
  padding: 0;
}

:global(html .el-dialog.settingsDialog .el-dialog__title) {
  position: absolute;
  top: 22px;
  left: 24px;
  z-index: 1;
  font-size: 15px;
}

:global(.settingsDialog .el-dialog__headerbtn) {
  top: 10px;
  right: 10px;
  width: 36px;
  height: 36px;
  border-radius: var(--ui-radius);
}

:global(.settingsDialog .el-dialog__headerbtn:hover) {
  background: var(--el-fill-color-light);
}

.settings {
  display: grid;
  grid-template-columns: 216px minmax(0, 1fr);
  height: min(76vh, calc(100dvh - 96px));
  overflow: hidden;

  .sidebar {
    min-height: 0;
    overflow-y: auto;
    padding: 60px 10px 16px;
    border-inline-end: 1px solid var(--el-border-color-lighter);
    background: var(--el-fill-color-extra-light);

    .settingsGroupLabel {
      margin: 16px 10px 6px;
      color: var(--el-text-color-placeholder);
      font-size: 12px;
      font-weight: 500;
      line-height: 1.5;
    }

    .settingsItem {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      min-height: 34px;
      padding: 7px 10px;
      margin-bottom: 2px;
      border: 0;
      border-radius: var(--el-border-radius-base);
      background: transparent;
      color: var(--el-text-color-regular);
      font: inherit;
      font-size: 13px;
      text-align: start;
      cursor: pointer;
      transition: background-color 0.15s, color 0.15s;

      .panelIcon {
        display: inline-flex;
        flex-shrink: 0;
        color: var(--el-text-color-secondary);
      }

      > span {
        min-width: 0;
        overflow-wrap: anywhere;
      }

      &:hover {
        background: var(--el-fill-color-light);
        color: var(--el-text-color-primary);
      }

      &[aria-pressed="true"] {
        background: var(--el-fill-color);
        color: var(--el-text-color-primary);
        font-weight: 500;

        .panelIcon {
          color: var(--el-text-color-primary);
        }
      }

      &:focus-visible {
        outline: 2px solid var(--el-color-primary);
        outline-offset: -2px;
      }
    }
  }

  .content {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 24px 28px 0 32px;
    overflow: hidden;

    .panelTitle {
      flex-shrink: 0;
      margin: 0 40px 20px 0;
      font-size: 20px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }

    .panelContent {
      flex: 1;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding-left: 5px;
      padding-right: 5px;
      padding-bottom: 50px;

      > :deep(.el-fade-in-enter-active),
      > :deep(.el-fade-in-leave-active) {
        transition-duration: 100ms;
      }
    }
  }

  @media (max-width: 700px) {
    grid-template-columns: 56px minmax(0, 1fr);

    .sidebar {
      padding: 56px 6px 12px;

      .settingsGroupLabel {
        margin: 12px 0 6px;
        text-align: center;
      }

      .settingsItem {
        justify-content: center;
        padding: 10px;
        span {
          display: none;
        }
      }
    }

    .content {
      padding: 20px 8px 0 16px;
    }
  }
}

@media (max-width: 700px) {
  :global(html .el-dialog.settingsDialog .el-dialog__title) {
    display: none;
  }
}
</style>
