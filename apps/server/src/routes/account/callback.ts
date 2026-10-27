import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { getLocale, translateMessage } from "@/lib/i18n";
import { isLocalSocket } from "@/lib/desktop";

export default Router().get("/", async (req, res) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" });
  let status = 200;
  let message = "已登录，请返回 Toonflow";
  try {
    if (!isLocalSocket(req) || req.hostname !== "127.0.0.1") throw new Error("只允许本机接收登录回调");
    const query = z.object({ state: z.string().max(128), code: z.string().max(8192).optional(), error: z.string().max(100).optional() }).parse(req.query);
    await u.account.completeLogin(query.state, query.code, query.error);
    if (query.error === "access_denied") message = "已取消登录，可以返回 Toonflow";
  } catch { status = 400; message = "登录未完成，请返回 Toonflow 查看原因并重新登录"; }
  res.status(status).type("html").send(`<!doctype html><html lang="${getLocale()}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${Bun.escapeHTML(translateMessage("登录逸仙"))}</title><body><h1>${Bun.escapeHTML(translateMessage(message))}</h1></body></html>`);
});
