import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const inputSchema = z.strictObject({ directory: z.string().min(1).max(4096) });
const router = Router();
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

export default router.get("/", validateFields(inputSchema.shape, "query"), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const input = inputSchema.parse(req.query);
  await u.workspace.resolveWorkspace(req, input.directory);
  const config = await u.whisper.readWhisperConfig();
  res.json(success({ ...await u.whisper.checkWhisper(), defaultModel: config.defaultModel }));
});
