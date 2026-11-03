import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ id: z.uuid(), index: z.coerce.number().int().min(0).max(19) }, "query"), async (req, res) => {
  await u.localHelper.uploadFile(req);
  res.json(success());
});
