import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/lib/middleware";
import { isWebMode } from "@/lib/webContext";

export default Router().post("/", validateFields({ name: z.string().trim().min(1).max(256) }), async (req, res) => {
  if (!isWebMode()) return void res.sendStatus(404);
  res.set("Cache-Control", "no-store").json(success(await u.webProjects.createWebProject(req.body.name.trim())));
});
