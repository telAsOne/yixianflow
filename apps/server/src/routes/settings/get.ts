import u from "@/utils";
import { Router } from "express";
import { success } from "@/lib/responseFormat";
import { isWebMode, webContext } from "@/lib/webContext";

const router = Router();

export default router.get("/", async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  res.set("Cache-Control", "no-store");
  if (isWebMode()) return void res.json(success(webContext.getStore() ? await u.webStore.getWebSettings() : {}));
  const settings = u.conf.get("settings", {});
  const currentConfig = u.account.getAccount() && u.account.getConfigState().revision;
  res.json(success(currentConfig ? settings : { ...settings, customProviders: [], defaultModels: {}, yixianConfig: undefined }));
});
