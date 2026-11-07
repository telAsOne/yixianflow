<template>
  <el-drawer v-model="visible" class="projectRecycleBin" size="min(720px, 100vw)" :withHeader="false" appendToBody destroyOnClose :closeOnClickModal="!busy" :closeOnPressEscape="!busy" :beforeClose="closeDrawer">
    <div class="recyclePanel" v-loading="loading">
      <header class="recycleHeader">
        <span class="headerIcon"><icon-trash :size="24" /></span>
        <div><h2>项目回收站</h2><p>删除的节点与画布保留 {{ overview?.retentionDays ?? 7 }} 天，刷新页面后仍可恢复。</p></div>
        <el-button text circle :icon="IconX" aria-label="关闭回收站" :disabled="busy" @click="visible = false" />
      </header>
      <div v-if="overview" class="storageSummary">
        <div><span>可恢复记录</span><strong>{{ overview.entries.length }}<small> 项</small></strong></div>
        <div><span>关联素材</span><strong>{{ formatBytes(overview.assetBytes) }}</strong></div>
        <div><span>预计可释放</span><strong>{{ formatBytes(overview.reclaimableBytes) }}</strong></div>
      </div>
      <el-alert v-if="error" :title="error" type="error" :closable="false" showIcon />
      <div class="recycleToolbar">
        <el-input v-model="search" :prefixIcon="IconSearch" placeholder="搜索名称或原画布" aria-label="搜索回收站" clearable />
        <el-button :icon="IconRefresh" :disabled="busy || loading" aria-label="刷新回收站" @click="load" />
        <el-button type="danger" plain :disabled="busy || loading || !overview?.entries.length" @click="purge(overview!.entries)">清空回收站</el-button>
      </div>
      <el-scrollbar class="recycleList">
        <div v-if="!loading && !entries.length && !error" class="emptyBin">
          <icon-trash :size="42" strokeWidth="1.3" />
          <strong>{{ search ? '没有匹配的删除记录' : '回收站是空的' }}</strong>
          <span>{{ search ? '试试其他名称或画布路径' : '删除节点或画布后，可以在这里找回。' }}</span>
        </div>
        <article v-for="entry in entries" :key="entry.id" class="recycleCard">
          <mentionThumbnail class="recycleThumbnail" :directory="directory" :thumbnail="entry.preview ? { url: entry.preview.path, mimeType: entry.preview.mimeType } : undefined">
            <icon-artboard v-if="entry.kind === 'canvas'" :size="28" /><icon-box-multiple v-else :size="28" />
          </mentionThumbnail>
          <div class="entryDetail">
            <div class="entryTitle"><strong :title="entry.label">{{ entry.label }}</strong><span>{{ entry.kind === 'canvas' ? '画布' : '节点' }}</span></div>
            <span class="originalCanvas" :title="entry.canvasPath">{{ entry.canvasPath }} · {{ entry.nodeCount }} 个节点</span>
            <span class="deletionTime">{{ dateFormatter.format(entry.deletedAt) }} 删除 · {{ daysLeft(entry) }} 天后到期</span>
            <span v-if="entry.error" class="entryError" role="alert">{{ entry.error }}</span>
          </div>
          <div class="entryActions">
            <el-button size="small" type="primary" plain :loading="busyId === entry.id" :disabled="busy" @click="restore(entry)">恢复</el-button>
            <el-button size="small" text type="danger" :disabled="busy" @click="purge([entry])">永久删除</el-button>
          </div>
        </article>
      </el-scrollbar>
      <footer class="recycleFooter">
        <p>仍被画布、撤销历史或任务使用的素材会保留；只有实际删除文件后才会释放空间。</p>
        <p v-if="overview?.pendingCleanupCount">{{ overview.pendingCleanupCount }} 项已永久删除记录，关联素材等待解除引用后释放。</p>
        <p v-for="item in overview?.cleanupErrors" :key="item" role="alert">{{ item }}</p>
        <p v-if="overview?.orphanCount" class="legacyInventory">另发现 {{ overview.orphanCount }} 个未登记且未被引用的旧素材目录，约 {{ formatBytes(overview.orphanBytes) }}。目前仅统计，自动清理不会删除它们。</p>
      </footer>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import { ElAlert, ElButton, ElDrawer, ElInput, ElMessage, ElMessageBox, ElScrollbar, ElLoading } from "element-plus";
import { IconArtboard, IconBoxMultiple, IconRefresh, IconSearch, IconTrash, IconX } from "@tabler/icons-vue";
import { locale } from "@toonflow/i18n/vue";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import mentionThumbnail from "@/components/agent/mentionThumbnail.vue";
import type { RecycleEntry, RecycleOverview } from "@toonflow/server/recycleTypes";

const props = defineProps<{ directory: string; flushSave: () => Promise<void>; preparePurge: (directory: string) => Promise<void>; afterRestore: (path: string) => Promise<void> }>();
const visible = defineModel<boolean>({ default: false });
const vLoading = ElLoading.directive;
const dateFormatter = computed(() => new Intl.DateTimeFormat(locale.value, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
const overview = shallowRef<RecycleOverview>();
const loading = ref(false);
const busy = ref(false);
const busyId = ref("");
const error = ref("");
const search = ref("");
let request = 0;
let disposed = false;
onScopeDispose(() => { disposed = true; request++; });
const entries = computed(() => overview.value?.entries.filter(entry => `${entry.label} ${entry.canvasPath}`.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())) ?? []);
function message(cause: any) { return cause?.response?.data?.message || cause?.message || "回收站操作失败，请重试"; }
function formatBytes(bytes: number) {
  const unit = bytes >= 1073741824 ? "GB" : bytes >= 1048576 ? "MB" : bytes >= 1024 ? "KB" : "B";
  const divisor = { GB: 1073741824, MB: 1048576, KB: 1024, B: 1 }[unit];
  return `${new Intl.NumberFormat(locale.value, { maximumFractionDigits: 1 }).format(bytes / divisor)} ${unit}`;
}
function daysLeft(entry: RecycleEntry) { return Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 86400000)); }
function closeDrawer(done: () => void) { if (!busy.value) done(); }

async function load() {
  const directory = props.directory;
  const current = ++request;
  loading.value = true; error.value = "";
  try {
    await props.flushSave();
    if (disposed || directory !== props.directory) return;
    const data = await useWorkspaceFiles(directory).getRecycleBin();
    if (current === request && directory === props.directory) overview.value = data;
  } catch (cause) { if (current === request) error.value = message(cause); }
  finally { if (current === request) loading.value = false; }
}

async function restore(entry: RecycleEntry) {
  if (busy.value) return;
  const directory = props.directory;
  busy.value = true; busyId.value = entry.id; error.value = "";
  try {
    await props.flushSave();
    if (disposed || directory !== props.directory) throw new Error("项目已切换，请重新打开回收站");
    const result = await useWorkspaceFiles(directory).restoreRecycleEntry(entry.id);
    if (disposed) return;
    await props.afterRestore(result.path);
    ElMessage.success("已恢复到画布");
    await load();
  } catch (cause) { error.value = message(cause); }
  finally { busy.value = false; busyId.value = ""; }
}

async function purge(selected: RecycleEntry[]) {
  if (busy.value || !selected.length) return;
  const directory = props.directory;
  const confirmed = await ElMessageBox.confirm(`永久删除这 ${selected.length} 项后将无法从回收站恢复，同时会清空当前页面的画布撤销历史。其他画布或任务仍使用的素材会保留。`, "永久删除", {
    type: "warning", confirmButtonText: "永久删除", cancelButtonText: "保留", closeOnClickModal: false,
  }).then(() => true, () => false);
  if (!confirmed || disposed || directory !== props.directory) return;
  busy.value = true; error.value = "";
  try {
    await props.flushSave();
    if (disposed) return;
    await props.preparePurge(directory);
    if (disposed || directory !== props.directory) throw new Error("项目已切换，请重新打开回收站");
    let freedBytes = 0, retainedCount = 0;
    for (let offset = 0; offset < selected.length; offset += 1000) {
      const result = await useWorkspaceFiles(directory).purgeRecycleEntries(selected.slice(offset, offset + 1000).map(entry => entry.id));
      freedBytes += result.freedBytes; retainedCount += result.retainedCount;
    }
    ElMessage.success(`已永久删除记录，释放 ${formatBytes(freedBytes)}${retainedCount ? "；仍被使用的素材将在空闲后清理" : ""}`);
    await load();
  } catch (cause) { error.value = message(cause); }
  finally { busy.value = false; }
}

watch([visible, () => props.directory], ([opened]) => {
  request++; overview.value = undefined; error.value = ""; search.value = "";
  if (opened) void load();
});
</script>

<style scoped lang="scss">
.recyclePanel {
  display: flex; flex-direction: column; gap: 20px; height: 100%; min-height: 0;
  .recycleHeader { display: flex; align-items: flex-start; gap: 14px;
    .headerIcon { display: grid; place-items: center; flex-shrink: 0; width: 48px; height: 48px; border: 1px solid var(--el-border-color-lighter); border-radius: 14px; background: var(--el-fill-color-light); color: var(--el-text-color-regular); }
    > div { flex: 1; min-width: 0; }
    h2 { margin: 1px 0 7px; font-size: 20px; font-weight: 650; }
    p { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.7; }
  }
  .storageSummary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;
    > div { display: flex; flex-direction: column; gap: 10px; padding: 16px; border: 1px solid var(--el-border-color-lighter); border-radius: 12px; background: var(--el-fill-color-extra-light); }
    span { font-size: 12px; color: var(--el-text-color-secondary); }
    strong { font-size: 21px; font-weight: 600; font-variant-numeric: tabular-nums; }
    small { font-size: 12px; font-weight: 400; }
  }
  .recycleToolbar { display: flex; align-items: center; gap: 8px; > .el-input { flex: 1; min-width: 0; } > .el-button { margin: 0; } }
  .recycleList { flex: 1; min-height: 180px; }
  .emptyBin { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 72px 16px; color: var(--el-text-color-secondary); strong { color: var(--el-text-color-regular); font-weight: 500; } span { font-size: 12px; } }
  .recycleCard { display: flex; align-items: center; gap: 14px; padding: 16px 0; border-bottom: 1px solid var(--el-border-color-lighter);
    &:first-child { padding-top: 0; }
    .recycleThumbnail { width: 68px; height: 76px; border-radius: 9px; border: 1px solid var(--el-border-color-lighter); }
    .entryDetail { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 6px; font-size: 12px; color: var(--el-text-color-secondary); }
    .entryTitle { display: flex; align-items: center; gap: 8px; strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--el-text-color-primary); font-size: 14px; font-weight: 550; } > span { flex-shrink: 0; font-size: 10px; padding: 1px 5px; border: 1px solid var(--el-border-color-light); border-radius: 4px; } }
    .originalCanvas { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .entryActions { display: flex; flex-direction: column; align-items: center; gap: 5px; > .el-button { margin: 0; } }
    .entryError { color: var(--el-color-danger); }
  }
  .recycleFooter { border-top: 1px solid var(--el-border-color-lighter); padding-top: 8px; p { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.7; margin: 4px 0; } .legacyInventory { margin-top: 10px; } }
  @media (max-width: 520px) { gap: 16px; .storageSummary { gap: 6px; > div { padding: 12px 8px; } strong { font-size: 17px; } } .recycleCard { gap: 10px; .recycleThumbnail { width: 48px; height: 60px; } } }
}
</style>
