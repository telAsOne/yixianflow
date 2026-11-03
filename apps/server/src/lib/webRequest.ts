import type { Request, Response, NextFunction } from "express";
import { isWebMode, webContext } from "@/lib/webContext";
import { readWebSession } from "@/utils/web/auth";
import { getWebOrigin } from "@/utils/web/store";
import { refreshConfig } from "@/utils/account";

const publicRoutes = new Set(["GET /api/runtime", "GET /api/account/get", "GET /api/account/callback", "POST /api/account/start", "POST /api/account/logout", "GET /api/settings/get"]);
const helperDeviceRoutes = new Set([
  "POST /api/localHelper/device/register", "POST /api/localHelper/device/poll", "POST /api/localHelper/device/result", "POST /api/localHelper/device/revoke",
  "POST /api/localHelper/device/chat", "GET /api/localHelper/device/projects", "POST /api/localHelper/device/transfer",
  "POST /api/localHelper/device/upload", "GET /api/localHelper/device/download", "POST /api/localHelper/device/finishTransfer",
]);
const privateRoutes = new Set([
  "GET /api/localHelper/status", "GET /api/localHelper/download", "POST /api/localHelper/bind", "PUT /api/localHelper/select", "DELETE /api/localHelper/revoke",
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
  "GET /api/account/cameraPresets", "POST /api/account/refreshModels", "POST /api/workspaces/selectDirectory", "GET /api/workspaces/list",
  "POST /api/workspaces/files/importImage", "POST /api/workspaces/presence/update",
  "GET /api/settings/systemPrompt", "GET /api/settings/personalization/get", "PUT /api/settings/personalization/save",
  "GET /api/providers/media/list", "GET /api/ffmpeg/status", "POST /api/ffmpeg/execute", "GET /api/ffmpeg/progress",
]);
const creativeRoutes = /^\/api\/(ai|agent|assets|singleAgent|whisper)(\/|$)/;
const pluginRoutes = /^\/api\/(nodes|tools|ext|skills|agents)(\/|$)/;

export default async function webRequest(req: Request, res: Response, next: NextFunction) {
  if (!isWebMode()) return next();
  if (!/^\/(api|mcp|a2a)(\/|$)/i.test(req.path)) return next();
  res.set("Cache-Control", "no-store");
  const origin = getWebOrigin();
  if (req.get("host")?.toLowerCase() !== new URL(origin).host.toLowerCase())
    throw Object.assign(new Error("页面来源与服务地址不一致"), { status: 403 });
  // 助手主动连接，每个设备接口独立校验 Bearer；不使用浏览器 Cookie 或跨域权限。
  if (helperDeviceRoutes.has(`${req.method} ${req.path}`)) return next();
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)
    && (req.get("origin") !== origin || req.get("x-toonflow-workspace") !== "1"))
    throw Object.assign(new Error("页面来源与服务地址不一致"), { status: 403 });
  const route = `${req.method} ${req.path}`;
  // 平台暂时不可用时公开接口按未登录处理，页面仍可启动和退出；其他接口照常拒绝。
  const session = await readWebSession(req).catch((error: { status?: number }) => {
    if (error.status === 503 && publicRoutes.has(route)) return undefined;
    throw error;
  });
  const expectedUser = req.get("x-yixianflow-user") ?? (req.path === "/api/assets/read" && typeof req.query.userId === "string" ? req.query.userId : undefined);
  if (expectedUser && session && expectedUser !== String(session.account.user.id))
    throw Object.assign(new Error("账户已切换或登录已过期，请刷新页面后继续"), { status: 409 });
  if (!publicRoutes.has(route) && !session) throw Object.assign(new Error("请先登录逸仙账户"), { status: 401 });
  const personalData = /^\/api\/(projects|settings|workspaces|ai|agent|assets|singleAgent|whisper|localHelper)(\/|$)/.test(req.path)
    && !["/api/workspaces/files/media", "/api/localHelper/download"].includes(req.path);
  if (session && personalData && !expectedUser) throw Object.assign(new Error("请刷新页面后继续访问个人项目"), { status: 409 });
  if (!publicRoutes.has(route) && !privateRoutes.has(route) && !creativeRoutes.test(req.path) && !pluginRoutes.test(req.path))
    throw Object.assign(new Error("此能力需要桌面客户端或独立的服务配置"), { status: 403 });
  if (session) return webContext.run(session, async () => {
    if (pluginRoutes.test(req.path) && req.method !== "GET" && session.account.user.role! < 100)
      throw Object.assign(new Error("仅超级管理员可以修改服务器插件"), { status: 403 });
    // 模型同步失败由账户状态展示，保留项目编辑与原有已保存配置。
    await refreshConfig(false).catch(() => {});
    next();
  });
  next();
}
