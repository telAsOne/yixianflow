import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().delete("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().min(1).max(4096), sessionId: z.uuid().optional() }), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  await u.workspaceFile.resolveWorkspacePath(directory, req.body.path, true);
  await u.canvasSync.removeRecovery(directory, req.body.path, u.mobileLink.getMobileLinkDevice(req)?.id ?? req.body.sessionId ?? "host");
  res.json(success());
});
