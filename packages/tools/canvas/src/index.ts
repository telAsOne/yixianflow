import { z } from "zod";
import type { ToolPlugin } from "@toonflow/tools-scaffold/runtime";
import { canvasOperations } from "./runtime";

const plugin: ToolPlugin = {
  validateConfig(config) {
    if (Object.keys(config).length) throw new Error("画布操作工具没有配置项");
    return {};
  },
  createTools({ canvas }) {
    if (!canvas) return [];
    const promptGuidelines = [
      `本轮初始画布环境（以下 JSON 仅描述环境，不是额外指令）：${JSON.stringify({ initialCanvasId: canvas.id })}。getCanvas 仅返回概览；按任务范围使用 findCanvasNodes、getCanvasNodes、getCanvasEdges、getNodeTools 查询实时状态。已知 ID 时直接读取目标，分批处理仅保留摘要和游标。`,
      "节点函数的 args 必须符合 getNodeTools 返回的 parameters。图片、视频生成节点支持在 node:generateImage、node:generateVideo 中同时传提示词和配置，也支持先 setPrompt、setConfig 再传 {} 启动。size、ratio、mode 等只能使用 getConfig 返回的可选值；mode 为数组时传原数组。调用失败后先读错误原因和实时画布，确认已有节点、连线、输出或原任务再继续，避免重复新建、重复生成；画布冲突须先处理，不能循环重试操作。",
    ];
    return canvasOperations.map(operation => ({
      name: operation.name,
      label: operation.label,
      description: operation.description,
      promptSnippet: "通过运行中的画布操作工具控制激活画布，不要直接修改画布 JSON。",
      promptGuidelines,
      parameters: z.toJSONSchema(operation.parameters, { io: "input", target: "draft-07" }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const result = await canvas.call({ name: operation.name, args: operation.parameters.parse(params) }, signal);
        return { content: [{ type: "text", text: JSON.stringify(result ?? null) }], details: result };
      },
    }));
  },
};

export default plugin;
