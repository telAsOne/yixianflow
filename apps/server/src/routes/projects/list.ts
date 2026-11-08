import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { isWebMode } from "@/lib/webContext";

export default Router().get("/", validateFields({ all: z.literal("1").optional() }, "query"), async (req, res) => {
  if (!isWebMode()) return void res.sendStatus(404);
  res.set("Cache-Control", "no-store").json(success(await u.webProjects.listWebProjects(req.query.all === "1")));
});
