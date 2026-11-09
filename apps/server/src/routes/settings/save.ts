import u from "@/utils";
import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { maxSystemPromptLength } from "@/agent/runtime/prompt";
import { t } from "@/lib/i18n";
import { isWebMode, requireWebAccount } from "@/lib/webContext";

const router = Router();

export default router.put("/", validateFields({ settings: z.record(z.string(), z.json()).and(z.object({
  agentSystemPrompt: z.string().max(maxSystemPromptLength, { error: () => t`系统提示词不能超过 ${maxSystemPromptLength} 个字符` }).optional(),
  mcp: z.object({ enabled: z.boolean().optional(), token: z.string().optional(), port: z.number().int().min(1).max(65535).optional() }).optional(),
})) }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const { settings } = req.body;
  u.removeLegacySettings(settings);
  if (isWebMode()) {
    await u.webStore.saveWebSettings(settings);
    if (!u.mcpAccess.isWebMcpEnabled()) {
      u.mcpAccess.cancelWebMcpCalls(requireWebAccount().user.id);
      await u.mcpAccess.clearWebMcpDeviceSessions();
      u.mcpControl.closeUserConnections();
    }
    return void res.json(success({ customProviders: u.getSettings().customProviders ?? [] }, "设置已保存"));
  }
  const previousSettings = u.conf.get("settings", {});
  for (const key of ["customProviders", "mediaProviderConfigs", "defaultModels", "yixianConfig"]) {
    if (Object.hasOwn(previousSettings, key)) settings[key] = previousSettings[key];
    else delete settings[key];
  }
  u.conf.set("settings", settings);
  await u.mcpRuntime.reloadMcpRuntime();
  const currentConfig = u.account.getAccount() && u.account.getConfigState().revision;
  res.json(success({ customProviders: currentConfig ? settings.customProviders : [] }, "设置已保存"));
});
