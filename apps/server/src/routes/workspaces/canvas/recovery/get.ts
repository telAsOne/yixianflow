import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().get("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().min(1).max(4096), sessionId: z.uuid().optional() }, "query"), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  await u.workspaceFile.resolveWorkspacePath(directory, req.query.path as string, true);
  const device = u.mobileLink.getMobileLinkDevice(req);
  const author = device?.id ?? req.query.sessionId as string | undefined ?? "host";
  res.set("Cache-Control", "no-store").json(success(await u.canvasSync.readRecovery(directory, req.query.path as string, author, !device && req.query.sessionId ? "host" : undefined)));
});
