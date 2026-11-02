import { z } from "zod";

export const helperVersion = "0.1.0";
const localPath = z.string().min(3).max(4096).regex(/^[a-z]:[\\/]/i, "请使用 Windows 本机磁盘的绝对路径");
export const localComputerRequest = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("status") }),
  z.strictObject({ action: z.literal("list"), path: localPath.optional(), offset: z.number().int().min(0).max(1000000).optional() }),
  z.strictObject({ action: z.literal("read"), path: localPath, offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    revision: z.string().max(128).optional(), encoding: z.enum(["utf8", "base64"]).optional() }),
  z.strictObject({ action: z.literal("write"), path: localPath, content: z.string().max(512000),
    encoding: z.enum(["utf8", "base64"]).optional(), revision: z.string().max(128).optional(), overwrite: z.boolean().optional() }),
  z.strictObject({ action: z.literal("mkdir"), path: localPath }),
  z.strictObject({ action: z.literal("move"), path: localPath, target: localPath }),
  z.strictObject({ action: z.literal("remove"), path: localPath, recursive: z.boolean().optional() }),
  z.strictObject({ action: z.literal("execute"), command: z.string().min(1).max(32000), cwd: localPath.optional(),
    timeoutSeconds: z.number().int().min(1).max(1200).optional() }),
  z.strictObject({ action: z.literal("install"), packageId: z.string().regex(/^[a-z\d][a-z\d._-]{1,127}$/i),
    timeoutSeconds: z.number().int().min(1).max(1200).optional() }),
]);

export type LocalComputerRequest = z.infer<typeof localComputerRequest>;
export type LocalHelperJob = { id: string; nonce: string; request: LocalComputerRequest };
export type LocalHelperResult = { id: string; nonce: string; result?: unknown; error?: string };
export type LocalHelperPoll = {
  owner: { id: number; name: string } | null;
  job: LocalHelperJob | null;
  cancelled: string[];
};
export type LocalHelperDevice = { id: string; name: string; online: boolean; approved: boolean; paused: boolean; autoExecute: boolean; version: string; lastSeenAt: string | null };
export type LocalHelperStatus = { devices: LocalHelperDevice[]; selectedId: string | null; downloadAvailable: boolean; version: string };
