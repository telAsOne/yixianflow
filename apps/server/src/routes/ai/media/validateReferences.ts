import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096),
  references: z.array(z.object({ path: z.string().min(1).max(4096), mimeType: z.string().max(100), mediaType: z.enum(["image", "audio", "video"]) })).max(1000),
  files: z.array(z.object({ mimeType: z.string().max(100), size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })).max(1000),
}), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  await u.mediaGeneration.validateReferenceSelection(directory, req.body.references, req.body.files);
  res.json(success());
});
