import { createHash } from "node:crypto";
import { z } from "zod";
import { estimateTokens, type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CanvasContext, SkillDocument } from "@toonflow/tools-scaffold/runtime";
import { createSkillContext } from "@/agent/skills";

const documentSchema = z.strictObject({ name: z.enum(["workflow", "canvas"]), path: z.string().min(1).max(4096) });
const requirementsSchema = z.array(documentSchema).max(16);
const documentResultSchema = documentSchema.extend({ scope: z.enum(["workspace", "global"]), content: z.string() });
type RequiredDocument = z.infer<typeof documentSchema>;
const canvasReads = new Set(["getCanvas", "findCanvasNodes", "getCanvasNodes", "getCanvasEdges", "getNodeTools", "selectNodes", "fitCanvas"]);
const canvasChanges = new Set(["addCanvas", "switchCanvas", "renameCanvas", "addNode", "addMediaNodes", "deleteNodes", "moveNodes", "renameNodes", "connectNodes", "deleteEdges", "arrangeCanvas"]);

export function installSkillExecution(session: AgentSession, cwd: string, tools: ToolDefinition[], canvas?: CanvasContext, task = "", signal?: AbortSignal) {
  const skills = createSkillContext(cwd);
  const operator = tools.find(tool => tool.name === "skillOperator");
  const actions = (operator?.parameters as { properties?: { action?: { enum?: string[] } } } | undefined)?.properties?.action?.enum;
  const canRead = operator ? actions?.includes("read") === true : tools.some(tool => tool.name === "read");
  const required = new Map<string, RequiredDocument>();
  const sent = new Map<string, string>();
  let restored = false;
  let lastRevision = "";
  const key = (document: RequiredDocument) => `${document.name}/${document.path}`;

  function restore() {
    if (restored) return;
    restored = true;
    const entry = session.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "toonflowSkillRequirements");
    const saved = requirementsSchema.safeParse(entry?.type === "custom" ? entry.data : undefined);
    if (saved.success) for (const document of saved.data) required.set(key(document), document);
  }

  async function read(document: RequiredDocument, signal?: AbortSignal) {
    if (!canRead) throw new Error("技能正文读取权限未开启，请启用技能读取后继续制作");
    const skill = skills.list().find(skill => skill.name === document.name);
    if (!skill) throw new Error(`必需技能 ${document.name} 未安装或已禁用`);
    if (skill.disableModelInvocation && !task.includes(`/skill:${skill.name}`)) throw new Error(`技能 ${skill.name} 仅允许用户明确指定后使用`);
    const result = await skills.read({ ...document, scope: skill.scope }, signal);
    return { ...result, revision: createHash("sha256").update(result.content).digest("hex") };
  }

  async function targetNodes(ids: string[], signal?: AbortSignal) {
    if (!canvas || !ids.length) return [];
    const result: { id: string; type?: string; data?: { model?: string } }[] = [];
    const unique = [...new Set(ids)];
    for (let offset = 0; offset < unique.length; offset += 20) {
      const page = await canvas.call({ name: "getCanvasNodes", args: { nodeIds: unique.slice(offset, offset + 20), fields: ["type", "data"], dataKeys: ["model"] } }, signal) as { nodes: typeof result; hasMore?: boolean; truncated?: unknown };
      if (!Array.isArray(page.nodes) || page.hasMore || page.truncated) throw new Error("无法完整核实目标节点，尚未执行修改，请先查询当前画布");
      result.push(...page.nodes);
    }
    return result;
  }

  async function requirements(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<RequiredDocument[]> {
    if (canvasReads.has(name)) return [];
    if (name === "assetOperator" && ["list", "read"].includes(String(args.action))) return [];
    if (name === "nodeTools" && /^node:(?:get|cancel|stop)/.test(String(args.name))) return [];
    const nodeArgs = (name === "nodeTools" ? args.args : args) as Record<string, unknown> | undefined;
    const nodes = name === "addNode" ? [{ type: String(args.type), data: undefined }]
      : name === "nodeTools" ? await targetNodes([String(args.nodeId)], signal)
        : name === "connectNodes" ? await targetNodes((args.connections as { target: string }[]).map(item => item.target), signal) : [];
    const image = ["generateImage", "downloadImage"].includes(name) || nodes.some(node => node.type?.endsWith("imageGenerationNode"));
    const video = name === "generateVideo" || nodes.some(node => node.type?.endsWith("videoGenerationNode"));
    const production = image || video || ["generateAudio", "write", "edit", "assetOperator"].includes(name)
      || name === "nodeTools" || name === "addNode";
    if (!production) return canvasChanges.has(name) && !required.has("workflow/SKILL.md") ? [{ name: "canvas", path: "SKILL.md" }] : [];
    const result: RequiredDocument[] = [{ name: "workflow", path: "SKILL.md" }, { name: "workflow", path: "references/canvasExecution.md" }];
    if (image || name === "assetOperator") result.push({ name: "workflow", path: "references/assets.md" });
    const modelIds = [nodeArgs?.modelId, ...nodes.flatMap(node => {
      try { return [JSON.parse(node.data?.model ?? "[]")[1]]; } catch { return []; }
    })];
    if (video && modelIds.some(id => typeof id === "string" && /^(?:yixian-h3-|u06$)/.test(id))) result.push({ name: "workflow", path: "references/h3Director.md" });
    return result;
  }

  const beforeToolCall = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async input => {
    const previous = await beforeToolCall?.(input);
    if (previous?.block) return previous;
    restore();
    const documents = await requirements(input.toolCall.name, input.args as Record<string, unknown>, signal);
    if (!documents.length) return previous;
    try {
      let changed = false;
      const missing: string[] = [];
      for (const document of documents) {
        const current = await read(document, signal);
        if (!required.has(key(document))) { required.set(key(document), document); changed = true; }
        if (sent.get(key(document)) !== current.revision) missing.push(key(document));
      }
      if (changed) session.sessionManager.appendCustomEntry("toonflowSkillRequirements", [...required.values()]);
      if (missing.length) throw new Error(`必需技能尚未进入当前模型请求：${missing.join("、")}。本次操作未执行；运行时将在紧接着的模型请求中补齐正文。正文就绪后应在本轮重新核对并继续已授权操作，无需用户再次发送继续`);
      if (input.toolCall.name === "generateVideo") {
        const args = input.args as { modelId?: string; prompt?: string; images?: unknown[]; referenceImageUrls?: unknown[] };
        if (args.modelId?.startsWith("yixian-h3-")) {
          const prompt = args.prompt ?? "";
          if (["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"].some(section => !new RegExp(`(?:^|\\n)\\s*${section}\\s*:`).test(prompt))) throw new Error("H3 直接生成同样需要技能规定的六段正文，不能通过直接媒体工具绕过节点提示词要求");
          const images = (args.images?.length ?? 0) + (args.referenceImageUrls?.length ?? 0);
          for (let index = 1; index <= images; index++) if (!prompt.includes(`<Picture ${index}>`)) throw new Error(`参考 <Picture ${index}> 尚未说明用途，请绑定真实素材后再生成`);
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "技能装载失败";
      session.sessionManager.appendCustomEntry("toonflowSkillBlocked", { tool: input.toolCall.name, reason });
      return { block: true, reason };
    }
    return previous;
  };

  const streamFunction = session.agent.streamFunction;
  session.agent.streamFunction = async (model, context, options) => {
    if (session.isCompacting) return streamFunction(model, context, options);
    restore();
    const provided = new Map<string, z.infer<typeof documentResultSchema>>();
    let changed = false;
    for (const message of context.messages) {
      if (message.role !== "toolResult" || message.toolName !== "skillOperator" || message.isError) continue;
      for (const part of message.content) {
        if (part.type !== "text") continue;
        try {
          const document = documentResultSchema.safeParse(JSON.parse(part.text));
          if (!document.success) continue;
          provided.set(key(document.data), document.data);
          if (!required.has(key(document.data))) {
            required.set(key(document.data), { name: document.data.name, path: document.data.path });
            changed = true;
          }
        } catch { /* 非技能正文的工具结果不作为读取凭证。 */ }
      }
    }
    if (changed) session.sessionManager.appendCustomEntry("toonflowSkillRequirements", [...required.values()]);
    const documents: (SkillDocument & { revision: string; inContext: boolean })[] = [];
    const unavailable: string[] = [];
    sent.clear();
    for (const document of required.values()) {
      try {
        const current = await read(document, options?.signal);
        const previous = provided.get(key(document));
        documents.push({ ...current, inContext: previous?.scope === current.scope && previous.content === current.content });
      }
      catch (error) { unavailable.push(`${key(document)}：${error instanceof Error ? error.message : "读取失败"}`); }
    }
    if (!documents.length && !unavailable.length) return streamFunction(model, context, options);
    const prompt = ["## 本次制作必需技能\n本次请求中已完整提供下列可用技能：正文来自先前 skillOperator 的完整读取结果或下方运行时装载，均已核对当前启用文件的内容与范围。按用户本次授权与当前阶段执行；不能以已读代替实际完成。此前仅因缺少技能正文被拦截的操作没有执行，相关正文就绪后应在本轮重新核对并继续，不要等待用户再次发送继续。不可用项仍禁止执行。",
      ...documents.map(document => `### ${document.name}/${document.path}（${document.scope}，SHA-256 ${document.revision}）\n${document.inContext ? "完整正文已在当前请求的 skillOperator 读取结果中提供。" : document.content}`),
      ...unavailable.map(error => `必需技能暂不可用：${error}。相关制作操作仍被拦截，可继续查询和说明缺项。`),
    ].join("\n\n");
    const systemPrompt = [context.systemPrompt, prompt].filter(Boolean).join("\n\n");
    const tokens = estimateTokens({ role: "user", content: systemPrompt, timestamp: Date.now() })
      + context.messages.reduce((total, message) => total + estimateTokens(message), 0);
    if (tokens + model.maxTokens >= model.contextWindow) throw new Error("必需技能与当前对话超过模型上下文预算，已保留原文且未发送请求；请整理对话后继续，不能截断技能后执行制作");
    for (const document of documents) sent.set(`${document.name}/${document.path}`, document.revision);
    const revisions = documents.map(({ name, scope, path, revision }) => ({ name, scope, path, revision }));
    const revision = JSON.stringify(revisions);
    if (revision !== lastRevision) {
      lastRevision = revision;
      session.sessionManager.appendCustomEntry("toonflowSkillsLoaded", revisions);
    }
    // ACT: 仅认可当前请求中与启用文件一致的完整工具正文；压缩或文件变化后补载，摘要和旧读取记录不作凭证。
    return streamFunction(model, { ...context, systemPrompt }, options);
  };
}
