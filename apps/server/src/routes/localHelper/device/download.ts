import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";

export default Router().get("/", validateFields({ id: z.uuid(), index: z.coerce.number().int().min(0).max(19) }, "query"), async (req, res) => {
  await u.localHelper.downloadFile(req, res);
});
