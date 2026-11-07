import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ mediaId: z.uuid(), path: z.string().min(1).max(4096),
  size: z.string().regex(/^\d{1,9}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) }, "query"), async (req, res) => {
  await u.localHelper.mediaOutput(req, res);
  res.json(success());
});
