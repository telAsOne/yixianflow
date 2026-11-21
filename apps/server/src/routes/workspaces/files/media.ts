import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { sendFile } from "@/utils/fileHttp";

export default Router().get("/", validateFields({ token: z.string().min(1).max(16384), preview: z.enum(["512", "1024", "canvas"]).optional() }, "query"), async (req, res, next) => {
  const media = await u.mediaAccess.resolveMediaAccess(req, req.query.token as string);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once("close", cancel);
  try {
    const preview = req.query.preview;
    const canvas = preview === "canvas";
    const path = preview ? await u.mediaPreviews.mediaPreview(media.path, media.revision, media.mimeType, preview === "1024" ? 1024 : 512, controller.signal, canvas) : media.path;
    if (canvas) res.set("Cache-Control", "private, no-cache");
    if (!path) { res.status(204).end(); return; }
    res.set({ "Cache-Control": "private, no-cache", "Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff" });
    if (path === media.path) res.type(media.mimeType);
    await sendFile(res, path, { dotfiles: "allow" }, error => { if (error) next(error); });
  } finally { res.off("close", cancel); }
});
