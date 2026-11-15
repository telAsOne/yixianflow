import { computed, onMounted, onScopeDispose, ref, watch, type Ref } from "vue";
import { ElMessage } from "element-plus";
import type { NodeMediaModel } from "@toonflow/nodes-scaffold/nodeAi";
import { showNodeError } from "./showNodeError";
import { groupNodeModels } from "./groupNodeModels";

function modelPriceLabel(model?: NodeMediaModel) {
  const pricing = model?.pricing;
  if (!pricing) return "价格暂不可用";
  const { price, groupRatio, quotaPerUnit } = pricing;
  const money = (amount: number) => {
    const value = amount * groupRatio;
    return `US$${value > 0 && value < 0.00000001 ? value.toExponential(2) : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 8 }).format(value)}`;
  };
  const variants = price.billing_plugin_variants?.length ? price.billing_plugin_variants : [price];
  if (variants.some(item => item.billing_usage_schema && Object.keys(item.billing_usage_schema).length)) {
    const labels = variants.map(item => {
      if (item.billing_mode !== "tiered_expr" || !item.billing_expr) return "价格未配置";
      // ACT: 仅展示能完整识别的平价用量表达式；条件和额外倍率保留按规格计费，避免显示不完整的单价。
      const body = /^(?:v1:)?\s*tier\(\s*"[^"\\]*"\s*,\s*(.*?)\s*\)\s*$/.exec(item.billing_expr)?.[1];
      if (!body) return "按规格计费";
      const terms: string[] = [];
      for (const text of body.split(/\s*\+\s*/)) {
        const term = /^u\(\s*"([^"\\]+)"\s*\)\s*\*\s*(\d+(?:\.\d+)?|\.\d+)(?:\s*\/\s*(1000000))?$/.exec(text);
        if (!term) return "按规格计费";
        const amount = Number(term[2]);
        if (!Number.isFinite(amount)) return "价格暂不可用";
        if (amount === 0) continue;
        const unit = item.billing_usage_schema?.[term[1]!] as { unit?: string } | undefined;
        const label = unit?.unit === "second" ? "秒" : unit?.unit === "count" ? (model?.type === "image" ? "张" : "次")
          : unit?.unit === "token" && term[3] ? "百万 token" : unit?.unit === "credit" ? "积分" : undefined;
        if (!label || term[3] && unit?.unit !== "token") return "按规格计费";
        terms.push(`${money(amount)}/${label}`);
      }
      return terms.join(" + ") || "免费";
    });
    const unique = [...new Set(labels)];
    return unique.length === 1 ? unique[0]! : "按渠道/规格计费";
  }
  if (price.billing_mode === "tiered_expr") {
    if (!price.billing_expr) return "价格未配置";
    const fixed = /^(?:v1:)?\s*tier\(\s*"[^"\\]*"\s*,\s*fixed\(\s*(\d+(?:\.\d+)?|\.\d+)\s*\)\s*\)(?:\s*\*\s*image_count)?\s*$/.exec(price.billing_expr);
    return fixed ? `${money(Number(fixed[1]))}/${model?.type === "image" ? "张" : "次"}` : "按用量计费";
  }
  if (price.quota_type === 1) return `${money(price.model_price)}/${model?.type === "image" ? "张" : "次"}`;
  const input = price.model_ratio * 1_000_000 / quotaPerUnit;
  return `输入 ${money(input)} · 输出 ${money(input * price.completion_ratio)}/百万 token`;
}

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
        const first = (type === "image" ? models.value.find(model => model.modelId === "gpt-image-2.6") : undefined)
          ?? models.value.find(model => model.isDefault) ?? models.value[0];
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

  return { models, modelsLoading, modelGroups, loadModels, modelPriceLabel };
}
