import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";

export default Router().post("/", validateFields({ code: z.string().regex(/^[A-Z0-9\s-]{12,20}$/i) }), async (req, res) => {
  await u.localHelper.bindDevice(req.body.code);
  res.json(success());
});
