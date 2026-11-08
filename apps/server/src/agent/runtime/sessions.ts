import { z } from "zod";
import { basename, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFile, stat } from "@toonflow/file";
import { listSessionSummaries } from "./sessionIndex";
export { listSessionPage } from "./sessionIndex";
import { cacheFile, readCache, writeCache } from "@/utils/cache";
import { calculateContextTokens, estimateTokens, getLastAssistantUsage, parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, FileEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentEvent, AgentMention, AgentSubAgent, AgentToolCall } from "@/agent/runtime/types";
import { agentMentionsSchema } from "@/agent/runtime/mentions";
import { getSettings } from "@/utils/conf";
import { providerSchema, getModelLimits } from "@/utils/ai";
import { lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";
import { answerQuestion } from "@/agent/bridge/question";

export const agentAttachmentsSchema = z
  .array(
    z.strictObject({
      name: z.string().min(1).max(255),
      path: z.string().min(1).max(4096),
      mimeType: z.string().regex(/^(?:(image|video)\/[a-zA-Z0-9.+-]+|text\/plain)$/),
    })
  )
  .max(20);

export type ActiveAgentSession = {
  history: SessionManager; session?: AgentSession; send: (event: AgentEvent) => void;
  entryOffset: number; tools: Map<string, AgentToolCall>;
  runId: string; signal: AbortSignal; steering: { id: string; text: string }[];
  clientFileRunId?: string; clientFileOwner?: string;
  abort(): Promise<void>;
};
type SessionMessage = {
  id: string; entryId: string; role: "user" | "assistant"; content: string; replyTo?: string; error?: string;
  streaming?: boolean;
  attachments?: z.infer<typeof agentAttachmentsSchema>; report?: { file: string; name: string };
  mentions?: AgentMention[];
  parts: ({ id: string; type: "text" | "thinking"; content: string; collapsed?: boolean } | { id: string; type: "tool"; tool: AgentToolCall })[];
};
// ACT: 复用正在运行的 SDK 会话，文件锁仍由 run 持有；多进程部署时需共享会话所有权。
const activeSessions = new Map<string, ActiveAgentSession>();
const sessionKey = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

export function getActiveAgentSession(path: string) {
  return activeSessions.get(sessionKey(path));
}

export function getAgentRun(path: string, runId: string, ownerId?: string) {
  const active = getActiveAgentSession(path);
  if (active && active.runId !== runId) throw Object.assign(new Error("此轮回复已结束，请重新打开对话查看当前状态"), { status: 409 });
  if (active?.clientFileOwner !== undefined && active.clientFileOwner !== ownerId) {
    throw Object.assign(new Error("此对话只能由授权本机目录的设备控制"), { status: 403 });
  }
  return active;
}

export async function steerAgentSession(cwd: string, active: ActiveAgentSession, prompt: string, messageId: string) {
  active.signal.throwIfAborted();
  if (!active.session?.isStreaming) throw Object.assign(new Error("对话正在准备或结束回复，请稍后发送补充要求"), { status: 409 });
  const saved = active.history.getBranch().find(entry => entry.type === "custom" && entry.customType === "toonflowUserMessage" && (entry.data as { clientId?: string })?.clientId === messageId);
  if (saved?.type === "custom") return (saved.data as { messageId: string }).messageId;
  if (active.steering.some(message => message.id === messageId)) return;
  active.steering.push({ id: messageId, text: prompt });
  try { await active.session.prompt(prompt, { streamingBehavior: "steer", expandPromptTemplates: false }); }
  catch (error) { active.steering = active.steering.filter(message => message.id !== messageId); throw error; }
  const visited = new Set<ActiveAgentSession>();
  const skipQuestions = (current: ActiveAgentSession) => {
    if (visited.has(current)) return;
    visited.add(current);
    for (const tool of current.tools.values()) {
      if (tool.status === "running" && tool.question) {
        try { answerQuestion(cwd, tool.question.callId, { skipped: true }, current.clientFileOwner); }
        catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
      }
    }
    for (const entry of current.history.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== "toonflowSubAgent") continue;
      const file = (entry.data as AgentSubAgent).file;
      if (!/^[\w-]+\.jsonl$/.test(file)) continue;
      const child = getActiveAgentSession(resolve(dirname(current.history.getSessionFile()!), file));
      if (child && getParentSessionFile(child.history) === basename(current.history.getSessionFile()!)) skipQuestions(child);
    }
  };
  skipQuestions(active);
}

export function hasPendingAgentQuestion(active: ActiveAgentSession, visited = new Set<ActiveAgentSession>()): boolean {
  if (visited.has(active)) return false;
  visited.add(active);
  const tools = [...active.tools.values()];
  if (tools.some(tool => tool.status === "running" && tool.question)) return true;
  if (!tools.some(tool => tool.name === "subAgent" && tool.status === "running")) return false;
  const path = active.history.getSessionFile()!;
  return active.history.getEntries().some(entry => {
    if (entry.type !== "custom" || entry.customType !== "toonflowSubAgent") return false;
    const file = (entry.data as AgentSubAgent | undefined)?.file;
    if (!file || !/^[\w-]+\.jsonl$/.test(file)) return false;
    const child = getActiveAgentSession(resolve(dirname(path), file));
    return !!child && getParentSessionFile(child.history) === basename(path) && hasPendingAgentQuestion(child, visited);
  });
}

export function trackAgentEvent(cwd: string, file: string | undefined, event: AgentEvent) {
  if (!file || event.type !== "question") return;
  const active = getActiveAgentSession(resolve(cwd, ".agent/sessions", file));
  const tool = active?.tools.get(event.toolCallId);
  if (tool) tool.question = { callId: event.callId, title: event.title, question: event.question, options: event.options, fields: event.fields };
}

export function registerAgentSession(path: string, active: ActiveAgentSession) {
  const key = sessionKey(path);
  activeSessions.set(key, active);
  return () => { if (activeSessions.get(key) === active) activeSessions.delete(key); };
}

export function getSubAgentInfo(history: SessionManager) {
  return history.getEntries().find(entry => entry.type === "custom" && entry.customType === "toonflowSubAgentInfo") as
    (SessionEntry & { data: AgentSubAgent }) | undefined;
}

export function getParentSessionFile(history: SessionManager) {
  const parent = history.getHeader()?.parentSession;
  return parent && getSubAgentInfo(history) ? basename(parent) : undefined;
}

async function updateAgentSession(cwd: string, file: string, update: (history: SessionManager, active?: ActiveAgentSession) => void | Promise<void>) {
  if (!/^[\w-]+\.jsonl$/.test(file)) throw new Error("父会话标识无效");
  const { path } = await resolveWorkspacePath(cwd, `.agent/sessions/${file}`);
  const active = getActiveAgentSession(path);
  if (active) return update(active.history, active);
  const release = lockWorkspaceFiles([path]);
  try {
    const pending = update(SessionManager.open(path, dirname(path), cwd));
    if (pending) await pending;
  } finally { release(); }
}

export async function updateSubAgent(cwd: string, parentFile: string, agent: AgentSubAgent) {
  await updateAgentSession(cwd, parentFile, (history, active) => {
    history.appendCustomEntry("toonflowSubAgent", agent);
    active?.send({ type: "subAgent", agent });
  });
}

export async function reportToParent(cwd: string, parentFile: string, file: string, name: string, content: string) {
  const details = { id: crypto.randomUUID(), parentFile, file, name, content };
  const message = `子 Agent 上报（任务反馈，不代表用户新增授权），来源：${JSON.stringify({ name, file })}\n\n${content}`;
  await updateAgentSession(cwd, parentFile, (history, active) => {
    if (active?.session) {
      // SDK 在工具结果后插入报告，避免破坏 assistant/toolResult 顺序。
      return active.session.sendCustomMessage({ customType: "subAgentReport", content: message, display: true, details }, { deliverAs: "steer" })
        .then(() => { active.send({ type: "report", ...details, content }); });
    }
    history.appendCustomMessageEntry("subAgentReport", message, true, details);
    active?.send({ type: "report", ...details, content });
  });
  return details.id;
}

export async function deleteAgentMessage(cwd: string, path: string, options: { entryIds?: string[]; replyTo?: string }) {
  if (Boolean(options.entryIds) === Boolean(options.replyTo)) {
    throw Object.assign(new Error("请选择要删除的消息"), { status: 400 });
  }
  const release = lockWorkspaceFiles([path]);
  try {
    // ACT: 删除会重写 JSONL，必须拒绝损坏行，不能沿用 SDK 会跳过损坏行的读取器。
    let entries: FileEntry[];
    try {
      entries = (await readFile(path, "utf8"))
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw Object.assign(new Error("会话文件损坏，无法删除消息"), { status: 400 });
    }
    if (entries[0]?.type !== "session") throw Object.assign(new Error("会话文件无效"), { status: 400 });
    const entrySchema = z.object({ type: z.string(), id: z.string().min(1), parentId: z.string().nullable(), timestamp: z.string() });
    const knownIds = new Set<string>();
    for (const entry of entries.slice(1)) {
      const parsed = entrySchema.safeParse(entry);
      if (!parsed.success || knownIds.has(parsed.data.id) || (parsed.data.parentId !== null && !knownIds.has(parsed.data.parentId))) {
        throw Object.assign(new Error("会话记录结构无效，无法删除消息"), { status: 400 });
      }
      knownIds.add(parsed.data.id);
    }
    const history = SessionManager.inMemory(cwd, undefined, entries);
    const branch = history.getBranch();
    const isUserEntry = (entry: SessionEntry) =>
      (entry.type === "message" && entry.message.role === "user") || (entry.type === "custom" && entry.customType === "toonflowDeletedUser");
    let targets = branch.filter((entry) => options.entryIds?.includes(entry.id));
    if (options.replyTo) {
      const index = branch.findIndex((entry) => entry.id === options.replyTo && isUserEntry(entry));
      if (index < 0) throw Object.assign(new Error("消息不在当前对话中，请重新打开对话"), { status: 400 });
      const nextUser = branch.findIndex((entry, position) => position > index && isUserEntry(entry));
      targets = branch
        .slice(index + 1, nextUser < 0 ? undefined : nextUser)
        .filter((entry) => entry.type === "message" && entry.message.role === "assistant");
    }
    if (
      options.entryIds &&
      (new Set(options.entryIds).size !== targets.length ||
        targets.some((entry) => entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")))
    ) {
      throw Object.assign(new Error("消息不在当前对话中，请重新打开对话"), { status: 400 });
    }
    if (!targets.length) return await getAgentSession(cwd, path);

    const removedIds = new Set(targets.map((entry) => entry.id));
    const toolCallIds = new Set(
      targets.flatMap((entry) =>
        entry.type === "message" && entry.message.role === "assistant"
          ? entry.message.content.filter((part) => part.type === "toolCall").map((part) => part.id)
          : []
      )
    );
    const affectedIds = new Set(removedIds);
    const timedTurns = new Map<string, boolean>();
    for (const entry of history.getEntries()) {
      if ((entry.parentId && affectedIds.has(entry.parentId)) || (entry.type === "branch_summary" && affectedIds.has(entry.fromId))) {
        affectedIds.add(entry.id);
      }
      const timingChanged = !isUserEntry(entry) && (removedIds.has(entry.id) || Boolean(entry.parentId && timedTurns.get(entry.parentId)));
      timedTurns.set(entry.id, timingChanged);
      if (
        (entry.type === "message" && entry.message.role === "toolResult" && toolCallIds.has(entry.message.toolCallId)) ||
        (entry.type === "custom" &&
          ["toonflowAttachments", "toonflowUserMessage"].includes(entry.customType) &&
          removedIds.has((entry.data as { messageId?: string } | undefined)?.messageId ?? "")) ||
        (entry.type === "custom" && entry.customType === "toonflowTiming" && timingChanged) ||
        ((entry.type === "compaction" || entry.type === "branch_summary") && affectedIds.has(entry.id)) ||
        (entry.type === "label" && removedIds.has(entry.targetId))
      ) {
        removedIds.add(entry.id);
      }
    }
    // ACT: 清除正文并保留树节点，避免分支、叶指针和实时回复的 user 锚点失效；摘要也不能带回已删内容。
    entries = [
      entries[0],
      ...history.getEntries().map((entry) =>
        removedIds.has(entry.id)
          ? {
              type: "custom" as const,
              id: entry.id,
              parentId: entry.parentId,
              timestamp: new Date().toISOString(),
              customType: isUserEntry(entry) ? "toonflowDeletedUser" : "toonflowDeletedEntry",
            }
          : entry
      ),
    ];
    await writeWorkspaceFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    return await getAgentSession(cwd, path);
  } finally {
    release();
  }
}

export async function createAgentConversation(cwd: string, child?: Omit<AgentSubAgent, "file" | "status">) {
  const { path: directory } = await resolveWorkspacePath(cwd, ".agent/sessions", true);
  const history = SessionManager.create(cwd, directory, child ? { parentSession: child.parentFile } : undefined);
  const path = history.getSessionFile()!;
  if (child) {
    history.appendSessionInfo(child.name);
    history.appendCustomEntry("toonflowSubAgentInfo", { ...child, file: basename(path), status: "running" });
    if (child.providerId && child.modelId) history.appendModelChange(child.providerId, child.modelId);
    if (child.thinkingLevel) history.appendThinkingLevelChange(child.thinkingLevel);
    if (child.modelId === "gemini-4-argon") history.appendCustomEntry("toonflowThinkingPreference", { level: child.thinkingLevel ?? null });
  }
  // ACT: SDK 默认等首条回复才落盘；先保存会话头，让空对话也能被历史列表读取。
  await writeWorkspaceFile(path, [history.getHeader(), ...history.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n", true);
  return getAgentSession(cwd, path);
}

export async function renameAgentSession(cwd: string, path: string, name: string) {
  const release = lockWorkspaceFiles([path]);
  try {
    const entries = parseSessionEntries(await readFile(path, "utf8"));
    if (entries[0]?.type !== "session") throw Object.assign(new Error("会话文件无效"), { status: 400 });
    const history = SessionManager.open(path, dirname(path), cwd);
    history.appendSessionInfo(name);
    return { name: history.getSessionName()! };
  } finally {
    release();
  }
}

export async function listAgentSessions(cwd: string, directory: string) {
  return listSessionSummaries(directory);
}

type SessionPages = {
  revision: string;
  session: Omit<Awaited<ReturnType<typeof getAgentSession>>, "messages">;
  ids: string[];
  pages: string[];
};
const pageBuilds = new Map<string, Promise<SessionPages>>();

async function buildSessionPages(cwd: string, path: string, revision: string, indexPath: string) {
  const key = `${path}:${revision}`;
  const existing = pageBuilds.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const { messages, ...session } = await getAgentSession(cwd, path);
    const index: SessionPages = { revision, session, ids: messages.map(message => message.id), pages: [] };
    // ACT: 每个版本首次解析一次；按 40 条保存内容寻址的快照，未变化的页复用，翻页不再解析整份 JSONL。
    for (let start = 0; start < messages.length; start += 40) {
      const page = messages.slice(start, start + 40);
      const hash = createHash("sha256").update(JSON.stringify(page)).digest("hex");
      const pagePath = cacheFile("sessionIndex", JSON.stringify(["sessionPage", path, hash]));
      if (!(await readCache<SessionMessage[]>(pagePath))) await writeCache(pagePath, page);
      index.pages.push(pagePath);
    }
    const after = await stat(path);
    if (!revision.startsWith(`${after.size}:${after.mtimeMs}:${after.ctimeMs}:`)) {
      throw Object.assign(new Error("历史对话正在变化，请稍后重新打开"), { status: 409 });
    }
    if (!session.running && !getActiveAgentSession(path)) await writeCache(indexPath, index);
    return index;
  })();
  pageBuilds.set(key, pending);
  try { return await pending; }
  finally { pageBuilds.delete(key); }
}

export async function getAgentSessionPage(cwd: string, path: string, before?: string) {
  if (getActiveAgentSession(path)) {
    const session = await getAgentSession(cwd, path);
    const end = before ? session.messages.findIndex(message => message.id === before) : session.messages.length;
    if (end < 0) throw Object.assign(new Error("历史对话已变化，请重新打开后继续读取"), { status: 409 });
    const start = Math.max(0, end - 40);
    return { ...session, messages: session.messages.slice(start, end), before: start ? session.messages[start]!.id : undefined };
  }
  const info = await stat(path);
  const providers = getSettings().customProviders;
  const modelSettings = Array.isArray(providers) ? providers.map(provider => ({ id: provider?.id, models: provider?.models })) : [];
  const revision = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${JSON.stringify(modelSettings)}`;
  const indexPath = cacheFile("sessionIndex", JSON.stringify(["sessionPages", path, 2]));
  let index = await readCache<SessionPages>(indexPath);
  if (index?.revision !== revision) index = await buildSessionPages(cwd, path, revision, indexPath);
  const end = before ? index.ids.indexOf(before) : index.ids.length;
  if (end < 0) throw Object.assign(new Error("历史对话已变化，请重新打开后继续读取"), { status: 409 });
  const start = Math.max(0, end - 40);
  const firstPage = Math.floor(start / 40);
  const readPages = (value: SessionPages) => Promise.all(value.pages.slice(firstPage, Math.ceil(end / 40)).map(page => readCache<SessionMessage[]>(page)));
  let pages = await readPages(index);
  if (pages.some(page => !page)) {
    index = await buildSessionPages(cwd, path, revision, indexPath);
    pages = await readPages(index);
  }
  if (pages.some(page => !page)) throw new Error("历史消息缓存读取失败，请重新打开对话");
  const subAgents = index.session.subAgents.map(agent => agent.status === "running" && !getActiveAgentSession(resolve(dirname(path), agent.file))
    ? { ...agent, status: "cancelled" as const, result: "上次运行已中断" } : agent);
  return { ...index.session, subAgents, messages: pages.flatMap(page => page!).slice(start % 40, start % 40 + end - start), before: start ? index.ids[start] : undefined };
}

export async function getAgentSession(cwd: string, path: string) {
  const active = getActiveAgentSession(path);
  const entries = active
    ? [active.history.getHeader()!, ...active.history.getEntries()]
    : parseSessionEntries(await readFile(path, "utf8"));
  if (entries[0]?.type !== "session") throw Object.assign(new Error("会话文件无效"), { status: 400 });
  const partial = active?.session?.agent.state.streamingMessage;
  if (partial?.role === "assistant") entries.push({
    type: "message", id: "streaming", parentId: active!.history.getLeafId(), timestamp: new Date().toISOString(), message: partial,
  });
  const messageIndices = new Map(active ? entries.slice(active.entryOffset + 1)
    .filter(entry => entry.type === "message" && entry.message.role === "assistant")
    .map((entry, index) => [(entry as SessionEntry).id, index + 1]) : []);
  const history = SessionManager.inMemory(cwd, undefined, entries);
  const branch = history.getBranch();
  const attachmentMessages = new Map(
    branch.flatMap((entry) => {
      if (entry.type !== "custom" || !["toonflowAttachments", "toonflowUserMessage"].includes(entry.customType)) return [];
      const parsed = z.object({ messageId: z.string(), content: z.string(), attachments: agentAttachmentsSchema, mentions: agentMentionsSchema.optional() }).safeParse(entry.data);
      return parsed.success ? [[parsed.data.messageId, parsed.data] as const] : [];
    })
  );
  const toolResults = new Map(
    branch.flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult" ? [[entry.message.toolCallId, entry.message] as const] : []
    )
  );
  let replyTo: string | undefined;
  const entriesMessages = branch.flatMap<SessionMessage>((entry) => {
    if (entry.type === "custom" && entry.customType === "toonflowDeletedUser") replyTo = entry.id;
    if (entry.type === "custom_message" && entry.customType === "subAgentReport") {
      const details = entry.details as { id?: string; file: string; name: string; content?: string };
      const content = details.content ?? (typeof entry.content === "string" ? entry.content : getToolResultText(entry.content));
      return [{
        id: details.id ?? entry.id, entryId: entry.id, replyTo: undefined, role: "assistant" as const,
        content, parts: [{ id: details.id ?? entry.id, type: "text", content }], error: undefined,
        attachments: undefined, report: { file: details.file, name: details.name },
      }];
    }
    if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) return [];
    const message = entry.message;
    if (message.role === "user") replyTo = entry.id;
    const attachmentMessage = message.role === "user" ? attachmentMessages.get(entry.id) : undefined;
    const attachments = attachmentMessage?.attachments;
    const parts =
      message.role === "assistant"
        ? message.content
            .map((part, index) => {
              const id = `${messageIndices.get(entry.id) ?? entry.id}:${index}`;
              if (part.type === "text") return { id, type: "text" as const, content: part.text };
              if (part.type === "thinking") return { id, type: "thinking" as const, content: part.thinking, collapsed: true };
              if (part.type === "toolCall") {
                const result = toolResults.get(part.id);
                return {
                  id,
                  type: "tool" as const,
                  tool: active?.tools.get(part.id) ?? {
                    id: part.id,
                    name: part.name,
                    args: part.arguments,
                    status: result ? (result.isError ? "error" as const : "success" as const) : "interrupted" as const,
                    result: result ? getToolResultText(result.content) : undefined,
                  },
                };
              }
            })
            .filter((part) => part !== undefined)
        : [];
    const content =
      message.role === "assistant"
        ? ""
        : attachmentMessage?.content ??
          (typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(""));
    const error = message.role === "assistant" ? message.errorMessage : undefined;
    return [
      {
        id: entry.id,
        entryId: entry.id,
        replyTo: message.role === "assistant" ? replyTo : undefined,
        role: message.role,
        content,
        parts,
        error,
        attachments,
        mentions: attachmentMessage?.mentions,
        report: undefined,
      },
    ];
  });
  const groupedMessages: typeof entriesMessages = [];
  for (const message of entriesMessages) {
    const previous = groupedMessages.at(-1);
    if (message.role === "assistant" && message.replyTo && previous?.role === "assistant" && previous.replyTo === message.replyTo) {
      previous.parts.push(...message.parts);
      previous.error = message.error;
    } else groupedMessages.push(message);
  }
  // ACT: 同轮的工具调用与多步回复合并后，只拼接一次正文。
  for (const message of groupedMessages) {
    if (message.role === "assistant" && !message.report) message.content = message.parts.flatMap(part => part.type === "text" ? [part.content] : []).join("\n\n");
  }
  const latestUser = groupedMessages.findLast(message => message.role === "user");
  const activeReply = active && latestUser ? groupedMessages.findLast(message =>
    message.role === "assistant" && !message.report && message.replyTo === latestUser.id && messageIndices.has(message.entryId)
  ) : undefined;
  if (activeReply) activeReply.streaming = true;
  const messages = groupedMessages.filter((message) => message.content || message.parts.length || message.error || message.attachments?.length || message.mentions?.length);
  const firstUserMessage = messages.find((item) => item.role === "user");
  const context = history.buildSessionContext();
  const lastReply = history.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
  const model =
    lastReply?.type === "message" && lastReply.message.role === "assistant"
      ? { provider: lastReply.message.provider, modelId: lastReply.message.model }
      : context.model;
  let thinkingLevel: string | undefined = context.thinkingLevel;
  if (model?.modelId === "gemini-4-argon") {
    const preference = branch.findLast(entry => entry.type === "custom" && entry.customType === "toonflowThinkingPreference");
    const parsed = preference?.type === "custom" ? z.object({ level: z.enum(["off", "low", "medium", "high"]).nullable() }).safeParse(preference.data) : undefined;
    thinkingLevel = parsed?.success ? parsed.data.level ?? undefined : thinkingLevel === "off" ? undefined : thinkingLevel;
  }
  const providers = getSettings().customProviders;
  const provider = providerSchema.safeParse(Array.isArray(providers) ? providers.find((item) => item?.id === model?.provider) : undefined);
  const configuredModel = provider.success ? provider.data.models.find((item) => item.id === model?.modelId) : undefined;
  const subAgents = new Map<string, AgentSubAgent>();
  for (const entry of history.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== "toonflowSubAgent") continue;
    const agent = entry.data as AgentSubAgent;
    const interrupted = agent.status === "running" && !active && !getActiveAgentSession(resolve(dirname(path), agent.file));
    subAgents.set(agent.file, interrupted ? { ...agent, status: "cancelled", result: "上次运行已中断" } : agent);
  }
  return {
    file: basename(path),
    name: history.getSessionName() || (firstUserMessage?.content.trim() || firstUserMessage?.attachments?.[0]?.name)?.slice(0, 60) || "新对话",
    messages,
    stats: getAgentStats(history),
    contextUsage: configuredModel && model ? getAgentContext(history, getModelLimits(model.provider, configuredModel).contextWindow) : undefined,
    providerId: model?.provider,
    modelId: model?.modelId,
    thinkingLevel,
    parentFile: getParentSessionFile(history),
    subAgents: [...subAgents.values()],
    running: Boolean(active),
    runId: active?.runId,
  };
}

export function getToolResultText(content: { type: string; text?: string }[]) {
  return content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
}

export function getAgentStats(history: SessionManager) {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let outputTokens = 0;
  let decodeMs = 0;
  for (const entry of history.getBranch()) {
    const usage =
      entry.type === "compaction" || entry.type === "branch_summary"
        ? entry.usage
        : entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")
        ? entry.message.usage
        : undefined;
    if (usage) {
      tokens.input += usage.input;
      tokens.output += usage.output;
      tokens.cacheRead += usage.cacheRead;
      tokens.cacheWrite += usage.cacheWrite;
    }
    if (entry.type === "custom" && entry.customType === "toonflowTiming") {
      const timing = entry.data as { outputTokens?: number; decodeMs?: number } | undefined;
      if (
        typeof timing?.outputTokens === "number" &&
        Number.isFinite(timing.outputTokens) &&
        timing.outputTokens > 0 &&
        typeof timing.decodeMs === "number" &&
        Number.isFinite(timing.decodeMs) &&
        timing.decodeMs > 0
      ) {
        outputTokens += timing.outputTokens;
        decodeMs += timing.decodeMs;
      }
    }
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return { tokens, tokensPerSecond: decodeMs > 0 ? (outputTokens * 1000) / decodeMs : undefined };
}

function getAgentContext(history: SessionManager, contextWindow: number) {
  const branch = history.getBranch();
  const compactionIndex = branch.findLastIndex((entry) => entry.type === "compaction");
  const recent = branch.slice(compactionIndex + 1);
  const usage = getLastAssistantUsage(recent);
  const messages = history.buildSessionContext().messages;
  const usageIndex = messages.findLastIndex((message) => message.role === "assistant" && message.usage === usage);
  const deletedAfterReply = branch.some(
    (entry) =>
      entry.type === "custom" &&
      (entry.customType === "toonflowDeletedUser" || entry.customType === "toonflowDeletedEntry") &&
      Date.parse(entry.timestamp) >= (messages[usageIndex]?.timestamp ?? 0)
  );
  const tokens =
    usage && usageIndex >= 0 && !deletedAfterReply
      ? calculateContextTokens(usage) + messages.slice(usageIndex + 1).reduce((total, message) => total + estimateTokens(message), 0)
      : compactionIndex >= 0 && !deletedAfterReply
      ? null
      : messages.reduce((total, message) => total + estimateTokens(message), 0);
  return { tokens, contextWindow, percent: tokens === null ? null : (tokens / contextWindow) * 100 };
}
