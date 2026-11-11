import { createHash } from "node:crypto";
import { basename } from "node:path";
import { stat } from "@toonflow/file";
import { file } from "@toonflow/file/bun";
import { z } from "zod";
import { t } from "@/lib/i18n";
import type { MediaReference } from "@toonflow/tools-scaffold/runtime";
import { requireAccount, getConfigState, platformFetch } from "@/utils/account";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { createReferenceCache } from "./referenceCache";
import { detectMimeType } from "./mimeType";

function invalid(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }

type Reference = MediaReference & { mediaType: "image" | "audio" | "video" };
type UploadOptions = {
  account?: ReturnType<typeof requireAccount>;
  request?: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;
};
const assetSchema = z.object({ success: z.literal(true), data: z.object({
  asset: z.object({ id: z.string().min(1).max(2048), media_type: z.enum(["image", "audio", "video"]) }), content_url: z.url({ protocol: /^https$/ }),
}) });
const continuationReviewSchema = z.object({
  source_seconds: z.number().positive().max(3600), tail_seconds: z.number().positive().max(3),
  tail: z.object({ asset_id: z.string().min(1).max(2048) }), frame: z.object({ asset_id: z.string().min(1).max(2048) }),
});

async function throwUploadFailure(response: Response, key: string): Promise<never> {
  const failure = await response.json().catch(() => undefined) as { error_code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown } } | undefined;
  const code = failure?.error_code ?? failure?.error?.code;
  const detail = failure?.message || failure?.error?.message;
  const message = typeof detail === "string" && detail.trim() ? detail :
    ({ 402: "余额不足，请充值后上传", 403: "账户存储已满", 413: "参考素材超过平台大小限制", 507: "服务器存储已满，请稍后再试" } as Record<number, string>)[response.status]
    || `上传素材失败（HTTP ${response.status}）`;
  throw Object.assign(new Error(message.replaceAll(key, "••••••").slice(0, 1500)), { status: response.status, code: typeof code === "string" ? code : undefined });
}

export async function preparePlatformReferences(directory: string, references: Reference[], signal?: AbortSignal, totalLimit?: number) {
  const { limits } = getConfigState();
  const maxTotalBytes = Math.min(limits.requestTotalMaxBytes, totalLimit ?? limits.requestTotalMaxBytes);
  if (references.length > limits.maxReferencesPerRequest) invalid(t`参考素材最多 ${limits.maxReferencesPerRequest} 个`);
  const prepared: { path: string; size: number; modified: number; mediaType: Reference["mediaType"]; mimeType: string; name: string }[] = [];
  let total = 0;
  let videoTotal = 0;
  for (const reference of references) {
    signal?.throwIfAborted();
    const { path } = await resolveWorkspacePath(directory, reference.path);
    const info = await stat(path);
    const limit = reference.mediaType === "video" ? Math.min(limits.videoMaxBytes, 20 * 1024 * 1024) : limits[`${reference.mediaType}MaxBytes`];
    if (!info.isFile() || !info.size || info.size > limit) invalid(t`参考素材为空或超过 ${limit / 1024 / 1024} MiB`, 413);
    total += info.size;
    if (reference.mediaType === "video") {
      videoTotal += info.size;
      if (videoTotal > 20 * 1024 * 1024) invalid("全部视频参考素材合计不能超过 20MB", 413);
    }
    if (total > maxTotalBytes) invalid(t`参考素材合计不能超过 ${maxTotalBytes / 1024 / 1024} MiB`, 413);
    prepared.push({ path, size: info.size, modified: info.mtimeMs, mediaType: reference.mediaType, mimeType: reference.mimeType, name: basename(path) });
  }
  for (const reference of prepared) {
    const header = new Uint8Array(await file(reference.path).slice(0, 512).arrayBuffer());
    if (!detectMimeType(header, "")) invalid("无法识别参考素材的文件格式", 415);
    reference.mimeType = detectMimeType(header, reference.mimeType);
    if (!reference.mimeType.startsWith(`${reference.mediaType}/`)) invalid("参考素材内容与媒体类型不匹配", 415);
  }
  return prepared;
}

export async function uploadPlatformReferences(directory: string, references: Reference[], signal?: AbortSignal, options?: UploadOptions): Promise<Extract<MediaInput, { type: "url" }>[]> {
  const account = options?.account ?? requireAccount();
  const request = options?.request ?? platformFetch;
  const prepared = await preparePlatformReferences(directory, references, signal);
  const withCache = createReferenceCache("yixianMedia", { apiUrl: account.baseUrl, userId: account.user.id }, directory, signal);
  return withCache(async cache => {
    const result: Extract<MediaInput, { type: "url" }>[] = [];
    const hashes = new Map<string, string>();
    const resolved = new Map<string, Extract<MediaInput, { type: "url" }>>();
    for (const reference of prepared) {
      signal?.throwIfAborted();
      const blob = file(reference.path, { type: reference.mimeType });
      let digest = hashes.get(reference.path);
      if (!digest) {
        const hash = createHash("sha256");
        for await (const chunk of blob.stream()) { signal?.throwIfAborted(); hash.update(chunk); }
        digest = hash.digest("hex");
        hashes.set(reference.path, digest);
      }
      const existing = resolved.get(digest);
      if (existing) { result.push(existing); continue; }
      const cached = await cache.get(digest);
      let asset: z.infer<typeof assetSchema>["data"] | undefined;
      if (cached?.ref) {
        const response = await request(`${account.baseUrl}/v1/media/${encodeURIComponent(cached.ref)}`, {
          signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]), headers: { Authorization: `Bearer ${account.key}` },
        });
        if (response.status === 404) { await response.body?.cancel(); await cache.remove(digest); }
        else {
          if (!response.ok) { await response.body?.cancel(); throw new Error(`检查素材失败（HTTP ${response.status}）`); }
          asset = assetSchema.parse(await response.json()).data;
        }
      }
      if (!asset) {
        const info = await stat(reference.path);
        if (info.size !== reference.size || info.mtimeMs !== reference.modified) throw new Error("参考素材已变化，请重新生成");
        const form = new FormData();
        form.append("media_type", reference.mediaType);
        form.append("file", blob, reference.name);
        const response = await request(`${account.baseUrl}/v1/media?media_type=${reference.mediaType}`, { method: "POST", body: form,
          headers: { Authorization: `Bearer ${account.key}` }, signal: AbortSignal.any([AbortSignal.timeout(300000), ...(signal ? [signal] : [])]) });
        if (!response.ok) await throwUploadFailure(response, account.key);
        asset = assetSchema.parse(await response.json()).data;
        const after = await stat(reference.path);
        if (after.size !== reference.size || after.mtimeMs !== reference.modified) throw new Error("上传期间参考素材已变化，请重新生成");
        await cache.set(digest, { ref: asset.asset.id, expiresAt: Date.now() + 7 * 24 * 60 * 60_000 });
      }
      if (asset.asset.media_type !== reference.mediaType) throw new Error("平台返回的素材类型不匹配");
      const uploaded = { type: "url" as const, url: asset.content_url, assetId: asset.asset.id, mimeType: reference.mimeType };
      resolved.set(digest, uploaded);
      result.push(uploaded);
    }
    return result;
  });
}

export async function uploadContinuationReviewReference(directory: string, reference: MediaReference, signal: AbortSignal, options: UploadOptions) {
  const account = options.account ?? requireAccount();
  const request = options.request ?? platformFetch;
  const [prepared] = await preparePlatformReferences(directory, [{ ...reference, mediaType: "video" }], signal);
  if (!prepared) throw new Error("续接审查来源不可用");
  const blob = file(prepared.path, { type: prepared.mimeType });
  const hash = createHash("sha256");
  for await (const chunk of blob.stream()) { signal.throwIfAborted(); hash.update(chunk); }
  const digest = hash.digest("hex");
  const withCache = createReferenceCache("yixianContinuationReview", { apiUrl: account.baseUrl, userId: account.user.id }, directory, signal);
  return withCache(async cache => {
    const info = await stat(prepared.path);
    if (info.size !== prepared.size || info.mtimeMs !== prepared.modified) throw new Error("续接来源已变化，请重新审查");
    const cached = await cache.get(digest);
    if (cached?.ref && cached.expiresAt > Date.now()) {
      const value = continuationReviewSchema.parse(JSON.parse(cached.ref));
      let available = true;
      for (const [id, kind] of [[value.tail.asset_id, "video"], [value.frame.asset_id, "image"]]) {
        const response = await request(`${account.baseUrl}/v1/media/${encodeURIComponent(id!)}`, {
          headers: { Authorization: `Bearer ${account.key}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        });
        if (response.status === 404) { await response.body?.cancel(); available = false; break; }
        if (!response.ok) await throwUploadFailure(response, account.key);
        const asset = assetSchema.parse(await response.json()).data.asset;
        if (asset.id !== id || asset.media_type !== kind) throw new Error("续接审查素材缓存与平台记录不匹配");
      }
      if (available) {
        const after = await stat(prepared.path);
        if (after.size !== prepared.size || after.mtimeMs !== prepared.modified) throw new Error("续接来源已变化，请重新审查");
        return value;
      }
      await cache.remove(digest);
    }
    const form = new FormData();
    form.append("video", blob, prepared.name);
    const response = await request(`${account.baseUrl}/v1/video-continuations/preview`, {
      method: "POST", body: form, headers: { Authorization: `Bearer ${account.key}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]),
    });
    if ([404, 405].includes(response.status)) {
      await response.body?.cancel();
      throw Object.assign(new Error("平台尚未启用续接素材审查，请更新平台后重试；也可取消结合素材，仅审查文字"), { status: 400 });
    }
    if (!response.ok) await throwUploadFailure(response, account.key);
    const value = z.object({ success: z.literal(true), data: continuationReviewSchema }).parse(await response.json()).data;
    if (value.tail_seconds > value.source_seconds || value.tail.asset_id === value.frame.asset_id) throw new Error("平台返回的续接审查素材无效");
    const after = await stat(prepared.path);
    if (after.size !== prepared.size || after.mtimeMs !== prepared.modified) throw new Error("上传期间续接来源已变化，请重新审查");
    await cache.set(digest, { ref: JSON.stringify(value), expiresAt: Date.now() + 7 * 24 * 60 * 60_000 });
    return value;
  });
}

export async function validateReferenceSelection(directory: string, references: Reference[], files: { mimeType: string; size: number }[]) {
  const { limits } = getConfigState();
  if (references.length + files.length > limits.maxReferencesPerRequest) invalid(t`参考素材最多 ${limits.maxReferencesPerRequest} 个`);
  let total = 0;
  for (const file of files) {
    const type = file.mimeType.split("/")[0];
    if (type !== "image" && type !== "audio" && type !== "video") invalid(t`请选择图片、音频或视频文件`);
    const limit = limits[`${type}MaxBytes`];
    if (!file.size || file.size > limit) invalid(t`参考素材为空或超过 ${limit / 1024 / 1024} MiB`, 413);
    total += file.size;
  }
  const prepared = await preparePlatformReferences(directory, references);
  total += prepared.reduce((sum, file) => sum + file.size, 0);
  if (total > limits.requestTotalMaxBytes) invalid(t`参考素材合计不能超过 ${limits.requestTotalMaxBytes / 1024 / 1024} MiB`, 413);
}
