import conf from "@/utils/conf";
import { translateMessage } from "@/lib/i18n";
import { accountFetch, getAccount, getBaseUrl } from "./index";
import { defaultUploadLimits, platformConfigSchema } from "@/types/account";
import { getMediaProvider, saveMediaProvider } from "@/utils/media/provider";
import yixian from "@toonflow/providers/language/yixian";

let pending: Promise<void> | undefined;
let pendingAccount: ReturnType<typeof getAccount>;
let configError = "";
let timer: ReturnType<typeof setInterval> | undefined;

export function getConfigState() {
  const saved = conf.get("settings.yixianConfig") as { baseUrl?: string; userId?: number; config?: unknown } | undefined;
  const parsed = saved?.baseUrl === getBaseUrl() && saved.userId === getAccount()?.user.id ? platformConfigSchema.safeParse(saved.config) : undefined;
  const limits = parsed?.success ? parsed.data.limits : defaultUploadLimits;
  const imageBodyLimit = parsed?.success ? parsed.data.categories.image.requestBodyLimitMiB : undefined;
  return { limits,
    imageTotalMaxBytes: Math.min(limits.requestTotalMaxBytes, imageBodyLimit ? Math.max(0, imageBodyLimit - 1) * 1024 * 1024 : limits.requestTotalMaxBytes),
    revision: parsed?.success ? parsed.data.revision : undefined, configError: getAccount() ? translateMessage(configError) : "" };
}

export async function refreshConfig(): Promise<void> {
  if (pending) {
    if (pendingAccount === getAccount()) return pending;
    await pending.catch(() => {});
    return refreshConfig();
  }
  const account = getAccount();
  if (!account) return;
  pendingAccount = account;
  pending = (async () => {
    try {
      const config = platformConfigSchema.parse(await accountFetch("/v1/toonflow/config"));
      if (getAccount() !== account) return;
      const { text, image, video } = config.categories;
      const provider = await getMediaProvider("yixianVideo");
      const models = [
        ...(image.enabled ? image.models.map(model => ({ ...model, type: "image" as const })) : []),
        ...(video.enabled ? video.models.map(model => ({ ...model, type: "video" as const, taskRecovery: true, referenceInput: "platformAsset" as const })) : []),
      ];
      const saved = conf.get("settings.yixianConfig") as { config?: unknown } | undefined;
      if (JSON.stringify(saved?.config) === JSON.stringify(config) && JSON.stringify(provider.models) === JSON.stringify(models)) {
        configError = "";
        return;
      }
      if (getAccount() !== account) return;
      await saveMediaProvider(provider.fileName, models, provider.revision);
      if (getAccount() !== account) return;
      const { id, label, icon, version, protocol } = yixian;
      const settings = conf.get("settings", {});
      conf.set("settings", { ...settings,
        customProviders: [{ id, label, icon, version, protocol, apiUrl: `${account.baseUrl}/v1`,
          models: text.enabled ? text.models : [], requestBodyLimitMiB: text.requestBodyLimitMiB }],
        mediaProviderConfigs: {},
        defaultModels: Object.fromEntries(Object.entries(config.categories).map(([type, category]) => [type,
          category.enabled ? { providerId: type === "text" ? "yixian" : "yixianVideo", modelId: category.defaultModel } : null])),
        yixianConfig: { baseUrl: account.baseUrl, userId: account.user.id, config },
      });
      configError = "";
    } catch (error) {
      if (getAccount() === account) configError = error instanceof Error ? error.message : "刷新模型失败";
      throw error;
    }
  })().finally(() => { pending = undefined; });
  return pending;
}

export async function initializeConfig() {
  await refreshConfig().catch(() => {});
  timer ??= setInterval(() => { void refreshConfig().catch(() => {}); }, 10 * 60_000);
  timer.unref();
}
