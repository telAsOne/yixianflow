import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";

export default Router().post("/", validateFields({
  content: z.string().min(1).max(20000), context: z.string().max(20000).optional(), durationSeconds: z.number().positive().max(3600).optional(),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const account = u.account.requireAccount();
  const { content, context, durationSeconds } = req.body as { content: string; context?: string; durationSeconds?: number };
  if (!content.trim() || Array.from(content).length + Array.from(context ?? "").length > 10000) {
    res.status(400).json(error("审查正文与背景合计须为 1～10000 字；仍可直接生成", null, 400));
    return;
  }
  const controller = new AbortController();
  const close = () => controller.abort();
  res.once("close", close);
  req.once("aborted", close);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    res.set({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) res.write("\n"); }, 20000);
    // 辅助请求使用当前账户快照，不触发全局登出、模型刷新或视频任务状态变更。
    const response = await fetch(new URL("/v1/video-prompts/review", account.baseUrl), {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(610000)]),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${account.key}`, "X-Toonflow-Version": req.app.locals.appVersion || process.env.appVersion || "2.0.0" },
      body: JSON.stringify({ content, ...(context ? { context } : {}), ...(durationSeconds ? { duration_seconds: durationSeconds } : {}) }),
    });
    const body = await response.json() as Record<string, unknown> & { error?: { message?: unknown; code?: string } };
    if (u.account.getAccount() !== account) throw new Error("账户已切换，请重新发起审查");
    if (res.destroyed || controller.signal.aborted) return;
    if (!response.ok) {
      const message = typeof body.error?.message === "string" ? body.error.message.replaceAll(account.key, "••••••").slice(0, 1500) : "审查暂不可用，仍可直接生成";
      res.write(JSON.stringify(error(message, {
        ...(Number.isSafeInteger(body.review_id) ? { reviewId: body.review_id } : {}),
        ...(typeof body.request_id === "string" ? { requestId: body.request_id.slice(0, 256) } : {}),
      }, response.status)));
      return;
    }
    const { object, schema_version, review_id, request_id, model, status, summary, issues } = body;
    res.write(JSON.stringify(success({ object, schema_version, review_id, request_id, model, status, summary, issues })));
  } catch {
    if (!res.destroyed && !controller.signal.aborted) res.write(JSON.stringify(error("审查未完成，仍可直接生成；请手动重试，重试可能产生费用", null, 502)));
  } finally {
    clearInterval(heartbeat);
    res.off("close", close);
    req.off("aborted", close);
    res.end();
  }
});
