import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const inputSchema = z.strictObject({
  directory: z.string().min(1).max(4096),
  source: z.string().min(1).max(4096),
  output: z.string().min(1).max(4096).regex(/\.srt$/i),
  model: z.enum(u.whisper.whisperModels).optional(),
  language: z.string().trim().max(32).regex(/^(?:[a-zA-Z][a-zA-Z -]*)?$/).optional()
    .transform(value => !value || value.toLowerCase() === "auto" ? undefined : value),
});
const router = Router();
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

export default router.post("/", validateFields(inputSchema.shape), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const input = inputSchema.parse(req.body);
  const directory = await u.workspace.resolveWorkspace(req, input.directory);
  const config = await u.whisper.readWhisperConfig();
  const source = await u.workspaceFile.resolveWorkspacePath(directory, input.source);
  const output = await u.workspaceFile.resolveWorkspacePath(directory, input.output);
  res.json(success(await u.whisper.startWhisper({
    directory, sourcePath: source.path, outputPath: output.path,
    model: input.model ?? config.defaultModel, language: input.language,
  })));
});
