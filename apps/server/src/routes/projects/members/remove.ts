import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { isWebMode } from "@/lib/webContext";

export default Router().delete("/", validateFields({ id: z.uuid(), userId: z.number().int().positive() }), async (req, res) => {
  if (!isWebMode()) return void res.sendStatus(404);
  res.json(success(await u.collaboration.saveProjectMember(req.body.id, req.body.userId)));
});
