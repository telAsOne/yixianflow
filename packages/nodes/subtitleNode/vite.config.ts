import { createNodeConfig } from "@toonflow/nodes-scaffold";

export default createNodeConfig({
  name: "subtitleNode",
  displayName: "字幕",
  author: "Toonflow",
  github: "https://github.com/HBAI-Ltd/Toonflow-app",
  configRules: [
    {
      type: "select", field: "defaultModel", title: "默认 Whisper 模型（本地助手执行）", value: "auto",
      options: ["auto", "tiny", "base", "small", "medium", "large", "turbo"].map(value => ({ label: value === "auto" ? "自动推荐（本机资源）" : value, value })),
    },
  ],
}, import.meta.url);
