<template>
  <div class="workspaceMenu">
    <div class="menuContent">
      <el-button class="toolButton" text aria-label="退出项目" title="退出项目" @click="exitVisible = true">
        <icon-x :size="17" aria-hidden="true" />
      </el-button>
      <el-button class="toolButton" text :loading="exporting" :disabled="exportDisabled || exporting" aria-label="导出项目 ZIP" title="导出项目 ZIP" @click="emit('exportProject')">
        <icon-download :size="17" aria-hidden="true" />
      </el-button>
      <el-button class="toolButton" text :aria-label="hasDesktopUpdate ? '设置，有新版本可用' : '设置'" title="设置" @click="emit('openSettings')">
        <el-badge isDot :hidden="!hasDesktopUpdate">
          <icon-settings :size="17" aria-hidden="true" />
        </el-badge>
      </el-button>
    </div>
    <el-dialog v-model="exitVisible" title="退出项目" width="360px" alignCenter appendToBody>
      <span>是否退出当前项目并返回首页？</span>
      <template #footer>
        <el-button @click="exitVisible = false">取消</el-button>
        <el-button type="primary" :loading="leaving" @click="exitProject">退出项目</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { IconX, IconSettings, IconDownload } from "@tabler/icons-vue";
import { hasDesktopUpdate } from "@/stores/desktopUpdate";

defineProps<{ exporting: boolean; exportDisabled: boolean }>();
const emit = defineEmits<{ openSettings: []; exportProject: [] }>();
const router = useRouter();
const exitVisible = ref(false);
const leaving = ref(false);

async function exitProject() {
  if (leaving.value) return;
  leaving.value = true;
  try {
    await router.push("/home");
  } finally {
    leaving.value = false;
  }
}
</script>

<style scoped lang="scss">
.workspaceMenu {
  .menuContent {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 38px;
    padding: 3px;
    border: 1px solid var(--el-border-color-light);
    border-radius: var(--ui-radius-large);
    background: var(--el-bg-color-overlay);
    box-shadow: var(--floatingShadow);

    .toolButton {
      width: 30px;
      height: 30px;
      margin: 0;
      padding: 0;
      border-radius: var(--ui-radius);
      color: var(--el-text-color-regular);

      &:hover {
        color: var(--el-text-color-primary);
      }
    }
  }
}
</style>
