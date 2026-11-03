import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "@toonflow/file";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import components from "unplugin-vue-components/vite";
import { ElementPlusResolver } from "unplugin-vue-components/resolvers";
import packageInfo from "../../package.json" with { type: "json" };
import postcssConfig from "../../postcss.config.ts";
import { i18nPlugin } from "@toonflow/i18n/vite";

const appVersion = process.env.appVersion ?? packageInfo.version;

const releaseNotes = process.env.releaseNotesFile
  ? JSON.parse(readFileSync(resolve(fileURLToPath(new URL("../../", import.meta.url)), process.env.releaseNotesFile), "utf8")) as { version: string; commit: string; markdown: string } | null
  : null;
if (process.env.releaseNotesFile && (!releaseNotes || releaseNotes.version !== appVersion
  || (process.env.GITHUB_SHA && releaseNotes.commit !== process.env.GITHUB_SHA)
  || typeof releaseNotes.markdown !== "string" || !releaseNotes.markdown.trim())) {
  throw new Error("更新说明与当前版本或源码提交不一致，停止构建。");
}

export default defineConfig({
  base: `${process.env.TOONFLOW_WEB_BASE_PATH || ""}/`,
  css: { postcss: postcssConfig },
  define: {
    "import.meta.env.appVersion": JSON.stringify(appVersion),
    "import.meta.env.releaseNotesVersion": JSON.stringify(releaseNotes?.version ?? ""),
    "import.meta.env.releaseNotesMarkdown": JSON.stringify(releaseNotes?.markdown ?? ""),
  },
  server: {
    proxy: {
      "/mcp": { target: "http://127.0.0.1:3000", changeOrigin: false },
      "/a2a": { target: "http://127.0.0.1:3000", changeOrigin: false },
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: false,
        configure(proxy) {
          proxy.on("proxyReq", (request, incoming) => {
            request.setHeader("x-toonflow-local-client", ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(incoming.socket.remoteAddress ?? "") ? "1" : "0");
          });
        },
      },
    },
  },
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      { find: /^shiki$/, replacement: fileURLToPath(new URL("./src/lib/shiki.ts", import.meta.url)) },
    ],
  },
  build: {
    outDir: "../../build/web",
    emptyOutDir: true,
  },
  plugins: [
    i18nPlugin(),
    vue(),
    components({
      globsExclude: ["src/components/settings/panels/**/*Dialog.vue"],
      dts: "src/types/components.d.ts",
      resolvers: [
        ElementPlusResolver(),
        (name) => {
          if (name.startsWith("Icon")) return { name, from: "@tabler/icons-vue" };
        },
      ],
    }),
  ],
});
