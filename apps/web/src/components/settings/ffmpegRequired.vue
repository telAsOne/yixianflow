<template>
  <el-dialog v-model="visible" title="本地助手" width="min(800px, calc(100vw - 32px))" alignCenter appendToBody destroyOnClose>
    <el-alert class="installationHint" title="连接电脑或修复本机媒体组件后，请重新发起刚才的操作。" type="info" :closable="false" showIcon />
    <localHelper v-if="visible" :visible="visible" />
  </el-dialog>
</template>

<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, ref } from "vue";

const localHelper = defineAsyncComponent(() => import("./panels/localHelper.vue"));

const visible = ref(false);
const events = new EventSource("/api/ffmpeg/events");
events.onmessage = event => {
  let data: { type?: string };
  try { data = JSON.parse(event.data); }
  catch { return; }
  if (data?.type === "required") visible.value = true;
};
onBeforeUnmount(() => events.close());
</script>

<style scoped>
.installationHint { margin-bottom: 12px; }
</style>
