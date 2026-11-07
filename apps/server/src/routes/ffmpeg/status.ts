import { Router } from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";

export default Router().get("/", validateFields({ refresh: z.literal("true").optional() }, "query"), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once("close", cancel);
  try { res.set("Cache-Control", "no-store").json(success(await u.ffmpeg.getStatus(req.query.refresh === "true", controller.signal))); }
  finally { res.off("close", cancel); }
});
