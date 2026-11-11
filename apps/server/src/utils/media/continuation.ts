import type { MediaGenerationRequest } from "@toonflow/tools-scaffold/runtime";

type ContinuationModel = { id: string; mode?: unknown };

function invalid(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }

/** NewAPI 提取末帧和尾部视频；画布只预留真实 API 位置并提交来源索引。 */
export function validateVideoContinuation(request: MediaGenerationRequest, model: ContinuationModel) {
  if (!request.continuation) return;
  if (request.providerId !== "yixianVideo") invalid("当前模型未提供续接视频能力");
  const index = request.continuation.videoIndex;
  if (!Number.isSafeInteger(index) || index < 0 || !request.videos?.[index]) invalid("续接来源必须是已添加的视频参考");
  if (request.firstFrame || request.lastFrame) invalid("当前模式不支持续接，请更换模式");
  const counts = { image: (request.images?.length ?? 0) + (request.referenceImageUrls?.length ?? 0) + 1,
    video: request.videos.length, audio: request.audios?.length ?? 0 };
  const compatible = (Array.isArray(model.mode) ? model.mode : []).some(mode => Array.isArray(mode)
    && (!request.mode || JSON.stringify(mode) === JSON.stringify(request.mode))
    && Object.entries(counts).every(([kind, count]) => count <= Number(mode.find(value => typeof value === "string" && value.startsWith(`${kind}Reference:`))?.split(":")[1] ?? 0)));
  if (!compatible) invalid("参考素材不符合当前模型要求，请减少素材或更换模型");
}
