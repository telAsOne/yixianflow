import { computed, onScopeDispose, ref, type Ref } from "vue";
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
  const refresh = (event: Event) => {
    if ((event as CustomEvent<{ type: string }>).detail.type === "provider") void loadModels().catch(error => showNodeError(error, "读取媒体模型失败"));
  };
  window.addEventListener("toonflow:plugin-installed", refresh);
  onScopeDispose(() => { disposed = true; window.removeEventListener("toonflow:plugin-installed", refresh); });

  function loadModels() {
    if (pending) return pending;
    modelsLoading.value = true;
    pending = getModels().then(items => {
      if (disposed || isBusy()) return;
      models.value = items.filter(item => item.type === type);
      // ACT: 仅空配置选择默认模型，暂时不可用的模型保持原选择，避免静默更换供应商。
      if (!data.value.model) {
        const first = models.value.find(model => model.isDefault) ?? models.value[0];
        data.value.model = first ? JSON.stringify([first.providerId, first.modelId]) : "";
      }
    }).finally(() => { modelsLoading.value = false; pending = undefined; });
    return pending;
  }

  return { models, modelsLoading, modelGroups, loadModels };
}
