import { resolve } from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  root: resolve(import.meta.dirname, "ui"),
  base: "./",
  plugins: [vue()],
  css: { postcss: { plugins: [] } },
  build: { outDir: resolve(process.env.helperUiOutput || resolve(import.meta.dirname, "../../build/localHelperUi")), emptyOutDir: true },
});
