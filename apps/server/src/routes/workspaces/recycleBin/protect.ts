import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().put("/", validateFields({ directory: z.string().min(1).max(4096), sessionId: z.uuid(),
  roots: z.array(z.string().regex(/^assets\/[^/\\\x00-\x1f]{1,500}$/)).max(20000) }), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  u.recycleBin.pinRecycleHistory(directory, req.body.sessionId, req.body.roots);
  res.json(success());
});
