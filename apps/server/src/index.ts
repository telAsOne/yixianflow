import { resolve } from "node:path";
import { createApp } from "./app";
import packageInfo from "../../../package.json";
import { isWebMode } from "@/lib/webContext";

const startTime = Date.now();
const host = process.env.TOONFLOW_HOST ?? "127.0.0.1";
const port = Number(process.env.TOONFLOW_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("TOONFLOW_PORT 必须是 1 到 65535 之间的整数");
const mcpHost = ["0.0.0.0", "::", "127.0.0.1", "localhost"].includes(host) ? "127.0.0.1" : host;
const mcpAddress = `http://${mcpHost.includes(":") && !mcpHost.startsWith("[") ? `[${mcpHost}]` : mcpHost}:${port}`;
// 源码位于 apps/server/src，生产构建位于 build/server，均从文件位置定位根目录。
const fromSource = import.meta.path.endsWith(".ts");
const appDirectory = resolve(import.meta.dirname, fromSource ? "../../.." : "../..");
const dataDirectory = process.env.TOONFLOW_DATA_DIR ?? resolve(appDirectory, "data");
const app = await createApp({
  webRoot: resolve(appDirectory, "build/web"),
  appVersion: process.env.appVersion ?? packageInfo.version,
  dataDirectory,
  // ACT: 开发代理保留局域网客户端的 Host；生产部署须显式登记可访问的域名或 IP。
  allowedHosts: process.env.NODE_ENV === "dev" ? undefined : ["localhost", "127.0.0.1", "[::1]",
    ...(process.env.TOONFLOW_ALLOWED_HOSTS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean)],
  toolsRoot: resolve(appDirectory, "build/tools"),
  nodesRoot: resolve(appDirectory, "build/nodes"),
  extRoot: resolve(appDirectory, "build/ext"),
  // ACT: 暂不安装内置团队，随团队打包一同恢复。
  // agentsRoot: resolve(appDirectory, "build/agents"),
  providersRoot: resolve(appDirectory, fromSource ? "packages/providers/src" : "build/providers"),
  skillsRoot: resolve(appDirectory, fromSource ? "packages/skills" : "build/skills"),
});
const { initializeMcpRuntime } = await import("./utils/mcp/runtime");
const { startMobileLinkRuntime } = await import("./utils/mobileLink");
app.listen(port, host, async error => {
  if (error) {
    console.error("服务启动失败：", error);
    process.exit(1);
  }
  if (!isWebMode()) {
    await initializeMcpRuntime(app, mcpAddress, resolve(appDirectory, fromSource ? "packages/mcp/src/stdio.ts" : "build/mcp/stdio.js"))
      .catch(error => console.error("MCP 启动失败：", error));
    await startMobileLinkRuntime(app).catch(error => console.error("设备互联启动失败：", error));
  }
  console.log(`[服务启动成功]: http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`);
  console.log(`[启动耗时]: ${(Date.now() - startTime).toFixed(2)}ms`);
});
