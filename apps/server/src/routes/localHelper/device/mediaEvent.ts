import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ mediaId: z.uuid(), event: z.strictObject({
  event: z.enum(["progress", "start", "codecData", "filenames"]), args: z.array(z.json()).max(20) }) }), async (req, res) => {
  await u.localHelper.mediaEvent(req);
  res.json(success());
});
