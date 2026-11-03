import { lstat } from "@toonflow/file";
import { sendFile } from "@/utils/fileHttp";
import { basename, extname } from "node:path";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";

const router = Router();

export default router.get("/", validateFields({ path: z.string().min(1).max(4096), download: z.literal("true").optional(), preview: z.literal("512").optional() }, "query"), async (req, res, next) => {
  const root = await u.assets.getAssetsDirectory();
  const { directory, path } = await u.workspaceFile.resolveWorkspacePath(root, req.query.path as string);
  u.workspaceFile.protectWorkspaceRoot(directory, path);
  const info = await lstat(path);
  if (!info.isFile()) throw Object.assign(new Error("只能读取文件"), { status: 400 });
  if (req.query.download === "true") res.attachment(basename(path));
  res.set({ "Cache-Control": "private, no-cache", "Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff" });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once("close", cancel);
  try {
    const mimeType = res.type(extname(path)).get("Content-Type")!.split(";")[0]!;
    const preview = req.query.preview && req.query.download !== "true"
      ? await u.mediaPreviews.mediaPreview(path, `${info.size}:${info.mtimeMs}:${info.ctimeMs}`, mimeType, 512, controller.signal) : path;
    if (!preview) { res.status(204).end(); return; }
    res.type(extname(preview));
    await sendFile(res, preview, { dotfiles: "allow" }, err => { if (err) next(err); });
  } finally { res.off("close", cancel); }
});
