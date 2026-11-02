import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { isWebMode } from "@/lib/webContext";

export default Router().post("/", async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  if (isWebMode()) await u.webAuth.logoutWebSession(res, req);
  else await u.account.logout();
  res.set("Cache-Control", "no-store").json(success());
});
