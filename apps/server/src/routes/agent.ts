import { Router } from "express";
import { z } from "zod";
import type { CanvasInfo } from "@toonflow/tools-scaffold/runtime";
import type { AgentEvent } from "@/agent/runtime/types";
import { validateFields } from "@/lib/middleware";
import u from "@/utils";
import { translateError, translateMessage } from "@/lib/i18n";
import { clientDirectorySchema } from "@/types/clientFiles";
import { isWebMode, webContext } from "@/lib/webContext";
import { subscribeProject } from "@/utils/web/projectEvents";

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
    id: z.string().max(256),
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
  const actor = webContext.getStore();
  const presenceId = crypto.randomUUID();
  const projectId = isWebMode() ? directory : undefined;
  const project = projectId ? await u.webProjects.getWebProject(projectId, "edit") : undefined;
  const helper = projectId ? await u.localHelper.getSelectedDevice() : undefined;
  let aiActivity = "AI 正在思考";
  let aiSelected: string[] = [];
  let failed = false;
  let finished = false;
  const updatePresence = (leave = false) => {
    if (!project || !actor) return;
    webContext.run(actor, () => u.collaboration.updateProjectPresence(project, { sessionId: presenceId, path: canvas?.id ?? "", panel: "canvas", visible: true, activity: aiActivity, selected: aiSelected, leave }, true));
  };
  const updateTargets = (args?: Record<string, unknown>) => {
    if (!args) return;
    const ids = [args.nodeId, args.sourceNodeId, args.targetNodeId, ...(Array.isArray(args.nodeIds) ? args.nodeIds : [])]
      .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 500);
    if (ids.length) aiSelected = [...new Set(ids)].slice(0, 100);
  };
  updatePresence();
  if (projectId) await u.collaboration.recordProjectActivity(cwd, "AI 开始处理项目", canvas?.id ?? "");
  res.set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const send = (event: AgentEvent) => {
    if (projectId && event.type === "tool") {
      updateTargets(event.tool.args);
      aiActivity = event.tool.status !== "running" ? "AI 正在整理结果" : event.tool.name === "localComputer" && helper ? `AI 正在使用本机 ${helper.name}`.slice(0, 160) : "AI 正在执行任务";
      updatePresence();
    }
    if (projectId && event.type === "canvasCall") { updateTargets(event.args); aiActivity = "AI 正在操作画布"; updatePresence(); }
    if (projectId && event.type === "question") { aiActivity = "AI 等待发起人确认"; updatePresence(); }
    if (event.type === "error") event = { ...event, message: translateMessage(event.message) };
    if (event.type === "session") options.sessionFile = event.file;
    u.agent.trackAgentEvent(cwd, options.sessionFile, event);
    if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`);
  };
  const bridge = canvas ? u.canvas.createCanvasContext(cwd, canvas as CanvasInfo, send) : undefined;
  const controller = new AbortController();
  const fileBridge = clientFiles ? u.clientFileBridge.createClientFileContext(cwd, device!.id, clientFiles.runId, clientFiles.directory, send, () => controller.abort()) : undefined;
  const questions = u.question.createQuestionContext(cwd, send, () => controller.abort(), fileBridge?.context.ownerId);
  const authorizeProject = async () => {
    if (!projectId) return;
    const session = await u.webAuth.readWebSession(req);
    if (!session) throw new Error("登录已失效");
    await webContext.run(session, () => u.webProjects.getWebProject(projectId, "edit"));
  };
  const heartbeat = setInterval(() => {
    if (!finished && projectId) void authorizeProject().catch(() => close());
    if (!finished) updatePresence();
    if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) res.write("\n");
  }, 20000);
  const close = () => { finished = true; clearInterval(heartbeat); updatePresence(true); bridge?.dispose(); fileBridge?.dispose(); questions.dispose(); controller.abort(); };
  const unsubscribe = projectId ? subscribeProject(projectId, event => { if (event.type === "permissions") void authorizeProject().catch(() => close()); }) : undefined;
  res.once("close", close);
  req.once("aborted", close);
  req.socket.once("close", close);
  try {
    await u.agent.run({ ...options, cwd, canvas: bridge?.context, clientFiles: fileBridge?.context, clientDeviceName: device?.name, question: questions.context, signal: controller.signal, onCancel: close }, send);
    send({ type: "done" });
  } catch (error) {
    failed = true;
    send({ type: "error", message: error instanceof Error ? translateError(error) : translateMessage("Agent 运行失败") });
  } finally {
    finished = true;
    updatePresence(true);
    if (projectId) await u.collaboration.recordProjectActivity(cwd, controller.signal.aborted ? "AI 操作已停止" : failed ? "AI 本轮处理失败" : "AI 本轮处理结束", canvas?.id ?? "", aiSelected).catch(() => { console.warn("[collaboration] AI activity could not be saved"); });
    clearInterval(heartbeat);
    unsubscribe?.();
    res.off("close", close);
    req.off("aborted", close);
    req.socket.off("close", close);
    bridge?.dispose();
    fileBridge?.dispose();
    questions.dispose();
    res.end();
  }
});
