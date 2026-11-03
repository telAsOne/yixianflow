import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { localOnly, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { isWebMode } from "@/lib/webContext";

export default Router().post("/", (req, res, next) => isWebMode() ? next() : localOnly("请在 Toonflow 所在电脑登录")(req, res, next), validateFields({ screen: z.enum(["signin", "signup"]) }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  res.set("Cache-Control", "no-store");
  if (isWebMode()) return void res.json(success(await u.webAuth.startWebLogin(req, res, req.body.screen)));
  const authorization = u.account.startLogin(req.socket.localPort!, req.body.screen);
  const browserOpened = !!req.app.locals.desktop;
  if (browserOpened && !u.desktop.getDesktopRuntime(req).openExternal(authorization.url)) {
    throw new Error("请检查默认浏览器设置后重试。");
  }
  res.json(success({ ...authorization, browserOpened }));
});
