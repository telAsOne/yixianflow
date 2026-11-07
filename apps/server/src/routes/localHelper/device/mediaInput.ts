import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import u from "@/utils";

export default Router().get("/", validateFields({ mediaId: z.uuid(), index: z.string().regex(/^\d{1,2}$/) }, "query"), async (req, res) => {
  await u.localHelper.mediaInput(req, res);
});
