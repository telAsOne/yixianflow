import { z } from "zod";
import type { LocalHelperRequest } from "./protocol";

export type HelperTaskState = "queued" | "approval" | "running" | "completed" | "failed" | "cancelled";
export type HelperTask = {
  id: string;
  source: "web" | "tray";
  chatId?: string;
  action: LocalHelperRequest["action"];
  state: HelperTaskState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  completed?: number;
  failed?: number;
  exitCode?: number;
  truncated?: boolean;
};
export type HelperTransfer = {
  id: string;
  taskId: string;
  direction: "upload" | "download";
  path: string;
  target: string;
  state: "running" | "confirming" | "completed" | "failed" | "cancelled";
  bytes: number;
  total: number;
  startedAt: number;
  updatedAt: number;
  error?: string;
};
export type HelperApproval = { id: string; title: string; detail: string; taskId?: string; expiresAt: number };
export type HelperLog = { at: string; level: "info" | "warn" | "error"; event: string; [key: string]: unknown };
export type HelperChatEntry = { role: "user" | "assistant" | "tool" | "error"; text: string; at: number };
export type HelperConversation = { id: string; title: string; preview: string; createdAt: number; updatedAt: number; messageCount: number };
export type HelperUpdateState = {
  phase: "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "current" | "failed";
  currentVersion: string;
  version?: string;
  bytes: number;
  total: number;
  checkedAt?: number;
  error?: string;
  autoCheck: boolean;
  autoInstall: boolean;
  notes?: string;
};
export type HelperRuntime = {
  message: string;
  code?: string;
  server: string;
  owner: string;
  paused: boolean;
  autoExecute: boolean;
  connected: boolean;
  approved: boolean;
  version: string;
  computer: string;
  deviceId?: string;
};
export type HelperSnapshot = {
  runtime?: HelperRuntime;
  tasks: HelperTask[];
  transfers: HelperTransfer[];
  approvals: HelperApproval[];
  chat: HelperChatEntry[];
  chatRunning: boolean;
  logs: HelperLog[];
  conversations?: HelperConversation[];
  conversationId?: string | null;
  update?: HelperUpdateState;
  environment?: {
    computer: string;
    platform: string;
    version: string;
    home: string;
    drives: string[];
    tools: Record<string, string | null>;
    powershell: string;
  };
};
export const controlCommand = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("snapshot") }),
  z.strictObject({ type: z.literal("taskCancel"), id: z.string().min(1).max(256) }),
  z.strictObject({ type: z.literal("tools") }),
  z.strictObject({ type: z.literal("chatNew") }),
  z.strictObject({ type: z.literal("chatSelect"), id: z.uuid() }),
  z.strictObject({ type: z.literal("chatDelete"), id: z.uuid() }),
  z.strictObject({ type: z.literal("chatRename"), id: z.uuid(), title: z.string().trim().min(1).max(80) }),
  z.strictObject({ type: z.literal("updateCheck") }),
  z.strictObject({ type: z.literal("updateDownload") }),
  z.strictObject({ type: z.literal("updateInstall") }),
  z.strictObject({ type: z.literal("updatePreferences"), autoCheck: z.boolean(), autoInstall: z.boolean() }),
]);
