<template>
  <main class="webProjects">
    <header class="projectHeader">
      <h1>我的项目</h1>
      <div class="projectActions">
        <template v-if="webUserId">
          <span>{{ webUserName }}</span>
          <el-button type="primary" :loading="busy" @click="createProject">新建项目</el-button>
          <el-button :disabled="busy" @click="signOut">退出登录</el-button>
        </template>
        <el-button v-else type="primary" @click="signInVisible = true">管理员登录</el-button>
      </div>
    </header>
    <p v-if="!webUserId">当前画布仅向逸仙管理员开放。</p>
    <el-alert v-if="message" :title="message" type="error" :closable="false" showIcon />
    <div v-if="webUserId" class="projectList" :aria-busy="busy">
      <article v-for="project in workspace.projectList" :key="project.id" class="projectItem">
        <el-button class="projectName" text :disabled="busy" @click="openProject(project)">{{ project.name }}</el-button>
        <el-button text :disabled="busy" :aria-label="`重命名项目 ${project.name}`" @click="renameProject(project)">重命名</el-button>
      </article>
    </div>
  </main>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessageBox } from "element-plus";
import api, { errorMessage } from "@/lib/api";
import { webUserId, webUserName } from "@/lib/webRuntime";
import { logout, signInVisible } from "@/stores/account";
import { useWorkspaceStore, type Project } from "@/stores/workspace";

const workspace = useWorkspaceStore();
const router = useRouter();
const route = useRoute();
const busy = ref(false);
const message = ref(route.query.login === "adminRequired" ? "当前画布仅向逸仙管理员开放" : route.query.login === "failed" ? "登录未完成，请重新登录" : "");

async function run(operation: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = "";
  try { await operation(); }
  catch (error) { message.value = errorMessage(error, "项目操作失败，请重试"); }
  finally { busy.value = false; }
}

async function createProject() {
  const result = await ElMessageBox.prompt("请输入项目名称", "新建项目", {
    confirmButtonText: "创建", cancelButtonText: "取消", inputValidator: value => !!value?.trim() && value.trim().length <= 256 || "请输入 1 至 256 字的项目名称",
  }).catch(() => null);
  if (!result) return;
  await run(async () => {
    const { data } = await api.post<{ data: Project }>("/api/projects/create", { name: result.value.trim() });
    await workspace.loadProjects();
    await workspace.openProject(data.data.directory);
    await router.push("/workspace");
  });
}

function openProject(project: Project) {
  return run(async () => {
    await workspace.openProject(project.directory);
    await router.push("/workspace");
  });
}

async function renameProject(project: Project) {
  const result = await ElMessageBox.prompt("请输入项目名称", "重命名项目", {
    inputValue: project.name, confirmButtonText: "保存", cancelButtonText: "取消",
    inputValidator: value => !!value?.trim() && value.trim().length <= 256 || "请输入 1 至 256 字的项目名称",
  }).catch(() => null);
  if (result) await run(() => workspace.renameProject(project.directory, result.value));
}

function signOut() {
  return run(logout);
}

onMounted(() => { if (webUserId.value) void run(() => workspace.loadProjects()); });
</script>

<style scoped lang="scss">
.webProjects {
  max-width: 1120px;
  margin: 0 auto;
  padding: 32px 20px;
  color: var(--el-text-color-primary);

  .projectHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 16px;
    margin-bottom: 24px;

    h1 { margin: 0; font-size: 24px; }
    .projectActions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  }

  .projectList {
    display: grid;
    gap: 12px;
    margin-top: 24px;

    .projectItem {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-width: 0;
      padding: 16px;
      border: 1px solid var(--el-border-color);
      border-radius: var(--ui-radius);

      .projectName { overflow: hidden; max-width: calc(100% - 90px); }
    }
  }
}
</style>
