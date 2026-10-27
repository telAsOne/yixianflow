import { platformFetch } from "@/utils/account";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

type RequestProvider = { apiUrl: string; requestBodyLimitMiB?: number };
type Stream = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
type Part = { type: string; content?: string | Part[]; [key: string]: unknown };
type RequestMessage = { role?: string; content?: string | Part[]; output?: string | Part[]; [key: string]: unknown };
type Payload = { messages?: RequestMessage[]; input?: RequestMessage[]; [key: string]: unknown };

function getRequestBodyLimit(provider: RequestProvider) {
  // ACT: 未知渠道的 24 MiB 是本地保护值；供应商配置可覆盖，不按模型名猜测网关限制。
  return (provider.requestBodyLimitMiB ?? (new URL(provider.apiUrl).hostname === "api.deepseek.com" ? 48 : 24)) * 1024 * 1024;
}

function size(value: unknown) { return Buffer.byteLength(JSON.stringify(value)); }
function formatSize(bytes: number) { return `${(bytes / 1024 / 1024).toFixed(2)} MiB`; }
function messageField(protocol: string) { return protocol === "openai-responses" ? "input" : "messages"; }

function lastUser(messages: RequestMessage[], context: Context) {
  const user = context.messages.findLast(message => message.role === "user");
  if (!user || user.role !== "user") return 0;
  const texts = new Set(typeof user.content === "string" ? [user.content]
    : user.content.flatMap(part => part.type === "text" ? [part.text] : []));
  // 工具图片也可能被协议转换成 user 消息。按原始用户输入定位；重复文字取较早位置，宁可多保留图片。
  const index = messages.findIndex(message => message.role === "user" && (typeof message.content === "string"
    ? texts.has(message.content) : message.content?.some(part => typeof part.text === "string" && texts.has(part.text))));
  return Math.max(0, index);
}

function trimHistoryMedia(payload: Payload, protocol: string, boundary: number, targetBytes: number) {
  const field = messageField(protocol);
  const messages = payload[field]!;
  let bytes = size(payload);
  const trim = (parts: Part[]): Part[] => parts.map(part => {
    if (bytes <= targetBytes) return part;
    if (part.type === "tool_result" && Array.isArray(part.content)) return { ...part, content: trim(part.content) };
    if (!["image", "image_url", "input_image", "document", "input_file", "video_url"].includes(part.type)) return part;
    const replacement = {
      type: protocol === "openai-responses" ? "input_text" : "text",
      text: "[本次请求省略此历史媒体，原文件与完整会话仍保留。需要查看细节时，请按此前附件或工具调用中的路径重新读取，不要凭摘要猜测。]",
    };
    const saved = size(part) - size(replacement);
    if (saved <= 0) return part;
    bytes -= saved;
    return replacement;
  });
  return { ...payload, [field]: messages.map((message, index) => index < boundary ? {
    ...message,
    ...(Array.isArray(message.content) ? { content: trim(message.content) } : {}),
    ...(Array.isArray(message.output) ? { output: trim(message.output) } : {}),
  } : message) };
}

export function withRequestBudget(stream: Stream, provider: RequestProvider, state: {
  canCompact(): boolean;
  isCompacting(): boolean;
  prepareCompaction?(context: Context): void;
}) {
  const limit = getRequestBodyLimit(provider);
  const threshold = Math.floor(limit * 0.8);
  let recovery: { bytes: number; retrying: boolean } | undefined;

  return async (model: Model<Api>, context: Context, options: SimpleStreamOptions = {}) => {
    const compacting = state.isCompacting();
    let requestBytes = 0;
    let canRecover = false;
    const fetchRequest = options.fetch ?? fetch;
    const result = await stream(model, context, {
      ...options,
      onPayload: async (original, requestModel) => {
        // 附件、提及和工具定义全部装配后再计量，避免只检查界面上的输入文字。
        let payload = (await options.onPayload?.(original, requestModel) ?? original) as Payload;
        const field = messageField(model.api);
        const messages = payload[field]!;
        const boundary = lastUser(messages, context);
        requestBytes = size(payload);
        const requiredBytes = size({ ...payload, [field]: [
          ...messages.slice(0, boundary).filter(message => message.role === "system" || message.role === "developer"),
          ...messages.slice(boundary),
        ] });
        canRecover = !compacting && state.canCompact() && boundary > 0
          && context.messages.findLastIndex(message => message.role === "user") > 0 && requiredBytes <= limit;

        if (!compacting && recovery) {
          payload = trimHistoryMedia(payload, model.api, boundary, Math.min(threshold, Math.floor(recovery.bytes * 0.8)));
          requestBytes = size(payload);
          if (recovery.retrying || requestBytes >= recovery.bytes) {
            throw new Error(`整理历史后请求未能继续缩小（${formatSize(requestBytes)}），已停止重试。请减少当前引用的媒体，或新建对话后带入任务摘要。`);
          }
          recovery.retrying = true;
        } else if (requestBytes > threshold && canRecover) {
          recovery = { bytes: requestBytes, retrying: false };
          state.prepareCompaction?.(context);
          // 复用 SDK 的一次压缩与继续，不重新执行已完成的工具。
          throw new Error(`request_too_large：请求为 ${formatSize(requestBytes)}，接近 ${formatSize(limit)} 上限，需要先整理会话历史。`);
        } else if (!compacting && !state.canCompact() && requestBytes > threshold) {
          payload = trimHistoryMedia(payload, model.api, boundary, threshold);
          requestBytes = size(payload);
        }
        if (requestBytes > limit) {
          throw new Error(`${compacting ? "会话摘要请求" : "当前请求"}为 ${formatSize(requestBytes)}，超过供应商设置的 ${formatSize(limit)} 上限。请减少当前图片、附件或文字；本次未发送请求。`);
        }
        return payload;
      },
      fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const response = await platformFetch(input, init);
        if (response.status !== 413) return response;
        await response.body?.cancel();
        const retry = canRecover && !recovery;
        if (retry) {
          recovery = { bytes: requestBytes, retrying: false };
          state.prepareCompaction?.(context);
        }
        // 统一纯文本/HTML/JSON 的 413，保留 HTTP 状态及追踪头；终止分支不再携带 SDK 的溢出重试标记。
        const headers = new Headers();
        for (const name of ["x-request-id", "x-trace-id", "request-id", "retry-after"]) {
          const value = response.headers.get(name);
          if (value) headers.set(name, value);
        }
        return Response.json({ error: {
          type: retry ? "request_too_large" : "request_body_limit",
          message: `${retry ? "request_too_large：" : ""}渠道返回 HTTP 413，拒绝了 ${formatSize(requestBytes)} 的请求。${retry ? "将整理历史后重试一次。" : "已停止重试，请减少当前引用或调低供应商的请求大小上限。"}`,
        } }, { status: 413, headers });
      }, { preconnect: fetchRequest.preconnect }) as typeof fetch,
    });
    // 摘要成功不代表原请求已恢复；只有普通模型请求成功才清除恢复记录。
    void result.result().then(message => {
      if (!compacting && message.stopReason !== "error" && message.stopReason !== "aborted") recovery = undefined;
    });
    return result;
  };
}

export function installRequestBudget(session: AgentSession, provider: RequestProvider) {
  const keepRecentTokens = session.settingsManager.getCompactionKeepRecentTokens();
  session.subscribe(event => {
    if (event.type === "compaction_end") session.settingsManager.applyOverrides({ compaction: { keepRecentTokens } });
  });
  session.agent.streamFunction = withRequestBudget(session.agent.streamFunction, provider, {
    canCompact: () => session.autoCompactionEnabled,
    isCompacting: () => session.isCompacting,
    prepareCompaction: context => {
      const index = context.messages.findLastIndex(message => message.role === "user");
      const currentTokens = context.messages.slice(Math.max(0, index)).reduce((total, message) => total + estimateTokens(message), 0);
      // 字节超限时保留本轮完整输入；沿用默认 2 万 token 会让少量大图的旧历史无法压缩。
      session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: currentTokens + 1 } });
    },
  });
}
