import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().get("/", validateFields({
  directory: z.string().min(1).max(4096), sessionFile: z.string().regex(/^[\w-]+\.jsonl$/), page: z.enum(["true"]).optional(), before: z.string().min(1).max(256).optional(),
  userId: z.coerce.number().int().positive().optional(),
}, "query"), async (req, res) => {
  const { directory, sessionFile } = req.query as { directory: string; sessionFile: string };
  const { directory: cwd, path } = await u.workspaceFile.resolveAgentRead(req, directory, `sessions/${sessionFile}`, req.query.userId === undefined ? undefined : Number(req.query.userId));
  res.set("Cache-Control", "no-store").json(success(req.query.page === "true" ? await u.agent.getAgentSessionPage(cwd, path, req.query.before as string | undefined) : await u.agent.getAgentSession(cwd, path)));
});
