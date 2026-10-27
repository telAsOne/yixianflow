import { Router } from "express";
import { z } from "zod";
import type { CanvasInfo } from "@toonflow/tools-scaffold/runtime";
import type { AgentEvent } from "@/agent/runtime/types";
import { validateFields } from "@/lib/middleware";
import u from "@/utils";
import { translateError, translateMessage } from "@/lib/i18n";
import { clientDirectorySchema } from "@/types/clientFiles";

const inputSchema = z.object({
  prompt: z.string().trim(), directory: z.string().min(1),
  attachments: u.agent.agentAttachmentsSchema.optional(),
  mentions: u.agent.agentMentionsSchema.optional(),
  providerId: z.string().min(1), modelId: z.string().min(1),
  thinkingLevel: z.enum(["off", "low", "medium", "high"]).optional(),
  sessionFile: z.string().regex(/^[\w-]+\.jsonl$/).optional(),
  runId: z.uuid().optional(), messageId: z.string().min(1).max(128).optional(),
  resendFrom: z.string().min(1).max(128).optional(),
  clientFiles: z.strictObject({ runId: z.uuid(), directory: clientDirectorySchema }).optional(),
  canvas: z.strictObject({
    id: z.string().min(1).max(256),
    tools: z.array(z.strictObject({
      nodeId: z.string().min(1).max(256),
      name: z.string().max(101).regex(/^node:[a-z][a-zA-Z0-9]*$/),
      nodeLabel: z.string().max(200).optional(),
      description: z.string().max(4000),
      parameters: z.record(z.string(), z.json()).refine(value => value.type === "object", "函数参数必须是 object JSON Schema"),
    })).max(1000),
  }).optional(),
});

export default Router().post("/", validateFields(inputSchema.shape), async (req, res) => {
  u.account.requireAccount();
  const { directory, canvas, clientFiles, ...options } = inputSchema.parse(req.body);
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  const device = u.mobileLink.getMobileLinkDevice(req);
  if (clientFiles && !device) throw Object.assign(new Error("本机文件读取仅支持已配对的操作端"), { status: 403 });
  res.set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const send = (event: AgentEvent) => {
    if (event.type === "error") event = { ...event, message: translateMessage(event.message) };
    if (event.type === "session") options.sessionFile = event.file;
    u.agent.trackAgentEvent(cwd, options.sessionFile, event);
    if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`);
  };
  const bridge = canvas ? u.canvas.createCanvasContext(cwd, canvas as CanvasInfo, send) : undefined;
  const controller = new AbortController();
  const fileBridge = clientFiles ? u.clientFileBridge.createClientFileContext(cwd, device!.id, clientFiles.runId, clientFiles.directory, send, () => controller.abort()) : undefined;
  const questions = u.question.createQuestionContext(cwd, send, () => controller.abort(), fileBridge?.context.ownerId);
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) res.write("\n");
  }, 20000);
  const close = () => { clearInterval(heartbeat); bridge?.dispose(); fileBridge?.dispose(); questions.dispose(); controller.abort(); };
  res.once("close", close);
  req.once("aborted", close);
  req.socket.once("close", close);
  try {
    await u.agent.run({ ...options, cwd, canvas: bridge?.context, clientFiles: fileBridge?.context, clientDeviceName: device?.name, question: questions.context, signal: controller.signal, onCancel: close }, send);
    send({ type: "done" });
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? translateError(error) : translateMessage("Agent 运行失败") });
  } finally {
    clearInterval(heartbeat);
    res.off("close", close);
    req.off("aborted", close);
    req.socket.off("close", close);
    bridge?.dispose();
    fileBridge?.dispose();
    questions.dispose();
    res.end();
  }
});
