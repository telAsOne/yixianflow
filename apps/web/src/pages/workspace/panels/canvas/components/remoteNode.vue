<template>
  <nodeSkeleton v-if="loading || !component || error || runtimeError" :loading="loading" :label="node.data.label || node.type" :handles="node.data.handles" :outputs="node.data.outputs">
    <p class="remoteNodeError" role="alert">{{ error || runtimeError || "远程节点未加载，请确认插件已安装并启用" }}</p>
  </nodeSkeleton>
  <component v-else :is="component" v-bind="$attrs" />
</template>

<script setup lang="ts">
import { onErrorCaptured, ref, watch, type Component } from "vue";
import { useNode } from "@vue-flow/core";
import { nodeSkeleton, type NodeData } from "@toonflow/nodes-scaffold/runtime";

defineOptions({ inheritAttrs: false });
const props = defineProps<{ component?: Component | string; error?: string; loading?: boolean }>();
const { node } = useNode<NodeData>();
const runtimeError = ref("");

onErrorCaptured(error => {
  runtimeError.value = error instanceof Error ? error.message : String(error);
  console.error(`远程节点 ${node.type} (${node.id}) 运行失败`, error);
  return false;
});
watch(() => props.component, () => { runtimeError.value = ""; });
</script>

<style scoped lang="scss">
.remoteNodeError {
  margin: 0;
  color: var(--el-color-danger);
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
