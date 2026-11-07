import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().min(1).max(4096),
  revision: z.string().regex(/^[a-f0-9]{64}$/), changes: z.array(u.canvasSync.changeSchema).max(20000),
  deletedNodes: u.canvasSync.canvasSchema.shape.nodes.max(20000).optional(), deletedEdges: u.canvasSync.canvasSchema.shape.edges.max(20000).optional() }), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  const result = await u.canvasSync.saveCanvas(directory, req.body.path, req.body.revision, req.body.changes, req.body.deletedNodes, req.body.deletedEdges);
  if (result.conflict) res.status(409).json(error(result.message ?? "同一处内容存在不同修改，请合并后保存", { code: "ECANVASCONFLICT", ...result }, 409));
  else res.json(success(result));
});
