import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { relative, sep } from "node:path";
import { requireWebAccount } from "@/lib/webContext";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { getAssetsDirectory } from "@/utils/assets";
import {
  lockWorkspaceFiles,
  protectWorkspaceRoot,
  resolveWorkspaceFile,
  resolveWorkspacePath,
} from "@/utils/workspace/files";
import { notifyFileChange } from "@/utils/workspace/canvasSync";
import {
  cancelObjectUpload,
  completeObjectUpload,
  initObjectUpload,
  objectTransferAvailable,
  readObjectUpload,
} from "./objectTransfer";

export function createObjectTransferRouter(
  scope: "workspace" | "assets",
  operation: "get" | "init" | "complete" | "cancel",
) {
  const router = Router();
  async function target(req: Request, directory: string, path: string) {
    const resolved =
      scope === "workspace"
        ? await resolveWorkspaceFile(req, directory, path)
        : await resolveWorkspacePath(await getAssetsDirectory(), path);
    protectWorkspaceRoot(resolved.directory, resolved.path);
    return resolved;
  }
  if (operation === "get")
    router.get("/", async (_req, res) => {
      res.set("Cache-Control", "private, no-store").json(
        success({
          direct_upload: await objectTransferAvailable(),
          protocol: "worker-v1",
          part_size: 64 * 1024 * 1024,
          max_file_bytes: (scope === "assets" ? 100 : 512) * 1024 * 1024,
        }),
      );
    });
  if (operation === "init")
    router.post(
      "/",
      validateFields({
        directory: z.string().max(4096).optional(),
        path: z.string().min(1).max(4096),
        size: z
          .number()
          .int()
          .positive()
          .max(512 * 1024 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        idempotencyKey: z.string().min(8).max(128),
        exclusive: z.boolean().optional(),
        expectedRevision: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      }),
      async (req, res) => {
        const resolved = await target(req, req.body.directory ?? "", req.body.path);
        const release = lockWorkspaceFiles([resolved.path]);
        try {
          const view = await initObjectUpload(
            requireWebAccount().user.id,
            resolved.path,
            scope,
            req.body.directory ?? "",
            relative(resolved.directory, resolved.path).split(sep).join("/"),
            req.body,
          );
          res.set("Cache-Control", "private, no-store").json(success(view));
        } finally {
          release();
        }
      },
    );
  if (operation === "complete")
    router.post(
      "/",
      validateFields({
        uploadId: z.uuid(),
        parts: z
          .array(
            z.object({
              part_number: z.number().int().min(1).max(16),
              etag: z.string().min(1).max(128),
            }),
          )
          .max(16)
          .optional(),
      }),
      async (req, res) => {
        const userId = requireWebAccount().user.id;
        const session = await readObjectUpload(userId, req.body.uploadId);
        if (session.scope !== scope)
          throw Object.assign(new Error("上传会话不存在"), { status: 404 });
        const resolved = await target(req, session.directory, session.relativePath);
        const release = lockWorkspaceFiles([resolved.path]);
        const controller = new AbortController();
        const cancel = () => controller.abort();
        res.once("close", cancel);
        try {
          const result = await completeObjectUpload(
            userId,
            session.id,
            resolved.path,
            req.body.parts ?? [],
            controller.signal,
          );
          if (scope === "workspace") notifyFileChange(resolved.directory, resolved.path);
          res.json(success(result));
        } finally {
          release();
          res.off("close", cancel);
        }
      },
    );
  if (operation === "cancel")
    router.delete("/", validateFields({ uploadId: z.uuid() }, "query"), async (req, res) => {
      const userId = requireWebAccount().user.id;
      const session = await readObjectUpload(userId, String(req.query.uploadId));
      if (session.scope !== scope)
        throw Object.assign(new Error("上传会话不存在"), { status: 404 });
      await cancelObjectUpload(userId, session.id);
      res.json(success({ cancelled: true }));
    });
  return router;
}
