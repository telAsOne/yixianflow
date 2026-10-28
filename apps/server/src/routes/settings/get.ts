import u from "@/utils";
import { Router } from "express";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.get("/", (req, res) => {
  u.mcpControl.assertAppRequest(req);
  res.set("Cache-Control", "no-store");
  const settings = u.conf.get("settings", {});
  const currentConfig = u.account.getAccount() && u.account.getConfigState().revision;
  res.json(success(currentConfig ? settings : { ...settings, customProviders: [], defaultModels: {}, yixianConfig: undefined }));
});
