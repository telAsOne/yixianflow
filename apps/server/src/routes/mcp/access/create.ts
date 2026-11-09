import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const fields = z.strictObject({ projectId: z.uuid(), name: z.string().trim().min(1).max(100), permission: z.enum(["read", "edit"]),
  scopes: z.array(u.mcpAccess.scopeSchema).max(5).default([]), deviceId: z.uuid().optional() });

export default Router().post("/", validateFields(fields.shape), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const input = fields.parse(req.body);
  res.set("Cache-Control", "no-store").json(success(await u.mcpAccess.createWebMcpAccess(input.projectId, input.name, input.permission, input.scopes, input.deviceId)));
});
