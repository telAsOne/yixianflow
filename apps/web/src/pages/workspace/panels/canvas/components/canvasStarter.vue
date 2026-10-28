<template>
  <div class="canvasStarter">
    <section class="starterCard" aria-labelledby="canvasStarterTitle" @dblclick.stop @contextmenu.stop>
      <h2 id="canvasStarterTitle">开始创作</h2>
      <p class="starterHint">双击空白处添加节点，或把图片、视频、音频、文本拖进画布。</p>
      <div v-if="starters.length" class="starterList">
        <button v-for="starter in starters" :key="starter.id" class="starterItem" type="button" :disabled="disabled" @click="emit('start', starter.id)">
          <span class="starterFlow" aria-hidden="true">
            <template v-for="(node, index) in starter.nodes" :key="index">
              <icon-arrow-narrow-right v-if="index" class="flowArrow" :size="14" />
              <component :is="nodeIcon(node.type)" :size="16" />
            </template>
          </span>
          <strong>{{ translate(starter.title) }}</strong>
          <span class="starterDescription">{{ translate(starter.description) }}</span>
        </button>
      </div>
      <div class="starterActions">
        <el-button text :icon="IconUpload" :disabled="disabled" @click="emit('upload')">上传</el-button>
        <el-button text :icon="IconSparkles" :disabled="disabled" @click="emit('askAgent')">让 AI 助手搭建</el-button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { translate } from "@toonflow/i18n/vue";
import { IconBox, IconSparkles, IconUpload } from "@tabler/icons-vue";
import type { useNodeCreation } from "../useNodeCreation";

type NodeCreation = ReturnType<typeof useNodeCreation>;
const props = defineProps<{ nodeOptions: NodeCreation["nodeOptions"]["value"]; starters: NodeCreation["starters"]["value"]; disabled?: boolean }>();
const emit = defineEmits<{ start: [id: string]; upload: []; askAgent: [] }>();

function nodeIcon(type: string) {
  return props.nodeOptions.find(node => node.type === type)?.icon ?? IconBox;
}
</script>

<style lang="scss" scoped>
.canvasStarter {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: grid;
  place-items: center;
  padding: 24px 24px 24px 72px;
  pointer-events: none;

  .starterCard {
    width: min(560px, 100%);
    padding: 24px;
    box-sizing: border-box;
    border: 1px solid var(--el-border-color-light);
    border-radius: calc(var(--ui-radius) * 2);
    background: var(--el-bg-color-overlay);
    box-shadow: var(--floatingShadow);
    pointer-events: auto;

    h2 {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }

    .starterHint {
      margin: 6px 0 0;
      color: var(--el-text-color-secondary);
      font-size: 13px;
      line-height: 1.6;
    }

    .starterList {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 8px;
      margin-top: 18px;

      .starterItem {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
        padding: 12px;
        border: 1px solid var(--el-border-color-light);
        border-radius: var(--ui-radius-large);
        background: transparent;
        color: var(--el-text-color-primary);
        font: inherit;
        text-align: start;
        cursor: pointer;
        transition: border-color 0.15s, background-color 0.15s;

        &:hover:not(:disabled) {
          border-color: var(--el-border-color-darker);
          background: var(--el-fill-color-extra-light);
        }

        &:focus-visible {
          outline: 2px solid var(--el-color-primary);
          outline-offset: 2px;
        }

        &:disabled {
          cursor: not-allowed;
          opacity: 0.5;
        }

        // 与画布一致按从左到右表示数据流向，RTL 界面不翻转。
        .starterFlow {
          display: flex;
          direction: ltr;
          align-items: center;
          gap: 4px;
          margin-bottom: 4px;
          color: var(--el-text-color-regular);

          .flowArrow {
            color: var(--el-text-color-placeholder);
          }
        }

        strong {
          font-size: 14px;
          font-weight: 600;
        }

        .starterDescription {
          color: var(--el-text-color-secondary);
          font-size: 12px;
          line-height: 1.5;
        }
      }
    }

    .starterActions {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin: 14px 0 -8px -8px;

      .el-button {
        margin: 0;
        color: var(--el-text-color-regular);

        &:hover {
          color: var(--el-text-color-primary);
        }
      }
    }
  }

  @media (max-width: 480px) {
    padding: 16px 16px 16px 56px;

    .starterCard {
      padding: 18px;
    }
  }
}
</style>
