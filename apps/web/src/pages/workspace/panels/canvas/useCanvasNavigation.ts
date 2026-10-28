import { computed, nextTick, ref, watch } from "vue";
import type { useVueFlow, ViewportTransform, XYPosition } from "@vue-flow/core";

export type CanvasNavigation = ReturnType<typeof useCanvasNavigation>;

export function useCanvasNavigation(flow: ReturnType<typeof useVueFlow>, binding: () => string, active: () => boolean) {
  const previousViews = ref<ViewportTransform[]>([]);
  const canGoBack = computed(() => previousViews.value.length > 0 && active() && !!binding());
  const duration = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 180;
  const ready = () => active() && !!binding() && flow.dimensions.value.width > 0 && flow.dimensions.value.height > 0;
  const sameView = (left: ViewportTransform, right: ViewportTransform) =>
    Math.abs(left.x - right.x) < 1 && Math.abs(left.y - right.y) < 1 && Math.abs(left.zoom - right.zoom) < 0.001;

  function rememberView() {
    if (!ready()) return;
    const viewport = { ...flow.viewport.value };
    const last = previousViews.value.at(-1);
    if (last && sameView(last, viewport)) return;
    // ACT: 只记最近 20 次主动定位；连续拖动由调用方在开始时记录一次，不持久化相机历史。
    previousViews.value = [...previousViews.value, viewport].slice(-20);
  }

  function centerOn(position: XYPosition, options: { remember?: boolean; animate?: boolean; zoom?: number } = {}) {
    if (!ready() || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return Promise.resolve(false);
    const zoom = options.zoom ?? flow.viewport.value.zoom;
    if (!Number.isFinite(zoom) || zoom <= 0) return Promise.resolve(false);
    if (options.remember !== false) rememberView();
    return flow.setCenter(position.x, position.y, {
      zoom: Math.min(flow.maxZoom.value, Math.max(flow.minZoom.value, zoom)),
      duration: options.animate === false ? 0 : duration(),
      interpolate: "linear",
    });
  }

  async function focusNodes(nodeIds: string[]) {
    await nextTick();
    const element = flow.vueFlowRef.value;
    if (element?.offsetWidth && element.offsetHeight) flow.dimensions.value = { width: element.offsetWidth, height: element.offsetHeight };
    if (!ready()) return false;
    const nodes = nodeIds.filter(id => {
      const node = flow.findNode(id);
      return node && !node.hidden && node.dimensions.width > 0 && node.dimensions.height > 0;
    });
    if (!nodes.length) return false;
    rememberView();
    // ACT: 聚焦立即结算；当前 Vue Flow 的动画被其他视口操作打断时不会 resolve，搜索不能依赖它解锁。
    return flow.fitView({ nodes, padding: 0.3, minZoom: flow.minZoom.value, maxZoom: 1.2, duration: 0 });
  }

  function showAll(options: { remember?: boolean; animate?: boolean } = {}) {
    if (!ready() || !flow.getNodes.value.some(node => !node.hidden && node.dimensions.width > 0 && node.dimensions.height > 0)) {
      return Promise.resolve(false);
    }
    if (options.remember !== false) rememberView();
    return flow.fitView({ padding: 0.2, minZoom: flow.minZoom.value, maxZoom: 1, duration: options.animate === false ? 0 : duration(), interpolate: "linear" });
  }

  function goBack() {
    if (!ready()) return Promise.resolve(false);
    let viewport = previousViews.value.pop();
    while (viewport && sameView(viewport, flow.viewport.value)) viewport = previousViews.value.pop();
    return viewport ? flow.setViewport(viewport, { duration: duration(), interpolate: "linear" }) : Promise.resolve(false);
  }

  function resetZoom() {
    if (!ready()) return Promise.resolve(false);
    rememberView();
    return flow.zoomTo(1, { duration: duration() });
  }

  watch(binding, () => { previousViews.value = []; }, { flush: "sync" });
  return { canGoBack, rememberView, centerOn, focusNodes, showAll, goBack, resetZoom };
}
