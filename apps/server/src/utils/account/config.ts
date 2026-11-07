import conf, { getSettings } from "@/utils/conf";
import { translateMessage } from "@/lib/i18n";
import { accountFetch, getAccount, getBaseUrl } from "./index";
import { defaultUploadLimits, platformConfigSchema, type PlatformConfig } from "@/types/account";
import { getMediaProvider, saveMediaProvider } from "@/utils/media/provider";
import yixian from "@toonflow/providers/language/yixian";
import { normalizeImageModel } from "@toonflow/providers/media/yixianVideo";
import { isWebMode } from "@/lib/webContext";
import { hashWebToken, saveWebManagedSettings } from "@/utils/web/store";
import type { Provider } from "@toonflow/providers";

let pending: Promise<void> | undefined;
let pendingAccount: ReturnType<typeof getAccount>;
let configError = "";
let timer: ReturnType<typeof setInterval> | undefined;
let refreshedAccount: ReturnType<typeof getAccount>;
let refreshedAt = 0;
const refreshInterval = 60_000;
type WebConfigState = { identity: string; refreshedAt: number; config?: PlatformConfig; pending?: Promise<PlatformConfig>; error: string };
const webConfigStates = new Map<number, WebConfigState>();

export function getManagedConfig() {
  const saved = getSettings().yixianConfig as { baseUrl?: string; userId?: number; config?: unknown } | undefined;
  if (saved?.baseUrl !== getBaseUrl() || saved.userId !== getAccount()?.user.id) return;
  const parsed = platformConfigSchema.safeParse(saved.config);
  return parsed.success ? parsed.data : undefined;
}

export function getManagedMediaModels(config: PlatformConfig | undefined): (Provider["models"][number] & { type: "image" | "video" })[] {
  if (!config) return [];
  const { image, video } = config.categories;
  return [
    ...(image.enabled ? image.models.map(model => ({ ...model, type: "image" as const })) : []),
    ...(video.enabled ? video.models.map(model => ({ ...model, type: "video" as const, taskRecovery: true, referenceInput: "platformAsset" as const })) : []),
  ].map(model => normalizeImageModel({ ...model, mode: model.mode as Provider["models"][number]["mode"] }));
}

async function refreshWebConfig(force: boolean) {
  const account = getAccount();
  if (!account) return;
  const identity = hashWebToken(account.baseUrl + ":" + account.key);
  const previous = webConfigStates.get(account.user.id);
  const state: WebConfigState = previous?.identity === identity ? previous : { identity, refreshedAt: 0, error: "" };
  webConfigStates.set(account.user.id, state);
  try {
    if (force || !state.config || Date.now() - state.refreshedAt >= refreshInterval) {
      state.pending ??= accountFetch("/v1/toonflow/config").then(value => platformConfigSchema.parse(value))
        .finally(() => { state.pending = undefined; });
      state.config = await state.pending;
      state.refreshedAt = Date.now();
    }
    if (webConfigStates.get(account.user.id) !== state) throw Object.assign(new Error("账户已更新，请刷新页面"), { status: 401 });
    const config = state.config;
    const { text } = config.categories;
    const { id, label, icon, version, protocol } = yixian;
    const customProviders = [{ id, label, icon, version, protocol, apiUrl: account.baseUrl + "/v1", models: text.enabled ? text.models : [], requestBodyLimitMiB: text.requestBodyLimitMiB }];
    const defaultModels = Object.fromEntries(Object.entries(config.categories).map(([type, category]) => [type,
      category.enabled ? { providerId: type === "text" ? "yixian" : "yixianVideo", modelId: category.defaultModel } : null]));
    const settings = getSettings();
    const saved = settings.yixianConfig as { config?: unknown } | undefined;
    if (JSON.stringify(saved?.config) !== JSON.stringify(config) || JSON.stringify(settings.customProviders) !== JSON.stringify(customProviders)
      || JSON.stringify(settings.defaultModels) !== JSON.stringify(defaultModels)) {
      await saveWebManagedSettings({ customProviders, defaultModels, mediaProviderConfigs: {}, yixianConfig: { baseUrl: account.baseUrl, userId: account.user.id, config } });
    }
    state.error = "";
  } catch (error) {
    state.error = error instanceof Error ? error.message : "刷新模型失败";
    throw error;
  }
}

export function getConfigState() {
  const config = getManagedConfig();
  const limits = config?.limits ?? defaultUploadLimits;
  const imageBodyLimit = config?.categories.image.requestBodyLimitMiB;
  return { limits,
    imageTotalMaxBytes: Math.min(limits.requestTotalMaxBytes, imageBodyLimit ? Math.max(0, imageBodyLimit - 1) * 1024 * 1024 : limits.requestTotalMaxBytes),
    revision: config?.revision,
    configError: getAccount() ? translateMessage(isWebMode() ? webConfigStates.get(getAccount()!.user.id)?.error ?? "" : configError) : "" };
}

export async function refreshConfig(force = true): Promise<void> {
  if (isWebMode()) return refreshWebConfig(force);
  if (pending) {
    if (pendingAccount === getAccount()) return pending;
    await pending.catch(() => {});
    return refreshConfig(force);
  }
  const account = getAccount();
  if (!account) return;
  const refreshStartedAt = Date.now();
  if (!force && refreshedAccount === account && refreshStartedAt - refreshedAt < refreshInterval) return;
  pendingAccount = account;
  pending = (async () => {
    try {
      const config = platformConfigSchema.parse(await accountFetch("/v1/toonflow/config"));
      if (getAccount() !== account) return;
      const { text } = config.categories;
      const provider = await getMediaProvider("yixianVideo");
      const models = getManagedMediaModels(config);
      const { id, label, icon, version, protocol } = yixian;
      const customProviders = [{ id, label, icon, version, protocol, apiUrl: `${account.baseUrl}/v1`,
        models: text.enabled ? text.models : [], requestBodyLimitMiB: text.requestBodyLimitMiB }];
      const defaultModels = Object.fromEntries(Object.entries(config.categories).map(([type, category]) => [type,
        category.enabled ? { providerId: type === "text" ? "yixian" : "yixianVideo", modelId: category.defaultModel } : null]));
      const saved = conf.get("settings.yixianConfig") as { config?: unknown } | undefined;
      if (JSON.stringify(saved?.config) === JSON.stringify(config) && JSON.stringify(provider.models) === JSON.stringify(models)
        && JSON.stringify(conf.get("settings.customProviders")) === JSON.stringify(customProviders)
        && JSON.stringify(conf.get("settings.defaultModels")) === JSON.stringify(defaultModels)) {
        configError = "";
        return;
      }
      if (getAccount() !== account) return;
      await saveMediaProvider(provider.fileName, models, provider.revision);
      if (getAccount() !== account) return;
      const settings = conf.get("settings", {});
      conf.set("settings", { ...settings,
        customProviders,
        mediaProviderConfigs: {},
        defaultModels,
        yixianConfig: { baseUrl: account.baseUrl, userId: account.user.id, config },
      });
      configError = "";
    } catch (error) {
      if (getAccount() === account) configError = error instanceof Error ? error.message : "刷新模型失败";
      throw error;
    }
  })().then(() => {
    if (getAccount() === account) { refreshedAccount = account; refreshedAt = refreshStartedAt; }
  }).finally(() => { pending = undefined; });
  return pending;
}

export async function initializeConfig() {
  await refreshConfig().catch(() => {});
  timer ??= setInterval(() => { void refreshConfig(false).catch(() => {}); }, refreshInterval);
  timer.unref();
}
