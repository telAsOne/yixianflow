import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";

export default Router().post("/", async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  u.account.requireAccount();
  await u.account.refreshConfig();
  res.set("Cache-Control", "no-store").json(success({ ...u.account.getConfigState(), customProviders: u.conf.get("settings.customProviders"),
    defaultModels: u.conf.get("settings.defaultModels") }));
});
