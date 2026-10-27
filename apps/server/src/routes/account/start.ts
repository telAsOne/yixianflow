import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { localOnly, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", localOnly("请在 Toonflow 所在电脑登录"), validateFields({ screen: z.enum(["signin", "signup"]) }), (req, res) => {
  u.mcpControl.assertAppRequest(req);
  res.set("Cache-Control", "no-store");
  const authorization = u.account.startLogin(req.socket.localPort!, req.body.screen);
  const browserOpened = !!req.app.locals.desktop;
  if (browserOpened && !u.desktop.getDesktopRuntime(req).openExternal(authorization.url)) {
    throw new Error("请检查默认浏览器设置后重试。");
  }
  res.json(success({ ...authorization, browserOpened }));
});
