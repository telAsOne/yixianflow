import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/lib/middleware";
import { isWebMode } from "@/lib/webContext";

export default Router().put("/", validateFields({ id: z.uuid(), name: z.string().trim().min(1).max(256) }), async (req, res) => {
  if (!isWebMode()) return void res.sendStatus(404);
  await u.webProjects.renameWebProject(req.body.id, req.body.name.trim());
  res.json(success());
});
