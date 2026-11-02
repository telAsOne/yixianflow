import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";

export default Router().post("/", validateFields({ id: z.uuid(), code: z.string().regex(/^[A-F0-9]{12}$/), name: z.string().min(1).max(100), version: z.string().max(32) }), async (req, res) => {
  await u.localHelper.registerDevice(req, req.body);
  res.json(success());
});
