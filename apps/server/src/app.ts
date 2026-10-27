import logger from "morgan";
import express from "express";
import { createHash } from "node:crypto";
import { basename, resolve, sep } from "node:path";
import { readFile } from "@toonflow/file";
import { mediaProviders } from "@toonflow/providers";
import type { Request, Response, NextFunction } from "express";
import buildRoute from "@/core";
import { errorFromCause } from "@/lib/responseFormat";
import desktopRequest from "@/lib/desktop";
import initializePlugins from "@/utils/plugins/initialize";
import { languageRequest, resolveRequestLocale, runWithLocale, setLocaleFallback, translateError, translateMessage } from "@/lib/i18n";
import { detectLocale, normalizeLocale } from "@toonflow/i18n";

const autoInstallProviders = mediaProviders.map(provider => `${provider.id}.ts`);

export async function createApp({
  webRoot,
  appVersion = "",
  dataDirectory,
  toolsRoot,
  nodesRoot,
  extRoot,
  providersRoot,
  skillsRoot,
  agentsRoot,
  pluginRevision,
  allowedHosts: hostnames,
}: {
  webRoot: string;
  appVersion?: string;
  dataDirectory?: string;
  toolsRoot?: string;
  nodesRoot?: string;
  extRoot?: string;
  providersRoot?: string;
  skillsRoot?: string;
  agentsRoot?: string;
  pluginRevision?: string;
  allowedHosts?: string[];
}) {
  // conf 由下方的路由动态加载，必须先确定整个进程共用的数据目录。
  if (dataDirectory) process.env.TOONFLOW_DATA_DIR = resolve(dataDirectory);
  const { default: conf } = await import("@/utils/conf");
  const systemLocale = detectLocale([Intl.DateTimeFormat().resolvedOptions().locale]);
  const readLocale = () => normalizeLocale((conf.get("settings", {}).ui as { language?: unknown } | undefined)?.language) ?? systemLocale;
  let fallbackLocale = readLocale();
  conf.onDidChange("settings", () => { fallbackLocale = readLocale(); });
  setLocaleFallback(() => fallbackLocale);
  if (dataDirectory && toolsRoot)
    await initializePlugins(resolve(dataDirectory, "tools"), toolsRoot, /^[a-z][a-zA-Z0-9]*\.tool\.js$/, pluginRevision);
  if (dataDirectory && nodesRoot) await initializePlugins(resolve(dataDirectory, "nodes"), nodesRoot, /^[a-z][a-zA-Z0-9]*\.umd\.js$/, pluginRevision);
  if (dataDirectory && extRoot) {
    const { default: initializeExt } = await import("@/utils/plugins/initializeExt");
    await initializeExt(resolve(dataDirectory, "ext"), extRoot, pluginRevision);
  }
  // ACT: 同步供应商代码时保留用户编辑的名称、模型列表和独立配置。
  if (dataDirectory && providersRoot) {
    const sourceDirectory = resolve(providersRoot, "media");
    let providerRevision = pluginRevision;
    if (providerRevision === undefined) {
      const hash = createHash("sha256");
      for (const name of autoInstallProviders) {
        const source = await readFile(resolve(sourceDirectory, name)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return Buffer.alloc(0);
          throw error;
        });
        hash.update(name).update("\0").update(source).update("\0");
      }
      providerRevision = hash.digest("hex");
    }
    const { initializeMediaProviders } = await import("@/utils/media/provider");
    await initializeMediaProviders(sourceDirectory, autoInstallProviders, providerRevision);
  }
  // ACT: 技能和团队只补首次安装，保留用户修改。
  if (dataDirectory && skillsRoot) await initializePlugins(resolve(dataDirectory, "skills"), skillsRoot);
  if (dataDirectory && agentsRoot) await initializePlugins(resolve(dataDirectory, "agents"), agentsRoot);
  const app = express();
  app.locals.appVersion = appVersion;

  if (process.env.NODE_ENV === "dev") {
    await buildRoute();
    app.use(logger("dev", { skip: req => req.path === "/api/account/callback" }));
  }
  const { sameOriginOnly, allowedHosts } = await import("@/lib/middleware");
  app.use(languageRequest);
  if (hostnames) app.use(allowedHosts(hostnames));
  app.use(sameOriginOnly);
  app.use("/a2a", express.json({ limit: "2mb" }));
  app.use(["/api/workspaces/files/write", "/api/assets/save"], express.raw({ type: "application/octet-stream", limit: "512mb" }));
  // ACT: 源码、Base64 安装包、画布快照和含媒体的对话保留原上限，其余 JSON 限制为 10 MB。
  app.use([
    "/api/tools/install", "/api/nodes/install", "/api/ext/install", "/api/skills/install", "/api/agents/install",
    "/api/skills/save", "/api/agents/save", "/api/workspaces/canvas/save", "/api/workspaces/canvas/recovery/save",
    "/api/ai/generate", "/api/agent", "/api/singleAgent/toolResult", "/api/mcp/control/result",
  ], express.json({ limit: "100mb" }));
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/desktop", desktopRequest);

  const { initializeAccount } = await import("@/utils/account");
  await initializeAccount(appVersion || process.env.appVersion || "2.0.0");
  const router = await import("@/router");
  router.default(app);
  const [{ createMcpRouter }, { getMcpTools }, { authorizeMcp }, { skillResources }] = await Promise.all([
    import("@toonflow/mcp"),
    import("@/utils/mcp/tools"),
    import("@/utils/mcp/control"),
    import("@/utils/mcp/resources"),
  ]);
  app.use("/mcp", createMcpRouter({ getTools: getMcpTools, authorize: authorizeMcp, resources: skillResources,
    runInRequest: (request, operation) => runWithLocale(resolveRequestLocale(request.get("accept-language")), operation),
    translate: translateMessage,
    translateError,
  }));
  const { createA2aRouter } = await import("@/agent/a2a");
  app.use("/a2a", createA2aRouter());
  const assetsRoot = resolve(webRoot, "assets") + sep;
  app.use(express.static(webRoot, { setHeaders(res, path) {
    if (path.startsWith(assetsRoot) && /-[\w-]{8,}\.[\w]+$/.test(basename(path))) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } }));

  // 错误处理
  app.use((err: Error & { status?: number }, request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) return next(err);
    console.error(err);
    const body = errorFromCause(err);
    response.status(body.code).json(body);
  });

  const { initializeMobileLinkRuntime } = await import("@/utils/mobileLink");
  initializeMobileLinkRuntime(app);
  return app;
}
