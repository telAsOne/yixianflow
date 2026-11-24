import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { extname, resolve, sep } from "node:path";
import { lstat } from "@/utils/media/objectFiles";
import { z } from "zod";
import type { Request } from "express";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { cacheFile, readCache } from "@/utils/cache";
import { isWebMode } from "@/lib/webContext";
import { resolveWorkspace } from "@/utils/workspace";
import { getWebBasePath, getWebOrigin, getWebDatabase } from "@/utils/web/store";
import { objectFile, objectConfig } from "@/utils/media/objectStorage";

const secret = randomBytes(32);
const publicAccessSchema = z.object({
  v: z.literal(2),
  file: z.string().max(4096),
  key: z.string().max(1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  owner: z.number().int().positive(),
  expires: z.number().int().positive(),
});
function publicSecret() {
  const key = process.env.TOONFLOW_WEB_SECRET;
  if (!isWebMode() || !key || !/^[a-f0-9]{64}$/i.test(key)) return undefined;
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update("yixianflow-media-access-v2")
    .digest();
}
function publicAccess(token: string) {
  const key = publicSecret();
  if (!key || token.length > 16384) return undefined;
  const [value, signature, extra] = token.split(".");
  if (!value || !signature || extra !== undefined) return undefined;
  const actual = Buffer.from(signature, "base64url"),
    expected = createHmac("sha256", key).update(value).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  try {
    const access = publicAccessSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (access.expires < Date.now() / 1000 || access.expires > Date.now() / 1000 + 7 * 86400)
      return undefined;
    return access;
  } catch {
    return undefined;
  }
}
export function publicMediaAccess(token: unknown) {
  return typeof token === "string" && !!publicAccess(token);
}
const accessSchema = z.object({
  directory: z.string().max(4096),
  path: z.string().max(4096),
  origin: z.string().max(1024),
  revision: z.string(),
});
const mediaTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  apng: "image/apng",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
};

export async function issueMediaAccess(req: Request, directory: string, path: string) {
  const resolved = await resolveWorkspacePath(directory, path);
  const info = await lstat(resolved.path);
  const mimeType = mediaTypes[extname(path).slice(1).toLowerCase()];
  if (!info.isFile() || !mimeType)
    throw Object.assign(new Error("只能预览图片、视频和音频文件"), { status: 415 });
  const revision = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const storedFile = await objectFile(resolved.path);
  const signingKey = publicSecret();
  if (storedFile && signingKey) {
    const parts = storedFile.path.split("/");
    let owner = 0;
    if (parts[0] === "users") owner = Number(parts[1]);
    else if (parts[0] === "workspaces") {
      const [project] =
        await getWebDatabase()`SELECT "ownerId" FROM yixianflow.projects WHERE id::text=${parts[1]}`;
      owner = Number(project?.ownerId);
    }
    if (!owner) throw Object.assign(new Error("媒体所属项目已失效"), { status: 404 });
    const expires = (Math.floor(Date.now() / 86400000) + 4) * 86400;
    const value = Buffer.from(
      JSON.stringify({
        v: 2,
        file: storedFile.path,
        key: storedFile.key,
        sha256: storedFile.sha256,
        owner,
        expires,
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", signingKey).update(value).digest("base64url");
    const publicURL = (await objectConfig())?.publicUrl;
    return {
      path,
      mimeType,
      url: `${publicURL ? new URL(publicURL).origin : ""}${getWebBasePath()}/api/workspaces/files/media?token=${value}.${signature}`,
      revision,
    };
  }
  // ACT: 凭据随服务进程结束失效；同一文件版本保持 URL 稳定，也不会中断长时间打开的播放器。
  const value = Buffer.from(
    JSON.stringify({
      directory: isWebMode() ? req.body.directory : directory,
      path,
      origin: `${req.protocol}://${req.get("host")}`,
      revision,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(value).digest("base64url");
  const stored = await readCache<unknown>(
    cacheFile("mediaPreviews", JSON.stringify([resolved.path, revision, "info"])),
  );
  const metadata = z
    .object({
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      duration: z.number().nonnegative().optional(),
    })
    .safeParse(stored);
  return {
    path,
    mimeType,
    url: `${isWebMode() ? getWebBasePath() : ""}/api/workspaces/files/media?token=${value}.${signature}`,
    revision,
    ...(metadata.success ? metadata.data : {}),
  };
}

export async function resolveMediaAccess(req: Request, token: string) {
  const publicFile = publicAccess(token);
  if (publicFile) {
    const root = process.env.TOONFLOW_DATA_DIR;
    if (
      !root ||
      publicFile.file
        .split("/")
        .some((part) => !part || part === "." || part === ".." || part.includes("\\"))
    )
      throw Object.assign(new Error("媒体访问凭据无效"), { status: 403 });
    const path = resolve(root, ...publicFile.file.split("/"));
    const record = await objectFile(path);
    if (!record || record.key !== publicFile.key || record.sha256 !== publicFile.sha256)
      throw Object.assign(new Error("媒体文件已被删除或更新"), { status: 404 });
    const scope = record.path.split("/");
    let owner = 0;
    if (scope[0] === "users") {
      const [user] =
        await getWebDatabase()`SELECT id FROM yixianflow.users WHERE id=${Number(scope[1])}`;
      owner = Number(user?.id);
    } else if (scope[0] === "workspaces") {
      const [project] =
        await getWebDatabase()`SELECT "ownerId" FROM yixianflow.projects WHERE id::text=${scope[1]}`;
      owner = Number(project?.ownerId);
    }
    if (owner !== publicFile.owner)
      throw Object.assign(new Error("媒体所属项目已失效"), { status: 404 });
    const mimeType = mediaTypes[extname(path).slice(1).toLowerCase()];
    if (!mimeType) throw Object.assign(new Error("媒体格式无效"), { status: 415 });
    return {
      directory: resolve(root, scope[0]!, scope[1]!),
      path,
      mimeType,
      revision: `${record.size}:${record.modified}:${record.modified}`,
    };
  }
  const [value, signature, extra] = token.split(".");
  const expected = createHmac("sha256", secret)
    .update(value ?? "")
    .digest();
  const actual = Buffer.from(signature ?? "", "base64url");
  if (
    extra !== undefined ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  )
    throw Object.assign(new Error("媒体访问凭据无效，请重新打开预览"), { status: 403 });
  const access = accessSchema.parse(JSON.parse(Buffer.from(value!, "base64url").toString("utf8")));
  const validOrigin =
    req.res?.locals.mediaObjectEdge === true
      ? ["http:", "https:"].includes(new URL(access.origin).protocol) &&
        new URL(access.origin).host === new URL(getWebOrigin()).host
      : access.origin === `${req.protocol}://${req.get("host")}`;
  if (!validOrigin)
    throw Object.assign(new Error("媒体访问凭据已失效，请重新打开预览"), { status: 403 });
  const directory = isWebMode() ? await resolveWorkspace(req, access.directory) : access.directory;
  const resolved = await resolveWorkspacePath(directory, access.path);
  const info = await lstat(resolved.path);
  const mimeType = mediaTypes[extname(access.path).slice(1).toLowerCase()];
  if (!info.isFile() || !mimeType)
    throw Object.assign(new Error("媒体文件不可用"), { status: 404 });
  return { ...resolved, mimeType, revision: `${info.size}:${info.mtimeMs}:${info.ctimeMs}` };
}
