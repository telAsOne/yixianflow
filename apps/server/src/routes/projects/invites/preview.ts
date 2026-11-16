import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { isWebMode } from "@/lib/webContext";

export default Router().post("/", validateFields({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }), async (req, res) => {
  if (!isWebMode()) return void res.sendStatus(404);
  res.json(success(await u.collaboration.previewProjectInvite(req.body.token)));
});
