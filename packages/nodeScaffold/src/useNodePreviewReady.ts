import { computed, inject, onScopeDispose, ref, watch, type Ref } from "vue";
import { useNode, useNodeId } from "@vue-flow/core";
import type { NodeDocumentContext } from "./nodeDocument";

// 新旧节点包可能同时加载。各版本共享各自的观察器状态。
const previewObserverKey = Symbol.for("toonflow.nodePreviewObserver.v4");
type PreviewState = { visible: Ref<boolean>; intersecting: Ref<boolean>; retained: Ref<boolean>; ready: Readonly<Ref<boolean>> };
type PreviewObserver = {
  observer: IntersectionObserver;
  targets: Map<Element, Map<PreviewState, number>>;
  states: WeakMap<object, PreviewState>;
  pending: Map<PreviewState, ReturnType<typeof setTimeout>>;
};

export function useNodePreviewReady(retain?: Ref<boolean>) {
  const nodeId = useNodeId();
  const documentContext = inject<NodeDocumentContext | undefined>("nodeDocument", undefined);
  const canvasActive = inject<Readonly<Ref<boolean>>>("canvasActive", ref(true));
  const allowNewPreview = inject<Readonly<Ref<boolean>> | undefined>("canvasAllowNewPreview", undefined);
  if (!nodeId || typeof IntersectionObserver === "undefined") return ref(true);
  const { node, nodeEl } = useNode();
  const host = globalThis as typeof globalThis & { [previewObserverKey]?: PreviewObserver };
  if (!host[previewObserverKey]) {
    const targets: PreviewObserver["targets"] = new Map();
    const pending: PreviewObserver["pending"] = new Map();
    function release(state: PreviewState) {
      clearTimeout(pending.get(state));
      pending.delete(state);
      state.visible.value = false;
    }
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) for (const state of targets.get(entry.target)?.keys() ?? []) {
        state.intersecting.value = entry.isIntersecting;
        if (entry.isIntersecting) {
          clearTimeout(pending.get(state));
          pending.delete(state);
          state.visible.value = true;
        } else if (state.visible.value && !pending.has(state)) {
          // ACT: 离屏预览最多保留 1.2 秒、32 个节点；来回拖动复用，长距离巡览及时回收。
          pending.set(state, setTimeout(() => release(state), 1200));
          if (pending.size > 32) release(pending.keys().next().value!);
        }
      }
    }, { rootMargin: "320px" });
    host[previewObserverKey] = { observer, targets, states: new WeakMap(), pending };
  }
  const { observer, targets, states, pending } = host[previewObserverKey];
  let state = states.get(node);
  if (!state) {
    const visible = ref(false);
    const intersecting = ref(false);
    // 只在进入视口且允许预览时开始加载。已经加载的节点仍享受离屏保留时间。
    const ready = computed<boolean>(loaded => visible.value && (loaded === true || intersecting.value && allowNewPreview?.value !== false));
    state = { visible, intersecting, ready, retained: ref(false) };
    states.set(node, state);
  }
  const current = state;
  if (retain) {
    watch(retain, value => { current.retained.value = value; }, { immediate: true, flush: "sync" });
    onScopeDispose(() => { current.retained.value = false; });
  }
  watch(nodeEl, (element, _previous, onCleanup) => {
    if (!element) return;
    const subscribers = targets.get(element) ?? new Map<PreviewState, number>();
    subscribers.set(current, (subscribers.get(current) ?? 0) + 1);
    targets.set(element, subscribers);
    observer.observe(element);
    onCleanup(() => {
      const count = subscribers.get(current)! - 1;
      if (count) subscribers.set(current, count);
      else {
        subscribers.delete(current);
        clearTimeout(pending.get(current));
        pending.delete(current);
        current.intersecting.value = false;
        current.visible.value = false;
      }
      if (targets.get(element) === subscribers && !subscribers.size) {
        targets.delete(element);
        observer.unobserve(element);
      }
    });
  }, { immediate: true, flush: "post" });
  // 只回收预览；节点运行时、生成任务和正在编辑的视图仍由所属组件保留。
  return computed(() => current.retained.value || !!documentContext?.targets.has(nodeId) || canvasActive.value && (current.ready.value || node.selected));
}
