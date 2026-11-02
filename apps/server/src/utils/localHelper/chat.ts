import type { Request } from "express";
import { helperChatMessage, helperChatRequest, localComputerDescription, localComputerGuidelines, localComputerParameters } from "@toonflow/local-helper/protocol";
import { requireReadyDevice } from "./index";
import { readWebAccount } from "@/utils/web/auth";
import { webContext } from "@/lib/webContext";
import { getSettings } from "@/utils/conf";
import { refreshConfig, platformFetch } from "@/utils/account";
import { getConfiguredModel } from "@/utils/ai";

const activeChats = new Set<string>();

export async function chat(req: Request) {
  const input = helperChatRequest.parse(req.body);
  const device = await requireReadyDevice(req);
  if (activeChats.has(device.id)) throw Object.assign(new Error("本机智能体正在回复，请等待或停止当前回复"), { status: 409 });
  activeChats.add(device.id);
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
      const { model } = getConfiguredModel("yixian", selection.modelId);
      const response = await platformFetch(new URL("/v1/chat/completions", account.account.baseUrl), {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
        body: JSON.stringify({ model: model.id, stream: false, max_tokens: Math.min(model.maxOutputTokens, 8192),
          messages: [{ role: "system", content: `你是 UnionFlow Windows 托盘中的本机智能体。使用中文回应，主要协助网页端处理本机，也可直接与用户聊天。你通过工具清单发现能力，不猜测工具结果。\n${localComputerGuidelines.join("\n")}` }, ...input.messages],
          tools: [{ type: "function", function: { name: "localComputer", description: localComputerDescription, parameters: localComputerParameters } }],
          tool_choice: "auto", parallel_tool_calls: false }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error(`文本模型请求失败（HTTP ${response.status}）`), { status: 502 });
      }
      const body = await response.json() as { choices?: { message?: { role?: string; content?: unknown; reasoning_content?: string; tool_calls?: unknown }; finish_reason?: string }[] };
      const choice = body.choices?.[0];
      if (choice?.finish_reason === "length") throw new Error("模型回复已达到长度上限，未执行截断的工具请求");
      const raw = choice?.message;
      const message = helperChatMessage.parse({ role: raw?.role, content: raw?.content ?? null,
        ...(raw?.tool_calls != null ? { tool_calls: raw.tool_calls } : {}),
        ...(raw?.reasoning_content ? { reasoning_content: raw.reasoning_content } : {}) });
      if (message.role !== "assistant" || (!message.content?.trim() && !message.tool_calls?.length)) throw new Error("模型没有返回有效回复");
      return { message, model: model.label };
    });
  } finally {
    activeChats.delete(device.id);
    req.res!.off("close", abort);
  }
}
