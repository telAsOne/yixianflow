import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";

export default Router().post("/", validateFields({ activeId: z.uuid().optional(), approved: z.boolean(), paused: z.boolean(), autoExecute: z.boolean(), version: z.string().max(32) }), async (req, res) => {
  res.json(success(await u.localHelper.pollDevice(req, req.body)));
});
