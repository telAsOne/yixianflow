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
const assetSchema = z.object({ success: z.literal(true), data: z.object({
  asset: z.object({ id: z.string().min(1).max(2048), media_type: z.enum(["image", "audio", "video"]) }), content_url: z.url({ protocol: /^https$/ }),
}) });

export async function preparePlatformReferences(directory: string, references: Reference[], signal?: AbortSignal, totalLimit?: number) {
  const { limits } = getConfigState();
  const maxTotalBytes = Math.min(limits.requestTotalMaxBytes, totalLimit ?? limits.requestTotalMaxBytes);
  if (references.length > limits.maxReferencesPerRequest) invalid(t`参考素材最多 ${limits.maxReferencesPerRequest} 个`);
  const prepared: { path: string; size: number; modified: number; mediaType: Reference["mediaType"]; mimeType: string; name: string }[] = [];
  let total = 0;
  for (const reference of references) {
    signal?.throwIfAborted();
    const { path } = await resolveWorkspacePath(directory, reference.path);
    const info = await stat(path);
    const limit = limits[`${reference.mediaType}MaxBytes`];
    if (!info.isFile() || !info.size || info.size > limit) invalid(t`参考素材为空或超过 ${limit / 1024 / 1024} MiB`, 413);
    total += info.size;
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

export async function uploadPlatformReferences(directory: string, references: Reference[], signal?: AbortSignal): Promise<Extract<MediaInput, { type: "url" }>[]> {
  const account = requireAccount();
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
        const response = await platformFetch(`${account.baseUrl}/v1/media/${encodeURIComponent(cached.ref)}`, {
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
        const response = await platformFetch(`${account.baseUrl}/v1/media?media_type=${reference.mediaType}`, { method: "POST", body: form,
          headers: { Authorization: `Bearer ${account.key}` }, signal: AbortSignal.any([AbortSignal.timeout(300000), ...(signal ? [signal] : [])]) });
        if (!response.ok) {
          const failure = await response.json().catch(() => undefined) as { error_code?: string; message?: string; error?: { code?: string; message?: string } } | undefined;
          const code = failure?.error_code ?? failure?.error?.code;
          const message = (code ? failure?.message || failure?.error?.message :
            ({ 402: "余额不足，请充值后上传", 403: "账户存储已满", 413: "参考素材超过平台大小限制", 507: "服务器存储已满，请稍后再试" } as Record<number, string>)[response.status])
            || `上传素材失败（HTTP ${response.status}）`;
          throw Object.assign(new Error(message.replaceAll(account.key, "••••••")), { status: response.status, code });
        }
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
