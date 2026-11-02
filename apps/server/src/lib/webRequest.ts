import type { Request, Response, NextFunction } from "express";
import { isWebMode, webContext } from "@/lib/webContext";
import { readWebSession } from "@/utils/web/auth";
import { getWebOrigin } from "@/utils/web/store";

const publicRoutes = new Set(["GET /api/runtime", "GET /api/account/get", "GET /api/account/callback", "POST /api/account/start", "POST /api/account/logout", "GET /api/settings/get"]);
const privateRoutes = new Set([
  "GET /api/projects/list", "POST /api/projects/create", "PUT /api/projects/rename", "PUT /api/settings/save",
  "GET /api/account/limits", "GET /api/workspaces/check",
  "GET /api/ai/models", "GET /api/ai/media/models",
  "GET /api/nodes/get", "GET /api/nodes/files", "GET /api/ext/list", "GET /api/ext/read",
  "GET /api/tools/get", "GET /api/tools/client", "GET /api/tools/renderers",
  "GET /api/workspaces/files/list", "GET /api/workspaces/files/canvases", "GET /api/workspaces/files/read", "PUT /api/workspaces/files/write",
  "POST /api/workspaces/files/mkdir", "POST /api/workspaces/files/rename", "POST /api/workspaces/files/copy", "DELETE /api/workspaces/files/remove",
  "GET /api/workspaces/files/media", "POST /api/workspaces/files/mediaAccess", "GET /api/workspaces/files/export",
  "GET /api/workspaces/canvas/events", "POST /api/workspaces/canvas/save", "GET /api/workspaces/canvas/recovery/get",
  "POST /api/workspaces/canvas/recovery/save", "DELETE /api/workspaces/canvas/recovery/remove",
]);

export default async function webRequest(req: Request, res: Response, next: NextFunction) {
  if (!isWebMode()) return next();
  if (!/^\/(api|mcp|a2a)(\/|$)/i.test(req.path)) return next();
  res.set("Cache-Control", "no-store");
  const origin = getWebOrigin();
  if (req.get("host")?.toLowerCase() !== new URL(origin).host.toLowerCase())
    throw Object.assign(new Error("页面来源与服务地址不一致"), { status: 403 });
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)
    && (req.get("origin") !== origin || req.get("x-toonflow-workspace") !== "1"))
    throw Object.assign(new Error("页面来源与服务地址不一致"), { status: 403 });
  const route = `${req.method} ${req.path}`;
  const session = await readWebSession(req);
  const expectedUser = req.get("x-yixianflow-user");
  if (expectedUser && session && expectedUser !== String(session.account.user.id))
    throw Object.assign(new Error("账户已切换或登录已过期，请刷新页面后继续"), { status: 409 });
  if (!publicRoutes.has(route) && !session) throw Object.assign(new Error("请先登录逸仙账户"), { status: 401 });
  const personalData = /^\/api\/(projects\/|settings\/|workspaces\/)/.test(req.path) && req.path !== "/api/workspaces/files/media";
  if (session && personalData && !expectedUser) throw Object.assign(new Error("请刷新页面后继续访问个人项目"), { status: 409 });
  // ACT: 第一阶段仅开放完成隔离的私有画布接口；后续逐项接入生成与个人资源。
  if (!publicRoutes.has(route) && !privateRoutes.has(route))
    throw Object.assign(new Error("当前网页版仅开放私有项目与画布编辑"), { status: 403 });
  if (session) return webContext.run(session, next);
  next();
}
