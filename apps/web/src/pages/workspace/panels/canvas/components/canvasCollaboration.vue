<template>
  <div class="collaborationOverlay" aria-label="成员操作标识">
    <template v-for="member in peers" :key="member.sessionId">
      <div v-for="selection in selections(member)" :key="selection.id" class="memberSelection" :style="{ ...selection.style, borderColor: member.color }"><span :style="{ background: member.color }">{{ member.userId === webUserId && !member.agent ? '我 · 另一窗口' : member.name }} · {{ member.activity }}</span></div>
      <div v-if="member.cursor" class="memberCursor" :style="{ transform: `translate(${screenPoint(member.cursor).x}px, ${screenPoint(member.cursor).y}px)`, color: member.color }">
        <svg width="18" height="22" viewBox="0 0 18 22" aria-hidden="true"><path d="M2 1L16 14H9L6 21Z" fill="currentColor" stroke="white" stroke-width="1.5" /></svg>
        <span :style="{ background: member.color }">{{ member.userId === webUserId && !member.agent ? '我 · 另一窗口' : member.name }}{{ member.admin ? ' · 管理员' : '' }}</span>
      </div>
    </template>
    <div v-if="followingMember" class="followingMember" role="status">正在跟随 {{ followingMember.name }}<el-button text size="small" @click="collaboration.following = ''">退出跟随</el-button></div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onScopeDispose, watch } from "vue";
import type { useVueFlow } from "@vue-flow/core";
import { useCollaborationStore } from "@/stores/collaboration";
import { webUserId } from "@/lib/webRuntime";
import type { ProjectPresence } from "@toonflow/server/collaboration";

const props = defineProps<{ flow: ReturnType<typeof useVueFlow>; path: string; active: boolean }>();
const collaboration = useCollaborationStore();
const peers = computed(() => collaboration.presence.filter(member => member.sessionId !== `${webUserId.value}:${collaboration.sessionId}` && member.path === props.path && member.visible));
const followingMember = computed(() => collaboration.presence.find(member => member.sessionId === collaboration.following));
const screenPoint = (point: { x: number; y: number }) => ({ x: point.x * props.flow.viewport.value.zoom + props.flow.viewport.value.x, y: point.y * props.flow.viewport.value.zoom + props.flow.viewport.value.y });
let cursor: { x: number; y: number } | undefined;
let previous = "";
let sentAt = 0;
let sending = false;

function selections(member: ProjectPresence) {
  return member.selected.flatMap(id => {
    const node = props.flow.findNode(id);
    if (!node) return [];
    const position = screenPoint(node.computedPosition ?? node.position);
    const zoom = props.flow.viewport.value.zoom;
    return [{ id, style: { left: `${position.x}px`, top: `${position.y}px`, width: `${Math.max(20, node.dimensions.width * zoom)}px`, height: `${Math.max(20, node.dimensions.height * zoom)}px` } }];
  });
}
async function broadcast() {
  if (!props.active || !props.path || sending || !collaboration.projectId) return;
  const selected = props.flow.getSelectedNodes.value.map(node => node.id).slice(0, 100);
  const element = document.activeElement;
  const editing = element instanceof HTMLElement && !!element.closest(".vue-flow__node, .nodeInspector") && (element.matches("input, textarea") || element.isContentEditable);
  const field = editing ? element.getAttribute("aria-label") || element.getAttribute("placeholder") || "节点内容" : "";
  const activity = props.flow.getNodes.value.some(node => node.dragging) ? "正在移动节点" : editing ? `正在编辑 ${field}`.slice(0, 160) : selected.length ? `选中 ${selected.length} 个节点` : "浏览画布";
  const state = { path: props.path, panel: "canvas" as const, visible: document.visibilityState === "visible", activity, cursor, selected, viewport: { ...props.flow.viewport.value } };
  const key = JSON.stringify(state);
  if (key === previous && Date.now() - sentAt < 10000) return;
  sending = true;
  try { await collaboration.updatePresence(state); previous = key; sentAt = Date.now(); } catch { /* 项目事件流负责展示连接状态，下一次心跳继续同步。 */ } finally { sending = false; }
}

onMounted(() => {
  const canvas = props.flow.vueFlowRef.value?.closest<HTMLElement>(".canvas");
  const move = (event: PointerEvent) => { cursor = props.flow.screenToFlowCoordinate({ x: event.clientX, y: event.clientY }); };
  const leave = () => { cursor = undefined; };
  const stopFollowing = () => { collaboration.following = ""; };
  canvas?.addEventListener("pointermove", move);
  canvas?.addEventListener("pointerleave", leave);
  canvas?.addEventListener("pointerdown", stopFollowing);
  canvas?.addEventListener("wheel", stopFollowing, { passive: true });
  const timer = setInterval(() => void broadcast(), 250);
  onScopeDispose(() => { clearInterval(timer); canvas?.removeEventListener("pointermove", move); canvas?.removeEventListener("pointerleave", leave); canvas?.removeEventListener("pointerdown", stopFollowing); canvas?.removeEventListener("wheel", stopFollowing); });
});
watch(() => followingMember.value, member => {
  if (!props.active || !member?.viewport) return;
  if (member.path !== props.path) { window.dispatchEvent(new CustomEvent("toonflow:activate-collaboration", { detail: { path: member.path } })); return; }
  void props.flow.setViewport(member.viewport, { duration: 0 });
}, { deep: true });
</script>

<style scoped lang="scss">
.collaborationOverlay {
  position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 2000;
  .memberCursor { position: absolute; left: 0; top: 0; display: flex; align-items: flex-start;
    > span { margin: 17px 0 0 -3px; padding: 4px 7px; border-radius: 0 6px 6px; white-space: nowrap; color: white; font-size: 11px; box-shadow: 0 2px 8px #0002; }
  }
  .memberSelection { position: absolute; box-sizing: border-box; border: 2px solid; border-radius: 9px;
    > span { position: absolute; left: -2px; bottom: calc(100% + 3px); padding: 3px 7px; border-radius: 5px; white-space: nowrap; color: white; font-size: 11px; }
  }
  .followingMember { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); pointer-events: auto; display: flex; align-items: center; gap: 8px; padding: 5px 12px; border: 1px solid var(--el-color-primary); border-radius: 20px; color: var(--el-color-primary); background: var(--el-bg-color); font-size: 12px; }
}
</style>
