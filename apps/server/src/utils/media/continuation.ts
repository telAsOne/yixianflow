import { mkdir, mkdtemp, rm, stat } from "@toonflow/file";
import { createFfmpeg } from "@toonflow/ffmpeg/runtime";
import { join, relative } from "node:path";
import type { MediaGenerationRequest, MediaReference } from "@toonflow/tools-scaffold/runtime";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { preparePlatformReferences, uploadPlatformReferences } from "./upload";

type ContinuationModel = { id: string; mode?: unknown };

function invalid(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }

export async function uploadVideoContinuationSource(directory: string, source: MediaReference, signal?: AbortSignal) {
  const [original] = await preparePlatformReferences(directory, [{ ...source, mediaType: "video" }], signal);
  const ffmpeg = createFfmpeg(directory);
  const seconds = await new Promise<number>((resolve, reject) => {
    ffmpeg(original!.path).ffprobe((error, metadata) => error ? reject(error) : resolve(Number(metadata.format.duration)));
  });
  if (!Number.isFinite(seconds) || seconds <= 0) invalid("无法读取续接来源视频的时长");
  signal?.throwIfAborted();
  const root = (await resolveWorkspacePath(directory, ".toonflow/continuationSources", true)).path;
  await mkdir(root, { recursive: true });
  const temporary = await mkdtemp(join(root, "source"));
  try {
    const output = join(temporary, "source.mp4");
    // ACT: 仅处理副本；末尾三秒供平台提取末帧，原视频和画布绑定保持完整。
    await new Promise<void>((resolve, reject) => {
      const command = ffmpeg({ source: original!.path, timeout: 180 }).seekInput(Math.max(0, seconds - 3)).duration(Math.min(3, seconds))
        .inputOptions("-nostdin", "-protocol_whitelist", "file,pipe", "-threads", "1")
        .videoCodec("libx264").audioCodec("aac").format("mp4")
        .outputOptions("-n", "-threads", "1", "-preset", "fast", "-crf", "18", "-movflags", "+faststart");
      const cancel = () => command.kill("SIGKILL");
      signal?.addEventListener("abort", cancel, { once: true });
      command.on("start", () => { if (signal?.aborted) cancel(); });
      command.on("end", () => { signal?.removeEventListener("abort", cancel); resolve(); });
      command.on("error", error => { signal?.removeEventListener("abort", cancel); reject(error); });
      command.save(output);
    });
    signal?.throwIfAborted();
    const current = await stat(original!.path);
    if (current.size !== original!.size || current.mtimeMs !== original!.modified) invalid("续接来源视频已变化，请重新生成");
    const [uploaded] = await uploadPlatformReferences(directory, [{ path: relative(directory, output), mimeType: "video/mp4", mediaType: "video" }], signal);
    return uploaded!;
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(error => console.warn("续接参考临时文件清理失败", error));
  }
}

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
