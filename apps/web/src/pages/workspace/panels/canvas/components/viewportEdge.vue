<template>
  <simple-bezier-edge v-if="visible" v-bind="props" />
</template>

<script setup lang="ts">
import { computed, inject, type Ref } from "vue";
import { SimpleBezierEdge, type EdgeProps } from "@vue-flow/core";
import type { CanvasEdgeBounds } from "../useCanvasView";

defineOptions({ inheritAttrs: false });
const props = defineProps<EdgeProps>();
const edgeBounds = inject<Readonly<Ref<CanvasEdgeBounds>>>("canvasEdgeBounds")!;
const canvasActive = inject<Ref<boolean>>("canvasActive");
const showEdges = inject<Ref<boolean>>("canvasShowEdges");
const visible = computed(() => {
  if (canvasActive?.value === false) return false;
  if (showEdges?.value === false
    && !props.sourceNode.selected && !props.sourceNode.dragging && !props.targetNode.selected && !props.targetNode.dragging) return false;
  const { left, top, right, bottom } = edgeBounds.value;
  const padding = props.interactionWidth ?? 40;
  // ACT: simple-bezier 的控制点位于端点包围盒内；连线穿过视口时保留，即使两个节点都在屏幕外。
  return Math.max(props.sourceX, props.targetX) >= left - padding
    && Math.min(props.sourceX, props.targetX) <= right + padding
    && Math.max(props.sourceY, props.targetY) >= top - padding
    && Math.min(props.sourceY, props.targetY) <= bottom + padding;
});
</script>
