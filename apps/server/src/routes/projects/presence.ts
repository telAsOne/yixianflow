import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { isWebMode } from "@/lib/webContext";

export default Router().post("/", validateFields({ id: z.uuid(), compact: z.boolean().optional(), ...u.collaboration.presenceSchema.shape }), async (req, res) => {
  if (!isWebMode()) return void res.sendStatus(404);
  const project = await u.webProjects.getWebProject(req.body.id);
  u.collaboration.updateProjectPresence(project, u.collaboration.presenceSchema.parse(req.body));
  res.json(success(req.body.compact === true ? undefined : u.collaboration.getProjectPresence(project.id)));
});
