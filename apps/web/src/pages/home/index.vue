<template>
  <div class="home">
    <header class="topBar">
      <div class="brand">
        <img class="brandLogo" :src="logoUrl" alt="" aria-hidden="true" />
        <span class="brandName">Yixianflow</span>
      </div>
      <nav class="topActions" aria-label="快捷操作">
        <el-button class="chromeButton" text :type="deviceHubEnabled ? 'success' : undefined" :icon="deviceHubEnabled || mobileConnection.mode === 'remote' ? IconDeviceDesktop : IconQrcode" @click="mobileConnectVisible = true">
          <span class="chromeLabel">{{ mobileConnectionLabel }}</span>
        </el-button>
        <el-badge isDot :hidden="!hasDesktopUpdate" :offset="[-6, 6]">
          <el-button class="chromeButton" text :icon="IconSettings" :aria-label="hasDesktopUpdate ? '设置，有新版本可用' : '设置'" @click="settingsVisible = true">
            <span class="chromeLabel">设置</span>
          </el-button>
        </el-badge>
      </nav>
    </header>
    <main class="pageContent">
      <section class="creationPanel" aria-label="创建项目">
        <div class="hero">
          <img class="heroLogo" :src="logoUrl" alt="Yixianflow" />
          <h1>Yixianflow</h1>
        </div>
        <div class="composer" :class="{ busy: creating || opening }">
          <div class="composerLabel"><icon-sparkles :size="14" aria-hidden="true" />灵感创作模式</div>
          <attachmentList v-if="promptAttachments.length" class="promptAttachments" :attachments="promptAttachments" removable restorable :disabled="creating || opening" @remove="promptAttachments.splice($event, 1)" @restore="restoreAttachment" />
          <el-input ref="promptInput" v-model="prompt" class="promptInput" type="textarea" :autosize="{ minRows: 3, maxRows: 10 }" resize="none" :disabled="creating || opening" :placeholder="promptPlaceholder" aria-label="创作描述" @paste.capture="pasteText" />
          <div class="composerFooter">
            <workspacePicker ref="promptWorkspacePicker" v-model="workspaceDirectory" :disabled="creating || opening" />
            <div class="sendActions">
              <modelPopover v-model="selectedModel" v-model:reasoningEffort="reasoningEffort" class="modelSelect" :disabled="creating || opening" />
              <el-button class="sendButton" type="primary" :circle="!!workspaceDirectory" :round="!workspaceDirectory" :icon="workspaceDirectory ? IconArrowUp : IconFolder" :loading="creating" :disabled="creating || opening" :aria-label="workspaceDirectory ? '发送' : '选择工作目录'" @click="workspaceDirectory ? createProject() : promptWorkspacePicker?.chooseDirectory()">
                <template v-if="!workspaceDirectory" #default>选择工作目录</template>
              </el-button>
            </div>
          </div>
        </div>
        <p v-if="!workspaceDirectory" class="workspaceHint" role="status"><icon-info-circle :size="14" aria-hidden="true" />请先选择一个空文件夹作为工作目录，画布和素材会保存在这里。</p>
      </section>
      <section class="projectList" aria-labelledby="projectListTitle">
        <div class="sectionHeader">
          <h2 id="projectListTitle">项目列表<span v-if="projectList.length" class="projectCount">{{ projectList.length }}</span></h2>
          <div class="sectionActions">
            <el-button class="sectionButton" text :icon="IconFolderOpen" :disabled="creating || opening" @click="openProject()">导入项目</el-button>
            <el-button class="sectionButton" text :icon="IconFolderPlus" :disabled="creating || opening" @click="createProject(false)">添加项目</el-button>
            <span class="actionDivider" aria-hidden="true" />
            <el-tooltip :content="sortDescending ? '按时间降序' : '按时间升序'" placement="top" :showArrow="false" :hideAfter="0">
              <el-button class="iconButton" text :icon="sortDescending ? IconSortDescending : IconSortAscending" :aria-label="sortDescending ? '按时间降序' : '按时间升序'" @click="sortDescending = !sortDescending" />
            </el-tooltip>
            <el-radio-group v-model="viewMode" class="viewToggle" aria-label="项目视图">
              <el-radio-button value="grid" aria-label="网格视图"><icon-layout-grid :size="15" /></el-radio-button>
              <el-radio-button value="list" aria-label="列表视图"><icon-list :size="15" /></el-radio-button>
            </el-radio-group>
          </div>
        </div>
        <div class="projectItems" :class="{ listView: viewMode === 'list' }">
          <article v-for="project in sortedProjects" :key="project.directory" class="projectCard">
            <button class="projectEntry" type="button" :disabled="creating || opening" :aria-label="`打开项目 ${project.name}`" @click="openProject(project)">
              <span class="projectIcon" aria-hidden="true"><icon-folder :size="18" /></span>
              <span class="projectName" :title="project.name">{{ project.name }}</span>
              <span class="projectPath" :title="project.directory">{{ project.directory }}</span>
              <span class="projectTime">最近打开 {{ new Date(project.lastOpenedAt).toLocaleString(locale, { hour12: false }) }}</span>
            </button>
            <div class="projectActions">
              <el-button text :icon="IconEdit" :disabled="creating || opening" :aria-label="`重命名项目 ${project.name}`" title="重命名" @click="renameProject(project)" />
              <el-button text type="danger" :icon="IconTrash" :disabled="creating || opening" :aria-label="`移除项目 ${project.name}`" title="从列表移除，不删除文件" @click="workspaceStore.removeProject(project.directory)" />
            </div>
          </article>
        </div>
      </section>
    </main>
    <settings v-model="settingsVisible" />
    <mobileConnect v-model="mobileConnectVisible" />
    <workspacePicker ref="relocationPicker" hideTrigger />
  </div>
</template>

<script setup lang="ts">
import { locale, translate } from "@toonflow/i18n/vue";
import axios from "axios";
import { storeToRefs } from "pinia";
import { computed, defineAsyncComponent, nextTick, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox, type InputInstance } from "element-plus";
import {
  IconSettings, IconQrcode, IconDeviceDesktop,
  IconArrowUp, IconLayoutGrid, IconList, IconSortDescending,
  IconSortAscending, IconFolder, IconEdit, IconSparkles, IconInfoCircle,
  IconTrash, IconFolderPlus, IconFolderOpen,
} from "@tabler/icons-vue";
import modelPopover from "@/components/modelPopover.vue";
import attachmentList from "@/components/agent/attachmentList.vue";
import { createPastedTextFile, readTextAttachment } from "@/components/agent/textAttachments";
import type { AgentAttachment } from "@/components/agent/types";
import logoUrl from "@toonflow/assets/logo.svg";
import { useWorkspaceStore, type Project } from "@/stores/workspace";
import { hasDesktopUpdate } from "@/stores/desktopUpdate";
import { deviceHubEnabled, mobileConnection, mobileConnectionLabel } from "@/lib/mobile";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import settings from "@/components/settings/index.vue";
import workspacePicker from "./workspacePicker.vue";

const settingsVisible = ref(false);
const mobileConnectVisible = ref(false);
const mobileConnect = defineAsyncComponent(() => import("@/components/mobileConnect.vue"));
const router = useRouter();
const creating = ref(false);
const opening = ref(false);
const promptWorkspacePicker = ref<InstanceType<typeof workspacePicker>>();
const relocationPicker = ref<InstanceType<typeof workspacePicker>>();
const prompt = ref("");
const promptInput = ref<InputInstance>();
const promptAttachments = ref<AgentAttachment[]>([]);
const workspaceStore = useWorkspaceStore();
const { project, projectList } = storeToRefs(workspaceStore);
const workspaceDirectory = ref(project.value?.directory ?? "");
const placeholderPhrases = [
  "描述你想创作的内容，让灵感从这里开始…",
  "把一个故事灵感，变成一段精彩的短片…",
  "为你的主角设计独特的外形和性格…",
  "创作一段雨夜街头的电影感镜头…",
  "把这段文字拆解成连贯的分镜画面…",
  "为一场奇幻冒险生成场景和角色…",
  "为你的画面配上一段合适的音乐…",
  "写一段温暖的旁白，讲述这个故事…",
  "设计一支富有想象力的产品宣传片…",
  "从一句话开始，搭建你的创作工作流…",
];
const promptPlaceholder = ref(translate(placeholderPhrases[0]!));

onMounted(() => {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let phraseIndex = 0;
  watch([() => !!prompt.value, locale], ([hasInput], _previous, onCleanup) => {
    if (reduceMotion) {
      promptPlaceholder.value = translate(placeholderPhrases[0]!);
      return;
    }
    if (hasInput) return;
    const segmenter = new Intl.Segmenter(locale.value, { granularity: "grapheme" });
    const phrases = placeholderPhrases.map(phrase => [...segmenter.segment(translate(phrase))].map(part => part.segment));
    let characterCount = 0;
    let deleting = false;
    let timer: ReturnType<typeof setTimeout>;
    promptPlaceholder.value = "";

    function typePlaceholder() {
      const phrase = phrases[phraseIndex]!;
      characterCount += deleting ? -1 : 1;
      promptPlaceholder.value = phrase.slice(0, characterCount).join("");
      let delay = deleting ? 35 : 85;
      if (characterCount === phrase.length) {
        deleting = true;
        delay = 1800;
      } else if (characterCount === 0) {
        deleting = false;
        phraseIndex = (phraseIndex + 1) % placeholderPhrases.length;
        delay = 300;
      }
      timer = setTimeout(typePlaceholder, delay);
    }

    timer = setTimeout(typePlaceholder, 300);
    onCleanup(() => clearTimeout(timer));
  }, { immediate: true });
});

const selectedModel = ref("");
const reasoningEffort = ref("");
const sortDescending = ref(true);
const viewMode = ref("grid");
const sortedProjects = computed(() => [...projectList.value].sort((left, right) =>
  sortDescending.value ? right.lastOpenedAt - left.lastOpenedAt : left.lastOpenedAt - right.lastOpenedAt
));

function pasteText(event: ClipboardEvent) {
  if (creating.value || opening.value) return;
  try {
    const file = createPastedTextFile(event.clipboardData?.getData("text/plain") ?? "");
    if (!file) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (promptAttachments.value.length >= 20) return ElMessage.warning("每条消息最多添加 20 个附件");
    promptAttachments.value.push({ name: file.name, path: "", mimeType: file.type, file });
  } catch (error) {
    event.preventDefault();
    event.stopImmediatePropagation();
    ElMessage.error(error instanceof Error ? error.message : "添加文本附件失败，请重试");
  }
}

async function restoreAttachment(index: number) {
  const attachment = promptAttachments.value[index];
  if (!attachment || creating.value || opening.value) return;
  try {
    const text = await readTextAttachment(attachment);
    const currentIndex = promptAttachments.value.indexOf(attachment);
    if (currentIndex < 0 || creating.value || opening.value) return;
    prompt.value += `${prompt.value ? "\n" : ""}${text}`;
    promptAttachments.value.splice(currentIndex, 1);
    await nextTick();
    promptInput.value?.focus();
    promptInput.value?.textarea?.setSelectionRange(prompt.value.length, prompt.value.length);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "取回文本失败，请重试");
  }
}

async function openProject(project?: Project) {
  if (creating.value || opening.value) return;
  opening.value = true;
  try {
    const directory = project?.directory ?? await relocationPicker.value?.chooseDirectory();
    if (!directory) return;
    try { await workspaceStore.openProject(directory); }
    catch (err) {
      if (!project || !axios.isAxiosError(err) || err.response?.status !== 404) throw err;
      const reselect = await ElMessageBox.confirm(`项目“${project.name}”的文件夹不存在，是否重新选择文件夹？`, "工作目录不存在", {
        confirmButtonText: "重新选择", cancelButtonText: "取消", type: "warning",
      }).then(() => true, () => false);
      if (!reselect) return;
      const directory = await relocationPicker.value?.chooseDirectory();
      if (!directory) return;
      await workspaceStore.openProject(directory, project.directory);
    }
    await router.push("/workspace");
  } catch (err) {
    ElMessage.error(axios.isAxiosError<{ message?: string }>(err)
      ? err.response?.data.message || "无法打开项目，请重试"
      : err instanceof Error ? err.message : "无法打开项目，请重试");
  } finally { opening.value = false; }
}

async function renameProject(project: Project) {
  const result = await ElMessageBox.prompt("请输入项目名称", "重命名项目", {
    inputValue: project.name, confirmButtonText: "保存", cancelButtonText: "取消",
    inputValidator: value => !!value?.trim() || "项目名称不能为空",
  }).catch(() => null);
  if (result) workspaceStore.renameProject(project.directory, result.value);
}

async function createProject(fromPrompt = true) {
  if (creating.value || opening.value || (fromPrompt && !workspaceDirectory.value)) return;
  creating.value = true;
  try {
    let path = workspaceDirectory.value;
    if (!fromPrompt) {
      const confirmed = await ElMessageBox.confirm("请选择一个空文件夹作为项目目录，画布和素材将保存在其中。", "添加项目", {
        confirmButtonText: "选择空文件夹", cancelButtonText: "取消", type: "info",
      }).then(() => true, () => false);
      if (!confirmed) return;
      path = await relocationPicker.value?.chooseDirectory() ?? "";
      if (!path) return;
    }
    const { directory, empty } = await useWorkspaceFiles(path).list();
    if (!empty) return ElMessage.warning("该文件夹不为空，请重新选择空文件夹；已有项目请使用“导入项目”或点击项目列表打开。");
    await useWorkspaceFiles(directory).writeJson("画布1.json", { toonflowCanvas: true, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, true);
    await workspaceStore.openProject(directory);
    if (fromPrompt && (prompt.value.trim() || promptAttachments.value.length)) {
      workspaceStore.pendingAgentMessage = { directory: workspaceStore.project!.directory, prompt: prompt.value, attachments: [...promptAttachments.value], model: selectedModel.value, reasoningEffort: reasoningEffort.value };
    }
    await router.push("/workspace");
  } catch (err) {
    ElMessage.error(axios.isAxiosError<{ message?: string }>(err)
      ? err.response?.data.message || "创建项目失败，请重试"
      : err instanceof Error ? err.message : "创建项目失败，请重试");
  } finally {
    creating.value = false;
  }
}
</script>

<style lang="scss" scoped>
.home {
  display: flex;
  flex-direction: column;
  min-height: 100dvh;
  background: var(--el-bg-color-page);
  color: var(--el-text-color-primary);

  .topBar {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 16px;
    height: 56px;
    padding: 0 clamp(16px, 3vw, 28px);
    background: color-mix(in srgb, var(--el-bg-color) 86%, transparent);
    backdrop-filter: saturate(1.6) blur(12px);

    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;

      .brandLogo {
        width: 22px;
        height: 22px;

        .dark & {
          filter: invert(1);
        }
      }

      .brandName {
        font-size: 15px;
        font-weight: 600;
        letter-spacing: -0.01em;
      }
    }

    .topActions {
      order: -1;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 4px;
      border: 1px solid var(--el-border-color-light);
      border-radius: var(--ui-radius-large);
      background: var(--el-bg-color-overlay);
      box-shadow: var(--floatingShadow);

      .chromeButton {
        height: 32px;
        margin: 0;
        padding: 0 10px;
        color: var(--el-text-color-regular);
        font-size: 13px;

        &.el-button--success {
          color: var(--el-color-success);
        }

        &:hover {
          color: var(--el-text-color-primary);
        }
      }

      a.chromeButton {
        text-decoration: none;
      }

      @media (max-width: 560px) {
        .chromeLabel {
          display: none;
        }

        .chromeButton {
          width: 32px;
          padding: 0;

          :deep(.el-icon) {
            margin: 0;
          }
        }
      }
    }
  }

  .pageContent {
    flex: 1;
    padding: 0 clamp(16px, 4vw, 48px) 64px;

    .creationPanel {
      max-width: 720px;
      margin: clamp(40px, 11vh, 120px) auto 72px;

      .hero {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 14px;
        margin-bottom: 32px;

        .heroLogo {
          width: 40px;
          height: 40px;

          .dark & {
            filter: invert(1);
          }
        }

        h1 {
          margin: 0;
          font-size: clamp(30px, 4vw, 40px);
          font-weight: 600;
          letter-spacing: -0.03em;
        }
      }

      .composer {
        position: relative;
        padding: 14px 14px 12px 18px;
        border: 1px solid var(--el-border-color);
        border-radius: calc(var(--ui-radius) * 2.5);
        background: var(--el-bg-color-overlay);
        box-shadow: 0 1px 2px rgb(0 0 0 / 4%), 0 12px 32px -16px rgb(0 0 0 / 16%);
        transition: border-color 0.2s, box-shadow 0.2s;

        &:focus-within {
          border-color: var(--el-border-color-darker);
          box-shadow: 0 1px 2px rgb(0 0 0 / 4%), 0 16px 40px -16px rgb(0 0 0 / 22%);
        }

        &.busy {
          opacity: 0.8;
        }

        .composerLabel {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-bottom: 6px;
          color: var(--el-text-color-secondary);
          font-size: 12px;
        }

        .promptAttachments {
          margin: 6px 0 10px;
        }

        .promptInput :deep(.el-textarea__inner) {
          padding: 2px 0;
          box-shadow: none;
          background: transparent;
          color: var(--el-text-color-primary);
          font-size: 15px;
          line-height: 1.7;
        }

        .composerFooter {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 8px 12px;
          margin-top: 10px;

          :deep(.workspaceButton) {
            height: 32px;
            margin-left: -8px;
            padding: 0 10px;
            border-radius: 999px;
            background: var(--el-fill-color-light);
            color: var(--el-text-color-regular);
            font-size: 13px;

            &:hover {
              background: var(--el-fill-color);
              color: var(--el-text-color-primary);
            }
          }

          .sendActions {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 8px;
            min-width: 0;
            margin-left: auto;

            .modelSelect {
              max-width: 220px;
            }

            .sendButton {
              flex-shrink: 0;
              height: 36px;
              margin: 0;

              &.is-circle {
                width: 36px;
              }
            }
          }
        }
      }

      .workspaceHint {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        margin: 14px 0 0;
        color: var(--el-text-color-secondary);
        font-size: 12px;
        line-height: 1.6;
        text-align: center;

        svg {
          flex-shrink: 0;
        }
      }
    }

    .projectList {
      max-width: 960px;
      margin: 0 auto;

      .sectionHeader {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 12px;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--el-border-color-lighter);

        h2 {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 0;
          font-size: 14px;
          font-weight: 600;

          .projectCount {
            min-width: 20px;
            padding: 0 6px;
            border-radius: 999px;
            background: var(--el-fill-color-light);
            color: var(--el-text-color-secondary);
            font-size: 12px;
            font-weight: 500;
            line-height: 20px;
            text-align: center;
            font-variant-numeric: tabular-nums;
          }
        }

        .sectionActions {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 4px;

          .sectionButton {
            height: 30px;
            margin: 0;
            padding: 0 10px;
            color: var(--el-text-color-regular);
            font-size: 13px;

            &:hover {
              color: var(--el-text-color-primary);
            }
          }

          .iconButton {
            width: 30px;
            height: 30px;
            margin: 0;
            padding: 0;
            color: var(--el-text-color-secondary);
          }

          .actionDivider {
            width: 1px;
            height: 16px;
            margin: 0 4px;
            background: var(--el-border-color);
          }

          .viewToggle {
            padding: 2px;
            border-radius: var(--ui-radius);
            background: var(--el-fill-color-light);

            :deep(.el-radio-button__inner) {
              display: grid;
              place-items: center;
              width: 28px;
              height: 26px;
              padding: 0;
              border: 0;
              border-radius: calc(var(--ui-radius) - 2px) !important;
              background: transparent;
              box-shadow: none !important;
              color: var(--el-text-color-secondary);
            }

            :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
              background: var(--el-bg-color-overlay);
              color: var(--el-text-color-primary);
              box-shadow: 0 1px 2px rgb(0 0 0 / 10%), 0 0 0 1px rgb(0 0 0 / 4%) !important;
            }
          }
        }
      }

      .projectItems {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr));
        gap: 12px;
        margin-top: 16px;

        .projectCard {
          position: relative;
          border: 1px solid var(--el-border-color-light);
          border-radius: var(--ui-radius-large);
          background: var(--el-bg-color-overlay);
          transition: border-color 0.18s, box-shadow 0.18s, background-color 0.18s;

          &:hover,
          &:focus-within {
            border-color: var(--el-border-color-dark);
            box-shadow: 0 1px 2px rgb(0 0 0 / 4%), 0 8px 24px -12px rgb(0 0 0 / 16%);

            .projectActions {
              opacity: 1;
            }
          }

          .projectEntry {
            display: grid;
            grid-template-columns: auto minmax(0, 1fr);
            grid-template-areas: "icon name" "icon path" "icon time";
            align-items: center;
            gap: 2px 12px;
            width: 100%;
            padding: 14px 76px 14px 14px;
            border: 0;
            border-radius: inherit;
            background: transparent;
            color: inherit;
            font: inherit;
            text-align: start;
            cursor: pointer;

            &:focus-visible {
              outline: 2px solid var(--el-color-primary);
              outline-offset: -2px;
            }

            &:disabled {
              cursor: wait;
              opacity: 0.6;
            }

            .projectIcon {
              grid-area: icon;
              align-self: start;
              display: grid;
              place-items: center;
              width: 36px;
              height: 36px;
              border-radius: var(--ui-radius);
              background: var(--el-fill-color-light);
              color: var(--el-text-color-regular);
            }

            .projectName,
            .projectPath {
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }

            .projectName {
              grid-area: name;
              font-size: 14px;
              font-weight: 600;
              line-height: 20px;
            }

            .projectPath {
              grid-area: path;
              color: var(--el-text-color-secondary);
              font-size: 12px;
              line-height: 18px;
            }

            .projectTime {
              grid-area: time;
              margin-top: 4px;
              color: var(--el-text-color-placeholder);
              font-size: 12px;
              line-height: 16px;
              font-variant-numeric: tabular-nums;
            }
          }

          .projectActions {
            position: absolute;
            top: 10px;
            inset-inline-end: 8px;
            display: flex;
            gap: 2px;
            opacity: 0;
            transition: opacity 0.15s;

            .el-button {
              width: 28px;
              height: 28px;
              margin: 0;
              padding: 0;
              color: var(--el-text-color-secondary);

              &.el-button--danger:hover {
                color: var(--el-color-danger);
              }
            }

            @media (hover: none) {
              opacity: 1;
            }
          }
        }

        &.listView {
          grid-template-columns: 1fr;
          gap: 0;
          margin-top: 4px;

          .projectCard {
            border-width: 0 0 1px;
            border-color: var(--el-border-color-lighter);
            border-radius: 0;
            background: transparent;

            &:hover,
            &:focus-within {
              border-color: var(--el-border-color-lighter);
              background: var(--el-fill-color-extra-light);
              box-shadow: none;
            }

            .projectEntry {
              grid-template-columns: auto minmax(0, 1fr) minmax(0, 1.2fr) auto;
              grid-template-areas: "icon name path time";
              gap: 16px;
              padding: 10px 84px 10px 8px;

              .projectIcon {
                align-self: center;
                width: 30px;
                height: 30px;
              }

              .projectTime {
                margin: 0;
              }
            }

            .projectActions {
              top: 50%;
              transform: translateY(-50%);
            }
          }

          @media (max-width: 720px) {
            .projectCard .projectEntry {
              grid-template-columns: auto minmax(0, 1fr);
              grid-template-areas: "icon name" "icon path" "icon time";
              gap: 2px 12px;
            }
          }
        }
      }
    }
  }
}
</style>
