import { Router } from "express";
import { subtitleReportSchema } from "@toonflow/local-helper/subtitleProtocol";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields(subtitleReportSchema.shape), async (req, res) => {
  res.json(success(await u.whisper.subtitleEvent(req)));
});
