import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { isWebMode } from "@/lib/webContext";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  clientId: z.uuid(),
  sessionId: z.uuid(),
  panel: z.enum(["canvas", "document"]),
  path: z.string().max(4096),
  active: z.boolean(),
  visible: z.boolean(),
  leave: z.boolean().optional(),
}), async (req, res) => {
  if (isWebMode()) return void res.sendStatus(404);
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  res.set("Cache-Control", "no-store").json(success(u.workspacePresence.updatePresence(req, directory, req.body)));
});
