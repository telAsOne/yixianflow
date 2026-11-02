import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";

export default Router().post("/", validateFields({ id: z.uuid(), nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/), result: z.json().optional(), error: z.string().max(4000).optional() }), async (req, res) => {
  await u.localHelper.completeDeviceCall(req, req.body);
  res.json(success());
});
