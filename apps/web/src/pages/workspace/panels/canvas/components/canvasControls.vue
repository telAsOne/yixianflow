<template>
  <div class="canvasControlStack" @dblclick.stop>
    <div class="canvasControls" role="toolbar" aria-label="画布导航">
      <el-tooltip :showArrow="false" :content="shortcutHint('返回上一视图', 'returnView')" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
        <el-button class="toolButton" text :disabled="!navigation.canGoBack.value" aria-label="返回上一视图" @click="navigation.goBack()">
          <icon-arrow-back-up :size="17" />
        </el-button>
      </el-tooltip>
      <span class="toolDivider" aria-hidden="true" />
      <el-tooltip :showArrow="false" :content="shortcutHint('聚焦选中节点', 'focusSelection')" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
        <el-button class="toolButton optionalTool" text :disabled="!canFocusSelection" aria-label="聚焦选中节点" @click="focusSelection">
          <icon-zoom-scan :size="17" />
        </el-button>
      </el-tooltip>
      <el-tooltip :showArrow="false" :content="shortcutHint('查看整个画布', 'fitView')" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
        <el-button class="toolButton" text :disabled="!canShowAll" aria-label="查看整个画布" @click="navigation.showAll()">
          <icon-focus-centered :size="17" />
        </el-button>
      </el-tooltip>
      <span class="toolDivider" aria-hidden="true" />
      <el-tooltip :showArrow="false" content="缩小" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
        <el-button class="toolButton" text :disabled="!canNavigate || viewport.zoom <= flow.minZoom.value" aria-label="缩小" @click="zoomOut()">
          <icon-minus :size="17" />
        </el-button>
      </el-tooltip>
      <el-tooltip :showArrow="false"
        content="缩放菜单（滚轮调整缩放）"
        placement="top"
        :hideAfter="0"
        :enterable="false"
        :triggerKeys="[]"
        :disabled="zoomMenuVisible">
        <span class="toolTrigger">
          <el-popover v-model:visible="zoomMenuVisible" trigger="click" placement="top-end" :width="216">
            <template #reference>
              <el-button
                class="toolButton zoomButton"
                text
                :disabled="!canNavigate"
                aria-label="缩放菜单"
                @wheel.stop.prevent="$event.deltaY && applyZoom(Math.min(800, Math.max(2, zoomPercent - Math.sign($event.deltaY))))">
                {{ zoomPercent }}%
              </el-button>
            </template>
            <div class="zoomMenu">
              <el-input-number
                class="zoomInput"
                :modelValue="zoomPercent"
                :min="2"
                :max="800"
                :controls="false"
                :disabled="!canNavigate"
                aria-label="缩放百分比"
                @change="applyZoom">
                <template #suffix>%</template>
              </el-input-number>
              <el-button class="zoomAction" text :disabled="!canNavigate" @click="zoomMenuVisible = false; navigation.resetZoom()">实际大小 · 100%</el-button>
              <el-button class="zoomAction" text :disabled="!canFocusSelection" @click="focusSelection">聚焦选中节点</el-button>
              <el-button class="zoomAction" text :disabled="!canShowAll" @click="zoomMenuVisible = false; navigation.showAll()">查看整个画布</el-button>
            </div>
          </el-popover>
        </span>
      </el-tooltip>
      <el-tooltip :showArrow="false" content="放大" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
        <el-button class="toolButton" text :disabled="!canNavigate || viewport.zoom >= flow.maxZoom.value" aria-label="放大" @click="zoomIn()">
          <icon-plus :size="17" />
        </el-button>
      </el-tooltip>
      <span class="toolDivider" aria-hidden="true" />
      <el-tooltip :showArrow="false" :content="shortcutHint(showMap ? '隐藏地图' : '显示地图', 'toggleMap')" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
        <el-button class="toolButton" text :aria-pressed="showMap" aria-label="显示或隐藏地图" @click="toggleMap">
          <icon-map :size="17" />
        </el-button>
      </el-tooltip>
      <el-tooltip :showArrow="false" content="更多画布工具" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]" :disabled="moreVisible">
        <span class="toolTrigger">
          <el-popover v-model:visible="moreVisible" trigger="click" placement="top-end" :width="196">
            <template #reference>
              <el-button class="toolButton" text aria-label="更多画布工具"><icon-dots :size="17" /></el-button>
            </template>
            <div class="helpMenu">
              <el-button class="helpAction" text :icon="IconSitemap" :disabled="!canArrange" @click="moreVisible = false; arrangeNodes()">整理画布</el-button>
              <el-button class="helpAction" text :icon="IconMagnet" :aria-pressed="snapEnabled" @click="snapEnabled = !snapEnabled">{{ snapEnabled ? '关闭网格吸附' : '开启网格吸附' }}</el-button>
              <el-button class="helpAction" text :icon="IconArrowGuide" :aria-pressed="showEdges" @click="showEdges = !showEdges">{{ showEdges ? '隐藏连线' : '显示连线' }}</el-button>
            </div>
          </el-popover>
        </span>
      </el-tooltip>
      <el-tooltip :showArrow="false" content="帮助" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]" :disabled="helpVisible">
        <span class="toolTrigger">
          <el-popover v-model:visible="helpVisible" trigger="click" placement="top-end" :width="196">
            <template #reference>
              <el-button class="toolButton" text aria-label="帮助">
                <icon-help :size="17" />
              </el-button>
            </template>
            <div class="helpMenu">
              <el-button
                class="helpAction"
                tag="a"
                text
                :icon="IconBook"
                href="https://qcn7xdsqgc4z.feishu.cn/docx/RXFqdgR2Xo0dXZxGfd0cZCGgnwf"
                target="_blank"
                rel="noopener noreferrer"
                @click="helpVisible = false">
                使用教程
              </el-button>
              <el-button
                class="helpAction"
                tag="a"
                text
                :icon="IconBug"
                href="https://docs.qq.com/smartsheet/form/EmvmQBrmlPmr%2Fss_vsqk2v%2FvhiGzE?tab=ss_vsqk2v"
                target="_blank"
                rel="noopener noreferrer"
                title="Toonflow 需求/BUG反馈表"
                @click="helpVisible = false">
                汇报 BUG
              </el-button>
              <el-button class="helpAction" text :icon="IconBrandWechat" @click="showContact('community')">加入交流群</el-button>
              <el-button class="helpAction" text :icon="IconBriefcase" @click="showContact('business')">商务合作</el-button>
            </div>
          </el-popover>
        </span>
      </el-tooltip>
    </div>
  </div>
  <arrangeDialog ref="arrangeDialogRef" :active="active" :canvasId="canvasId" :directory="directory" :projectName="projectName" :batchHistory="batchHistory" />
  <el-dialog v-model="contactVisible" :title="contactInfo.title" width="min(360px, calc(100vw - 32px))" alignCenter appendToBody>
    <div class="contactContent">
      <tdesignProvider><q-r-code
        :value="contactInfo.url"
        :size="192"
        type="svg"
        color="#000000"
        bgColor="#ffffff"
        borderless
        role="img"
        :aria-label="`${contactInfo.title}二维码`" /></tdesignProvider>
      <p class="contactTip">{{ contactInfo.tip }}</p>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import tdesignProvider from "@/components/tdesignProvider.vue";
import { computed, ref } from "vue";
import { useVueFlow } from "@vue-flow/core";
import { IconArrowGuide, IconBook, IconBug, IconBrandWechat, IconBriefcase, IconMagnet, IconSitemap } from "@tabler/icons-vue";
import { ElMessage } from "element-plus";
import { QRCode } from "tdesign-vue-next";
import arrangeDialog from "./arrangeDialog.vue";
import type { CanvasNavigation } from "../useCanvasNavigation";
import { generalSettings } from "@/stores/settings";
import { shortcutLabel, type CanvasShortcutAction } from "@/lib/canvasShortcuts";

const props = defineProps<{
  active: boolean;
  canvasId: string;
  directory: string | undefined;
  projectName: string;
  navigation: CanvasNavigation;
  batchHistory: (action: () => Promise<void>) => Promise<void>;
}>();
const snapEnabled = defineModel<boolean>("snapEnabled", { required: true });
const showEdges = defineModel<boolean>("showEdges", { required: true });
const showMap = defineModel<boolean>("showMap", { default: true });
const zoomMenuVisible = ref(false);
const moreVisible = ref(false);
const helpVisible = ref(false);
const contactVisible = ref(false);
const contactType = ref<"community" | "business">("community");
const contacts = {
  community: {
    title: "加入交流群",
    url: "https://work.weixin.qq.com/u/vc36adcc89845edcbe?v=5.0.3.63936&bb=85b8d228e8",
    tip: "Toonflow 是为爱发电的开源项目。欢迎文明交流、友善反馈；回复可能需要一些时间，请避免责问或命令式沟通，感谢你的理解与尊重。",
  },
  business: {
    title: "商务合作",
    url: "https://work.weixin.qq.com/u/vc0f54596c5837d05a?v=5.0.8.70675",
    tip: "此联系方式仅用于商务合作接洽，不提供问题答疑。使用问题欢迎在交流群交流，需求与 BUG 可通过反馈表提交。感谢理解。",
  },
};
const contactInfo = computed(() => contacts[contactType.value]);
const flow = useVueFlow();
const { viewport, zoomTo, zoomIn, zoomOut, getNodes } = flow;
const canNavigate = computed(() => props.active && !!props.canvasId && !!props.directory);
const canShowAll = computed(() => canNavigate.value && getNodes.value.some(node => !node.hidden && node.dimensions.width > 0 && node.dimensions.height > 0));
const canFocusSelection = computed(() => canNavigate.value && flow.getSelectedNodes.value.some(node => !node.hidden && node.dimensions.width > 0 && node.dimensions.height > 0));
const zoomPercent = computed(() => Math.round(viewport.value.zoom * 100));
const arrangeDialogRef = ref<InstanceType<typeof arrangeDialog>>();
const canArrange = computed(() => {
  const nodes = getNodes.value.filter((node) => node.type !== "canvasGroup");
  return (
    props.active &&
    !!props.canvasId &&
    !!props.directory &&
    !arrangeDialogRef.value?.visible &&
    nodes.length > 0 &&
    nodes.every((node) => node.dimensions.width > 0 && node.dimensions.height > 0)
  );
});
defineExpose({ arrangeNodes, requestArrange });

function shortcutHint(label: string, action: CanvasShortcutAction) {
  const binding = shortcutLabel(generalSettings.value.canvasShortcuts[action]);
  return binding ? `${label}（${binding}）` : label;
}

function toggleMap() {
  showMap.value = !showMap.value;
}

function focusSelection() {
  zoomMenuVisible.value = false;
  return props.navigation.focusNodes(flow.getSelectedNodes.value.map(node => node.id));
}

function showContact(type: "community" | "business") {
  contactType.value = type;
  helpVisible.value = false;
  contactVisible.value = true;
}

function applyZoom(value: number | undefined) {
  if (value !== undefined && Number.isFinite(value) && canNavigate.value) {
    void zoomTo(Math.min(flow.maxZoom.value, Math.max(flow.minZoom.value, value / 100)));
  }
}

async function arrangeNodes() {
  if (!canArrange.value) return;
  try {
    await requestArrange();
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) ElMessage.error(error instanceof Error ? error.message : "整理画布失败");
  }
}

async function requestArrange(signal?: AbortSignal) {
  if (!canArrange.value || !arrangeDialogRef.value) throw new Error("画布尚未就绪或正在整理");
  return arrangeDialogRef.value.open(signal);
}
</script>

<style lang="scss" scoped>
.canvasControlStack {
  pointer-events: auto;

  .canvasControls {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--el-border-color-light);
    border-radius: var(--ui-radius-large);
    background: var(--el-bg-color-overlay);
    box-shadow: var(--floatingShadow);

    // 画布容器较窄时（如 AI 助手停靠），聚焦按钮收起，缩放菜单内仍可使用。
    @container (max-width: 560px) {
      .optionalTool { display: none; }
      .toolDivider { margin: 0 1px; }
      .toolButton { width: 30px; }
    }

    .toolTrigger { display: inline-flex; }

    .toolDivider {
      width: 1px;
      height: 18px;
      margin: 0 3px;
      background: var(--el-border-color);
    }

    .toolButton {
      width: 32px;
      height: 32px;
      flex-shrink: 0;
      margin-left: 0;
      padding: 0;
      border-radius: var(--ui-radius);
      color: var(--el-text-color-regular);

      &:hover:not(.is-disabled) {
        background: var(--el-fill-color-light);
        color: var(--el-text-color-primary);
      }

      &[aria-pressed="true"] {
        background: var(--el-fill-color);
        color: var(--el-color-primary);
      }

      &.zoomButton {
        width: auto;
        min-width: 48px;
        padding: 0 4px;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
      }
    }
  }
}

.zoomMenu {
  display: flex;
  flex-direction: column;

  .zoomInput {
    width: 100%;
  }

  .zoomAction {
    justify-content: flex-start;
    margin-left: 0;
  }
}

.helpMenu {
  display: flex;
  flex-direction: column;
  gap: 4px;

  .helpAction {
    justify-content: flex-start;
    margin-left: 0;
  }
}

.contactContent {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;

  .contactTip {
    margin: 0;
    color: var(--el-text-color-secondary);
    font-size: 12px;
    line-height: 1.7;
  }
}
</style>
