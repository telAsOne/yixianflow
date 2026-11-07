import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";

export default Router().get("/", validateFields({ operationId: z.uuid() }, "query"), async (req, res) => {
  await u.whisper.subtitleInput(req, res);
});
