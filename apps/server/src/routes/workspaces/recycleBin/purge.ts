import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().delete("/", validateFields({ directory: z.string().min(1).max(4096), ids: z.array(z.uuid()).min(1).max(1000) }), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  res.json(success(await u.recycleBin.cleanRecycleEntries(directory, req.body.ids, req)));
});
