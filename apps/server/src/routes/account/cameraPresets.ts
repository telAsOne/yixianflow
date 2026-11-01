import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { cameraPresetSchema } from "@/types/account";

const presetsSchema = z.array(cameraPresetSchema.pick({ id: true, name: true })).max(128);

export default Router().get("/", async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const account = u.account.requireAccount();
  const presets = presetsSchema.parse(await u.account.accountFetch("/v1/toonflow/camera-presets"));
  if (u.account.getAccount() !== account) throw Object.assign(new Error("账户已切换，请重新发起操作"), { status: 401 });
  res.set("Cache-Control", "no-store").json(success(presets));
});
