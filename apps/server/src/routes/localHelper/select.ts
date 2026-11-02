import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";

export default Router().put("/", validateFields({ id: z.uuid().nullable() }), async (req, res) => {
  await u.localHelper.selectDevice(req.body.id);
  res.json(success());
});
