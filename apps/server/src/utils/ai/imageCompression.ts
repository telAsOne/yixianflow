import { createHash } from "node:crypto";
import { requireAccount } from "@/utils/account";
import { cacheFile, readCache, writeCache } from "@/utils/cache";
import { detectMimeType } from "@/utils/media/mimeType";

export const preserveAiImage = Symbol("preserveAiImage");
export type RequestPart = { type: string; content?: string | RequestPart[]; [preserveAiImage]?: boolean; [key: string]: unknown };
export type RequestMessage = { role?: string; content?: string | RequestPart[]; output?: string | RequestPart[]; [key: string]: unknown };
export type RequestPayload = { messages?: RequestMessage[]; input?: RequestMessage[]; [key: string]: unknown };

type ImageData = { part: RequestPart; data: string; mimeType: string };
type ImageJob = { promise: Promise<string | null>; controller: AbortController; users: number };
const pending = new Map<string, ImageJob>();
let queue = Promise.resolve();
const minImageBytes = 512 * 1024;
const maxImagePixels = 32 * 1024 * 1024;

function imageProperties(bytes: Buffer, mimeType: string) {
  let alpha = false;
  let animated = false;
  if (mimeType === "image/png") {
    alpha = bytes[25] === 4 || bytes[25] === 6;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      const kind = bytes.toString("ascii", offset + 4, offset + 8);
      if (offset + 12 + length > bytes.length) throw new Error("Invalid PNG chunk length");
      alpha ||= kind === "tRNS";
      animated ||= kind === "acTL" || kind === "fcTL" || kind === "fdAT";
      offset += 12 + length;
    }
  } else if (mimeType === "image/webp") {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const length = bytes.readUInt32LE(offset + 4);
      const kind = bytes.toString("ascii", offset, offset + 4);
      if (offset + 8 + length > bytes.length) throw new Error("Invalid WebP chunk length");
      alpha ||= kind === "ALPH" || kind === "VP8X" && length >= 1 && !!(bytes[offset + 8] & 0x10)
        || kind === "VP8L" && length >= 5 && !!(bytes[offset + 12] & 0x10);
      animated ||= kind === "ANIM" || kind === "ANMF" || kind === "VP8X" && length >= 1 && !!(bytes[offset + 8] & 0x02);
      offset += 8 + length + length % 2;
    }
  }
  return { alpha, animated };
}

async function compressImage(data: string, mimeType: string, scope: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const hash = createHash("sha256").update(data).digest("hex");
  const path = cacheFile("aiImages", JSON.stringify([scope, hash, "jpeg", 80, 1]));
  const cached = await readCache<string | null>(path);
  signal?.throwIfAborted();
  if (cached !== undefined) return cached;
  let job = pending.get(path);
  if (!job) {
    const controller = new AbortController();
    const operation = queue.then(async () => {
      controller.signal.throwIfAborted();
      const bytes = Buffer.from(data, "base64");
      const actualMimeType = detectMimeType(bytes, mimeType);
      let result: string | null = null;
      if (["image/jpeg", "image/png", "image/webp"].includes(actualMimeType)) {
        const properties = imageProperties(bytes, actualMimeType);
        if (!properties.animated) {
          const image = new Bun.Image(bytes, { maxPixels: maxImagePixels });
          let metadata: Bun.Image.Metadata | undefined;
          try { metadata = await image.metadata(); }
          catch (error) {
            if ((error as { code?: string }).code !== "ERR_IMAGE_TOO_MANY_PIXELS") throw error;
          }
          controller.signal.throwIfAborted();
          if (metadata && (!properties.alpha || metadata.width <= 16383 && metadata.height <= 16383)) {
            // ACT: Bun 无 alpha 元数据；仅有透明通道的图片无损重编码一次，区分全不透明 RGBA 与实际透明图。
            const transparent = properties.alpha && imageProperties(await image.webp({ lossless: true }).buffer(), "image/webp").alpha;
            controller.signal.throwIfAborted();
            if (!transparent) {
              const compressed = await image.jpeg({ quality: 80 }).buffer();
              if (compressed.length < bytes.length) result = `data:image/jpeg;base64,${compressed.toString("base64")}`;
            }
          }
        }
      }
      controller.signal.throwIfAborted();
      await writeCache(path, result);
      return result;
    }).finally(() => { if (pending.get(path) === job) pending.delete(path); });
    // ACT: 编码单并发，同图共享任务；等待队列保留请求已有的 base64，进入编码时才分配像素与字节缓冲。
    queue = operation.then(() => {}, () => {});
    job = { promise: operation, controller, users: 0 };
    pending.set(path, job);
  }
  job.users++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (--job.users === 0) {
      if (pending.get(path) === job) pending.delete(path);
      job.controller.abort();
    }
  };
  signal?.addEventListener("abort", release, { once: true });
  if (signal?.aborted) release();
  try {
    const result = await job.promise;
    signal?.throwIfAborted();
    return result;
  } finally { signal?.removeEventListener("abort", release); release(); }
}

function collectImages(parts: RequestPart[], images: ImageData[]) {
  for (const part of parts) {
    if (part.type === "tool_result" && Array.isArray(part.content)) collectImages(part.content, images);
    let url: unknown;
    if (part.type === "image_url") url = (part.image_url as { url?: unknown } | undefined)?.url;
    else if (part.type === "input_image") url = part.image_url;
    else if (part.type === "image") {
      const source = part.source as { type?: string; media_type?: string; data?: string } | undefined;
      if (source?.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string") {
        images.push({ part, data: source.data, mimeType: source.media_type });
      }
    }
    if (typeof url !== "string" || !url.startsWith("data:image/")) continue;
    const separator = url.indexOf(";base64,");
    if (separator > 0) images.push({ part, data: url.slice(separator + 8), mimeType: url.slice(5, separator) });
  }
}

function replaceImages(parts: RequestPart[], replacements: Map<RequestPart, string>): RequestPart[] {
  return parts.map(part => {
    if (part.type === "tool_result" && Array.isArray(part.content)) return { ...part, content: replaceImages(part.content, replacements) };
    const url = replacements.get(part);
    if (!url) return part;
    if (part.type === "image_url") return { ...part, image_url: { ...part.image_url as object, url } };
    if (part.type === "input_image") return { ...part, image_url: url };
    return { ...part, source: { ...part.source as object, media_type: "image/jpeg", data: url.slice(url.indexOf(",") + 1) } };
  });
}

export async function compressRequestImages(payload: RequestPayload, field: "messages" | "input", directory?: string, signal?: AbortSignal): Promise<RequestPayload> {
  const messages = payload[field]!;
  const images: ImageData[] = [];
  for (const message of messages) {
    if (Array.isArray(message.content)) collectImages(message.content, images);
    if (Array.isArray(message.output)) collectImages(message.output, images);
  }
  // 同图同时以普通图和蒙版出现时，所有引用均保留原样，包括工具返回的相同图片。
  const preserved = new Set(images.filter(image => image.part[preserveAiImage]).map(image => image.data));
  const candidates = images.filter(image => !preserved.has(image.data)
    && ["image/jpeg", "image/png", "image/webp"].includes(image.mimeType)
    && Buffer.byteLength(image.data, "base64") > minImageBytes);
  if (!candidates.length) return payload;
  const account = requireAccount();
  const scope = JSON.stringify([account.baseUrl, account.user.id, directory ?? "inline"]);
  const replacements = new Map<RequestPart, string>();
  const processed = new Map<string, string | null>();
  for (const image of candidates) {
    if (!processed.has(image.data)) processed.set(image.data, await compressImage(image.data, image.mimeType, scope, signal));
    const compressed = processed.get(image.data);
    if (compressed) replacements.set(image.part, compressed);
  }
  if (!replacements.size) return payload;
  return { ...payload, [field]: messages.map(message => ({
    ...message,
    ...(Array.isArray(message.content) ? { content: replaceImages(message.content, replacements) } : {}),
    ...(Array.isArray(message.output) ? { output: replaceImages(message.output, replacements) } : {}),
  })) };
}
