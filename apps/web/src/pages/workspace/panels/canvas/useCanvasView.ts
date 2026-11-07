import { computed, nextTick, onBeforeUnmount, onScopeDispose, ref, watch, type Ref } from "vue";
import { debounce } from "lodash-es";
import { z } from "zod";
import type { useVueFlow } from "@vue-flow/core";
import { settingsStorage } from "@/stores/settings";
import type { CanvasNavigation } from "./useCanvasNavigation";

const canvasViewSchema = z.object({
  x: z.number(), y: z.number(), zoom: z.number().positive(),
  selectedNodeIds: z.array(z.string()).optional(),
  showMap: z.boolean().optional(),
  snapEnabled: z.boolean().optional(),
  showEdges: z.boolean().optional(),
});

export function useCanvasView(flow: ReturnType<typeof useVueFlow>, navigation: CanvasNavigation, options: {
  directory(): string | undefined; path(): string; active(): boolean; loaded(): boolean;
  showMap: Ref<boolean>; snapEnabled: Ref<boolean>; showEdges: Ref<boolean>;
}) {
  const key = ref("");
  const ready = ref(false);
  const selectionReady = ref(false);
  let saved: z.infer<typeof canvasViewSchema> | undefined;
  // 个人视图随账户设置上传，平移缩放停下后再写入；隐藏、切换和卸载时立即写入。
  const save = debounce((key: string, value: string) => settingsStorage.setItem(key, value), 300);

  function remember() {
    if (!key.value || !ready.value) return;
    save(key.value, JSON.stringify({
      ...flow.viewport.value,
      selectedNodeIds: flow.getSelectedNodes.value.map(node => node.id),
      showMap: options.showMap.value, snapEnabled: options.snapEnabled.value, showEdges: options.showEdges.value,
    }));
  }

  function flush() {
    remember();
    save.flush();
  }

  watch([options.directory, options.path], ([directory, path], [previousDirectory, previousPath]) => {
    flush();
    key.value = directory && path ? `toonflow.canvasViewport:${JSON.stringify([directory, path])}` : "";
    // 同一实例的非空路径变化来自改名，沿用当前视图，不重新定位。
    if (directory === previousDirectory && path && previousPath) { remember(); return; }
    ready.value = false;
    selectionReady.value = false;
    saved = undefined;
    if (!key.value) return;
    try { saved = canvasViewSchema.parse(JSON.parse(settingsStorage.getItem(key.value) ?? "null")); }
    catch { /* 没有有效的个人视图时，等待节点就绪后显示整个画布。 */ }
    options.showMap.value = saved?.showMap ?? false;
    options.snapEnabled.value = saved?.snapEnabled ?? false;
    options.showEdges.value = saved?.showEdges ?? true;
    const selected = new Set(saved?.selectedNodeIds ?? []);
    flow.removeSelectedElements();
    flow.addSelectedNodes(flow.getNodes.value.filter(node => selected.has(node.id)));
    selectionReady.value = true;
  }, { immediate: true, flush: "sync" });

  watch([options.active, flow.vueFlowRef], async ([active], _previous, onCleanup) => {
    if (!active) return;
    let cancelled = false;
    onCleanup(() => { cancelled = true; });
    await nextTick();
    const element = flow.vueFlowRef.value;
    // 后台画布首次激活时可见性变了，尺寸未变，ResizeObserver 不一定再次通知。
    if (!cancelled && element?.offsetWidth && element.offsetHeight) flow.dimensions.value = { width: element.offsetWidth, height: element.offsetHeight };
  }, { immediate: true, flush: "post" });

  const canRestore = computed(() => !!key.value && options.active() && options.loaded()
    && flow.viewportHelper.value.viewportInitialized
    && flow.getNodes.value.every(node => node.hidden || node.dimensions.width > 0 && node.dimensions.height > 0));
  watch([key, canRestore], async ([, canRestore], _previous, onCleanup) => {
    if (!canRestore || ready.value) return;
    let cancelled = false;
    let frame = 0;
    onCleanup(() => { cancelled = true; cancelAnimationFrame(frame); });
    await nextTick();
    if (cancelled) return;
    frame = requestAnimationFrame(async () => {
      if (saved) await flow.setViewport({ x: saved.x, y: saved.y, zoom: Math.min(flow.maxZoom.value, Math.max(flow.minZoom.value, saved.zoom)) });
      else if (flow.getNodes.value.some(node => !node.hidden)) await navigation.showAll({ remember: false, animate: false });
      else await flow.setViewport({ x: 0, y: 0, zoom: 1 });
      if (cancelled) return;
      ready.value = true;
      remember();
    });
  }, { immediate: true, flush: "post" });

  // 个人视图只写设置，不标记共享画布内容发生修改。
  watch(() => [flow.viewport.value.x, flow.viewport.value.y, flow.viewport.value.zoom,
    flow.getSelectedNodes.value.map(node => node.id).join(","), options.showMap.value, options.snapEnabled.value, options.showEdges.value], remember, { flush: "post" });
  function flushWhenHidden() { if (document.visibilityState === "hidden") flush(); }
  document.addEventListener("visibilitychange", flushWhenHidden, true);
  onBeforeUnmount(() => { flush(); ready.value = false; });
  onScopeDispose(() => {
    save.flush();
    document.removeEventListener("visibilitychange", flushWhenHidden, true);
  });
  return { ready, selectionReady, flush };
}
