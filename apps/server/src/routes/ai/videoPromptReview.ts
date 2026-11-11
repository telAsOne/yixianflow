import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";
import { preparePlatformReferences, uploadContinuationReviewReference, uploadPlatformReferences } from "@/utils/media/upload";

const reviewMediaSchema = z.object({ id: z.string().min(1).max(128), type: z.enum(["image", "video", "audio"]), path: z.string().min(1).max(8192), mimeType: z.string().max(100), purpose: z.string().max(1000).optional() });
const continuationSchema = z.strictObject({ mediaId: z.string().min(1).max(128), frameId: z.string().min(1).max(128) });

export default Router().post("/", validateFields({
  content: z.string().min(1).max(20000), context: z.string().max(20000).optional(), durationSeconds: z.number().positive().max(3600).optional(),
  directory: z.string().min(1).max(4096).optional(), media: z.array(reviewMediaSchema).max(16).optional(), model: z.string().min(1).max(200).optional(), audioInput: z.boolean().optional(),
  continuation: continuationSchema.optional(),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const account = u.account.requireAccount();
  const { content, context, durationSeconds, directory, model, audioInput } = req.body as { content: string; context?: string; durationSeconds?: number; directory?: string; model?: string; audioInput?: boolean };
  const media = z.array(reviewMediaSchema).max(16).parse(req.body.media ?? []);
  const continuation = continuationSchema.optional().parse(req.body.continuation);
  const source = continuation && media.find(item => item.id === continuation.mediaId);
  if (new Set(media.map(item => item.id)).size !== media.length || continuation &&
    (!source || source.type !== "video" || /^https:\/\//i.test(source.path) || media.some(item => item.id === continuation.frameId) || media.length >= 16)) {
    res.status(400).json(error("续接审查来源或素材标识无效，请使用工作区内的视频，最多同时审查 15 项原始素材", null, 400));
    return;
  }
  if (!content.trim() || Array.from(content).length + Array.from(context ?? "").length > 10000) {
    res.status(400).json(error("审查正文与背景合计须为 1～10000 字；仍可直接生成", null, 400));
    return;
  }
  const controller = new AbortController();
  // Review uploads and model calls share one account snapshot. Their failures
  // must not invoke the normal generation transport's logout/config refresh.
  const reviewFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    controller.signal.throwIfAborted();
    if (u.account.getAccount() !== account) throw Object.assign(new Error("账户已切换，请重新发起审查"), { status: 401 });
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== new URL(account.baseUrl).origin || !url.pathname.startsWith("/v1/") || url.username || url.password) throw new Error("审查素材只允许调用当前平台接口");
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${account.key}`);
    headers.set("X-Toonflow-Version", req.app.locals.appVersion || process.env.appVersion || "2.0.0");
    return fetch(input, { ...init, headers, cache: "no-store", redirect: "error" });
  };
  const close = () => controller.abort();
  res.once("close", close);
  req.once("aborted", close);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    res.set({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) res.write("\n"); }, 20000);
    const local = media.filter(item => !/^https:\/\//i.test(item.path));
    if (local.length && !directory) throw new Error("请先选择素材所在的项目工作区");
    const cwd = local.length ? await u.workspace.resolveWorkspace(req, directory!) : "";
    if (source) await preparePlatformReferences(cwd, local.map(item => ({ path: item.path, mimeType: item.mimeType, mediaType: item.type })), controller.signal);
    const preview = source ? await uploadContinuationReviewReference(cwd, source, controller.signal, { account, request: reviewFetch }) : undefined;
    const ordinary = local.filter(item => item !== source);
    const uploaded = ordinary.length ? await uploadPlatformReferences(cwd, ordinary.map(item => ({ path: item.path, mimeType: item.mimeType, mediaType: item.type })), controller.signal, { account, request: reviewFetch }) : [];
    let localIndex = 0;
    const materials = media.map(item => item === source && preview ? {
      id: item.id, type: item.type,
      purpose: `续接来源原片共 ${preview.source_seconds} 秒，本次只读取最后 ${preview.tail_seconds} 秒；帧时间相对于尾部片段，未读取完整原片。只用来承接末段动作、人物状态和镜头运动，不修改原片、不在新增片段重演尾段。${audioInput ? "原音是否读取以报告的素材覆盖为准。" : "本次未听取原音，不判断音色、声源或原片是否有可听见的声音。"}`,
      asset_id: preview.tail.asset_id,
    } : { id: item.id, type: item.type, ...(item.purpose ? { purpose: item.purpose } : {}),
      ...(/^https:\/\//i.test(item.path) ? { url: item.path } : { asset_id: uploaded[localIndex++]!.assetId }) });
    if (preview && continuation) materials.push({ id: continuation.frameId, type: "image",
      asset_id: preview.frame.asset_id, purpose: `由续接流程从 ${continuation.mediaId} 自动提取的真实末帧，只作为新增片段起点的人物、姿态、构图、场景和光影依据，不是缺少定义的新人物或普通参考图。审查范围不含完整原片。` });
    if (u.account.getAccount() !== account) throw Object.assign(new Error("账户已切换，请重新发起审查"), { status: 401 });
    // 辅助请求使用当前账户快照，不触发全局登出、模型刷新或视频任务状态变更。
    const response = await reviewFetch(new URL("/v1/video-prompts/review", account.baseUrl), {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(610000)]),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${account.key}`, "X-Toonflow-Version": req.app.locals.appVersion || process.env.appVersion || "2.0.0" },
      body: JSON.stringify({ content, ...(context ? { context } : {}), ...(durationSeconds ? { duration_seconds: durationSeconds } : {}),
        ...(materials.length ? { media: materials, audio_input: !!audioInput } : {}), ...(model ? { model } : {}) }),
    });
    const body = await response.json() as Record<string, unknown> & { error?: { message?: unknown; code?: string; param?: string } };
    if (u.account.getAccount() !== account) throw Object.assign(new Error("账户已切换，请重新发起审查"), { status: 401 });
    if (res.destroyed || controller.signal.aborted) return;
    if (!response.ok) {
      const message = body.error?.code === "video_review.invalid_field" && ["media", "audio_input"].includes(body.error.param ?? "")
        ? "平台审查接口尚未支持素材输入，请更新平台后重试；也可取消结合素材，仅审查文字"
        : typeof body.error?.message === "string" ? body.error.message.replaceAll(account.key, "••••••").slice(0, 1500) : "审查暂不可用，仍可直接生成";
      res.write(JSON.stringify(error(message, {
        ...(Number.isSafeInteger(body.review_id) ? { reviewId: body.review_id } : {}),
        ...(typeof body.request_id === "string" ? { requestId: body.request_id.slice(0, 256) } : {}),
      }, response.status)));
      return;
    }
    const { object, schema_version, review_id, request_id, model: reviewModel, status, summary, issues, media_coverage, media_input_complete } = body;
    res.write(JSON.stringify(success({ object, schema_version, review_id, request_id, model: reviewModel, status, summary, issues, media_coverage, media_input_complete })));
  } catch (failure) {
    const message = failure instanceof Error ? failure.message.replaceAll(account.key, "••••••").slice(0, 1500) : "审查未完成";
    const status = Number((failure as { status?: unknown } | null)?.status);
    if (!res.destroyed && !controller.signal.aborted) res.write(JSON.stringify(error(`${message}；仍可直接生成。重试可能产生费用，请先核对审查记录。`, null, [400, 401, 403, 404, 413, 415].includes(status) ? status : 502)));
  } finally {
    clearInterval(heartbeat);
    res.off("close", close);
    req.off("aborted", close);
    res.end();
  }
});
