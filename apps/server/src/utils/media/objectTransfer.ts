import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import * as local from "@toonflow/file";
import { z } from "zod";
import { getWebDatabase } from "@/utils/web/store";
import {
  objectConfig,
  objectFile,
  objectFilePath,
  objectRequest,
  registerObjectFile,
} from "./objectStorage";
import { mimeTypeFor } from "./objectFiles";

const partSize = 64 * 1024 * 1024;
const uploadInput = z.object({
  size: z
    .number()
    .int()
    .positive()
    .max(512 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(8).max(128),
  exclusive: z.boolean().default(false),
  expectedRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type ObjectUploadInput = z.input<typeof uploadInput>;
export type ObjectUploadPart = { part_number: number; etag: string };
export type ObjectUploadSession = {
  id: string;
  userId: number;
  directory: string;
  relativePath: string;
  scope: "workspace" | "assets";
  path: string;
  bucket: string;
  key: string;
  size: number;
  sha256: string;
  mimeType: string;
  exclusive: boolean;
  expectedRevision: string | null;
  state: string;
  expires: number;
  lease: string;
  leaseUntil: number;
  multipartId: string;
  resultKey: string;
};
let ready: Promise<void> | undefined;

async function prepare() {
  if (!ready)
    ready = (async () => {
      const sql = getWebDatabase();
      await sql`CREATE TABLE IF NOT EXISTS yixianflow.mediaUploads(
      id TEXT PRIMARY KEY,"userId" INTEGER NOT NULL,directory TEXT NOT NULL,"relativePath" TEXT NOT NULL,scope TEXT NOT NULL,path TEXT NOT NULL,bucket TEXT NOT NULL,key TEXT NOT NULL,
      size BIGINT NOT NULL,sha256 TEXT NOT NULL,"mimeType" TEXT NOT NULL,exclusive BOOLEAN NOT NULL,"expectedRevision" TEXT,"idempotencyKey" TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,
      state TEXT NOT NULL,expires BIGINT NOT NULL,lease TEXT NOT NULL DEFAULT '',"leaseUntil" BIGINT NOT NULL DEFAULT 0,"multipartId" TEXT NOT NULL DEFAULT '',"resultKey" TEXT NOT NULL DEFAULT '',"cleanupQueued" BOOLEAN NOT NULL DEFAULT FALSE)`;
      await sql`CREATE INDEX IF NOT EXISTS "mediaUploadsExpiry" ON yixianflow.mediaUploads(state,expires)`;
      await sql`CREATE TABLE IF NOT EXISTS yixianflow.mediaMultipartCleanup(bucket TEXT NOT NULL,key TEXT NOT NULL,"uploadId" TEXT NOT NULL,"nextAttempt" TIMESTAMPTZ NOT NULL,PRIMARY KEY(bucket,key,"uploadId"))`;
    })().catch((error) => {
      ready = undefined;
      throw error;
    });
  await ready;
}

function unavailable() {
  return Object.assign(new Error("直传暂不可用，请稍后重试原上传会话"), { status: 503 });
}
function conflict(message = "文件已被修改，未覆盖当前内容") {
  return Object.assign(new Error(message), { status: 409, code: "ESTALE" });
}

async function sdk() {
  const config = await objectConfig();
  if (!config) throw unavailable();
  return new S3Client({
    endpoint: config.endpoint,
    region: "auto",
    forcePathStyle: true,
    maxAttempts: 2,
    credentials: config.credentials,
  });
}

export async function objectTransferAvailable(path?: string) {
  const config = await objectConfig();
  if (!config?.uploadUrl || (path && !objectFilePath(resolve(path)))) return false;
  const address = new URL(config.uploadUrl);
  return (
    address.protocol === "https:" &&
    !address.username &&
    !address.password &&
    !address.search &&
    !address.hash
  );
}

function sessionRecord(row: Record<string, unknown>): ObjectUploadSession {
  return {
    ...row,
    size: Number(row.size),
    userId: Number(row.userId),
    expires: Number(row.expires),
    leaseUntil: Number(row.leaseUntil),
  } as ObjectUploadSession;
}

async function precondition(
  path: string,
  input: { exclusive: boolean; expectedRevision?: string | null },
) {
  const record = await objectFile(path);
  const physical = record
    ? undefined
    : await local.lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
  if (input.exclusive && (record || physical)) throw conflict("已存在同名文件");
  if (input.expectedRevision) {
    if (record && record.sha256 === input.expectedRevision) return;
    if (!physical?.isFile()) throw conflict();
    const hash = createHash("sha256");
    for await (const value of local.createReadStream(path)) hash.update(value);
    if (hash.digest("hex") !== input.expectedRevision) throw conflict();
  }
}

export async function initObjectUpload(
  userId: number,
  path: string,
  scope: "workspace" | "assets",
  directory: string,
  relativePath: string,
  value: ObjectUploadInput,
) {
  if (!(await objectTransferAvailable(path))) throw unavailable();
  const input = uploadInput.parse(value);
  if (scope === "assets" && input.size > 100 * 1024 * 1024)
    throw Object.assign(new Error("素材文件不能超过 100 MB"), { status: 413 });
  const name = objectFilePath(path)!;
  const config = (await objectConfig())!;
  await objectFile(path);
  await prepare();
  const idempotency = createHash("sha256")
    .update(userId + "\n" + input.idempotencyKey)
    .digest("hex");
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        name,
        input.size,
        input.sha256,
        input.exclusive,
        input.expectedRevision ?? null,
        scope,
      ]),
    )
    .digest("hex");
  let session: ObjectUploadSession | undefined;
  const sql = getWebDatabase();
  await sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${idempotency},0))`;
    const [previous] =
      await transaction`SELECT * FROM yixianflow.mediaUploads WHERE "idempotencyKey"=${idempotency} AND "userId"=${userId} FOR UPDATE`;
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw conflict("上传幂等标识与文件不一致");
      session = sessionRecord(previous);
      return;
    }
    await precondition(path, input);
    const id = randomUUID(),
      key = [config.keyPrefix, "uploads", id].filter(Boolean).join("/");
    const mimeType = mimeTypeFor(path);
    let multipartId = "";
    if (input.size > partSize) {
      const client = await sdk();
      try {
        const result = await client.send(
          new CreateMultipartUploadCommand({
            Bucket: config.bucket,
            Key: key,
            ContentType: mimeType,
            CacheControl: "private, no-store",
            Metadata: { sha256: input.sha256, upload: id },
          }),
        );
        multipartId = result.UploadId ?? "";
        if (!multipartId) throw unavailable();
      } catch {
        throw unavailable();
      } finally {
        client.destroy();
      }
    }
    const expires = Math.floor(Date.now() / 1000) + (multipartId ? 3600 : 600);
    const [row] =
      await transaction`INSERT INTO yixianflow.mediaUploads(id,"userId",directory,"relativePath",scope,path,bucket,key,size,sha256,"mimeType",exclusive,"expectedRevision","idempotencyKey",fingerprint,state,expires,"multipartId")
      VALUES(${id},${userId},${directory},${relativePath},${scope},${name},${config.bucket},${key},${input.size},${input.sha256},${mimeType},${input.exclusive},${input.expectedRevision ?? null},${idempotency},${fingerprint},'pending',${expires},${multipartId}) RETURNING *`;
    session = sessionRecord(row);
  });
  if (!session || session.bucket !== config.bucket) throw unavailable();
  if (session.state !== "complete" && session.expires <= Date.now() / 1000)
    throw Object.assign(new Error("上传会话已过期"), { status: 410 });
  const claims = {
    kind: "upload",
    id: session.id,
    bucket: session.bucket,
    key: session.key,
    size: session.size,
    mime: session.mimeType,
    expires: session.expires,
    sha256: session.sha256,
    multipart_id: session.multipartId || undefined,
    part_size: partSize,
  };
  const data = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const address = new URL(config.uploadUrl!);
  address.pathname = address.pathname.replace(/\/$/, "") + "/" + session.id;
  address.searchParams.set(
    "access",
    data + "." + createHmac("sha256", config.edgeSecret).update(data).digest("hex"),
  );
  return {
    upload_id: session.id,
    asset_id: session.id,
    upload_url: address.href,
    method: "PUT" as const,
    headers: { "Content-Type": session.mimeType },
    expires_at: session.expires,
    complete: session.state === "complete",
    multipart: !!session.multipartId,
    part_size: session.multipartId ? partSize : undefined,
    part_count: session.multipartId ? Math.ceil(session.size / partSize) : undefined,
  };
}

export async function readObjectUpload(userId: number, id: string) {
  await prepare();
  const [row] =
    await getWebDatabase()`SELECT * FROM yixianflow.mediaUploads WHERE id=${id} AND "userId"=${userId}`;
  if (!row) throw Object.assign(new Error("上传会话不存在"), { status: 404 });
  return sessionRecord(row);
}

export async function completeObjectUpload(
  userId: number,
  id: string,
  path: string,
  parts: ObjectUploadPart[],
  signal?: AbortSignal,
) {
  await prepare();
  const config = await objectConfig();
  if (!config) throw unavailable();
  const lease = randomUUID(),
    sql = getWebDatabase();
  let session: ObjectUploadSession | undefined;
  await sql.begin(async (transaction) => {
    const [row] =
      await transaction`SELECT * FROM yixianflow.mediaUploads WHERE id=${id} AND "userId"=${userId} FOR UPDATE`;
    if (!row) throw Object.assign(new Error("上传会话不存在"), { status: 404 });
    session = sessionRecord(row);
    if (session.path !== objectFilePath(path) || session.bucket !== config.bucket)
      throw conflict("上传目标已变化");
    if (session.state === "complete") return;
    if (session.expires <= Date.now() / 1000)
      throw Object.assign(new Error("上传会话已过期"), { status: 410 });
    if (session.state === "finalizing" && session.leaseUntil > Date.now())
      throw conflict("上传确认正在进行，请重试此会话");
    if (!["pending", "finalizing"].includes(session.state))
      throw Object.assign(new Error("上传会话已取消"), { status: 410 });
    await transaction`UPDATE yixianflow.mediaUploads SET state='finalizing',lease=${lease},"leaseUntil"=${Date.now() + 600000} WHERE id=${id}`;
  });
  if (!session) throw unavailable();
  if (session.state === "complete") {
    const current = await objectFile(path);
    if (!current || current.key !== session.resultKey)
      throw conflict("上传已完成，但文件已被删除或修改");
    return { revision: session.sha256 };
  }
  try {
    await precondition(path, session);
    let head = await objectRequest(config, "HEAD", session.key, undefined, {}, signal);
    await head.body?.cancel();
    if (head.status === 404 && session.multipartId) {
      if (
        parts.length !== Math.ceil(session.size / partSize) ||
        parts.some(
          (part, index) =>
            part.part_number !== index + 1 ||
            !/^[a-f0-9]{32}$/i.test(part.etag.replaceAll('"', "")),
        )
      )
        throw Object.assign(new Error("上传分片不完整"), { status: 400 });
      const client = await sdk();
      try {
        await client.send(
          new CompleteMultipartUploadCommand({
            Bucket: config.bucket,
            Key: session.key,
            UploadId: session.multipartId,
            MultipartUpload: {
              Parts: parts.map((part) => ({
                PartNumber: part.part_number,
                ETag: '"' + part.etag.replaceAll('"', "") + '"',
              })),
            },
          }),
          { abortSignal: signal },
        );
      } catch {
        throw unavailable();
      } finally {
        client.destroy();
      }
      head = await objectRequest(config, "HEAD", session.key, undefined, {}, signal);
      await head.body?.cancel();
    }
    if (
      head.status !== 200 ||
      Number(head.headers.get("Content-Length")) !== session.size ||
      head.headers.get("X-Amz-Meta-Upload") !== id ||
      head.headers.get("X-Amz-Meta-Sha256") !== session.sha256
    )
      throw Object.assign(new Error("上传内容不完整，请重试此会话"), { status: 400 });
    const source = await objectRequest(config, "GET", session.key, undefined, {}, signal);
    if (source.status !== 200 || !source.body) throw unavailable();
    const reader = source.body.getReader(),
      hash = createHash("sha256");
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > session.size) throw conflict("上传文件大小不一致");
        hash.update(value);
      }
    } finally {
      await reader.cancel();
    }
    if (size !== session.size || hash.digest("hex") !== session.sha256)
      throw Object.assign(new Error("上传内容校验失败"), { status: 400 });
    const key = [config.keyPrefix, "objects", session.sha256, randomUUID()]
      .filter(Boolean)
      .join("/");
    await sql`INSERT INTO yixianflow.mediaObjectCleanup(bucket,key,"nextAttempt") VALUES(${config.bucket},${key},CURRENT_TIMESTAMP+INTERVAL '30 minutes') ON CONFLICT DO NOTHING`;
    const client = await sdk();
    try {
      await client.send(
        new CopyObjectCommand({
          Bucket: config.bucket,
          Key: key,
          CopySource: config.bucket + "/" + session.key,
          CopySourceIfMatch: head.headers.get("ETag") ?? undefined,
          ContentType: session.mimeType,
          CacheControl: "private, no-store",
          MetadataDirective: "REPLACE",
          Metadata: { sha256: session.sha256 },
        }),
        { abortSignal: signal },
      );
    } catch {
      throw unavailable();
    } finally {
      client.destroy();
    }
    const verified = await objectRequest(config, "HEAD", key, undefined, {}, signal);
    await verified.body?.cancel();
    if (
      verified.status !== 200 ||
      Number(verified.headers.get("Content-Length")) !== session.size ||
      verified.headers.get("X-Amz-Meta-Sha256") !== session.sha256
    )
      throw unavailable();
    await registerObjectFile(
      {
        path: session.path,
        bucket: config.bucket,
        key,
        size: session.size,
        sha256: session.sha256,
        mimeType: session.mimeType,
        modified: Date.now(),
      },
      {
        exclusive: session.exclusive,
        expectedRevision: session.expectedRevision ?? undefined,
        upload: { id, lease },
      },
    );
    await queueUploadCleanup(session);
    return { revision: session.sha256 };
  } finally {
    await sql`UPDATE yixianflow.mediaUploads SET state='pending',lease='',"leaseUntil"=0 WHERE id=${id} AND state='finalizing' AND lease=${lease}`;
  }
}

async function queueUploadCleanup(session: ObjectUploadSession) {
  const sql = getWebDatabase(),
    when = new Date((session.expires + 600) * 1000);
  await sql.begin(async (transaction) => {
    await transaction`INSERT INTO yixianflow.mediaObjectCleanup(bucket,key,"nextAttempt") VALUES(${session.bucket},${session.key},${when}) ON CONFLICT DO NOTHING`;
    if (session.multipartId)
      await transaction`INSERT INTO yixianflow.mediaMultipartCleanup(bucket,key,"uploadId","nextAttempt") VALUES(${session.bucket},${session.key},${session.multipartId},${when}) ON CONFLICT DO NOTHING`;
    await transaction`UPDATE yixianflow.mediaUploads SET "cleanupQueued"=TRUE WHERE id=${session.id}`;
  });
}

export async function cancelObjectUpload(userId: number, id: string) {
  const session = await readObjectUpload(userId, id);
  if (session.state === "complete") throw conflict("上传已经完成");
  const changed =
    await getWebDatabase()`UPDATE yixianflow.mediaUploads SET state='expired' WHERE id=${id} AND "userId"=${userId} AND (state IN ('pending','expired') OR state='finalizing' AND "leaseUntil"<${Date.now()}) RETURNING id`;
  if (!changed.length) throw conflict("上传确认正在进行");
  await queueUploadCleanup(session);
}

export async function cleanupObjectUploads() {
  const config = await objectConfig();
  if (!config) return;
  await prepare();
  const sql = getWebDatabase();
  const expired =
    await sql`UPDATE yixianflow.mediaUploads SET state='expired' WHERE id IN(SELECT id FROM yixianflow.mediaUploads WHERE state IN('pending','finalizing','expired') AND NOT "cleanupQueued" AND expires<${Math.floor(Date.now() / 1000)} AND "leaseUntil"<${Date.now()} LIMIT 100) RETURNING *`;
  for (const row of expired) await queueUploadCleanup(sessionRecord(row));
  const completed =
    await sql`SELECT * FROM yixianflow.mediaUploads WHERE state='complete' AND NOT "cleanupQueued" AND expires<${Math.floor(Date.now() / 1000)} ORDER BY expires LIMIT 100`;
  for (const row of completed) await queueUploadCleanup(sessionRecord(row));
  const aborts =
    await sql`SELECT * FROM yixianflow.mediaMultipartCleanup WHERE bucket=${config.bucket} AND "nextAttempt"<CURRENT_TIMESTAMP LIMIT 100`;
  if (aborts.length) {
    const client = await sdk();
    try {
      for (const row of aborts) {
        try {
          await client.send(
            new AbortMultipartUploadCommand({
              Bucket: row.bucket,
              Key: row.key,
              UploadId: row.uploadId,
            }),
          );
        } catch (error) {
          if (
            (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404
          )
            continue;
        }
        await sql`DELETE FROM yixianflow.mediaMultipartCleanup WHERE bucket=${row.bucket} AND key=${row.key} AND "uploadId"=${row.uploadId}`;
      }
    } finally {
      client.destroy();
    }
  }
}
