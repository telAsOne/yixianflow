import useWorkspaceFiles from "@/lib/workspaceFiles";
import type { BrowserMediaRequest, BrowserMediaResult, MediaFrame } from "@toonflow/server/mediaRead";

function mediaEvent(video: HTMLVideoElement, event: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      video.removeEventListener(event, ready);
      video.removeEventListener("error", failed);
      signal.removeEventListener("abort", aborted);
      error ? reject(error) : resolve();
    };
    const ready = () => finish();
    const failed = () => finish(new Error(`浏览器无法解码此视频：${video.error?.message || video.error?.code || "格式不支持"}；可改用本地助手`));
    const aborted = () => finish(signal.reason ?? new Error("网页媒体读取已取消"));
    const timer = setTimeout(() => finish(new Error("等待网页视频帧超时，可重试此区间或使用本地助手")), 30000);
    video.addEventListener(event, ready, { once: true });
    video.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

export async function readBrowserMedia(directory: string, request: BrowserMediaRequest, signal: AbortSignal): Promise<BrowserMediaResult> {
  signal.throwIfAborted();
  const files = useWorkspaceFiles(directory);
  const info = await files.getMediaInfo(request.path);
  if (info.revision !== request.revision) throw new Error("视频版本已变化，请重新读取");
  if (!info.mimeType.startsWith("video/")) throw new Error("网页备用解码目前读取视频画面；音频处理请使用本地助手");
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = "anonymous";
  const canvas = document.createElement("canvas");
  try {
    const loaded = mediaEvent(video, "loadeddata", signal);
    video.src = new URL(info.url, location.origin).href;
    video.load();
    await loaded;
    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) throw new Error("网页没有取得有效视频时长和尺寸");
    const frames: MediaFrame[] = [];
    for (const time of request.times) {
      signal.throwIfAborted();
      if (time < 0 || time >= video.duration) throw new Error("抽帧位置超出网页视频时长");
      if (Math.abs(video.currentTime - time) > 0.000001) {
        const ready = mediaEvent(video, "seeked", signal);
        video.currentTime = time;
        await ready;
      }
      const crop = request.crop ?? { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight };
      if (crop.x + crop.width > video.videoWidth || crop.y + crop.height > video.videoHeight) throw new Error("裁剪范围超出视频画面");
      const scale = request.maxEdge ? Math.min(1, request.maxEdge / Math.max(crop.width, crop.height)) : 1;
      canvas.width = Math.max(1, Math.round(crop.width * scale));
      canvas.height = Math.max(1, Math.round(crop.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("当前浏览器没有可用 Canvas 解码能力");
      let frameTime: number | undefined;
      const image = await new Promise<Blob>((resolve, reject) => {
        let captured = false;
        let callback: number | undefined;
        const capture = (seconds?: number) => {
          if (captured) return;
          captured = true;
          clearTimeout(timer);
          if (callback !== undefined) video.cancelVideoFrameCallback(callback);
          signal.removeEventListener("abort", aborted);
          frameTime = seconds;
          try {
            context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("网页视频帧编码失败")), "image/jpeg", 0.88);
          } catch (error) { reject(error); }
        };
        const aborted = () => {
          captured = true;
          clearTimeout(timer);
          if (callback !== undefined) video.cancelVideoFrameCallback(callback);
          reject(signal.reason ?? new Error("网页媒体读取已取消"));
        };
        // 暂停视频未触发呈现回调时仍可读取当前画面，并如实标为 seek 定位。
        const timer = setTimeout(() => capture(), 150);
        signal.addEventListener("abort", aborted, { once: true });
        if (typeof video.requestVideoFrameCallback === "function") callback = video.requestVideoFrameCallback((_now, metadata) => capture(metadata.mediaTime));
        if (signal.aborted) aborted();
      });
      signal.throwIfAborted();
      const path = `${request.outputDirectory}/frame${crypto.randomUUID()}.jpg`;
      await files.write(path, image, true, signal);
      frames.push({ requestedSeconds: time, seconds: frameTime ?? video.currentTime, timestampKind: frameTime === undefined ? "browserSeek" : "decodedFrame",
        path, mimeType: "image/jpeg", width: canvas.width, height: canvas.height });
    }
    if ((await files.getMediaInfo(request.path)).revision !== request.revision) throw new Error("视频在网页读取期间变化，请重新读取");
    return { revision: request.revision, metadata: { duration: video.duration, width: video.videoWidth, height: video.videoHeight }, frames };
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    canvas.width = canvas.height = 1;
  }
}
