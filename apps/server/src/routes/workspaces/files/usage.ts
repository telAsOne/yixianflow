import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().get("/", validateFields({ directory: z.string().min(1).max(4096) }, "query"), async (req, res) => {
  const controller = new AbortController();
  const close = () => controller.abort();
  res.once("close", close);
  try {
    const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
    const usage = await u.workspaceFile.getWorkspaceUsage(directory, controller.signal);
    res.set("Cache-Control", "no-store").json(success(usage));
  } finally { res.off("close", close); }
});
