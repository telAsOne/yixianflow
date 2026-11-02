import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { appendFile, mkdir, readFile, rm, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import { helperVersion, helperChatMessage, helperChatRequest, localComputerRequest, type HelperChatMessage, type LocalComputerRequest, type LocalHelperJob, type LocalHelperPoll, type LocalHelperResult } from "./protocol";
import { operate } from "./operations";
import { deviceRequest } from "./connection";
import { remoteFiles } from "./files";

if (process.platform !== "win32") throw new Error("本地助手首版仅支持 Windows");
const server = new URL(process.env.TOONFLOW_HELPER_SERVER || "https://yixian.lol/flow/");
if ((server.protocol !== "https:" && !(server.protocol === "http:" && server.hostname === "127.0.0.1" && /bun(?:\.exe)?$/i.test(process.execPath)))
  || server.username || server.password || server.search || server.hash) throw new Error("服务地址必须是 HTTPS，且不能包含凭据、查询或片段");
if (!server.pathname.endsWith("/")) server.pathname += "/";
const dataDirectory = resolve(process.env.TOONFLOW_HELPER_DATA_DIR || join(process.env.LOCALAPPDATA || homedir(), "UnionFlfow/localHelper"));
const statePath = join(dataDirectory, "device.json");
const resultPath = join(dataDirectory, "pendingResult.json");
const stateSchema = z.strictObject({ id: z.uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: z.string().regex(/^[A-F0-9]{12}$/),
  server: z.string(), registeredAt: z.number() });
let state!: z.infer<typeof stateSchema>;
let paused = false;
let autoExecute = false;
let authorizedOwner: number | undefined;
let ownerName = "";
let active: { job: LocalHelperJob; controller: AbortController; done: Promise<void> } | undefined;
let resetting = false;
const lifetime = new AbortController();
const approvals = new Map<string, (allowed: boolean) => void>();
let operationQueue = Promise.resolve();
let chatController: AbortController | undefined;
let chatDone = Promise.resolve();
let chatHistory: HelperChatMessage[] = [];

function send(message: Record<string, unknown>) { process.stdout.write(JSON.stringify(message) + "\n"); }
function status(message: string) { send({ type: "status", message, code: state?.code, server: server.href, owner: ownerName, paused, autoExecute }); }

async function confirm(title: string, detail: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const id = crypto.randomUUID();
  return new Promise<boolean>(resolveApproval => {
    const finish = (allowed: boolean) => {
      if (!approvals.delete(id)) return;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      send({ type: "dismiss", id });
      resolveApproval(allowed);
    };
    const abort = () => finish(false);
    const timer = globalThis.setTimeout(() => finish(false), 150000);
    approvals.set(id, finish);
    signal.addEventListener("abort", abort, { once: true });
    send({ type: "confirm", id, title, detail });
  });
}

const controls = createInterface({ input: process.stdin });
controls.on("line", line => {
  try {
    const message = JSON.parse(line) as { type?: string; id?: string; allowed?: boolean; value?: boolean; text?: string };
    if (message.type === "approval" && message.id) approvals.get(message.id)?.(message.allowed === true);
    if (message.type === "pause") {
      paused = message.value === true;
      active?.controller.abort();
      chatController?.abort();
      status(paused ? "已暂停接收，本机运行任务已取消" : "正在连接平台");
    }
    if (message.type === "automatic") { autoExecute = message.value === true; status("本次运行的执行权限已更新"); }
    if (message.type === "chat" && typeof message.text === "string") startChat(message.text);
    if (message.type === "chatCancel") chatController?.abort();
    if (message.type === "chatReset" && !chatController) { chatHistory = []; send({ type: "chatReset" }); }
    if (message.type === "reset") { resetting = true; authorizedOwner = undefined; autoExecute = false; active?.controller.abort(); chatController?.abort(); chatHistory = []; send({ type: "chatReset" }); }
    if (message.type === "shutdown") { lifetime.abort(); active?.controller.abort(); chatController?.abort(); }
  } catch { status("托盘控制消息无效"); }
});
controls.on("close", () => { lifetime.abort(); active?.controller.abort(); chatController?.abort(); });
process.on("SIGTERM", () => { lifetime.abort(); active?.controller.abort(); chatController?.abort(); });

async function request<T>(path: string, body: unknown): Promise<T> {
  return deviceRequest(server, state.token, path, body, AbortSignal.any([lifetime.signal, AbortSignal.timeout(30000)]));
}

function runOperation(request: LocalComputerRequest, signal: AbortSignal) {
  const pending = operationQueue.then(async () => {
    signal.throwIfAborted();
    const operation = localComputerRequest.parse(request);
    if (!["status", "list", "read", "readBatch", "projects"].includes(operation.action) && !autoExecute) {
      const detail = operation.action === "execute" ? `PowerShell\n目录：${operation.cwd || "用户主目录"}\n\n${operation.command}`
        : operation.action === "install" ? `通过 Windows winget 安装软件：${operation.packageId}\n范围：当前 Windows 用户`
          : JSON.stringify(operation, null, 2);
      const allowed = await confirm("确认本机操作", `请求账户：${ownerName}\n来源：${server.href}\n\n${detail}\n\n是否允许这一次操作？`, signal);
      if (!allowed) throw new Error("本机用户拒绝、取消或未及时确认操作");
    }
    signal.throwIfAborted();
    status(`正在本机执行：${operation.action}`);
    if (operation.action === "projects" || operation.action === "upload" || operation.action === "download")
      return remoteFiles(operation, server, state.token, AbortSignal.any([signal, AbortSignal.timeout(15 * 60000)]));
    return operate(operation, signal);
  });
  operationQueue = pending.then(() => {}, () => {});
  return pending;
}

function startChat(text: string) {
  if (chatController) return;
  if (paused || resetting || authorizedOwner === undefined || !state) {
    send({ type: "chat", role: "error", text: "请先在网页绑定本机，在托盘确认连接并继续接收任务。", done: true });
    return;
  }
  const parsed = helperChatMessage.safeParse({ role: "user", content: text.trim() });
  if (!parsed.success) { send({ type: "chat", role: "error", text: "消息不能为空，且不能超过 32000 字符。", done: true }); return; }
  const controller = new AbortController();
  chatController = controller;
  const signal = AbortSignal.any([controller.signal, lifetime.signal]);
  chatDone = (async () => {
    const messages = [...chatHistory, parsed.data];
    const calls = new Set<string>();
    send({ type: "chatState", running: true });
    try {
      let count = 0;
      for (let round = 0; round < 21; round++) {
        signal.throwIfAborted();
        helperChatRequest.parse({ messages });
        const reply = await deviceRequest<{ message: unknown; model: string }>(server, state.token, "chat", { messages },
          AbortSignal.any([signal, AbortSignal.timeout(150000)]));
        const message = helperChatMessage.parse(reply.message);
        if (message.role !== "assistant") throw new Error("平台未返回智能体回复");
        messages.push(message);
        if (message.content) send({ type: "chat", role: "assistant", text: message.content, model: reply.model });
        if (!message.tool_calls?.length) { chatHistory = messages; return; }
        for (const call of message.tool_calls) {
          let result: unknown;
          try {
            signal.throwIfAborted();
            if (calls.has(call.id)) throw new Error("重复的工具调用，未再次执行");
            calls.add(call.id);
            if (++count > 20) throw new Error("本轮已达到 20 次工具调用上限，请核对结果后再继续");
            const operation = localComputerRequest.parse(JSON.parse(call.function.arguments));
            send({ type: "chat", role: "tool", text: `正在执行：${operation.action}` });
            result = await runOperation(operation, signal);
            const detail = JSON.stringify(result);
            send({ type: "chat", role: "tool", text: `执行结果：${detail.slice(0, 24000)}${detail.length > 24000 ? "\n（窗口仅显示前 24000 字符）" : ""}` });
          } catch (error) {
            result = { error: signal.aborted ? "本次操作已停止，请核对停止前已经完成的文件或命令，不要自动重跑。" : error instanceof Error ? error.message : String(error) };
            send({ type: "chat", role: "error", text: (result as { error: string }).error });
          }
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
        chatHistory = messages;
        if (count > 20) throw new Error("本轮工具调用已达上限，请核对已完成的操作");
      }
      throw new Error("智能体已达到本轮操作上限，请核对结果后再继续");
    } catch (error) {
      send({ type: "chat", role: "error", text: signal.aborted ? "本次回复已停止，请核对停止前已完成的操作。" : error instanceof Error ? error.message : String(error) });
    } finally {
      chatController = undefined;
      send({ type: "chatState", running: false });
      status(paused ? "已暂停" : "本地助手已连接");
    }
  })();
}

async function register() {
  state = { id: crypto.randomUUID(), token: randomBytes(32).toString("base64url"), code: randomBytes(6).toString("hex").toUpperCase(), server: server.href, registeredAt: Date.now() };
  await request("register", { id: state.id, code: state.code, name: hostname().slice(0, 100), version: helperVersion });
  await writeAtomic(statePath, JSON.stringify(state));
  status("请在网页“设置 → 本地助手”输入配对码");
}

async function execute(job: LocalHelperJob) {
  const controller = active!.controller;
  const result: LocalHelperResult = { id: job.id, nonce: job.nonce };
  let action = "invalid";
  try {
    const operation = localComputerRequest.parse(job.request);
    action = operation.action;
    result.result = await runOperation(operation, controller.signal);
  } catch (error) { result.error = (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
  // 先落盘再回报；重连只重传结果，永不重新执行命令。
  await writeAtomic(resultPath, JSON.stringify(result));
  await appendFile(join(dataDirectory, "activity.jsonl"), JSON.stringify({ at: new Date().toISOString(), id: job.id, action, success: !result.error }) + "\n");
  status(result.error ? `操作未完成：${result.error}` : "本机操作完成，正在回传结果");
}

async function flushResult() {
  let result: LocalHelperResult;
  try { result = JSON.parse(await readFile(resultPath, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  let rejected = false;
  try { await request("result", result); }
  catch (error) {
    if ((error as { status?: number }).status !== 409) throw error;
    rejected = true;
  }
  await rm(resultPath);
  if (active?.job.id === result.id) active = undefined;
  status(rejected ? "原任务授权已结束，结果未提交；请核对本机状态" : paused ? "已暂停" : "本地助手已连接");
}

await mkdir(dataDirectory, { recursive: true });
try {
  state = stateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
  if (state.server !== server.href) throw new Error("服务地址与已保存设备不匹配，请先使用原地址解除绑定");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

let retryDelay = 1000;
while (!lifetime.signal.aborted) {
  try {
    if (!state) await register();
    if (resetting) {
      await active?.done;
      await chatDone;
      chatHistory = []; send({ type: "chatReset" });
      await request("revoke", {}).catch((error: { status?: number }) => { if (error.status !== 401) throw error; });
      await rm(statePath, { force: true });
      await rm(resultPath, { force: true });
      active = undefined; ownerName = ""; resetting = false;
      await register();
    }
    await flushResult();
    const poll = await request<LocalHelperPoll>("poll", { activeId: active?.job.id, approved: authorizedOwner !== undefined,
      paused, autoExecute, version: helperVersion });
    retryDelay = 1000;
    for (const id of poll.cancelled) if (active?.job.id === id) active.controller.abort();
    if (poll.owner && authorizedOwner !== poll.owner.id && !paused) {
      ownerName = poll.owner.name;
      const allowed = await confirm("连接本地电脑", `${server.href}\n\n账户：${ownerName}\n\n允许 UnionFlow AI 读取当前 Windows 用户可访问的本机文件。读取的内容会发送到平台并用于 AI 对话。\n写入、上传下载、删除、执行命令和安装软件仍逐次确认；可在托盘中开启本次运行的自动执行。\n\n是否允许连接？`, lifetime.signal);
      if (allowed) { authorizedOwner = poll.owner.id; status("本地助手已连接"); }
      else { paused = true; status("连接未授权，已暂停"); }
    }
    if (!poll.owner && !active && Date.now() - state.registeredAt > 9 * 60000) { await request("revoke", {}); await register(); }
    if (poll.job && !active && !paused && authorizedOwner === poll.owner?.id) {
      active = { job: poll.job, controller: new AbortController(), done: Promise.resolve() };
      active.done = execute(poll.job).catch(error => { paused = true; status(`无法保存执行记录，已暂停：${error instanceof Error ? error.message : error}`); });
    }
    if (!poll.owner || paused || authorizedOwner === undefined) await setTimeout(2000, undefined, { signal: lifetime.signal });
  } catch (error) {
    if (lifetime.signal.aborted) break;
    if ((error as { status?: number }).status === 401) {
      active?.controller.abort();
      chatController?.abort();
      await active?.done;
      await chatDone;
      chatHistory = []; send({ type: "chatReset" });
      authorizedOwner = undefined; autoExecute = false; active = undefined; ownerName = "";
      await rm(resultPath, { force: true });
      await rm(statePath, { force: true });
      state = undefined!;
    }
    status(`连接暂不可用：${error instanceof Error ? error.message : error}，稍后重连`);
    await setTimeout(retryDelay, undefined, { signal: lifetime.signal }).catch(() => {});
    retryDelay = Math.min(30000, retryDelay * 2);
  }
}
active?.controller.abort();
chatController?.abort();
await active?.done;
await chatDone;
controls.close();
process.exit(0);
