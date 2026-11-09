import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";

export default Router().get("/", validateFields({
  id: z.string().regex(/^[^\s{}]{1,128}$/),
  kind: z.enum(["cover", "motion", "video"]),
  version: z.string().regex(/^[a-f0-9]{64}\.(?:jpg|png|webp|gif|mp4|webm)$/),
}, "query"), async (req, res) => {
  // Image/video elements send the same-origin Referer and the existing web session.
  // A desktop request must also originate from the local application page.
  u.mcpControl.getAppOrigin(req);
  const account = u.account.requireAccount();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once("close", cancel);
  try {
    const headers = new Headers();
    const range = req.get("range");
    if (range) {
      if (!/^bytes=\d*-\d*$/.test(range)) { res.sendStatus(416); return; }
      headers.set("Range", range);
    }
    const route = `/v1/toonflow/camera-presets/${encodeURIComponent(req.query.id as string)}/media/${req.query.kind}`;
    const url = new URL(route, u.account.getBaseUrl());
    url.searchParams.set("v", req.query.version as string);
    const upstream = await u.account.platformFetch(url, { headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) });
    if (u.account.getAccount() !== account) throw Object.assign(new Error("账户已切换，请重新发起操作"), { status: 401 });
    if (!upstream.ok || !upstream.body) { res.sendStatus(upstream.status); return; }
    const mime = upstream.headers.get("content-type") ?? "";
    if (!/^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm))(;|$)/.test(mime)) throw Object.assign(new Error("运镜预览格式无效"), { status: 502 });
    res.status(upstream.status).set({ "Content-Type": mime, "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff" });
    for (const name of ["content-length", "content-range", "accept-ranges", "etag"]) {
      const value = upstream.headers.get(name);
      if (value) res.set(name, value);
    }
    await pipeline(Readable.fromWeb(upstream.body as NodeReadableStream), res);
  } finally { res.off("close", cancel); }
});
