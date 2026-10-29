<template>
  <div class="home">
    <aside class="sideBar" aria-label="工作台导航">
      <div class="brand">
        <img class="brandLogo" :src="logoUrl" alt="" aria-hidden="true" />
        <div><span class="brandName">Yixianflow</span><span class="brandCaption">AI 影像创作空间</span></div>
      </div>
      <el-button class="newProjectButton" type="primary" :icon="IconPlus" :disabled="creating || opening" @click="createProject(false)">新建项目</el-button>
      <nav class="sideNav" aria-label="创作导航">
        <button type="button" class="navItem" :aria-current="activeSection === 'create' ? 'location' : undefined" @click="showSection('create')"><icon-sparkles :size="18" />灵感创作</button>
        <button type="button" class="navItem" :aria-current="activeSection === 'projects' ? 'location' : undefined" @click="showSection('projects')"><icon-folders :size="18" />我的项目<span v-if="projectList.length" class="navCount">{{ projectList.length }}</span></button>
      </nav>
      <div v-if="project" class="resumeSection">
        <span class="sideCaption">继续上次创作</span>
        <button class="resumeProject" type="button" :disabled="creating || opening" :title="project.directory" @click="openProject(project)"><icon-layout-dashboard :size="18" /><span>{{ project.name }}</span><icon-arrow-up-right :size="15" /></button>
      </div>
      <div class="sideFooter"><icon-device-desktop :size="15" /><span>画布与素材保存在工作目录</span></div>
    </aside>
    <div class="mainArea">
      <header class="topBar">
        <span class="pageTitle">创作工作台</span>
        <nav class="topActions" aria-label="快捷操作">
          <el-button class="chromeButton" text :type="deviceHubEnabled ? 'success' : undefined" :icon="deviceHubEnabled || mobileConnection.mode === 'remote' ? IconDeviceDesktop : IconQrcode" :aria-label="mobileConnectionLabel" @click="mobileConnectVisible = true">
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
        <section ref="creationPanel" class="creationPanel" aria-label="创建项目">
          <div class="hero">
            <span class="heroEyebrow"><icon-sparkles :size="14" />想法不设限，创作有起点</span>
            <h1>让灵感，成为你的下一部作品</h1>
            <p>从一个故事、一张参考图开始，在画布上串联你的创作。</p>
          </div>
          <div class="composer" :class="{ busy: creating || opening }">
            <div class="composerLabel"><span class="composerMode"><icon-sparkles :size="15" aria-hidden="true" />AI 灵感创作</span><span>和 AI 助手一起搭建画布</span></div>
            <attachmentList v-if="promptAttachments.length" class="promptAttachments" :attachments="promptAttachments" removable restorable :disabled="creating || opening" @remove="promptAttachments.splice($event, 1)" @restore="restoreAttachment" />
            <el-input ref="promptInput" v-model="prompt" class="promptInput" type="textarea" :autosize="{ minRows: 3, maxRows: 10 }" resize="none" :disabled="creating || opening" :placeholder="promptPlaceholder" aria-label="创作描述" @paste.capture="pasteText" />
            <div class="composerFooter">
              <workspacePicker v-model="workspaceDirectory" :disabled="creating || opening" />
              <div class="sendActions">
                <modelPopover v-model="selectedModel" v-model:reasoningEffort="reasoningEffort" class="modelSelect" :disabled="creating || opening" />
                <el-button class="sendButton" type="primary" :icon="IconArrowUpRight" :loading="creating" :disabled="creating || opening" @click="createProject()">{{ hasPrompt ? '开始创作' : '新建画布' }}</el-button>
              </div>
            </div>
          </div>
          <div class="composerHint" role="status">
            <span><icon-folder :size="14" aria-hidden="true" />{{ workspaceDirectory ? '新项目将保存在所选文件夹，请确保文件夹为空。' : '开始时选择一个空文件夹，保存画布和素材。' }}</span>
            <span v-if="!selectedModel"><icon-info-circle :size="14" aria-hidden="true" />{{ accountView?.authenticated ? '请先选择可用模型进行 AI 创作' : 'AI 创作需要登录账户' }}<el-button v-if="!accountView?.authenticated" link type="primary" :disabled="creating || opening" @click="signInVisible = true">去登录</el-button></span>
          </div>
          <div class="creationEntries" aria-label="创作方式">
            <button class="creationEntry" type="button" :disabled="creating || opening" @click="focusPrompt">
              <span class="entryIcon agentEntry"><icon-sparkles :size="21" /></span>
              <span class="entryCopy"><strong>从灵感开始</strong><span>描述想法，让 AI 助手协助创作</span></span><icon-arrow-up-right class="entryArrow" :size="17" />
            </button>
            <button class="creationEntry" type="button" :disabled="creating || opening" @click="createProject(false)">
              <span class="entryIcon canvasEntry"><icon-layout-dashboard :size="21" /></span>
              <span class="entryCopy"><strong>自由画布</strong><span>连接节点，按自己的节奏创作</span></span><icon-arrow-up-right class="entryArrow" :size="17" />
            </button>
            <button class="creationEntry" type="button" :disabled="creating || opening" @click="openProject()">
              <span class="entryIcon importEntry"><icon-folder-open :size="21" /></span>
              <span class="entryCopy"><strong>导入已有项目</strong><span>打开工作目录，接着上次继续</span></span><icon-arrow-up-right class="entryArrow" :size="17" />
            </button>
          </div>
        </section>
        <section ref="projectPanel" class="projectList" aria-labelledby="projectListTitle">
          <div class="sectionHeader">
            <h2 id="projectListTitle">我的项目<span v-if="projectList.length" class="projectCount">{{ projectList.length }}</span></h2>
            <div class="sectionActions">
              <el-input v-if="projectList.length" v-model="projectSearch" class="projectSearch" :prefixIcon="IconSearch" placeholder="搜索项目名称或路径" clearable aria-label="搜索项目" />
              <el-button class="sectionButton" text :icon="IconFolderOpen" :disabled="creating || opening" @click="openProject()">导入项目</el-button>
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
          <div v-if="filteredProjects.length" class="projectItems" :class="{ listView: viewMode === 'list' }">
            <article v-for="project in filteredProjects" :key="project.directory" class="projectCard">
              <button class="projectEntry" type="button" :disabled="creating || opening" :aria-label="`打开项目 ${project.name}`" @click="openProject(project)">
                <span class="projectVisual" aria-hidden="true"><span class="visualGrid" /><icon-layout-dashboard :size="32" /><span class="visualLabel">画布项目</span><span class="openProjectHint"><icon-arrow-up-right :size="18" />打开项目</span></span>
                <span class="projectName" :title="project.name">{{ project.name }}</span>
                <span class="projectPath" :title="project.directory">{{ project.directory }}</span>
                <span class="projectTime" :title="new Date(project.lastOpenedAt).toLocaleString(locale, { hour12: false })"><icon-clock :size="13" />{{ dateFormatter.format(project.lastOpenedAt) }}</span>
              </button>
              <div class="projectActions">
                <el-button text :icon="IconEdit" :disabled="creating || opening" :aria-label="`重命名项目 ${project.name}`" title="重命名" @click="renameProject(project)" />
                <el-button text type="danger" :icon="IconTrash" :disabled="creating || opening" :aria-label="`移除项目 ${project.name}`" title="从列表移除，不删除文件" @click="workspaceStore.removeProject(project.directory)" />
              </div>
            </article>
          </div>
          <div v-else class="projectEmpty" role="status">
            <span class="emptyIcon"><component :is="projectSearch.trim() ? IconSearch : IconFolders" :size="26" /></span>
            <strong>{{ projectSearch.trim() ? '没有找到匹配的项目' : '你的第一部作品，从这里开始' }}</strong>
            <p>{{ projectSearch.trim() ? '试试其他名称，或搜索项目所在的文件夹路径。' : '新建一张画布，或导入已有项目，开始积累你的创作。' }}</p>
            <el-button v-if="projectSearch.trim()" text @click="projectSearch = ''">清除搜索</el-button>
            <el-button v-else :icon="IconPlus" :disabled="creating || opening" @click="createProject(false)">新建项目</el-button>
          </div>
        </section>
      </main>
    </div>
    <settings v-model="settingsVisible" />
    <mobileConnect v-model="mobileConnectVisible" />
    <workspacePicker ref="relocationPicker" hideTrigger />
  </div>
</template>

<script setup lang="ts">
import { locale, translate } from "@toonflow/i18n/vue";
import axios from "axios";
import { storeToRefs } from "pinia";
import { computed, defineAsyncComponent, nextTick, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox, type InputInstance } from "element-plus";
import {
  IconSettings, IconQrcode, IconDeviceDesktop,
  IconArrowUpRight, IconLayoutGrid, IconList, IconSortDescending,
  IconSortAscending, IconFolder, IconEdit, IconSparkles, IconInfoCircle,
  IconTrash, IconFolderOpen, IconFolders, IconLayoutDashboard, IconPlus, IconSearch, IconClock,
} from "@tabler/icons-vue";
import modelPopover from "@/components/modelPopover.vue";
import attachmentList from "@/components/agent/attachmentList.vue";
import { createPastedTextFile, readTextAttachment } from "@/components/agent/textAttachments";
import type { AgentAttachment } from "@/components/agent/types";
import logoUrl from "@toonflow/assets/logo.svg";
import { useWorkspaceStore, type Project } from "@/stores/workspace";
import { hasDesktopUpdate } from "@/stores/desktopUpdate";
import { accountView, signInVisible } from "@/stores/account";
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
const relocationPicker = ref<InstanceType<typeof workspacePicker>>();
const prompt = ref("");
const promptInput = ref<InputInstance>();
const promptAttachments = ref<AgentAttachment[]>([]);
const workspaceStore = useWorkspaceStore();
const { project, projectList } = storeToRefs(workspaceStore);
const workspaceDirectory = ref("");
const hasPrompt = computed(() => !!prompt.value.trim() || !!promptAttachments.value.length);
const promptPlaceholder = computed(() => translate("描述你想创作的故事、角色或镜头，AI 助手会和你一起搭建画布…"));
const activeSection = ref("create");
const creationPanel = ref<HTMLElement>();
const projectPanel = ref<HTMLElement>();
const projectSearch = ref("");
const dateFormatter = computed(() => new Intl.DateTimeFormat(locale.value, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }));

const selectedModel = ref("");
const reasoningEffort = ref("");
const sortDescending = ref(true);
const viewMode = ref("grid");
const sortedProjects = computed(() => [...projectList.value].sort((left, right) =>
  sortDescending.value ? right.lastOpenedAt - left.lastOpenedAt : left.lastOpenedAt - right.lastOpenedAt
));
const filteredProjects = computed(() => {
  const query = projectSearch.value.trim().toLocaleLowerCase(locale.value);
  return query ? sortedProjects.value.filter(item => `${item.name}\n${item.directory}`.toLocaleLowerCase(locale.value).includes(query)) : sortedProjects.value;
});

function showSection(section: "create" | "projects") {
  activeSection.value = section;
  (section === "create" ? creationPanel : projectPanel).value?.scrollIntoView({ block: "start" });
}

function focusPrompt() {
  showSection("create");
  promptInput.value?.focus();
}

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
  if (creating.value || opening.value) return;
  if (fromPrompt && hasPrompt.value && !selectedModel.value) return ElMessage.warning("请先选择可用模型，再开始 AI 创作；也可以直接新建空白画布。");
  creating.value = true;
  try {
    let path = fromPrompt ? workspaceDirectory.value : "";
    if (!path) {
      path = await relocationPicker.value?.chooseDirectory() ?? "";
      if (!path) return;
      if (fromPrompt) workspaceDirectory.value = path;
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
  display: grid;
  grid-template-columns: 208px minmax(0, 1fr);
  min-height: 100dvh;
  background: var(--el-bg-color-page);
  color: var(--el-text-color-primary);

  .sideBar {
    position: sticky;
    top: 0;
    display: flex;
    flex-direction: column;
    gap: 24px;
    height: 100dvh;
    padding: 26px 16px 18px;
    border-inline-end: 1px solid var(--el-border-color-light);
    background: var(--el-bg-color);

    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 8px;

      .brandLogo {
        width: 28px;
        height: 28px;

        .dark & { filter: invert(1); }
      }

      .brandName { display: block; font-size: 17px; font-weight: 650; letter-spacing: -0.03em; }
      .brandCaption { display: block; margin-top: 3px; color: var(--el-text-color-secondary); font-size: 10px; letter-spacing: 0.04em; }
    }

    .newProjectButton { width: 100%; height: 40px; margin: 0; font-size: 13px; }

    .sideNav {
      display: grid;
      gap: 6px;

      .navItem {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px;
        border: 0;
        border-radius: var(--ui-radius);
        background: transparent;
        color: var(--el-text-color-regular);
        font: inherit;
        font-size: 13px;
        text-align: start;
        cursor: pointer;

        &:hover { background: var(--el-fill-color-extra-light); }
        &[aria-current] { background: var(--el-fill-color); color: var(--el-text-color-primary); font-weight: 600; }
        &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }

        .navCount { margin-inline-start: auto; color: var(--el-text-color-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
      }
    }

    .resumeSection {
      display: grid;
      gap: 10px;
      padding-top: 20px;
      border-top: 1px solid var(--el-border-color-lighter);

      .sideCaption { padding-inline: 12px; color: var(--el-text-color-secondary); font-size: 11px; }

      .resumeProject {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        padding: 10px 12px;
        border: 0;
        border-radius: var(--ui-radius);
        background: transparent;
        color: var(--el-text-color-regular);
        font: inherit;
        font-size: 12px;
        text-align: start;
        cursor: pointer;

        span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        svg { flex-shrink: 0; }
        &:hover { background: var(--el-fill-color-light); }
        &:focus-visible { outline: 2px solid var(--el-color-primary); }
        &:disabled { cursor: wait; opacity: 0.5; }
      }
    }

    .sideFooter { display: flex; align-items: center; gap: 6px; margin-top: auto; color: var(--el-text-color-secondary); font-size: 10px; line-height: 1.6; }
  }

  .mainArea { min-width: 0; }

  .topBar {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 16px;
    height: 64px;
    padding: 0 clamp(20px, 3vw, 40px);
    background: color-mix(in srgb, var(--el-bg-color) 86%, transparent);
    backdrop-filter: saturate(1.6) blur(12px);

    .pageTitle { color: var(--el-text-color-secondary); font-size: 13px; }

    .topActions {
      display: flex;
      align-items: center;
      gap: 2px;
      margin-inline-start: auto;

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
    max-width: 1280px;
    margin: 0 auto;
    padding: 0 clamp(20px, 4vw, 56px) 56px;

    .creationPanel {
      max-width: 960px;
      margin: clamp(28px, 5vh, 64px) auto 44px;
      scroll-margin-top: 88px;

      .hero {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        margin-bottom: 28px;
        text-align: center;

        .heroEyebrow { display: inline-flex; align-items: center; gap: 6px; color: var(--el-text-color-secondary); font-size: 12px; }

        h1 {
          margin: 0;
          font-size: clamp(26px, 3vw, 36px);
          font-weight: 600;
          letter-spacing: -0.03em;
          line-height: 1.4;
        }

        p { margin: 0; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.7; }
      }

      .composer {
        position: relative;
        padding: 18px 20px 14px;
        border: 1px solid var(--el-border-color);
        border-radius: calc(var(--ui-radius) * 2.5);
        background: var(--el-bg-color-overlay);
        box-shadow: 0 2px 6px rgb(0 0 0 / 2%), 0 16px 40px -24px rgb(0 0 0 / 18%);
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
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 12px;
          color: var(--el-text-color-secondary);
          font-size: 11px;

          .composerMode { display: inline-flex; align-items: center; gap: 6px; color: var(--el-text-color-primary); font-size: 12px; font-weight: 600; }
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
          margin-top: 14px;
          padding-top: 12px;
          border-top: 1px solid var(--el-border-color-lighter);

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
              padding-inline: 16px;
            }
          }
        }
      }

      .composerHint {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 4px 12px;
        margin: 12px 2px 0;
        color: var(--el-text-color-secondary);
        font-size: 11px;
        line-height: 1.6;

        > span { display: inline-flex; align-items: center; gap: 5px; }
        svg { flex-shrink: 0; }
        .el-button { height: auto; padding: 0; font-size: inherit; }
      }

      .creationEntries {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        margin-top: 28px;

        .creationEntry {
          display: flex;
          align-items: center;
          gap: 12px;
          min-width: 0;
          padding: 18px 14px;
          border: 1px solid var(--el-border-color-light);
          border-radius: var(--ui-radius-large);
          background: var(--el-bg-color);
          color: var(--el-text-color-primary);
          font: inherit;
          text-align: start;
          cursor: pointer;
          transition: border-color 0.15s, background-color 0.15s;

          &:hover:not(:disabled) { border-color: var(--el-border-color-darker); background: var(--el-fill-color-extra-light); }
          &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
          &:disabled { cursor: wait; opacity: 0.5; }

          .entryIcon { display: grid; flex-shrink: 0; place-items: center; width: 40px; height: 40px; border-radius: var(--ui-radius); }
          .agentEntry { color: #8c6cb0; background: color-mix(in srgb, #8c6cb0 10%, var(--el-bg-color)); }
          .canvasEntry { color: #36867b; background: color-mix(in srgb, #36867b 10%, var(--el-bg-color)); }
          .importEntry { color: #b27e3d; background: color-mix(in srgb, #b27e3d 10%, var(--el-bg-color)); }
          .entryCopy { display: grid; gap: 5px; min-width: 0; }
          .entryCopy strong { font-size: 13px; font-weight: 600; }
          .entryCopy > span { color: var(--el-text-color-secondary); font-size: 11px; line-height: 1.5; }
          .entryArrow { flex-shrink: 0; margin-inline-start: auto; color: var(--el-text-color-placeholder); }
        }
      }
    }

    .projectList {
      margin: 0 auto;
      scroll-margin-top: 88px;

      .sectionHeader {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 12px;
        padding-bottom: 4px;

        h2 {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 0;
          font-size: 16px;
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
          gap: 6px;

          .projectSearch { width: 212px; margin-inline-end: 4px; font-size: 12px; }

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
        gap: 16px;
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
          }

          .projectEntry {
            display: grid;
            grid-template-columns: minmax(0, 1fr);
            grid-template-areas: "visual" "name" "path" "time";
            align-items: center;
            gap: 2px 12px;
            width: 100%;
            padding: 0 14px 14px;
            overflow: hidden;
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

            .projectVisual {
              position: relative;
              grid-area: visual;
              display: grid;
              place-items: center;
              height: 132px;
              margin: 0 -14px 12px;
              overflow: hidden;
              border-bottom: 1px solid var(--el-border-color-lighter);
              background: var(--el-fill-color-extra-light);
              color: var(--el-text-color-secondary);

              .visualGrid { position: absolute; inset: 0; background-image: radial-gradient(var(--el-border-color-dark) 1px, transparent 1px); background-size: 16px 16px; opacity: 0.6; }
              > svg { z-index: 1; box-sizing: content-box; padding: 16px; border: 1px solid var(--el-border-color-light); border-radius: var(--ui-radius-large); background: var(--el-bg-color); box-shadow: var(--el-box-shadow-lighter); }
              .visualLabel { position: absolute; inset-inline-start: 12px; bottom: 10px; font-size: 10px; }
              .openProjectHint { position: absolute; inset-inline-end: 12px; bottom: 10px; display: inline-flex; align-items: center; gap: 4px; color: var(--el-text-color-primary); font-size: 11px; opacity: 0; }
            }

            &:hover .openProjectHint, &:focus-visible .openProjectHint { opacity: 1; }

            .projectName,
            .projectPath {
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }

            .projectName {
              grid-area: name;
              padding-inline-end: 64px;
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
              display: flex;
              align-items: center;
              gap: 5px;
              margin-top: 10px;
              color: var(--el-text-color-secondary);
              font-size: 11px;
              line-height: 16px;
              font-variant-numeric: tabular-nums;
            }
          }

          .projectActions {
            position: absolute;
            top: 142px;
            inset-inline-end: 8px;
            display: flex;
            gap: 2px;

            .el-button {
              width: 28px;
              height: 28px;
              margin: 0;
              padding: 0;
              border-radius: var(--ui-radius-small);
              background: var(--el-bg-color-overlay);
              color: var(--el-text-color-secondary);

              &.el-button--danger:hover {
                color: var(--el-color-danger);
              }
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
              grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr) auto;
              grid-template-areas: "name path time";
              gap: 16px;
              padding: 10px 84px 10px 8px;

              .projectVisual { display: none; }
              .projectName { padding-inline-end: 0; }

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
              grid-template-columns: minmax(0, 1fr);
              grid-template-areas: "name" "path" "time";
              gap: 2px 12px;
            }
          }
        }
      }

      .projectEmpty {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 36px 20px;
        margin-top: 16px;
        border: 1px dashed var(--el-border-color);
        border-radius: var(--ui-radius-large);
        text-align: center;

        .emptyIcon { display: grid; place-items: center; width: 56px; height: 56px; margin-bottom: 14px; border: 1px solid var(--el-border-color-light); border-radius: var(--ui-radius-large); background: var(--el-bg-color); color: var(--el-text-color-secondary); }
        strong { font-size: 14px; font-weight: 500; }
        p { margin: 8px 0 18px; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
        .el-button { font-size: 12px; }
      }
    }
  }

  @media (max-width: 1100px) {
    grid-template-columns: 176px minmax(0, 1fr);

    .sideBar { padding-inline: 12px; }
    .pageContent .creationPanel .creationEntries .creationEntry { gap: 8px; padding: 14px 10px; }
    .pageContent .creationPanel .creationEntries .creationEntry .entryArrow { display: none; }
  }

  @media (max-width: 760px) {
    display: block;

    .sideBar {
      position: static;
      flex-direction: row;
      align-items: center;
      gap: 12px;
      height: auto;
      padding: 14px 20px;
      border-inline-end: 0;
      border-bottom: 1px solid var(--el-border-color-lighter);

      .brand { padding: 0; }
      .brand .brandCaption, .sideNav, .resumeSection, .sideFooter { display: none; }
      .newProjectButton { width: auto; height: 34px; margin-inline-start: auto; }
    }

    .topBar { height: 48px; }
    .pageContent .creationPanel { margin-top: 26px; }
    .pageContent .creationPanel .hero { gap: 8px; margin-bottom: 22px; }
    .pageContent .creationPanel .creationEntries { gap: 8px; }
    .pageContent .creationPanel .creationEntries .creationEntry { flex-direction: column; align-items: flex-start; }
    .pageContent .projectList .sectionHeader .sectionActions { flex: 1 1 100%; }
    .pageContent .projectList .sectionHeader .sectionActions .projectSearch { flex: 1; width: auto; min-width: 120px; }
  }

  @media (max-width: 480px) {
    .pageContent .creationPanel .hero h1 { font-size: 25px; }
    .pageContent .creationPanel .composer { padding: 14px; }
    .pageContent .creationPanel .composer .composerLabel > span:last-child { display: none; }
    .pageContent .creationPanel .composer .composerFooter .sendActions { flex: 1 1 100%; justify-content: space-between; }
    .pageContent .creationPanel .creationEntries .creationEntry .entryCopy > span { display: none; }
    .pageContent .creationPanel .creationEntries .creationEntry .entryCopy strong { font-size: 12px; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { transition: none !important; }
  }
}
</style>
