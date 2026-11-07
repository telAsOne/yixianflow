import { Router } from "express";
import type { BrowserFfmpegRequest } from "@toonflow/ffmpeg";
import { ffmpegRequest } from "@toonflow/local-helper/protocol";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { translateError, validationOptions } from "@/lib/i18n";

const inputSchema = ffmpegRequest;
// ACT: Bun 的静默 SSE 不保证触发断开事件；显式取消复用本接口和单进程会话状态。
const requests = new Map<string, { controller: AbortController; finished: Promise<void> }>();

export default Router().post("/", validateFields(inputSchema.shape), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const input = inputSchema.parse(req.body, validationOptions()) as BrowserFfmpegRequest;
  const cwd = await u.workspace.resolveWorkspace(req, input.directory);
  const requestKey = `${cwd}\0${input.requestId}`;
  if (input.operation.method === "cancel") {
    const active = requests.get(requestKey);
    active?.controller.abort();
    await active?.finished;
    res.json(success());
    return;
  }
  // 服务器只协调任务；素材路径由统一入口检查，编码和探测交给选定的本地助手。
  const controller = new AbortController();
  const finished = Promise.withResolvers<void>();
  if (input.operation.method !== "prepare") {
    if (requests.has(requestKey)) throw Object.assign(new Error("FFmpeg 请求已在执行"), { status: 409 });
    requests.set(requestKey, { controller, finished: finished.promise });
  }
  const close = () => controller.abort();
  res.once("close", close);
  req.once("aborted", close);
  req.socket.once("close", close);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    if (input.operation.method === "prepare") {
      await u.ffmpeg.createWorkspaceFfmpeg(cwd, controller.signal);
      res.json(success());
      return;
    }
    res.set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    heartbeat = setInterval(() => { if (!res.destroyed) res.write(": keepalive\n\n"); }, 1000);
    await u.ffmpeg.executeWorkspaceFfmpeg(cwd, input, event => {
      const failure = event.event === "error" ? event.args[0] as { message?: unknown; i18nMessage?: unknown } | undefined : undefined;
      if (failure && typeof failure.message === "string") {
        const { i18nMessage, ...details } = failure;
        event = { ...event, args: [{ ...details, message: translateError(failure) }, ...event.args.slice(1)] };
      }
      if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    }, controller.signal);
    res.end();
  } catch (error) {
    if (!res.headersSent) throw error;
    if (!res.destroyed) {
      const failure = error as Error & { code?: string };
      res.write(`data: ${JSON.stringify({ event: "error", args: [{ name: failure.name, message: translateError(error), code: failure.code }] })}\n\n`);
      res.end();
    }
  } finally {
    if (requests.get(requestKey)?.controller === controller) requests.delete(requestKey);
    clearInterval(heartbeat);
    res.off("close", close);
    req.off("aborted", close);
    req.socket.off("close", close);
    finished.resolve();
  }
});
