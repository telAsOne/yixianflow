import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import u from "@/utils";
import { error } from "./responseFormat";
import { t, translateMessage, validationOptions } from "./i18n";

export function sameOriginOnly(req: Request, res: Response, next: NextFunction) {
  const origin = req.get("origin");
  // ACT: 设备互联网关单独校验配对码或设备令牌；代理会改写 Host，来源检查留给网关。
  if (origin !== undefined && !u.mobileLink.isMobileLinkGatewayRequest(req)
    && (!URL.canParse(origin) || new URL(origin).host !== req.get("host"))) {
    return void res.status(403).json(error("页面来源与服务地址不一致", null, 403));
  }
  next();
}

export function allowedHosts(hosts: string[]) {
  const names = new Set(hosts.map(host => host.toLowerCase()));
  return (req: Request, res: Response, next: NextFunction) => {
    if (!u.mobileLink.isMobileLinkGatewayRequest(req) && !names.has(req.hostname.toLowerCase())) {
      return void res.status(403).json(error("页面来源与服务地址不一致", null, 403));
    }
    next();
  };
}

export function localOnly(message: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!u.workspace.canManagePlugins(req)) return void res.status(403).json(error(message, null, 403));
    next();
  };
}

export function validateFields(
  shape: Record<string, z.ZodType>,
  source: "body" | "query" | "params" = "body", // 默认校验 body
) {
  const schema = z.object(shape);

  return (req: Request, res: Response, next: NextFunction) => {
    const data = req[source];
    const parseResult = schema.safeParse(data, validationOptions());
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map((issue) => t`字段 ${issue.path.join(".")} ${translateMessage(issue.message)}`);
      console.error(errors);
      return res.status(400).json(error("参数错误", errors));
    }
    next();
  };
}
