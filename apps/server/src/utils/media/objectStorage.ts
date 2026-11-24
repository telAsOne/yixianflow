import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { S3Client } from "bun";
import * as local from "@toonflow/file";
import type { Request, Response } from "express";
import { z } from "zod";
import { isWebMode } from "@/lib/webContext";
import { getWebDatabase } from "@/utils/web/store";

const configSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["primary", "disabled"]),
  endpoint: z.string(),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  keyPrefix: z.string().default(""),
  prefixes: z.array(z.string()).min(1),
  edgeSecret: z.string().min(32),
  uploadUrl: z.string().optional(),
  publicUrl: z.string().optional(),
  credentials: z.object({
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    sessionToken: z.string().optional(),
  }),
});
type ObjectConfig = z.infer<typeof configSchema>;
type ObjectRequestBody = NonNullable<NonNullable<Parameters<typeof fetch>[1]>["body"]>;
export type ObjectFileRecord = {
  path: string;
  bucket: string;
  key: string;
  size: number;
  sha256: string;
  mimeType: string;
  modified: number;
};
let schemaReady: Promise<void> | undefined;
let cleanupTimer: ReturnType<typeof setInterval> | undefined;
let cleaning = false;
const mediaExtensions = new Set(
  ".png .jpg .jpeg .webp .gif .avif .apng .svg .bmp .tif .tiff .mp4 .mkv .mov .webm .avi .m4v .ogv .mp3 .wav .ogg .opus .m4a .flac .aac .srt .vtt .pdf .zip .psd .blend .glb .gltf .txt .md .csv".split(
    " ",
  ),
);

function storageError(message = "对象存储暂不可用，请稍后重试") {
  return Object.assign(new Error(message), { status: 503 });
}

export function objectFilePath(path: string): string | undefined {
  if (
    !isWebMode() ||
    (!process.env.TOONFLOW_OBJECT_STORAGE_CONFIG &&
      process.env.TOONFLOW_OBJECT_STORAGE_REQUIRED !== "1") ||
    !process.env.TOONFLOW_DATA_DIR ||
    !isAbsolute(path)
  )
    return undefined;
  const name = relative(resolve(process.env.TOONFLOW_DATA_DIR), resolve(path)).split(sep).join("/");
  if (
    /^cache\/(?:mediaPreviews\/[a-f0-9]{64}\.(?:png|jpg)|aiImages\/[a-f0-9]{64}\.json)$/i.test(name)
  )
    return name;
  if (
    /^workspaces\/[a-f0-9-]{36}\/\.toonflow\/videoTasks\/[a-f0-9]{64}\/[a-f0-9-]{36}\.part$/i.test(
      name,
    )
  )
    return process.platform === "win32" ? name.toLowerCase() : name;
  if (
    /^workspaces\/[a-f0-9-]{36}\/\.toonflow\/imageTasks\/[a-f0-9]{64}\/[a-f0-9-]{36}\.(request|result)\.json$/i.test(
      name,
    )
  )
    return process.platform === "win32" ? name.toLowerCase() : name;
  if (name.startsWith("../") || name.split("/").some((part) => !part || part.startsWith(".")))
    return undefined;
  const assets = /^(?:workspaces\/[a-f0-9-]{36}|users\/[1-9][0-9]*)\/assets\//i.test(name);
  const extension = extname(name).toLowerCase();
  if (!assets && (!mediaExtensions.has(extension) || [".txt", ".md", ".csv"].includes(extension)))
    return undefined;
  if (!/^workspaces\/[a-f0-9-]{36}\//i.test(name) && !/^users\/[1-9][0-9]*\//.test(name))
    return undefined;
  return process.platform === "win32" ? name.toLowerCase() : name;
}

export function objectDirectoryPath(path: string): string | undefined {
  if (
    !isWebMode() ||
    (!process.env.TOONFLOW_OBJECT_STORAGE_CONFIG &&
      process.env.TOONFLOW_OBJECT_STORAGE_REQUIRED !== "1") ||
    !process.env.TOONFLOW_DATA_DIR
  )
    return undefined;
  const name = relative(resolve(process.env.TOONFLOW_DATA_DIR), resolve(path)).split(sep).join("/");
  if (/^cache\/(mediaPreviews|aiImages)$/i.test(name)) return name;
  if (/^workspaces\/[a-f0-9-]{36}\/\.toonflow\/videoTasks\/[a-f0-9]{64}$/i.test(name))
    return process.platform === "win32" ? name.toLowerCase() : name;
  if (/^workspaces\/[a-f0-9-]{36}\/\.toonflow\/imageTasks\/[a-f0-9]{64}$/i.test(name))
    return process.platform === "win32" ? name.toLowerCase() : name;
  if (name.startsWith("../") || name.split("/").some((part) => part.startsWith(".")))
    return undefined;
  if (
    !/^workspaces\/[a-f0-9-]{36}(?:\/|$)/i.test(name) &&
    !/^users\/[1-9][0-9]*(?:\/|$)/.test(name)
  )
    return undefined;
  return process.platform === "win32" ? name.toLowerCase() : name;
}

export async function objectConfig(): Promise<ObjectConfig | undefined> {
  if (!isWebMode()) return undefined;
  if (!process.env.TOONFLOW_OBJECT_STORAGE_CONFIG) {
    if (process.env.TOONFLOW_OBJECT_STORAGE_REQUIRED === "1") throw storageError();
    return undefined;
  }
  try {
    const path = process.env.TOONFLOW_OBJECT_STORAGE_CONFIG;
    const info = await local.lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 16384 ||
      (process.platform !== "win32" && info.mode & 0o077)
    )
      throw storageError();
    const value = JSON.parse(await local.readFile(path, "utf8"));
    if (value?.enabled === false || value?.mode === "disabled") {
      if (process.env.TOONFLOW_OBJECT_STORAGE_REQUIRED === "1") throw storageError();
      return undefined;
    }
    const config = configSchema.parse(value);
    if (!config.enabled || config.mode === "disabled") return undefined;
    const endpoint = new URL(config.endpoint);
    if (config.publicUrl) {
      const publicURL = new URL(config.publicUrl);
      if (
        publicURL.protocol !== "https:" ||
        publicURL.username ||
        publicURL.password ||
        publicURL.pathname !== "/" ||
        publicURL.search ||
        publicURL.hash
      )
        throw storageError();
    }
    if (
      endpoint.protocol !== "https:" ||
      !/^[a-f0-9]{32}(?:\.(?:eu|us))?\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname) ||
      endpoint.port ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== "/" ||
      endpoint.search ||
      endpoint.hash
    )
      throw storageError();
    if (
      config.keyPrefix &&
      (config.keyPrefix.startsWith("/") ||
        config.keyPrefix
          .split("/")
          .some((part) => !part || part === "." || part === ".." || /[\\?#]/.test(part)))
    )
      throw storageError();
    return config;
  } catch {
    throw storageError();
  }
}

async function ready() {
  if (!schemaReady)
    schemaReady = (async () => {
      const sql = getWebDatabase();
      await sql`CREATE TABLE IF NOT EXISTS yixianflow.mediaFiles (
      path TEXT PRIMARY KEY, bucket TEXT NOT NULL, key TEXT NOT NULL, size BIGINT NOT NULL CHECK(size >= 0),
      sha256 TEXT NOT NULL, "mimeType" TEXT NOT NULL, modified DOUBLE PRECISION NOT NULL
    )`;
      await sql`CREATE INDEX IF NOT EXISTS "mediaFilesObject" ON yixianflow.mediaFiles(bucket,key)`;
      await sql`CREATE TABLE IF NOT EXISTS yixianflow.mediaObjectCleanup (
      bucket TEXT NOT NULL, key TEXT NOT NULL, "nextAttempt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(bucket,key)
    )`;
      if (!cleanupTimer) {
        cleanupTimer = setInterval(() => {
          void cleanupObjects().catch(() => console.warn("对象存储清理将在下一轮重试"));
        }, 60000);
        cleanupTimer.unref();
      }
    })().catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  await schemaReady;
}

function normalizeRecord(value: Record<string, unknown>): ObjectFileRecord {
  const size = Number(value.size),
    modified = Number(value.modified);
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    !Number.isFinite(modified) ||
    modified < 0 ||
    !/^[a-f0-9]{64}$/.test(String(value.sha256))
  )
    throw storageError();
  return {
    path: String(value.path),
    bucket: String(value.bucket),
    key: String(value.key),
    size,
    sha256: String(value.sha256),
    mimeType: String(value.mimeType),
    modified,
  };
}

export async function objectFile(path: string): Promise<ObjectFileRecord | undefined> {
  const name = objectFilePath(path);
  if (!name || !(await objectConfig())) return undefined;
  await ready();
  const [row] = await getWebDatabase()`SELECT * FROM yixianflow.mediaFiles WHERE path=${name}`;
  return row ? normalizeRecord(row) : undefined;
}

export async function objectChildren(path: string): Promise<ObjectFileRecord[]> {
  const name = objectDirectoryPath(path);
  if (name === undefined || !(await objectConfig())) return [];
  await ready();
  const prefix = name + "/";
  const rows =
    await getWebDatabase()`SELECT * FROM yixianflow.mediaFiles WHERE left(path,length(${prefix}))=${prefix} AND strpos(substr(path,length(${prefix})+1),'/')=0 ORDER BY path`;
  return rows.map(normalizeRecord);
}

function allowedKey(config: ObjectConfig, key: string) {
  return (
    !key.startsWith("/") &&
    !key.split("/").some((part) => !part || part === "." || part === ".." || /[\\?#]/.test(part)) &&
    config.prefixes.some((prefix) => prefix.endsWith("/") && key.startsWith(prefix))
  );
}

export async function objectRequest(
  config: ObjectConfig,
  method: string,
  key: string,
  body?: ObjectRequestBody,
  extra: Record<string, string> = {},
  signal?: AbortSignal,
  payloadDigest?: string,
) {
  if (!allowedKey(config, key)) throw storageError("对象路径超出已授权范围");
  const strictEncode = (value: string) =>
    encodeURIComponent(value).replace(
      /[!'()*]/g,
      (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase(),
    );
  const url = new URL(config.endpoint);
  url.pathname = "/" + config.bucket + "/" + key.split("/").map(strictEncode).join("/");
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const digest =
    payloadDigest ??
    createHash("sha256")
      .update(body instanceof Uint8Array ? body : new Uint8Array())
      .digest("hex");
  const headers = new Headers({ ...extra, "x-amz-date": date, "x-amz-content-sha256": digest });
  if (config.credentials.sessionToken)
    headers.set("x-amz-security-token", config.credentials.sessionToken);
  const signedHeaders = ["host", ...Array.from(headers.keys())].sort();
  const canonicalHeaders = signedHeaders
    .map(
      (name) =>
        name +
        ":" +
        (name === "host" ? url.host : headers.get(name)!.trim().replace(/\s+/g, " ")) +
        "\n",
    )
    .join("");
  const canonical = [
    method,
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders.join(";"),
    digest,
  ].join("\n");
  const scope = date.slice(0, 8) + "/auto/s3/aws4_request";
  const content =
    "AWS4-HMAC-SHA256\n" +
    date +
    "\n" +
    scope +
    "\n" +
    createHash("sha256").update(canonical).digest("hex");
  let signingKey = createHmac("sha256", "AWS4" + config.credentials.secretAccessKey)
    .update(date.slice(0, 8))
    .digest();
  for (const value of ["auto", "s3", "aws4_request"])
    signingKey = createHmac("sha256", signingKey).update(value).digest();
  const signature = createHmac("sha256", signingKey).update(content).digest("hex");
  headers.set(
    "Authorization",
    `AWS4-HMAC-SHA256 Credential=${config.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`,
  );
  try {
    return await fetch(url, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(600000)])
        : AbortSignal.timeout(600000),
    });
  } catch {
    throw storageError();
  }
}

export async function writeObjectFile(
  path: string,
  bytes: Uint8Array,
  exclusive: boolean,
  mimeType = "application/octet-stream",
): Promise<boolean> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return persistObjectFile(path, bytes, bytes.length, sha256, exclusive, mimeType);
}

export async function writeObjectFromFile(
  path: string,
  source: string,
  exclusive: boolean,
  mimeType: string,
): Promise<boolean> {
  const name = objectFilePath(path);
  if (!name || !(await objectConfig())) return false;
  const info = await local.lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw storageError("只能处理普通素材文件");
  const hash = createHash("sha256");
  for await (const chunk of local.createReadStream(source)) hash.update(chunk);
  return persistObjectFile(
    path,
    Readable.toWeb(local.createReadStream(source)),
    info.size,
    hash.digest("hex"),
    exclusive,
    mimeType,
  );
}

async function persistObjectFile(
  path: string,
  body: ObjectRequestBody,
  size: number,
  sha256: string,
  exclusive: boolean,
  mimeType: string,
): Promise<boolean> {
  const name = objectFilePath(path);
  if (!name) return false;
  const config = await objectConfig();
  if (!config) return false;
  if (!Number.isSafeInteger(size) || size < 0 || size > 512 * 1024 * 1024)
    throw Object.assign(new Error("素材大小超出允许范围"), { status: 413 });
  await ready();
  const key = [config.keyPrefix, "objects", sha256, randomUUID()].filter(Boolean).join("/");
  const sql = getWebDatabase();
  await sql`INSERT INTO yixianflow.mediaObjectCleanup(bucket,key,"nextAttempt") VALUES(${config.bucket},${key},CURRENT_TIMESTAMP+INTERVAL '30 minutes') ON CONFLICT DO NOTHING`;
  const uploaded = await objectRequest(
    config,
    "PUT",
    key,
    body,
    {
      "Content-Length": String(size),
      "Content-Type": mimeType,
      "X-Amz-Meta-Sha256": sha256,
      "Cache-Control": "private, no-store",
      "If-None-Match": "*",
    },
    undefined,
    sha256,
  );
  await uploaded.body?.cancel();
  if (uploaded.status !== 200) throw storageError();
  const head = await objectRequest(config, "HEAD", key);
  await head.body?.cancel();
  if (
    head.status !== 200 ||
    Number(head.headers.get("Content-Length")) !== size ||
    head.headers.get("X-Amz-Meta-Sha256") !== sha256
  )
    throw storageError();
  await registerObjectFile(
    { path: name, bucket: config.bucket, key, size, sha256, mimeType, modified: Date.now() },
    { exclusive },
  );
  return true;
}

export async function registerObjectFile(
  record: ObjectFileRecord,
  options: {
    exclusive: boolean;
    expectedRevision?: string;
    upload?: { id: string; lease: string };
  },
) {
  await ready();
  const { path: name, bucket, key, size, sha256, mimeType, modified } = record;
  const sql = getWebDatabase();
  await sql.begin(async (transaction) => {
    await transaction`SET LOCAL lock_timeout='5s'`;
    await transaction`SET LOCAL statement_timeout='20s'`;
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${name},0))`;
    const scope = name.split("/");
    if (scope[0] === "workspaces") {
      const [project] =
        await transaction`SELECT id FROM yixianflow.projects WHERE id::text=${scope[1]} FOR KEY SHARE`;
      if (!project) throw Object.assign(new Error("项目已被删除"), { status: 404 });
    }
    if (scope[0] === "users") {
      const [user] =
        await transaction`SELECT id FROM yixianflow.users WHERE id=${Number(scope[1])} FOR KEY SHARE`;
      if (!user) throw Object.assign(new Error("账户已被移除"), { status: 404 });
    }
    const [previous] =
      await transaction`SELECT bucket,key,sha256 FROM yixianflow.mediaFiles WHERE path=${name} FOR UPDATE`;
    if (options.exclusive && previous)
      throw Object.assign(new Error("已存在同名文件"), { code: "EEXIST", status: 409 });
    if (options.expectedRevision && previous?.sha256 !== options.expectedRevision)
      throw Object.assign(new Error("文件已被其他编辑器修改，未覆盖当前内容"), {
        status: 409,
        code: "ESTALE",
      });
    if (options.upload) {
      const updated =
        await transaction`UPDATE yixianflow.mediaUploads SET state='complete',"resultKey"=${key},lease='' WHERE id=${options.upload.id} AND state='finalizing' AND lease=${options.upload.lease} RETURNING id`;
      if (!updated.length)
        throw Object.assign(new Error("上传确认已被其他请求接管"), { status: 409 });
    }
    await transaction`INSERT INTO yixianflow.mediaFiles(path,bucket,key,size,sha256,"mimeType",modified) VALUES(${name},${bucket},${key},${size},${sha256},${mimeType},${modified})
      ON CONFLICT(path) DO UPDATE SET bucket=EXCLUDED.bucket,key=EXCLUDED.key,size=EXCLUDED.size,sha256=EXCLUDED.sha256,"mimeType"=EXCLUDED."mimeType",modified=EXCLUDED.modified`;
    await transaction`DELETE FROM yixianflow.mediaObjectCleanup WHERE bucket=${bucket} AND key=${key}`;
    if (previous)
      await transaction`INSERT INTO yixianflow.mediaObjectCleanup(bucket,key,"nextAttempt") VALUES(${previous.bucket},${previous.key},CURRENT_TIMESTAMP+INTERVAL '1 hour') ON CONFLICT DO NOTHING`;
  });
}

export async function objectBlob(path: string, options?: { type?: string }) {
  const record = await objectFile(resolve(path));
  if (!record) return (await import("@toonflow/file/bun")).file(path, options);
  const config = await objectConfig();
  if (!config || config.bucket !== record.bucket || !allowedKey(config, record.key))
    throw storageError();
  const client = new S3Client({
    endpoint: config.endpoint,
    bucket: config.bucket,
    region: "auto",
    accessKeyId: config.credentials.accessKeyId,
    secretAccessKey: config.credentials.secretAccessKey,
    sessionToken: config.credentials.sessionToken,
  });
  return client.file(record.key, { type: options?.type ?? record.mimeType });
}

export async function createObjectTemporary(path: string) {
  const root = resolve(process.env.TOONFLOW_MEDIA_PROCESSING_DIR || tmpdir());
  await local.mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await local.mkdtemp(join(root, "yixianflowObject-"));
  return {
    directory,
    path: join(directory, basename(path)),
    dispose: () => local.rm(directory, { recursive: true, force: true }),
  };
}

export async function materializeObject(path: string, signal?: AbortSignal) {
  const record = await objectFile(resolve(path));
  if (!record) return { path, dispose: async () => {} };
  const config = await objectConfig();
  if (!config || config.bucket !== record.bucket) throw storageError();
  const { directory, path: temporary } = await createObjectTemporary(path);
  try {
    const response = await objectRequest(config, "GET", record.key, undefined, {}, signal);
    if (
      response.status !== 200 ||
      !response.body ||
      Number(response.headers.get("Content-Length")) !== record.size ||
      response.headers.get("X-Amz-Meta-Sha256") !== record.sha256
    ) {
      await response.body?.cancel();
      throw storageError();
    }
    const hash = createHash("sha256");
    let size = 0;
    const measure = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > record.size) return callback(storageError());
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      measure,
      local.createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    if (size !== record.size || hash.digest("hex") !== record.sha256) throw storageError();
    return {
      path: temporary,
      dispose: () => local.rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await local.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function readObjectFile(
  record: ObjectFileRecord,
  signal?: AbortSignal,
): Promise<Buffer> {
  const config = await objectConfig();
  if (!config || config.bucket !== record.bucket) throw storageError();
  const response = await objectRequest(config, "GET", record.key, undefined, {}, signal);
  if (
    response.status !== 200 ||
    Number(response.headers.get("Content-Length")) !== record.size ||
    response.headers.get("X-Amz-Meta-Sha256") !== record.sha256
  ) {
    await response.body?.cancel();
    throw storageError();
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    bytes.length !== record.size ||
    createHash("sha256").update(bytes).digest("hex") !== record.sha256
  )
    throw storageError();
  return bytes;
}

export async function removeObjectFile(path: string): Promise<boolean> {
  const record = await objectFile(path);
  if (!record) return false;
  await getWebDatabase().begin(async (transaction) => {
    await transaction`SET LOCAL lock_timeout='5s'`;
    await transaction`SET LOCAL statement_timeout='20s'`;
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${record.path},0))`;
    const removed =
      await transaction`DELETE FROM yixianflow.mediaFiles WHERE path=${record.path} AND key=${record.key} RETURNING path`;
    if (!removed.length)
      throw Object.assign(new Error("文件已被其他请求修改，请刷新后重试"), {
        status: 409,
        code: "ESTALE",
      });
    await transaction`INSERT INTO yixianflow.mediaObjectCleanup(bucket,key,"nextAttempt") VALUES(${record.bucket},${record.key},CURRENT_TIMESTAMP+INTERVAL '1 hour') ON CONFLICT DO NOTHING`;
  });
  return true;
}

export async function moveObjectFiles(
  source: string,
  target: string,
  copy: boolean,
  exclusive = true,
): Promise<boolean> {
  const from = objectFilePath(source) ?? objectDirectoryPath(source),
    to = objectFilePath(target) ?? objectDirectoryPath(target);
  if (from === undefined || to === undefined || !(await objectConfig())) return false;
  await ready();
  const sql = getWebDatabase();
  const prefix = from + "/";
  if (to.startsWith(prefix))
    throw Object.assign(new Error("不能把文件夹移入自身"), { code: "EINVAL", status: 400 });
  return sql.begin(async (transaction) => {
    await transaction`SET LOCAL lock_timeout='5s'`;
    await transaction`SET LOCAL statement_timeout='20s'`;
    const scope = to.split("/");
    if (scope[0] === "workspaces") {
      const [project] =
        await transaction`SELECT id FROM yixianflow.projects WHERE id::text=${scope[1]} FOR KEY SHARE`;
      if (!project) throw Object.assign(new Error("项目已被删除"), { status: 404 });
    }
    if (scope[0] === "users") {
      const [user] =
        await transaction`SELECT id FROM yixianflow.users WHERE id=${Number(scope[1])} FOR KEY SHARE`;
      if (!user) throw Object.assign(new Error("账户已被移除"), { status: 404 });
    }
    const snapshot =
      await transaction`SELECT path FROM yixianflow.mediaFiles WHERE path=${from} OR left(path,length(${prefix}))=${prefix} ORDER BY path`;
    const names = snapshot
      .flatMap((row: { path: string }) => [row.path, to + row.path.slice(from.length)])
      .sort();
    for (const name of new Set(names))
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${name},0))`;
    const rows =
      await transaction`SELECT * FROM yixianflow.mediaFiles WHERE path=${from} OR left(path,length(${prefix}))=${prefix} ORDER BY path FOR UPDATE`;
    if (!rows.length) return false;
    if (from === to) {
      if (copy && exclusive)
        throw Object.assign(new Error("已存在同名文件"), { code: "EEXIST", status: 409 });
      return true;
    }
    if (
      rows.length !== snapshot.length ||
      rows.some((row: { path: string }, index: number) => row.path !== snapshot[index].path)
    )
      throw Object.assign(new Error("文件夹已被其他请求修改，请重试"), { status: 409 });
    for (const row of rows) {
      const destination = to + String(row.path).slice(from.length);
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${destination},0))`;
      const [previous] =
        await transaction`SELECT bucket,key FROM yixianflow.mediaFiles WHERE path=${destination} FOR UPDATE`;
      if (previous && exclusive)
        throw Object.assign(new Error("已存在同名文件"), { code: "EEXIST", status: 409 });
      await transaction`INSERT INTO yixianflow.mediaFiles(path,bucket,key,size,sha256,"mimeType",modified) VALUES(${destination},${row.bucket},${row.key},${row.size},${row.sha256},${row.mimeType},${row.modified}) ON CONFLICT(path) DO UPDATE SET bucket=EXCLUDED.bucket,key=EXCLUDED.key,size=EXCLUDED.size,sha256=EXCLUDED.sha256,"mimeType"=EXCLUDED."mimeType",modified=EXCLUDED.modified`;
      if (previous && previous.key !== row.key)
        await transaction`INSERT INTO yixianflow.mediaObjectCleanup(bucket,key,"nextAttempt") VALUES(${previous.bucket},${previous.key},CURRENT_TIMESTAMP+INTERVAL '1 hour') ON CONFLICT DO NOTHING`;
    }
    if (!copy)
      await transaction`DELETE FROM yixianflow.mediaFiles WHERE path=${from} OR left(path,length(${prefix}))=${prefix}`;
    return true;
  });
}

export async function cleanupObjects() {
  if (cleaning) return;
  cleaning = true;
  try {
    const config = await objectConfig();
    if (!config) return;
    await ready();
    const sql = getWebDatabase();
    const rows =
      await sql`SELECT bucket,key FROM yixianflow.mediaObjectCleanup WHERE bucket=${config.bucket} AND "nextAttempt"<CURRENT_TIMESTAMP ORDER BY "nextAttempt" LIMIT 100`;
    for (const row of rows) {
      const [reference] =
        await sql`SELECT 1 FROM yixianflow.mediaFiles WHERE bucket=${row.bucket} AND key=${row.key} LIMIT 1`;
      if (reference) {
        await sql`DELETE FROM yixianflow.mediaObjectCleanup WHERE bucket=${row.bucket} AND key=${row.key}`;
        continue;
      }
      const result = await objectRequest(config, "DELETE", row.key);
      await result.body?.cancel();
      if ([200, 204, 404].includes(result.status))
        await sql`DELETE FROM yixianflow.mediaObjectCleanup WHERE bucket=${row.bucket} AND key=${row.key}`;
      else
        await sql`UPDATE yixianflow.mediaObjectCleanup SET "nextAttempt"=CURRENT_TIMESTAMP+INTERVAL '1 minute' WHERE bucket=${row.bucket} AND key=${row.key}`;
    }
    await (await import("./objectTransfer")).cleanupObjectUploads();
  } finally {
    cleaning = false;
  }
}

export function preserveObjectRequest(req: Request, res: Response) {
  if (!req.headers["x-yixian-media-resolve"]) return;
  const base = process.env.TOONFLOW_WEB_BASE_PATH || "";
  const uri = req.originalUrl || req.url;
  res.locals.mediaObjectURI = base && !uri.startsWith(base + "/") ? base + uri : uri;
}

export async function authorizedObjectEdge(req: Request, res: Response) {
  const proof = req.headers["x-yixian-media-resolve"];
  if (
    typeof proof !== "string" ||
    !/^\d{10}\.[a-f0-9]{64}$/.test(proof) ||
    !["GET", "HEAD"].includes(req.method)
  )
    return false;
  const config = await objectConfig();
  if (!config) return false;
  const stamp = Number(proof.slice(0, 10));
  if (stamp < Date.now() / 1000 - 30 || stamp > Date.now() / 1000 + 5) return false;
  const uri = res.locals.mediaObjectURI ?? req.originalUrl;
  const expected = createHmac("sha256", config.edgeSecret)
    .update(req.method + "\n" + uri + "\n" + proof.slice(0, 10))
    .digest();
  return timingSafeEqual(expected, Buffer.from(proof.slice(11), "hex"));
}

export async function resolveObjectForEdge(req: Request, res: Response, record: ObjectFileRecord) {
  const config = await objectConfig();
  const proof = req.headers["x-yixian-media-resolve"];
  if (!config || typeof proof !== "string" || !/^\d{10}\.[a-f0-9]{64}$/.test(proof)) return false;
  const uri = res.locals.mediaObjectURI ?? req.originalUrl;
  const stamp = Number(proof.slice(0, 10));
  if (stamp < Date.now() / 1000 - 30 || stamp > Date.now() / 1000 + 5) return false;
  const expected = createHmac("sha256", config.edgeSecret)
    .update(req.method + "\n" + uri + "\n" + proof.slice(0, 10))
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(proof.slice(11), "hex"))) return false;
  const payload = {
    bucket: record.bucket,
    key: record.key,
    size: record.size,
    sha256: record.sha256,
    mime_type: record.mimeType,
    filename: record.path.slice(record.path.lastIndexOf("/") + 1),
    etag: '"' + record.sha256 + '"',
    modified: Math.floor(record.modified / 1000),
    expires: Math.floor(Date.now() / 1000) + 30,
    request: createHash("sha256")
      .update(req.method + "\n" + uri)
      .digest("hex"),
    cache_control: String(res.getHeader("Cache-Control") ?? "private, no-store"),
    content_disposition: res.getHeader("Content-Disposition"),
    csp: res.getHeader("Content-Security-Policy"),
  };
  payload.mime_type = String(res.getHeader("Content-Type") ?? record.mimeType);
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  res.setHeader(
    "X-Yixian-Media-Object",
    data + "." + createHmac("sha256", config.edgeSecret).update(data).digest("hex"),
  );
  res.setHeader("Cache-Control", "private, no-store");
  res.status(204).end();
  return true;
}
