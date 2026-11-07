import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, readFile, stat, unlink, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import { helperChatMessage, type HelperChatMessage } from "./protocol";
import { dataDirectory } from "./logger";
import { recordChat, updateConversations } from "./activity";
import type { HelperChatEntry } from "./controlProtocol";

const summarySchema = z.strictObject({
  id: z.uuid(),
  title: z.string().max(80),
  preview: z.string().max(160),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  messageCount: z.number().int().nonnegative(),
});
const sessionSchema = summarySchema.extend({
  messages: z.array(helperChatMessage).max(200),
  entries: z
    .array(
      z.strictObject({
        role: z.enum(["user", "assistant", "tool", "error"]),
        text: z.string().max(128000),
        at: z.number().int().positive(),
      }),
    )
    .max(1000),
});
const indexSchema = z.strictObject({ version: z.literal(1), activeId: z.uuid().nullable(), sessions: z.array(summarySchema).max(10000) });
let directory = "";
let index: z.infer<typeof indexSchema> = { version: 1, activeId: null, sessions: [] };
let current: z.infer<typeof sessionSchema> | undefined;
let queue = Promise.resolve();

function publish(includeChat = false) {
  updateConversations(
    [...index.sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    index.activeId,
    includeChat ? [...(current?.entries ?? [])] : undefined,
  );
}

async function readJson(path: string, maxBytes = 4 * 1024 * 1024) {
  if ((await stat(path)).size > maxBytes) throw new Error("历史记录文件超过读取上限，未自动覆盖，请保留原文件后处理");
  return JSON.parse(await readFile(path, "utf8"));
}

function save() {
  if (!directory || !current) return Promise.resolve();
  const record = sessionSchema.parse(current);
  const { entries: _entries, messages: _messages, ...summary } = record;
  index.sessions = [summary, ...index.sessions.filter((item) => item.id !== record.id)];
  const sessionText = JSON.stringify(record);
  if (Buffer.byteLength(sessionText) > 4 * 1024 * 1024)
    return Promise.reject(new Error("会话已达到本机保存上限，请开始新对话；已有历史仍保留"));
  const indexText = JSON.stringify(indexSchema.parse(index));
  const targetDirectory = directory;
  publish();
  const pending = queue.then(async () => {
    await writeAtomic(join(targetDirectory, `${record.id}.json`), sessionText, { mode: 0o600 });
    await writeAtomic(join(targetDirectory, "index.json"), indexText, { mode: 0o600 });
  });
  queue = pending.catch(() => {});
  return pending;
}

async function select(id: string) {
  if (!directory || !index.sessions.some((item) => item.id === id)) throw new Error("历史会话不存在或不属于当前账户");
  await queue;
  const record = sessionSchema.parse(await readJson(join(directory, `${z.uuid().parse(id)}.json`)));
  if (record.id !== id) throw new Error("历史会话编号不一致，未加载");
  // ACT: 恢复只补齐中断的工具回执，绝不重新执行上次未完成的操作。
  const messages: HelperChatMessage[] = [];
  for (let position = 0; position < record.messages.length; position++) {
    const message = record.messages[position];
    messages.push(message);
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    const replies = new Set<string>();
    let next = position + 1;
    while (record.messages[next]?.role === "tool") {
      const reply = record.messages[next++];
      if (reply.role === "tool") replies.add(reply.tool_call_id);
    }
    for (const call of message.tool_calls)
      if (!replies.has(call.id))
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error: "上次执行已中断，结果未确认。请核对本机实际状态，不要自动重跑。" }),
        });
  }
  current = { ...record, messages };
  index.activeId = id;
  publish(true);
  await save();
}

export const conversations = {
  async load(ownerId: number, server: string) {
    await queue;
    const account = createHash("sha256").update(`${server}:${ownerId}`).digest("hex").slice(0, 32);
    directory = join(dataDirectory, "chats", account);
    await mkdir(directory, { recursive: true });
    current = undefined;
    index = { version: 1, activeId: null, sessions: [] };
    publish(true);
    try {
      index = indexSchema.parse(await readJson(join(directory, "index.json"), 16 * 1024 * 1024));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        directory = "";
        throw error;
      }
      index = { version: 1, activeId: null, sessions: [] };
    }
    if (index.activeId) await select(index.activeId);
    else publish(true);
  },
  async create() {
    if (!directory) throw new Error("请先授权当前绑定账户");
    await queue;
    const now = Date.now();
    current = {
      id: randomUUID(),
      title: "新对话",
      preview: "",
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      messages: [],
      entries: [],
    };
    index.activeId = current.id;
    await save();
    publish(true);
  },
  select,
  async rename(id: string, title: string) {
    if (!directory || !index.sessions.some((item) => item.id === id)) throw new Error("历史会话不存在");
    if (current?.id !== id) await select(id);
    current!.title = summarySchema.shape.title.min(1).parse(title.trim());
    await save();
  },
  async remove(id: string) {
    if (!directory || !index.sessions.some((item) => item.id === id)) throw new Error("历史会话不存在");
    await queue;
    const next = {
      ...index,
      sessions: index.sessions.filter((item) => item.id !== id),
      activeId: index.activeId === id ? null : index.activeId,
    };
    // 先提交索引；删除正文失败时明确报错，保留可恢复的原文件。
    await writeAtomic(join(directory, "index.json"), JSON.stringify(next), { mode: 0o600 });
    try {
      await unlink(join(directory, `${z.uuid().parse(id)}.json`));
    } catch (error) {
      await writeAtomic(join(directory, "index.json"), JSON.stringify(index), { mode: 0o600 });
      throw error;
    }
    index = next;
    if (current?.id === id) current = undefined;
    publish(true);
    if (!current && index.sessions.length) await select(index.sessions[0].id);
  },
  async append(role: HelperChatEntry["role"], text: string) {
    if (!current) await this.create();
    const entry = recordChat(role, text);
    current!.entries.push(entry);
    current!.updatedAt = entry.at;
    if (role === "user") {
      if (!current!.messageCount) current!.title = text.replace(/\s+/g, " ").slice(0, 32).replace(/[\uD800-\uDBFF]$/, "");
      current!.messageCount++;
    }
    if (role === "user" || role === "assistant") current!.preview = text.replace(/\s+/g, " ").slice(0, 160).replace(/[\uD800-\uDBFF]$/, "");
    await save();
  },
  async saveMessages(messages: HelperChatMessage[]) {
    if (!current) throw new Error("尚未创建会话");
    current.messages = [...messages];
    await save();
  },
  messages() {
    return current?.messages ?? [];
  },
  isLoaded() {
    return !!directory;
  },
  async detach() {
    await queue;
    directory = "";
    current = undefined;
    index = { version: 1, activeId: null, sessions: [] };
    publish(true);
  },
  async flush() {
    await queue;
  },
};
