import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";

export default Router().get("/", validateFields({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }, "query"), async (req, res) => {
  await u.localHelper.downloadUpdate(req, res);
});
