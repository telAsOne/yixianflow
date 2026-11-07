import { dirname, join } from "node:path";
import { mkdir, stat, unlink, rename } from "@toonflow/file";
import { cacheDirectory, cacheFile, readCache, scheduleCachePrune, touchCache, writeCache } from "@/utils/cache";
import { executeFileFfmpeg } from "@/utils/ffmpeg";
import { requireMediaDevice } from "@/utils/localHelper/media";

type PreviewJob = { promise: Promise<string | undefined>; controller: AbortController; users: number };
const pending = new Map<string, PreviewJob>();
let queue = Promise.resolve();
type MediaInfo = { width?: number; height?: number; duration?: number };

export async function mediaPreview(source: string, revision: string, mimeType: string, size: 512 | 1024, signal: AbortSignal) {
  if (!/^(image\/(png|jpeg|webp|avif|bmp)|video\/)/.test(mimeType)) return source;
  const video = mimeType.startsWith("video/");
  const identity = JSON.stringify([source, revision, video ? 640 : size, 1]);
  const output = cacheFile("mediaPreviews", identity, video ? "jpg" : "png");
  if (await stat(output).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; })) { touchCache(output); return output; }
  try { await requireMediaDevice(); }
  catch (error) {
    if ((error as { status?: number }).status === 424) return video ? undefined : source;
    throw error;
  }
  let job = pending.get(output);
  if (!job) {
    const controller = new AbortController();
    const signal = controller.signal;
    const operation = queue.then(async () => {
      signal.throwIfAborted();
      const temporaryDirectory = join(dirname(cacheDirectory), "temp", "mediaPreviews");
      await mkdir(temporaryDirectory, { recursive: true });
      await mkdir(dirname(output), { recursive: true });
      const temporary = join(temporaryDirectory, `${crypto.randomUUID()}.${video ? "jpg" : "png"}`);
      try {
        const limit = video ? 640 : size;
        await executeFileFfmpeg(source, temporary, [
          { method: "frames", args: [1] },
          { method: "videoFilters", args: [{ filter: "scale", options: { w: limit, h: limit, force_original_aspect_ratio: "decrease" } }] },
          { method: "outputOptions", args: ["-threads", "1"] },
        ], { method: "save", args: [video ? "output.jpg" : "output.png"] }, signal);
        const metadataPath = cacheFile("mediaPreviews", JSON.stringify([source, revision, "info"]));
        if (!await readCache<MediaInfo>(metadataPath)) {
          const data = await executeFileFfmpeg(source, undefined, [], { method: "ffprobe", args: [] }, signal) as {
            streams?: { codec_type?: string; width?: number; height?: number }[]; format?: { duration?: string | number };
          };
          const stream = data.streams?.find(stream => stream.codec_type === "video");
          await writeCache(metadataPath, { width: stream?.width, height: stream?.height, duration: Number(data.format?.duration) || undefined });
        }
        await rename(temporary, output);
        touchCache(output);
        scheduleCachePrune();
        return output;
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      }
    }).finally(() => { if (pending.get(output) === job) pending.delete(output); });
    queue = operation.then(() => {}, () => {});
    job = { promise: operation, controller, users: 0 };
    pending.set(output, job);
  }
  job.users++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (--job.users === 0) {
      if (pending.get(output) === job) pending.delete(output);
      job.controller.abort();
    }
  };
  signal.addEventListener("abort", release, { once: true });
  if (signal.aborted) release();
  try {
    const result = await job.promise;
    signal.throwIfAborted();
    return result;
  } finally { signal.removeEventListener("abort", release); release(); }
}
