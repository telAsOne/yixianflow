import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ text: z.string().min(1).max(24000) }), async (req, res) => {
  res.json(success(await u.localHelper.chat(req, true)));
});
