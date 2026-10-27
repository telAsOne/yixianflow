<template>
  <div class="providerList">
    <el-button :loading="refreshingModels" @click="refresh">刷新模型</el-button>
    <el-alert v-if="message" :title="message" type="error" :closable="false" showIcon />
    <el-card v-for="provider in customProviders" :key="provider.id" shadow="never">
      <template #header>{{ provider.label }}</template>
      <el-table :data="provider.models">
        <el-table-column prop="label" label="模型" />
        <el-table-column prop="id" label="模型 ID" />
        <el-table-column prop="contextWindow" label="上下文窗口" />
        <el-table-column prop="maxOutputTokens" label="最大输出" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { t } from "@toonflow/i18n/vue";
import { ref } from "vue";
import { customProviders } from "@/stores/settings";
import { refreshModels, refreshingModels } from "@/stores/account";
import { errorMessage } from "@/lib/api";
const message = ref("");
async function refresh() {
  try { await refreshModels(); message.value = ""; }
  catch (error) { message.value = errorMessage(error, t`刷新模型失败`); }
}
</script>

<style scoped lang="scss">
.providerList { display: grid; gap: 16px; }
</style>
