<template>
  <el-dialog v-model="visible" class="cameraPresetDialog" title="运镜" width="min(920px, 94vw)" appendToBody destroyOnClose :closeOnClickModal="false">
    <cameraPresetGrid v-if="visible" :presets="presets" :loading="loading" :error="error" :disabled="disabled" @confirm="emit('confirm', $event)" @retry="emit('retry')" @cancel="visible = false" />
  </el-dialog>
</template>

<script setup lang="ts">
import { ElDialog } from "element-plus";
import cameraPresetGrid from "./cameraPresetGrid.vue";
import type { CameraPreset } from "../cameraPresets";

const visible = defineModel<boolean>({ required: true });
defineProps<{ presets?: CameraPreset[]; loading: boolean; error?: string; disabled?: boolean }>();
const emit = defineEmits<{ confirm: [preset: CameraPreset]; retry: [] }>();
</script>
