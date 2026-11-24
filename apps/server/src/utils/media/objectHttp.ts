import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  objectConfig,
  objectFile,
  objectRequest,
  resolveObjectForEdge,
  type ObjectFileRecord,
} from "./objectStorage";

function matches(value: string, etag: string, weak: boolean) {
  return value.split(",").some((item) => {
    item = item.trim();
    return (
      item === "*" ||
      (weak ? item.replace(/^W\//, "") === etag : !item.startsWith("W/") && item === etag)
    );
  });
}

async function part(record: ObjectFileRecord, start: number, end: number, signal: AbortSignal) {
  const config = await objectConfig();
  if (!config || config.bucket !== record.bucket)
    throw Object.assign(new Error("对象存储暂不可用"), { status: 503 });
  const response = await objectRequest(
    config,
    "GET",
    record.key,
    undefined,
    { Range: `bytes=${start}-${end}` },
    signal,
  );
  if (
    response.status !== 206 ||
    !response.body ||
    Number(response.headers.get("Content-Length")) !== end - start + 1 ||
    response.headers.get("Content-Range") !== `bytes ${start}-${end}/${record.size}` ||
    response.headers.get("X-Amz-Meta-Sha256") !== record.sha256
  ) {
    await response.body?.cancel();
    throw Object.assign(new Error("素材读取失败，请重试原地址"), { status: 503 });
  }
  return response;
}

// The caller has already applied its project/session/media-ticket authorization.
// Responses stream from R2; only internal processing calls materialize a file.
export async function sendObjectFile(
  req: Request,
  res: Response,
  path: string,
  signal: AbortSignal,
): Promise<boolean> {
  const record = await objectFile(path);
  if (!record) return false;
  if (await resolveObjectForEdge(req, res, record)) return true;
  const config = await objectConfig();
  if (!config || config.bucket !== record.bucket)
    throw Object.assign(new Error("对象存储暂不可用"), { status: 503 });
  const head = await objectRequest(config, "HEAD", record.key, undefined, {}, signal);
  await head.body?.cancel();
  if (
    head.status !== 200 ||
    Number(head.headers.get("Content-Length")) !== record.size ||
    head.headers.get("X-Amz-Meta-Sha256") !== record.sha256
  )
    throw Object.assign(new Error("素材不存在或暂时无法读取"), {
      status: head.status === 404 ? 404 : 503,
    });
  const etag = '"' + record.sha256 + '"';
  res.set({
    ETag: etag,
    "Last-Modified": new Date(record.modified).toUTCString(),
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
  });
  if (!res.get("Content-Type")) res.type(record.mimeType);
  const ifMatch = req.get("if-match"),
    ifNone = req.get("if-none-match");
  if (ifMatch && !matches(ifMatch, etag, false)) {
    res.status(412).end();
    return true;
  }
  const modified = Math.floor(record.modified / 1000) * 1000;
  if (
    !ifMatch &&
    req.get("if-unmodified-since") &&
    modified > Date.parse(req.get("if-unmodified-since")!)
  ) {
    res.status(412).end();
    return true;
  }
  if (
    ifNone
      ? matches(ifNone, etag, true)
      : req.get("if-modified-since") && modified <= Date.parse(req.get("if-modified-since")!)
  ) {
    res.status(304).end();
    return true;
  }
  let ranges = req.headers.range ? req.range(record.size, { combine: true }) : undefined;
  const ifRange = req.get("if-range");
  if (ifRange && (ifRange.startsWith('"') ? ifRange !== etag : Date.parse(ifRange) !== modified))
    ranges = undefined;
  if (ranges === -1 || ranges === -2) {
    res.status(416).set("Content-Range", `bytes */${record.size}`).end();
    return true;
  }
  if (
    ranges &&
    (ranges.type !== "bytes" ||
      ranges.length > 16 ||
      ranges.reduce((sum, value) => sum + value.end - value.start + 1, 0) > record.size)
  )
    ranges = undefined;
  if (!ranges || ranges.length === 1) {
    const range = ranges?.[0] ?? { start: 0, end: record.size - 1 };
    res.status(ranges ? 206 : 200).set("Content-Length", String(range.end - range.start + 1));
    if (ranges) res.set("Content-Range", `bytes ${range.start}-${range.end}/${record.size}`);
    if (req.method === "HEAD" || record.size === 0) {
      res.end();
      return true;
    }
    const response = await part(record, range.start, range.end, signal);
    await pipeline(Readable.fromWeb(response.body!), res, { signal });
    return true;
  }
  const boundary = "flow" + randomUUID().replaceAll("-", "");
  const multiple = ranges;
  const headers = ranges.map((value) =>
    Buffer.from(
      `--${boundary}\r\nContent-Type: ${record.mimeType}\r\nContent-Range: bytes ${value.start}-${value.end}/${record.size}\r\n\r\n`,
    ),
  );
  const ending = Buffer.from(`--${boundary}--\r\n`);
  const length = headers.reduce(
    (sum, value, index) => sum + value.length + ranges[index].end - ranges[index].start + 3,
    ending.length,
  );
  res.status(206).set({
    "Content-Type": "multipart/byteranges; boundary=" + boundary,
    "Content-Length": String(length),
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  async function* chunks() {
    for (let index = 0; index < multiple.length; index++) {
      yield headers[index];
      const response = await part(record!, multiple[index].start, multiple[index].end, signal);
      yield* Readable.fromWeb(response.body!);
      yield Buffer.from("\r\n");
    }
    yield ending;
  }
  await pipeline(Readable.from(chunks()), res, { signal });
  return true;
}
