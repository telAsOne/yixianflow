import type { Request } from "express";
import { helperChatMessage, helperChatRequest, localComputerDescription, localComputerGuidelines, localComputerParameters } from "@toonflow/local-helper/protocol";
import { requireReadyDevice } from "./index";
import { readWebAccount } from "@/utils/web/auth";
import { webContext } from "@/lib/webContext";
import { getSettings } from "@/utils/conf";
import { refreshConfig, platformFetch } from "@/utils/account";
import { getConfiguredModel, streamAi } from "@/utils/ai";
import { z } from "zod";
import { parseSubtitleReview, subtitleReviewInstruction } from "@toonflow/local-helper/subtitleProtocol";

const activeChats = new Set<string>();

export async function chat(req: Request, review = false) {
  const reviewInput = review ? z.object({ text: z.string().min(1).max(24000) }).parse(req.body) : undefined;
  const input = reviewInput ? { messages: [{ role: "user" as const, content: reviewInput.text }] }
    : helperChatRequest.parse(req.body);
  const device = await requireReadyDevice(req);
  const requestKey = `${device.id}:${review ? "subtitle" : "chat"}`;
  if (activeChats.has(requestKey)) throw Object.assign(new Error("本机文本请求正在处理，请稍后重试"), { status: 409 });
  activeChats.add(requestKey);
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.res!.once("close", abort);
  try {
    const account = await readWebAccount(device.ownerId, req.app.locals.appVersion || process.env.appVersion || "2.0.0");
    if (!account) throw Object.assign(new Error("账户已失效，请在网页重新登录"), { status: 401 });
    return await webContext.run({ sessionHash: "", ...account }, async () => {
      await refreshConfig(false);
      const selection = (getSettings().defaultModels as { text?: { modelId: string } } | undefined)?.text;
      if (!selection) throw Object.assign(new Error("当前账户没有可用的默认文本模型"), { status: 400 });
      const configured = getConfiguredModel("yixian", selection.modelId);
      const { model } = configured;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
      if (reviewInput) {
        const stream = await streamAi({ ...configured, model: { ...model, maxOutputTokens: Math.min(model.maxOutputTokens, 8192) } }, {
          systemPrompt: subtitleReviewInstruction,
          messages: [{ role: "user", content: reviewInput.text, timestamp: Date.now() }],
        }, signal);
        const reply = await stream.result();
        if (reply.stopReason === "error" || reply.stopReason === "aborted")
          throw Object.assign(new Error(reply.errorMessage || "字幕校对请求失败，当前字幕已保留"), { status: 502 });
        if (reply.stopReason === "length") throw Object.assign(new Error("字幕校对回复不完整，当前字幕已保留"), { status: 502 });
        if (reply.content.some(part => part.type === "toolCall")) throw Object.assign(new Error("字幕校对返回了不允许的工具调用"), { status: 502 });
        const content = reply.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        try { return { message: { role: "assistant" as const, content: JSON.stringify(parseSubtitleReview(content)) }, model: model.label }; }
        catch { throw Object.assign(new Error("AI 校对返回的数据格式不正确，本次未应用修改"), { status: 502 }); }
      }
      const response = await platformFetch(new URL("/v1/chat/completions", account.account.baseUrl), {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({ model: model.id, stream: false, max_tokens: Math.min(model.maxOutputTokens, 8192),
          messages: [{ role: "system", content: `你是 UnionFlow Windows 托盘中的本机智能体。使用中文回应，主要协助网页端处理本机，也可直接与用户聊天。你通过工具清单发现能力，不猜测工具结果。\n${localComputerGuidelines.join("\n")}` }, ...input.messages],
          tools: [{ type: "function", function: { name: "localComputer", description: localComputerDescription, parameters: localComputerParameters } }],
          tool_choice: "auto", parallel_tool_calls: false }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error(`文本模型请求失败（HTTP ${response.status}）`), { status: 502 });
      }
      const body = await response.json() as { choices?: { message?: { role?: string; content?: unknown; reasoning_content?: string;
        tool_calls?: { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } }[] | null }; finish_reason?: string }[] };
      const choice = body.choices?.[0];
      if (choice?.finish_reason === "length") throw new Error("模型回复已达到长度上限，未执行截断的工具请求");
      const raw = choice?.message;
      // 网关常在工具调用上附加 index 等字段，只保留协议字段再严格校验。
      const toolCalls = Array.isArray(raw?.tool_calls)
        ? raw.tool_calls.map(call => ({ id: call?.id, type: call?.type, function: { name: call?.function?.name, arguments: call?.function?.arguments } }))
        : raw?.tool_calls;
      const message = helperChatMessage.parse({ role: raw?.role, content: raw?.content ?? null,
        ...(toolCalls != null ? { tool_calls: toolCalls } : {}),
        ...(raw?.reasoning_content ? { reasoning_content: raw.reasoning_content } : {}) });
      if (message.role !== "assistant" || (!message.content?.trim() && !message.tool_calls?.length)) throw new Error("模型没有返回有效回复");
      return { message, model: model.label };
    });
  } finally {
    activeChats.delete(requestKey);
    req.res!.off("close", abort);
  }
}
