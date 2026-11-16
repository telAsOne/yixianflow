import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { isWebMode } from "@/lib/webContext";

export default Router().get("/", validateFields({ id: z.uuid() }, "query"), async (req, res) => {
  if (!isWebMode()) return void res.sendStatus(404);
  res.json(success(await u.collaboration.listProjectActivity(req.query.id as string)));
});
