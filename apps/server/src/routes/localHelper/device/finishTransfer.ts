import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ id: z.uuid() }), async (req, res) => {
  await u.localHelper.finishTransfer(req, req.body.id);
  res.json(success());
});
