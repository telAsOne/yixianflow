import { computed, nextTick, onScopeDispose, ref } from "vue";
import { z } from "@toonflow/nodes-scaffold/nodeTools";

const reviewTargetSchema = z.object({
  source_id: z.string().max(128), shot_id: z.string().max(128).nullable(), field: z.enum(["content", "context"]),
  quote: z.string().min(1).max(20000), start_char: z.number().int().nonnegative().max(10000), end_char: z.number().int().positive().max(10000),
});
const reviewEditSchema = z.object({
  source_id: z.string().max(128), shot_id: z.string().max(128).nullable(), field: z.enum(["content", "context"]),
  original: z.string().min(1).max(20000), replacement: z.string().max(20000),
});
const reviewResultSchema = z.object({
  review_id: z.number().int().positive(), request_id: z.string().max(256), model: z.string().max(200),
  status: z.enum(["pass", "needs_revision", "needs_clarification"]), summary: z.string().max(20000),
  media_input_complete: z.boolean().optional(),
  media_coverage: z.array(z.object({ id: z.string(), type: z.enum(["image", "video", "audio"]), asset_id: z.string(), sha256: z.string(), status: z.string(), purpose: z.string().optional(), frame_seconds: z.array(z.number()).optional(), duration_seconds: z.number().optional(), warning: z.string().optional() })).max(16).nullable().optional(),
  issues: z.array(z.object({
    id: z.string().max(128), category: z.string().max(64), kind: z.enum(["conflict", "risk", "needs_clarification"]),
    severity: z.enum(["error", "warning"]), next_action: z.enum(["revise", "confirm"]),
    targets: z.array(reviewTargetSchema).min(1).max(8), reason: z.string().max(20000), impact: z.string().max(20000),
    suggestion: z.string().max(20000), edits: z.array(reviewEditSchema).max(16),
    media_evidence: z.array(z.object({ media_id: z.string(), observation: z.string().max(2000), frame_seconds: z.number().nonnegative().optional(), audio_start_seconds: z.number().nonnegative().optional(), audio_end_seconds: z.number().positive().optional() })).max(8).optional(),
  })).max(16),
});
const reviewInputSchema = z.object({
  content: z.string().max(20000), context: z.string().max(20000), editorPrompt: z.string().max(20000),
  dependencies: z.string().max(100000), durationSeconds: z.number().positive().max(3600).optional(),
  directory: z.string().max(4096).optional(), model: z.string().max(200).optional(), audioInput: z.boolean().optional(),
  media: z.array(z.object({ id: z.string().min(1).max(128), type: z.enum(["image", "video", "audio"]), path: z.string().min(1).max(8192), mimeType: z.string().max(100), purpose: z.string().max(1000).optional() })).max(16).optional(),
  continuation: z.object({ mediaId: z.string().min(1).max(128), frameId: z.string().min(1).max(128) }).optional(),
});
const reviewRecordSchema = z.object({
  input: reviewInputSchema, finishedAt: z.number(), result: reviewResultSchema.optional(),
  error: z.string().max(2000).optional(), reviewId: z.number().int().positive().optional(), requestId: z.string().max(256).optional(),
});
const reviewRunSchema = z.object({
  input: reviewInputSchema, startedAt: z.number(), finishedAt: z.number().optional(),
  state: z.enum(["running", "pass", "needs_confirmation", "stopped", "failed", "limit_reached"]), message: z.string().max(2000),
  rounds: z.array(z.object({ record: reviewRecordSchema, appliedPrompt: z.string().max(20000).optional() })).max(3),
});

export type PromptReviewInput = z.infer<typeof reviewInputSchema>;
export type PromptReviewRecord = z.infer<typeof reviewRecordSchema>;
export type PromptReviewResult = z.infer<typeof reviewResultSchema>;
export type PromptReviewEdit = z.infer<typeof reviewEditSchema>;
export type PromptReviewTarget = z.infer<typeof reviewTargetSchema>;
export type PromptReviewRun = z.infer<typeof reviewRunSchema>;
export type PromptReviewSubmission = { status: string; label: string; reviewId?: number; recordedAt: number };

export function samePromptReviewInput(first: PromptReviewInput, second: PromptReviewInput) {
  const firstMedia = first.media ?? [];
  const secondMedia = second.media ?? [];
  return first.content === second.content && first.context === second.context && first.editorPrompt === second.editorPrompt
    && first.dependencies === second.dependencies && first.durationSeconds === second.durationSeconds
    && (first.model ?? "") === (second.model ?? "") && !!first.audioInput === !!second.audioInput
    && (first.continuation?.mediaId ?? "") === (second.continuation?.mediaId ?? "")
    && (first.continuation?.frameId ?? "") === (second.continuation?.frameId ?? "")
    && (first.directory ?? "") === (second.directory ?? "") && firstMedia.length === secondMedia.length
    && firstMedia.every((media, index) => {
      const other = secondMedia[index]!;
      return media.id === other.id && media.type === other.type && media.path === other.path && media.mimeType === other.mimeType && (media.purpose ?? "") === (other.purpose ?? "");
    });
}

export function usePromptReview(options: {
  input(): PromptReviewInput; record(): unknown; save(record: PromptReviewRecord): void;
  run(): unknown; saveRun(run: PromptReviewRun): void; editable(): boolean; apply(prompt: string): void;
}) {
  const requestReviewing = ref(false);
  const automaticallyReviewing = ref(false);
  const reviewing = computed(() => requestReviewing.value || automaticallyReviewing.value);
  const transientError = ref("");
  let controller: AbortController | undefined;
  let automaticController: AbortController | undefined;
  let disposed = false;
  const record = computed(() => {
    const parsed = reviewRecordSchema.safeParse(options.record());
    return parsed.success ? parsed.data : undefined;
  });
  const run = computed(() => {
    const parsed = reviewRunSchema.safeParse(options.run());
    if (!parsed.success) return undefined;
    return parsed.data.state === "running" && !automaticallyReviewing.value
      ? { ...parsed.data, state: "stopped" as const, message: "上次多轮审查已中断，已保存的修改和报告仍保留；重新发起后才会继续审查。" }
      : parsed.data;
  });
  const current = computed(() => {
    try { return !!record.value && samePromptReviewInput(record.value.input, options.input()); }
    catch { return false; }
  });
  const status = computed(() => reviewing.value ? "reviewing" : transientError.value ? "failed" : !record.value ? "unreviewed"
    : !current.value ? "stale" : record.value.error ? "failed" : record.value.result?.media_input_complete === false ? "incomplete" : record.value.result?.status ?? "unreviewed");
  const label = computed(() => ({ unreviewed: "未审查", reviewing: "审查中", stale: "内容已变更 · 待重审", failed: "审查未完成",
    pass: "本次范围内未发现问题", incomplete: "素材未完整读取", needs_revision: "有待处理项", needs_clarification: "有待确认项" })[status.value]);
  const error = computed(() => transientError.value || record.value?.error || "");

  async function reviewOnce(force = false) {
    if (disposed || requestReviewing.value) return;
    if (!force && current.value && record.value?.result && !error.value) return;
    transientError.value = "";
    const activeController = new AbortController();
    controller = activeController;
    requestReviewing.value = true;
    let input: PromptReviewInput | undefined;
    try {
      input = reviewInputSchema.parse(options.input());
      if (!input.content.trim()) throw new Error("请输入需要审查的提示词");
      if (Array.from(input.content).length + Array.from(input.context).length > 10000) throw new Error("提示词与审查背景合计超过 10000 字，请缩短后再审查；仍可直接生成");
      const signal = AbortSignal.any([activeController.signal, AbortSignal.timeout(630000)]);
      const response = await fetch("/api/ai/videoPromptReview", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Toonflow-Workspace": "1" }, cache: "no-store", signal,
        body: JSON.stringify({ content: input.content, context: input.context, ...(input.durationSeconds ? { durationSeconds: input.durationSeconds } : {}),
          ...(input.media?.length ? { directory: input.directory, media: input.media, audioInput: input.audioInput } : {}),
          ...(input.continuation ? { continuation: input.continuation } : {}), ...(input.model ? { model: input.model } : {}) }),
      });
      const body = await response.json();
      signal.throwIfAborted();
      if (!response.ok || body?.code !== 200) {
        const failure = new Error(typeof body?.message === "string" && body.message ? body.message.slice(0, 1800) : "审查暂不可用，仍可直接生成");
        throw Object.assign(failure, { reviewId: body?.data?.reviewId, requestId: body?.data?.requestId });
      }
      const result = reviewResultSchema.parse(body.data);
      if (input.media?.length || input.continuation) {
        const expectedMedia = new Map((input.media ?? []).map(media => [media.id, media.type]));
        if (expectedMedia.size !== (input.media?.length ?? 0)) throw new Error("审查素材标记重复，请重新发起审查");
        if (input.continuation) {
          if (expectedMedia.get(input.continuation.mediaId) !== "video" || expectedMedia.has(input.continuation.frameId))
            throw new Error("续接审查素材标记无效，请重新发起审查");
          expectedMedia.set(input.continuation.frameId, "image");
        }
        const coverage = result.media_coverage;
        if (!coverage || coverage.length !== expectedMedia.size || new Set(coverage.map(item => item.id)).size !== coverage.length
          || coverage.some(item => expectedMedia.get(item.id) !== item.type))
          throw new Error("审查服务未返回完整的素材读取范围，请核对后手动重试");
        if (typeof result.media_input_complete !== "boolean" || result.media_input_complete
          && coverage.some(item => item.status !== ({ image: "reviewed_image", video: "reviewed_frames", audio: "reviewed_audio" })[item.type]))
          throw new Error("审查报告的素材读取结论无效，请核对后手动重试");
      }
      if ((result.status === "pass") !== (result.issues.length === 0)) throw new Error("审查报告的结论与问题列表不一致，请手动重试");
      for (const issue of result.issues) {
        for (const evidence of issue.media_evidence ?? []) {
          const media = result.media_coverage?.find(item => item.id === evidence.media_id);
          if (!media || ["unavailable", "audio_metadata"].includes(media.status) || evidence.frame_seconds !== undefined && !media.frame_seconds?.includes(evidence.frame_seconds))
            throw new Error("审查报告的素材证据无效，请核对后手动重试");
        }
        for (const target of issue.targets) {
          const source = input[target.field];
          if (target.shot_id !== null || Array.from(source).slice(target.start_char, target.end_char).join("") !== target.quote)
            throw new Error("审查报告的原文定位无效，请手动重试");
        }
      }
      if (!disposed && !activeController.signal.aborted) options.save({ input, result, finishedAt: Date.now() });
    } catch (failure) {
      if (disposed || activeController.signal.aborted) return;
      const message = failure instanceof z.ZodError ? "审查报告或输入格式无效，仍可直接生成"
        : failure instanceof Error && failure.name === "TimeoutError" ? "审查等待超时，仍可直接生成；请手动重试，重试可能产生费用"
        : failure instanceof Error ? failure.message : "审查暂不可用，仍可直接生成";
      const trace = failure as { reviewId?: unknown; requestId?: unknown } | null;
      const saved: PromptReviewRecord | undefined = input ? { input, error: message.slice(0, 1800), finishedAt: Date.now(),
        ...(Number.isSafeInteger(trace?.reviewId) && Number(trace?.reviewId) > 0 ? { reviewId: Number(trace?.reviewId) } : {}),
        ...(typeof trace?.requestId === "string" ? { requestId: trace.requestId.slice(0, 256) } : {}) } : undefined;
      // 审查和审查记录保存均为辅助操作，失败只反映在审查区。
      try { if (saved) options.save(saved); else transientError.value = message; }
      catch { transientError.value = "审查结果未能保存，仍可直接生成"; }
    } finally {
      if (controller === activeController) { controller = undefined; requestReviewing.value = false; }
    }
  }

  async function review(force = false) {
    if (!automaticallyReviewing.value) await reviewOnce(force);
  }

  function saveRun(value: PromptReviewRun) {
    options.saveRun({ ...value, rounds: value.rounds.map(round => ({ ...round })) });
  }

  async function reviewAutomatically() {
    if (disposed || reviewing.value) return;
    if (current.value && record.value?.result?.status === "pass" && record.value.result.media_input_complete !== false && !error.value) return;
    if (!options.editable()) { transientError.value = "当前节点暂不可自动修改提示词，请稍后发起一键审查；仍可单次审查。"; return; }
    const activeController = new AbortController();
    automaticController = activeController;
    automaticallyReviewing.value = true;
    let activeRun: PromptReviewRun | undefined;
    const finish = (state: PromptReviewRun["state"], message: string) => {
      if (!activeRun) return;
      activeRun.state = state;
      activeRun.message = message.slice(0, 2000);
      activeRun.finishedAt = Date.now();
      saveRun(activeRun);
    };
    try {
      let input = reviewInputSchema.parse(options.input());
      activeRun = { input, startedAt: Date.now(), state: "running", message: "准备开始多轮审查", rounds: [] };
      const seenPrompts = new Set([input.editorPrompt]);
      // ACT: 固定最多三轮，仅采用报告中的局部修改；不重试失败请求，不在刷新后自动续跑。
      for (let round = 1; round <= 3; round++) {
        if (disposed || activeController.signal.aborted) return;
        if (!samePromptReviewInput(input, options.input())) { finish("stopped", "编辑稿或参考配置已变化，已停止多轮审查，请核对后重新发起。"); return; }
        if (!options.editable()) { finish("stopped", "当前节点暂不可修改提示词，已停止多轮审查，保留已有修改和报告。"); return; }
        activeRun.message = `第 ${round}/3 轮：审查中，每轮按实际用量计费`;
        saveRun(activeRun);
        await reviewOnce();
        if (disposed || activeController.signal.aborted) return;
        const latest = record.value;
        if (!latest || !samePromptReviewInput(input, latest.input)) { finish("failed", error.value || "未取得本轮报告，已停止多轮审查，请核对后手动重试。"); return; }
        const entry: PromptReviewRun["rounds"][number] = { record: latest };
        activeRun.rounds.push(entry);
        if (!current.value || !samePromptReviewInput(input, options.input())) { finish("stopped", "审查期间编辑稿或参考配置已变化，已保留本轮报告并停止自动修改。"); return; }
        if (error.value || latest.error || !latest.result) { finish("failed", error.value || latest.error || "本轮审查未完成，已停止，不会自动重试。"); return; }
        const result = latest.result;
        if (result.media_input_complete === false) { finish("needs_confirmation", "部分素材未完整读取，已停止自动修改；请核对素材范围或选择支持原音的模型后重审。"); return; }
        if (result.status === "pass") { finish("pass", `第 ${round}/3 轮审查通过，已保留原稿、修改与每轮报告。`); return; }
        if (result.status === "needs_clarification" || result.issues.some(issue => issue.next_action === "confirm" || issue.kind === "needs_clarification")) {
          finish("needs_confirmation", "报告中有需要确认创作意图的问题，已停止自动修改，请查看报告后决定。"); return;
        }
        if (round === 3) { finish("limit_reached", "已完成最多 3 轮审查，仍有待处理项；已保留当前稿和报告，请手动确认。"); return; }
        if (!options.editable()) { finish("stopped", "当前节点暂不可修改提示词，已保留报告并停止自动修改。"); return; }
        if (result.issues.some(issue => !issue.edits.length)) { finish("needs_confirmation", "部分问题没有可直接采用的局部修改，已停止，请对照报告手动确认。"); return; }
        let prompt: string;
        try {
          prompt = applyPromptReviewEdits(input, result.issues.flatMap(issue => issue.edits));
          if (!prompt.trim() || prompt.length > 20000) throw new Error("修改后的提示词为空或过长，请手动确认");
          if (seenPrompts.has(prompt)) throw new Error("修改未带来变化或出现重复稿，已停止多轮审查");
        } catch (failure) {
          finish("needs_confirmation", failure instanceof Error ? failure.message : "无法安全采用局部修改，请手动确认。"); return;
        }
        options.apply(prompt);
        entry.appliedPrompt = prompt;
        activeRun.message = `已采用第 ${round} 轮局部修改，准备复审`;
        saveRun(activeRun);
        seenPrompts.add(prompt);
        input = reviewInputSchema.parse(options.input());
        if (input.editorPrompt !== prompt) { finish("stopped", "编辑稿未能保持本轮修改，已停止，请核对当前内容。"); return; }
        await nextTick();
      }
    } catch (failure) {
      if (disposed || activeController.signal.aborted) return;
      transientError.value = failure instanceof Error && !(failure instanceof z.ZodError) ? failure.message.slice(0, 1800) : "多轮审查未完成，已停止自动修改，仍可直接生成";
      try { finish("failed", transientError.value); }
      catch { transientError.value = "多轮审查记录未能保存，已停止自动修改，仍可直接生成"; }
    } finally {
      if (automaticController === activeController) { automaticController = undefined; automaticallyReviewing.value = false; }
    }
  }

  function cancel() {
    if (!controller && !automaticController) return;
    const activeRun = automaticController ? run.value : undefined;
    automaticController?.abort();
    automaticController = undefined;
    automaticallyReviewing.value = false;
    controller?.abort();
    controller = undefined;
    requestReviewing.value = false;
    transientError.value = "已停止等待审查；已发出的请求可能产生费用，仍可直接生成";
    if (activeRun) {
      try { saveRun({ ...activeRun, state: "stopped", finishedAt: Date.now(), message: "已停止多轮审查，已完成的修改和报告已保留；已发出的请求可能产生费用。" }); }
      catch { transientError.value = "停止记录未能保存；已停止多轮审查，仍可直接生成"; }
    }
  }

  function submission(): PromptReviewSubmission | undefined {
    // 只附加提交时的参考信息；任何审查异常都不能抛入视频提交、排队或恢复流程。
    try { return { status: status.value, label: label.value, reviewId: record.value?.result?.review_id ?? record.value?.reviewId, recordedAt: Date.now() }; }
    catch { return undefined; }
  }

  onScopeDispose(() => { disposed = true; automaticController?.abort(); controller?.abort(); });
  return { record, run, current, reviewing, status, label, error, review, reviewAutomatically, cancel, submission };
}

export function applyPromptReviewEdits(input: PromptReviewInput, edits: PromptReviewEdit[]) {
  if (!edits.length) throw new Error("这项建议需要手动确认创作意图");
  const replacements = edits.map(edit => {
    const start = input.editorPrompt.indexOf(edit.original);
    if (edit.field !== "content" || edit.shot_id !== null || start < 0 || input.editorPrompt.indexOf(edit.original, start + 1) >= 0
      || input.content.indexOf(edit.original) < 0 || input.content.indexOf(edit.original, input.content.indexOf(edit.original) + 1) >= 0)
      throw new Error("建议涉及连接文本、重复原文或其他来源，请对照引用手动修改");
    return { start, end: start + edit.original.length, replacement: edit.replacement };
  }).sort((a, b) => b.start - a.start);
  let prompt = input.editorPrompt;
  for (let index = 0; index < replacements.length; index++) {
    const edit = replacements[index];
    if (index && edit.end > replacements[index - 1].start) throw new Error("修改建议存在重叠，请对照原文手动修改");
    prompt = prompt.slice(0, edit.start) + edit.replacement + prompt.slice(edit.end);
  }
  return prompt;
}
