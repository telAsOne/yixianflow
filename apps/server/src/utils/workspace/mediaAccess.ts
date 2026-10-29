import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { extname } from "node:path";
import { lstat } from "@toonflow/file";
import { z } from "zod";
import type { Request } from "express";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { cacheFile, readCache } from "@/utils/cache";

const secret = randomBytes(32);
const accessSchema = z.object({ directory: z.string().max(4096), path: z.string().max(4096), origin: z.string().max(1024), revision: z.string() });
const mediaTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", avif: "image/avif", gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", svg: "image/svg+xml", apng: "image/apng", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo", ogv: "video/ogg", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac" };

export async function issueMediaAccess(req: Request, directory: string, path: string) {
  const resolved = await resolveWorkspacePath(directory, path);
  const info = await lstat(resolved.path);
  const mimeType = mediaTypes[extname(path).slice(1).toLowerCase()];
  if (!info.isFile() || !mimeType) throw Object.assign(new Error("只能预览图片、视频和音频文件"), { status: 415 });
  const revision = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  // ACT: 凭据随服务进程结束失效；同一文件版本保持 URL 稳定，也不会中断长时间打开的播放器。
  const value = Buffer.from(JSON.stringify({ directory, path, origin: `${req.protocol}://${req.get("host")}`, revision })).toString("base64url");
  const signature = createHmac("sha256", secret).update(value).digest("base64url");
  const stored = await readCache<unknown>(cacheFile("mediaPreviews", JSON.stringify([resolved.path, revision, "info"])));
  const metadata = z.object({ width: z.number().positive().optional(), height: z.number().positive().optional(), duration: z.number().nonnegative().optional() }).safeParse(stored);
  return { path, mimeType, url: `/api/workspaces/files/media?token=${value}.${signature}`, revision, ...(metadata.success ? metadata.data : {}) };
}

export async function resolveMediaAccess(req: Request, token: string) {
  const [value, signature, extra] = token.split(".");
  const expected = createHmac("sha256", secret).update(value ?? "").digest();
  const actual = Buffer.from(signature ?? "", "base64url");
  if (extra !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Object.assign(new Error("媒体访问凭据无效，请重新打开预览"), { status: 403 });
  const access = accessSchema.parse(JSON.parse(Buffer.from(value!, "base64url").toString("utf8")));
  if (access.origin !== `${req.protocol}://${req.get("host")}`) throw Object.assign(new Error("媒体访问凭据已失效，请重新打开预览"), { status: 403 });
  const resolved = await resolveWorkspacePath(access.directory, access.path);
  const info = await lstat(resolved.path);
  const mimeType = mediaTypes[extname(access.path).slice(1).toLowerCase()];
  if (!info.isFile() || !mimeType) throw Object.assign(new Error("媒体文件不可用"), { status: 404 });
  return { ...resolved, mimeType, revision: `${info.size}:${info.mtimeMs}:${info.ctimeMs}` };
}
