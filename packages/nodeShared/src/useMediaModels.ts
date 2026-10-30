import { computed, onMounted, onScopeDispose, ref, watch, type Ref } from "vue";
import { ElMessage } from "element-plus";
import type { NodeMediaModel } from "@toonflow/nodes-scaffold/nodeAi";
import { showNodeError } from "./showNodeError";
import { groupNodeModels } from "./groupNodeModels";

export function useMediaModels(type: "image" | "video" | "audio", data: Readonly<Ref<{ model: string }>>,
  isBusy: () => boolean, getModels: () => Promise<NodeMediaModel[]>) {
  const models = ref<NodeMediaModel[]>([]);
  const modelsLoading = ref(false);
  const modelGroups = computed(() => groupNodeModels(models.value));
  let pending: Promise<void> | undefined;
  let disposed = false;
  let refreshPending = false;
  const refresh = (event?: Event) => {
    if (event && (event as CustomEvent<{ type: string }>).detail.type !== "provider") return;
    refreshPending = true;
    if (!disposed && !isBusy()) void loadModels().catch(error => showNodeError(error, "读取媒体模型失败"));
  };
  window.addEventListener("toonflow:plugin-installed", refresh);
  onMounted(() => { watch(isBusy, busy => { if (!busy && refreshPending) refresh(); }); });
  onScopeDispose(() => { disposed = true; window.removeEventListener("toonflow:plugin-installed", refresh); });

  function loadModels() {
    if (pending) return pending;
    refreshPending = false;
    modelsLoading.value = true;
    pending = getModels().then(items => {
      if (disposed) return;
      if (isBusy()) { refreshPending = true; return; }
      models.value = items.filter(item => item.type === type);
      // ACT: 平台统一管理模型，旧偏好或已下架型号回到本类默认值；运行中的任务保留原请求。
      if (!models.value.some(model => JSON.stringify([model.providerId, model.modelId]) === data.value.model)) {
        const first = models.value.find(model => model.isDefault) ?? models.value[0];
        const previous = data.value.model;
        data.value.model = first ? JSON.stringify([first.providerId, first.modelId]) : "";
        if (previous) ElMessage.warning({ grouping: true, duration: 6000, message: first
          ? `原模型已不可用，已切换为 ${first.label}，请确认后再生成`
          : "当前没有可用模型，请稍后重试" });
      }
    }).finally(() => {
      modelsLoading.value = false;
      pending = undefined;
      if (refreshPending && !disposed && !isBusy()) refresh();
    });
    return pending;
  }

  return { models, modelsLoading, modelGroups, loadModels };
}
