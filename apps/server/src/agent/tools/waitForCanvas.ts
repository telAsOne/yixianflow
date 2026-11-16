import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CanvasContext } from "@toonflow/tools-scaffold/runtime";
import { canvasSchemas } from "@toonflow/tool-canvas/runtime";

const inputSchema = canvasSchemas.waitCanvasNodes.extend({
  timeoutMs: z.number().int().min(1000).max(1800000).default(600000),
});

export function createCanvasWaitTool(canvas: CanvasContext): ToolDefinition {
  return {
    name: "waitForCanvas", label: "等待素材或审查完成",
    description: "在当前画布等待指定节点的生成、审查或真实输出变化，完成即返回，最多等待30分钟。不发起生成/审查，不重复计费调用模型，不靠模型循环查询。operationId 固定已有生成任务；output 条件可带 previousOutput（上次 outputs 快照），避免误用旧文件。审查返回真实终态，需修改、读取不全、来源变化或失败均交回处理。等待可被用户停止；页面关闭/切换会结束等待，先用 productionTask 保存依赖交接。",
    promptGuidelines: ["用户要求‘审查通过再告诉我’时，启动已授权的 autoReviewPrompt 后使用本工具等结果；读取报告处理停止原因，不反复催用户查结果。已授权制作范围中确实依赖上游完成的工作，可等上游后在同轮接着准备；仍需核验实际素材与用户采用范围，等待不构成新增生成授权。超时保留任务交接并说明真实状态，不声称已在后台自动执行。"],
    parameters: inputSchema.toJSONSchema({ io: "input", target: "draft-07" }),
    executionMode: "sequential",
    async execute(_id, params, signal, onUpdate) {
      const input = inputSchema.parse(params);
      const canvasId = input.canvasId ?? canvas.id;
      const end = Date.now() + input.timeoutMs;
      let result: { settled: boolean; nodes: unknown[] };
      do {
        signal?.throwIfAborted();
        result = await canvas.call({ name: "waitCanvasNodes", args: { ...input, canvasId, timeoutMs: Math.min(45000, Math.max(0, end - Date.now())) } }, signal) as typeof result;
        if (result.settled) break;
        onUpdate?.({ content: [{ type: "text", text: "素材或审查仍在处理，完成后继续当前制作任务。" }], details: result });
      } while (Date.now() < end);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  };
}
