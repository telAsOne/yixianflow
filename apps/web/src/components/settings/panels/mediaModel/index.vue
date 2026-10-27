<template>
  <div class="providerList">
    <el-button :loading="refreshingModels" @click="refresh">刷新模型</el-button>
    <el-alert v-if="message" :title="message" type="error" :closable="false" showIcon />
    <el-card v-for="provider in providers" :key="provider.id" shadow="never">
      <template #header>{{ provider.label }}</template>
      <el-alert v-if="provider.loadError" :title="provider.loadError" type="error" :closable="false" />
      <el-table :data="provider.models">
        <el-table-column prop="label" label="模型" />
        <el-table-column prop="id" label="模型 ID" />
        <el-table-column label="类型"><template #default="{ row }">{{ row.type === "image" ? "图像" : "视频" }}</template></el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { t } from "@toonflow/i18n/vue";
import { onMounted, onBeforeUnmount, ref } from "vue";
import api, { errorMessage } from "@/lib/api";
import { refreshModels, refreshingModels } from "@/stores/account";
import type { MediaProvider } from "./types";
const providers = ref<MediaProvider[]>([]);
const message = ref("");
let disposed = false;
async function loadProviders() {
  try {
    const { data } = await api.get<{ data: MediaProvider[] }>("/api/providers/media/list");
    if (!disposed) providers.value = data.data;
  } catch (error) { if (!disposed) message.value = errorMessage(error, t`读取媒体模型失败`); }
}
function changed() { void loadProviders(); }
onMounted(() => { changed(); window.addEventListener("toonflow:plugin-installed", changed); });
onBeforeUnmount(() => { disposed = true; window.removeEventListener("toonflow:plugin-installed", changed); });
async function refresh() {
  try { await refreshModels(); await loadProviders(); message.value = ""; }
  catch (error) { message.value = errorMessage(error, t`刷新模型失败`); }
}
</script>

<style scoped lang="scss">
.providerList { display: grid; gap: 16px; }
</style>
