<template>
  <nav class="canvasDock" aria-label="创作工具" @dblclick.stop @contextmenu.stop.prevent>
    <div v-if="nodeOptions.length" class="dockGroup">
      <el-tooltip v-for="node in nodeOptions" :key="node.type" :content="`${node.label}（点击后选择位置，或拖入画布）`" placement="right" :showArrow="false" :hideAfter="0" :enterable="false">
        <el-button class="dockButton" text :disabled="disabled" :aria-label="node.label" :aria-pressed="placingType === node.type" draggable="true" @click="release($event); emit('addNode', node.type)" @dragstart="emit('dragNode', $event, node.type)">
          <component :is="node.icon" :size="18" aria-hidden="true" />
        </el-button>
      </el-tooltip>
    </div>
    <span v-if="nodeOptions.length" class="dockDivider" aria-hidden="true" />
    <div class="dockGroup">
      <el-tooltip content="上传" placement="right" :showArrow="false" :hideAfter="0" :enterable="false">
        <el-button class="dockButton" text :disabled="disabled" aria-label="上传" @click="release($event); emit('upload')">
          <icon-upload :size="18" aria-hidden="true" />
        </el-button>
      </el-tooltip>
      <el-tooltip :content="assetsVisible ? '关闭素材库' : '打开素材库'" placement="right" :showArrow="false" :hideAfter="0" :enterable="false">
        <el-button class="dockButton" text :disabled="disabled" :aria-pressed="assetsVisible" aria-label="素材库" @click="assetsVisible = !assetsVisible">
          <icon-folders :size="18" aria-hidden="true" />
        </el-button>
      </el-tooltip>
      <el-popover v-if="starters.length" v-model:visible="startersVisible" trigger="click" placement="right-start" :width="260" :showArrow="false" :offset="10">
        <template #reference>
          <span class="dockTrigger">
            <el-tooltip content="快速开始" placement="right" :showArrow="false" :hideAfter="0" :enterable="false" :disabled="startersVisible">
              <el-button class="dockButton" text :disabled="disabled" aria-label="快速开始" :aria-expanded="startersVisible">
                <icon-template :size="18" aria-hidden="true" />
              </el-button>
            </el-tooltip>
          </span>
        </template>
        <div class="starterMenu" role="menu" aria-label="快速开始">
          <button v-for="starter in starters" :key="starter.id" class="starterOption" type="button" role="menuitem" :disabled="disabled" @click="startersVisible = false; emit('start', starter.id)">
            <strong>{{ translate(starter.title) }}</strong>
            <span>{{ translate(starter.description) }}</span>
          </button>
        </div>
      </el-popover>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { translate } from "@toonflow/i18n/vue";
import type { useNodeCreation } from "../useNodeCreation";

type NodeCreation = ReturnType<typeof useNodeCreation>;
defineProps<{ nodeOptions: NodeCreation["nodeOptions"]["value"]; starters: NodeCreation["starters"]["value"]; disabled?: boolean; placingType?: string }>();
const assetsVisible = defineModel<boolean>("assetsVisible", { default: false });
const emit = defineEmits<{ addNode: [type: string]; dragNode: [event: DragEvent, type: string]; upload: []; start: [id: string] }>();
const startersVisible = ref(false);

// 鼠标点击后归还焦点，使新建节点可直接用画布快捷键操作；键盘触发时保留焦点位置。
function release(event: MouseEvent) {
  if (event.detail) (event.currentTarget as HTMLElement).blur();
}
</script>

<style lang="scss" scoped>
.canvasDock {
  position: absolute;
  top: 50%;
  left: 12px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  max-height: calc(100% - 24px);
  padding: 4px;
  overflow-y: auto;
  box-sizing: border-box;
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--ui-radius-large);
  background: var(--el-bg-color-overlay);
  box-shadow: var(--floatingShadow);
  transform: translateY(-50%);
  scrollbar-width: none;

  .dockGroup {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .dockTrigger {
    display: inline-flex;
  }

  .dockDivider {
    flex-shrink: 0;
    width: 18px;
    height: 1px;
    background: var(--el-border-color);
  }

  .dockButton {
    width: 36px;
    height: 36px;
    margin: 0;
    padding: 0;
    border-radius: var(--ui-radius);
    color: var(--el-text-color-regular);
    cursor: pointer;

    &:hover:not(.is-disabled) {
      background: var(--el-fill-color-light);
      color: var(--el-text-color-primary);
    }

    &[aria-pressed="true"],
    &[aria-expanded="true"] {
      background: var(--el-fill-color);
      color: var(--el-color-primary);
    }

    &:focus-visible {
      outline: 2px solid var(--el-color-primary);
      outline-offset: -2px;
    }
  }

  @media (max-width: 480px) {
    left: 8px;

    .dockButton {
      width: 32px;
      height: 32px;
    }
  }
}

.starterMenu {
  display: flex;
  flex-direction: column;
  gap: 2px;

  .starterOption {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px;
    border: 0;
    border-radius: var(--ui-radius);
    background: transparent;
    color: var(--el-text-color-primary);
    font: inherit;
    text-align: start;
    cursor: pointer;

    strong {
      font-size: 13px;
      font-weight: 600;
    }

    span {
      color: var(--el-text-color-secondary);
      font-size: 12px;
      line-height: 1.5;
    }

    &:hover:not(:disabled),
    &:focus-visible {
      background: var(--el-fill-color-light);
      outline: none;
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
  }
}
</style>
