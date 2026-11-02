<template>
  <div class="canvasStarter">
    <section class="starterCard" aria-labelledby="canvasStarterTitle" @dblclick.stop @contextmenu.stop>
      <div class="starterHeading">
        <span class="starterMark"><icon-layout-dashboard :size="24" /></span>
        <div><h2 id="canvasStarterTitle">你的灵感，从这张画布开始</h2><p class="starterHint">选一个起点，自动搭建并连接节点，再填入你的创作内容。</p></div>
      </div>
      <div v-if="starters.length" class="starterList">
        <button v-for="starter in starters" :key="starter.id" class="starterItem" :data-starter="starter.id" type="button" :disabled="disabled" @click="emit('start', starter.id)">
          <span class="starterFlow" aria-hidden="true">
            <template v-for="(node, index) in starter.nodes" :key="index">
              <icon-arrow-narrow-right v-if="index" class="flowArrow" :size="14" />
              <span class="flowNode"><component :is="nodeIcon(node.type)" :size="19" /><span :title="translate(node.label)">{{ translate(node.label) }}</span></span>
            </template>
          </span>
          <span class="starterTitle"><strong>{{ translate(starter.title) }}</strong><icon-arrow-up-right :size="16" /></span>
          <span class="starterDescription">{{ translate(starter.description) }}</span>
          <span class="starterMeta">{{ starter.nodes.length }} 个节点 · 点击搭建</span>
        </button>
      </div>
      <div class="starterActions">
        <el-button :icon="IconUpload" :disabled="disabled" @click="emit('upload')">上传素材</el-button>
        <el-button text :icon="IconSparkles" :disabled="disabled" @click="emit('askAgent')">让 AI 助手搭建</el-button>
      </div>
      <p class="canvasHint">也可以双击添加节点，或直接拖入图片、视频、音频和文本。</p>
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
  padding: 24px 24px 24px 168px;
  pointer-events: none;

  .starterCard {
    width: min(720px, 100%);
    padding: 24px;
    box-sizing: border-box;
    border: 1px solid var(--el-border-color-light);
    border-radius: calc(var(--ui-radius) * 2);
    background: var(--el-bg-color-overlay);
    box-shadow: var(--floatingShadow);
    pointer-events: auto;

    .starterHeading {
      display: flex;
      align-items: center;
      gap: 12px;

      .starterMark { display: grid; flex-shrink: 0; place-items: center; width: 48px; height: 48px; border: 1px solid var(--el-border-color-light); border-radius: var(--ui-radius-large); background: var(--el-fill-color-extra-light); color: var(--el-text-color-regular); }
    }

    h2 {
      margin: 0;
      font-size: 20px;
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
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-top: 24px;

      .starterItem {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
        min-width: 0;
        padding: 16px 12px;
        border: 1px solid var(--el-border-color-light);
        border-radius: var(--ui-radius-large);
        background: var(--el-fill-color-extra-light);
        color: var(--el-text-color-primary);
        font: inherit;
        text-align: start;
        cursor: pointer;
        transition: border-color 0.15s, background-color 0.15s;
        --flowAccent: #8c6cb0;

        &[data-starter="imageToVideo"] { --flowAccent: #36867b; }
        &[data-starter="scriptToShot"] { --flowAccent: #b27e3d; }

        &:hover:not(:disabled) {
          border-color: var(--flowAccent);
          background: var(--el-bg-color);
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
          justify-content: center;
          gap: 5px;
          width: 100%;
          min-height: 74px;
          margin-bottom: 8px;
          color: var(--flowAccent);

          .flowNode {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 6px;
            min-width: 0;

            > svg { flex-shrink: 0; box-sizing: content-box; padding: 9px; border: 1px solid color-mix(in srgb, var(--flowAccent) 20%, var(--el-border-color-light)); border-radius: var(--ui-radius); background: color-mix(in srgb, var(--flowAccent) 6%, var(--el-bg-color)); }
            > span { max-width: 60px; overflow: hidden; color: var(--el-text-color-secondary); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
          }

          .flowArrow {
            flex-shrink: 0;
            margin-top: -18px;
            color: var(--el-text-color-placeholder);
          }
        }

        .starterTitle {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 4px;
          width: 100%;

          strong { font-size: 14px; font-weight: 600; }
          > svg { flex-shrink: 0; color: var(--el-text-color-secondary); }
        }

        .starterDescription {
          color: var(--el-text-color-secondary);
          font-size: 12px;
          line-height: 1.5;
          flex: 1;
        }

        .starterMeta { margin-top: 6px; color: var(--el-text-color-secondary); font-size: 10px; }
      }
    }

    .starterActions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 20px;

      .el-button {
        margin: 0;
        color: var(--el-text-color-regular);

        &:hover {
          color: var(--el-text-color-primary);
        }
      }
    }

    .canvasHint { margin: 16px 0 0; color: var(--el-text-color-secondary); font-size: 11px; line-height: 1.7; }
  }

  @container (max-width: 700px) {
    padding-inline-start: 76px;

    .starterCard { padding: 18px; }
    .starterCard .starterHeading .starterMark { display: none; }
    .starterCard h2 { font-size: 18px; }
    .starterCard .starterList { grid-template-columns: 1fr; gap: 8px; margin-top: 16px; }
    .starterCard .starterList .starterItem { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 8px; padding: 10px 12px; }
    .starterCard .starterList .starterItem .starterFlow { display: none; }
    .starterCard .starterList .starterItem .starterTitle { grid-column: 1; }
    .starterCard .starterList .starterItem .starterTitle > svg { display: none; }
    .starterCard .starterList .starterItem .starterMeta { grid-column: 2; grid-row: 1 / 3; align-self: center; margin: 0; }
    .starterCard .starterList .starterItem .starterDescription { grid-column: 1; }
  }

  @media (max-width: 480px) {
    padding: 16px 16px 16px 56px;

    .starterCard {
      padding: 16px;
    }
  }

  @media (max-height: 650px) {
    align-items: start;
    overflow-y: auto;
  }

  @media (prefers-reduced-motion: reduce) {
    .starterCard .starterList .starterItem { transition: none; }
  }
}
</style>
