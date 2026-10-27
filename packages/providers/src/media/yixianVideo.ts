const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" }, validate: [{ required: true, message: "请登录逸仙账户" }] },
  { type: "input", field: "apiUrl" as const, title: "API 地址", value: "https://yixian.lol" },
];

type YixianResponse = {
  success?: boolean;
  id?: string;
  status?: string;
  progress?: number;
  error?: unknown;
  message?: string;
  data?: { asset?: { id?: string; media_type?: string } };
};
type YixianSnapshot = { base: string; body: { model: string; parameters: Record<string, unknown> } };

async function readBytes(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`逸仙接口返回空正文（HTTP ${response.status}）`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > limit) throw new Error("逸仙接口响应超过接收上限");
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("逸仙接口响应超过接收上限");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks, size);
}

async function apiRequest(context: ProviderContext, url: string, headers: Record<string, string>, init: RequestInit = {}) {
  const response = await context.tool.fetch(url, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(init.method === "POST" ? 300000 : 30000), redirect: "error", cache: "no-store" });
  const bytes = await readBytes(response, 1024 * 1024);
  let value: YixianResponse;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`逸仙接口未返回有效 JSON（HTTP ${response.status}），请保留原任务核查`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("逸仙接口返回的数据格式无效");
  return { response, value };
}

function responseMessage(context: ProviderContext, response: Response, value: YixianResponse) {
  return context.tool.errorMessage(`逸仙 HTTP ${response.status}：${context.tool.errorMessage(value) || "接口未返回有效结果"}`);
}

function modelFor(context: ProviderContext, id: string, type: ModelType) {
  const model = context.models.find(model => model.id === id && model.type === type);
  if (!model) throw new Error("模型不可用，请选择其他模型");
  return model;
}

async function createSnapshot(context: ProviderContext, base: string, headers: Record<string, string>, request: VideoRequest): Promise<YixianSnapshot> {
  const model = modelFor(context, request.model, "video");
  if (!request.prompt.trim()) throw new Error("请输入生成提示词");
  const images = request.images ?? [];
  const videos = request.videos ?? [];
  const audios = request.audios ?? [];
  const count = images.length + videos.length + audios.length;
  const matches = (mode: ImageMode | VideoMode) => {
    if (Array.isArray(mode)) return !request.firstFrame && !request.lastFrame && count > 0
      && [["image", images.length], ["video", videos.length], ["audio", audios.length]].every(([type, count]) =>
        Number(count) <= Number(mode.find(value => value.startsWith(type + "Reference:"))?.split(":")[1] ?? 0));
    if (mode === "text") return count === 0 && !request.firstFrame && !request.lastFrame;
    if (mode === "singleImage") return images.length === 1 && !videos.length && !audios.length && !request.firstFrame && !request.lastFrame;
    if (mode === "startEndRequired") return count === 0 && !!request.firstFrame && !!request.lastFrame;
    if (mode === "endFrameOptional") return count === 0 && !!request.firstFrame;
    if (mode === "startFrameOptional") return count === 0 && !!request.lastFrame;
    return false;
  };
  const modes = model.mode ?? [];
  if (!modes.some(mode => (request.mode === undefined || JSON.stringify(mode) === JSON.stringify(request.mode)) && matches(mode)))
    throw new Error("参考素材与模型声明的生成模式或数量不匹配");
  if (images.length < (model.minReferenceImages ?? 0)) throw new Error(`此模型至少需要 ${model.minReferenceImages} 张参考图片`);
  if (request.other && Object.keys(request.other).length || request.watermark !== undefined) throw new Error("此模型没有声明这些高级参数");
  const duration = request.duration ?? model.defaultDuration;
  const resolution = request.resolution ?? model.defaultResolution;
  const rows = model.durationResolutionMap ?? [];
  if (duration !== undefined && !rows.some(row => row.duration.includes(duration) && (resolution === undefined || row.resolution.includes(resolution))))
    throw new Error("时长或分辨率不在模型声明的范围内");
  if (resolution !== undefined && !rows.some(row => row.resolution.includes(resolution) && (duration === undefined || row.duration.includes(duration))))
    throw new Error("分辨率不在模型声明的范围内");
  if (request.ratio !== undefined && !model.videoRatios?.includes(request.ratio)) throw new Error("画面比例不在模型声明的范围内");
  if (request.seed !== undefined && (!model.supportsSeed || !Number.isSafeInteger(request.seed) || request.seed < 0)) throw new Error("模型不支持此 seed 或 seed 不是非负安全整数");
  if (request.generateAudio !== undefined && ((model.audio === undefined || model.audio === false) && request.generateAudio || model.audio === true && !request.generateAudio))
    throw new Error("声音设置不符合模型声明");
  const parameters: Record<string, unknown> = { prompt: request.prompt };
  if (duration !== undefined) parameters.duration = duration;
  if (resolution !== undefined) parameters.resolution = resolution;
  if (request.ratio !== undefined) parameters.aspect_ratio = request.ratio;
  if (request.seed !== undefined) parameters.seed = request.seed;
  if (model.audio === true) parameters.generate_audio = true;
  else if (model.audio === "optional" && request.generateAudio !== undefined) parameters.generate_audio = request.generateAudio;
  for (const [field, input] of [
    ...images.map((input, index) => [`ref_image_${index}`, input] as const),
    ...videos.map((input, index) => [`ref_video_${index}`, input] as const),
    ...audios.map((input, index) => [`ref_audio_${index}`, input] as const),
    ["first_frame", request.firstFrame], ["last_frame", request.lastFrame],
  ] as [string, MediaInput | undefined][]) {
    if (!input) continue;
    if (input.type !== "url" || !input.assetId) throw new Error("参考素材尚未上传到逸仙平台");
    parameters[field] = { asset_id: input.assetId };
  }
  return { base, body: { model: request.model, parameters } };
}

async function generateImage(this: ProviderContext, request: ImageRequest): Promise<MediaAsset[]> {
  const model = modelFor(this, request.model, "image");
  const images = request.images ?? [];
  const modes = model.mode ?? [];
  if (!request.prompt.trim()) throw new Error("请输入生成提示词");
  if (!modes.some(mode => mode === "text" && images.length === 0 || mode === "singleImage" && images.length === 1
    || mode === "multiReference" && images.length >= Math.max(1, model.minReferenceImages ?? 0))) throw new Error("参考图片不符合模型声明的生成模式");
  if (request.size !== undefined && !model.imageSizes?.includes(request.size)) throw new Error("图片尺寸不在模型声明的范围内");
  if (request.ratio !== undefined && !model.imageRatios?.includes(request.ratio)) throw new Error("画面比例不在模型声明的范围内");
  const n = request.n ?? 1;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("图片数量无效");
  const fields = { model: request.model, prompt: request.prompt, n, ...(request.size ? { size: request.size } : {}), ...(request.ratio ? { aspect_ratio: request.ratio } : {}) };
  const headers: Record<string, string> = { Authorization: `Bearer ${this.config.apiKey}` };
  let body: RequestInit["body"];
  if (images.length) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
    for (const input of images) {
      if (input.type !== "file") throw new Error("图像参考必须为工作区文件");
      form.append("image[]", input.file, input.name);
    }
    body = form;
  } else { headers["Content-Type"] = "application/json"; body = JSON.stringify(fields); }
  const response = await this.tool.fetch(`${this.config.apiUrl}/v1/images/${images.length ? "edits" : "generations"}`, {
    method: "POST", headers, body, signal: AbortSignal.timeout(300000), redirect: "error",
  });
  const bytes = await readBytes(response, 150 * 1024 * 1024);
  const result = JSON.parse(bytes.toString("utf8")) as { data?: { url?: string; b64_json?: string }[]; error?: unknown };
  if (!response.ok || !Array.isArray(result.data) || !result.data.length) throw new Error(this.tool.errorMessage(result) || `逸仙图像生成失败（HTTP ${response.status}）`);
  return result.data.map(item => {
    if (typeof item.b64_json === "string" && item.b64_json) return { type: "base64", data: item.b64_json, mimeType: "image/png", mediaType: "image" };
    if (typeof item.url === "string" && /^https:\/\//.test(item.url)) return { type: "url", url: item.url, mediaType: "image" };
    throw new Error("逸仙未返回有效图片");
  });
}

async function wait(context: ProviderContext, milliseconds: number) {
  context.signal?.throwIfAborted();
  await context.videoTask!.update({ retryAt: Date.now() + milliseconds });
  if (milliseconds > 60000) throw new Error(`逸仙接口要求等待 ${Math.ceil(milliseconds / 1000)} 秒，请稍后恢复原任务`);
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(context.signal?.reason); };
    const timer = setTimeout(() => { context.signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    context.signal?.addEventListener("abort", abort, { once: true });
    if (context.signal?.aborted) { context.signal.removeEventListener("abort", abort); abort(); }
  });
}

export default {
  id: "yixianVideo",
  label: "逸仙",
  version: "2.0.0",
  apiUrl: "https://yixian.lol",
  readme: "模型及能力由逸仙平台统一管理。",
  rules,
  models: [],
  generateImage,
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const task = this.videoTask;
    if (!task) throw new Error("逸仙视频需要持久化任务支持，请从视频节点或媒体生成工具使用");
    const apiKey = this.config.apiKey.trim().replace(/^Bearer\s+/i, "").trim();
    if (!apiKey) throw new Error("请填写逸仙 API Key");
    const url = new URL(this.config.apiUrl.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["/", "/v1", "/v1/"].includes(url.pathname)) throw new Error("逸仙 API 地址须为 HTTPS 站点根地址或 /v1 地址");
    const base = url.origin;
    const headers = { Authorization: `Bearer ${apiKey}` };
    if (task.state.phase === "failed") throw new Error(task.state.error || "逸仙原任务已失败，请确认后发起新生成");
    if (task.state.retryAt && task.state.retryAt > Date.now()) await wait(this, task.state.retryAt - Date.now());
    if (!task.state.taskId) {
      if (task.state.phase !== "prepared") throw new Error("逸仙提交受理状态尚未确认且没有任务编号，请到视频专栏核查；恢复不会重新提交生成");
      const snapshot: YixianSnapshot = task.requestSaved ? JSON.parse(await task.readRequest()) : await createSnapshot(this, base, headers, request);
      if (snapshot.base !== base) throw new Error("恢复任务须使用原逸仙 API 地址");
      if (!task.requestSaved) await task.saveRequest(JSON.stringify(snapshot));
      // ACT: 逸仙未提供提交幂等查询；提交前持久化状态，回执丢失时停止，避免重复付费生成。
      this.signal?.throwIfAborted();
      await task.update({ phase: "submitting", retryAt: undefined, error: undefined });
      const { response, value } = await apiRequest(this, `${base}/v1/videos`, headers, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot.body) });
      if (!response.ok || typeof value.id !== "string" || !value.id.trim() || value.id.length > 2048) {
        const message = responseMessage(this, response, value);
        const rejected = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status) && !value.id;
        await task.update({ ...(rejected ? { phase: "failed" as const } : {}), error: message });
        throw new Error(message);
      }
      await task.update({ taskId: value.id, phase: "queued", error: undefined });
    }
    const taskUrl = `${base}/v1/videos/${encodeURIComponent(task.state.taskId!)}`;
    const deadline = Date.now() + 30 * 60 * 1000;
    let failures = 0;
    while (task.state.phase !== "downloading") {
      this.signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new Error("逸仙本地等待已满 30 分钟，请恢复原任务继续查询");
      let result: Awaited<ReturnType<typeof apiRequest>>;
      try { result = await apiRequest(this, taskUrl, headers); }
      catch (error) {
        this.signal?.throwIfAborted();
        if (++failures >= 3) throw error;
        await wait(this, failures * 5000);
        continue;
      }
      const { response, value } = result;
      if (!response.ok) {
        if ([408, 429].includes(response.status) || response.status >= 500) {
          const header = response.headers.get("retry-after");
          const delay = header ? /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now() : 0;
          const milliseconds = Math.max(++failures * 5000, Number.isFinite(delay) ? delay : 0);
          await task.update({ retryAt: Date.now() + milliseconds });
          if (failures < 3) { await wait(this, milliseconds); continue; }
        }
        throw new Error(responseMessage(this, response, value));
      }
      failures = 0;
      if (value.id !== task.state.taskId) throw new Error("逸仙返回的任务编号不匹配，已保留原任务");
      if (value.status === "failed") {
        const error = this.tool.errorMessage(value) || "逸仙视频生成失败";
        await task.update({ phase: "failed", error, retryAt: undefined });
        throw new Error(error);
      }
      if (value.status === "completed") { await task.update({ phase: "downloading", progress: 100, retryAt: undefined, error: undefined }); break; }
      if (!["queued", "in_progress"].includes(value.status ?? "")) throw new Error("逸仙返回未知任务状态，已保留原任务，请稍后恢复查询");
      const progress = typeof value.progress === "number" && Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 100 ? value.progress : undefined;
      await task.update({ phase: value.status === "queued" ? "queued" : "in_progress", progress, retryAt: undefined, error: undefined });
      await wait(this, 5000);
    }
    return [await task.download(`${taskUrl}/content`, headers, "gateway")];
  },
} satisfies ProviderDefinition<typeof rules>;
