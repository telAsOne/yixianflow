import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";

export default Router().delete("/", validateFields({ id: z.uuid() }), async (req, res) => {
  await u.localHelper.revokeDevice(req.body.id);
  res.json(success());
});
