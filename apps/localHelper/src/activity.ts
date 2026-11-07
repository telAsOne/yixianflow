import type {
  HelperApproval,
  HelperChatEntry,
  HelperLog,
  HelperRuntime,
  HelperSnapshot,
  HelperTask,
  HelperTransfer,
  HelperConversation,
  HelperUpdateState,
} from "./controlProtocol";

const snapshot: HelperSnapshot = { tasks: [], transfers: [], approvals: [], chat: [], chatRunning: false, logs: [] };

export function sendControl(message: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

export function sendSnapshot() {
  sendControl({ type: "snapshot", snapshot });
}
export function updateRuntime(runtime: HelperRuntime) {
  snapshot.runtime = runtime;
  sendControl({ type: "status", ...runtime });
}

export function updateTask(task: HelperTask) {
  const index = snapshot.tasks.findIndex((item) => item.id === task.id);
  if (index >= 0) snapshot.tasks[index] = task;
  else snapshot.tasks.unshift(task);
  // ACT: 历史只保存在本次进程内，保留最近 100 项和全部未结束任务；持久审计仍使用原日志。
  snapshot.tasks = snapshot.tasks.filter((item, position) => position < 100 || !item.finishedAt);
  sendControl({ type: "task", task });
}

export function updateTransfer(transfer: HelperTransfer) {
  const index = snapshot.transfers.findIndex((item) => item.id === transfer.id);
  if (index >= 0) snapshot.transfers[index] = transfer;
  else snapshot.transfers.unshift(transfer);
  snapshot.transfers = snapshot.transfers.filter((item, position) => position < 200 || ["running", "confirming"].includes(item.state));
  sendControl({ type: "transfer", transfer });
}

export function updateApproval(approval: HelperApproval, remove = false) {
  snapshot.approvals = snapshot.approvals.filter((item) => item.id !== approval.id);
  if (!remove) snapshot.approvals.push(approval);
  sendControl({ type: "approvals", approvals: snapshot.approvals });
}

export function recordChat(role: HelperChatEntry["role"], text: string) {
  const entry = { role, text, at: Date.now() };
  snapshot.chat.push(entry);
  sendControl({ type: "chatEntry", entry });
  return entry;
}

export function updateConversations(conversations: HelperConversation[], conversationId: string | null, chat?: HelperChatEntry[]) {
  snapshot.conversations = conversations;
  snapshot.conversationId = conversationId;
  if (chat) snapshot.chat = chat;
  sendControl({ type: "conversations", conversations, conversationId, ...(chat ? { chat } : {}) });
}
export function updateVersion(update: HelperUpdateState) {
  snapshot.update = update;
  sendControl({ type: "update", update });
}

export function setChatRunning(running: boolean) {
  snapshot.chatRunning = running;
}
export function resetChat() {
  snapshot.chat = [];
  sendControl({ type: "chatReset" });
}
export function recordLog(entry: HelperLog) {
  snapshot.logs.push(entry);
  if (snapshot.logs.length > 300) snapshot.logs.shift();
  sendControl({ type: "logEntry", entry });
}
export function updateEnvironment(environment: NonNullable<HelperSnapshot["environment"]>) {
  snapshot.environment = environment;
  sendControl({ type: "environment", environment });
}
