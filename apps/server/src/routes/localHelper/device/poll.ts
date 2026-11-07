import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { localMediaStatus } from "@toonflow/local-helper/protocol";

export default Router().post("/", validateFields({ activeId: z.uuid().optional(), approved: z.boolean(), paused: z.boolean(), autoExecute: z.boolean(), version: z.string().max(32), media: localMediaStatus.optional(), subtitleTasks: z.array(z.uuid()).max(100).optional() }), async (req, res) => {
  res.json(success(await u.localHelper.pollDevice(req, req.body)));
});
