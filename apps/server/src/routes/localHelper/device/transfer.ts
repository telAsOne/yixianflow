import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ action: z.enum(["upload", "download"]), projectId: z.uuid(), files: z.array(z.json()).min(1).max(20) }), async (req, res) => {
  res.json(success(await u.localHelper.prepareTransfer(req)));
});
