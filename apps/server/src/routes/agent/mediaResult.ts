import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

const schema = z.object({
  directory: z.string().min(1), callId: z.uuid(), error: z.string().min(1).max(8000).optional(),
  result: z.object({
    revision: z.string().min(1),
    metadata: z.object({ duration: z.number().finite().nonnegative(), width: z.number().positive().optional(), height: z.number().positive().optional() }),
    frames: z.array(z.object({ requestedSeconds: z.number().finite().nonnegative(), seconds: z.number().finite().nonnegative(),
      timestampKind: z.enum(["decodedFrame", "browserSeek"]), path: z.string().min(1), mimeType: z.literal("image/jpeg"), width: z.number().positive(), height: z.number().positive() })),
  }).optional(),
});

export default Router().post("/", validateFields(schema.shape), async (req, res) => {
  const { directory, callId, ...response } = schema.parse(req.body);
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  u.mediaBridge.finishBrowserMediaRead(cwd, callId, response);
  res.json(success());
});
