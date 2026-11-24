import * as local from "@toonflow/file";
import type { Dirent, PathLike, Stats } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  objectChildren,
  objectConfig,
  objectDirectoryPath,
  objectFile,
  objectFilePath,
  objectRequest,
  moveObjectFiles,
  readObjectFile,
  removeObjectFile,
  writeObjectFile,
  writeObjectFromFile,
  materializeObject,
  createObjectTemporary,
  type ObjectFileRecord,
} from "./objectStorage";

export * from "@toonflow/file";

class mediaStats implements Stats {
  dev = 0;
  ino = 0;
  mode = 0o100600;
  nlink = 1;
  uid = 0;
  gid = 0;
  rdev = 0;
  blksize = 4096;
  blocks = 0;
  size: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  birthtime: Date;
  constructor(record: ObjectFileRecord) {
    this.size = record.size;
    this.atimeMs = this.mtimeMs = this.ctimeMs = this.birthtimeMs = record.modified;
    this.atime = this.mtime = this.ctime = this.birthtime = new Date(record.modified);
  }
  isFile() {
    return true;
  }
  isDirectory() {
    return false;
  }
  isBlockDevice() {
    return false;
  }
  isCharacterDevice() {
    return false;
  }
  isSymbolicLink() {
    return false;
  }
  isFIFO() {
    return false;
  }
  isSocket() {
    return false;
  }
  get atimeInstant() {
    return this.instant(this.atime);
  }
  get mtimeInstant() {
    return this.instant(this.mtime);
  }
  get ctimeInstant() {
    return this.instant(this.ctime);
  }
  get birthtimeInstant() {
    return this.instant(this.birthtime);
  }
  private instant(date: Date) {
    return (date as Date & { toTemporalInstant?: () => unknown }).toTemporalInstant?.();
  }
}

class mediaDirent implements Dirent {
  name: string;
  parentPath: string;
  path: string;
  constructor(record: ObjectFileRecord, path: string) {
    this.name = basename(record.path);
    this.parentPath = this.path = path;
  }
  isFile() {
    return true;
  }
  isDirectory() {
    return false;
  }
  isBlockDevice() {
    return false;
  }
  isCharacterDevice() {
    return false;
  }
  isSymbolicLink() {
    return false;
  }
  isFIFO() {
    return false;
  }
  isSocket() {
    return false;
  }
}

async function recordFor(path: PathLike | local.FileHandle) {
  return typeof path === "string" ? objectFile(resolve(path)) : undefined;
}

export const lstat: typeof local.lstat = (async (path: PathLike, options?: unknown) => {
  const record = await recordFor(path);
  if (record) return new mediaStats(record);
  return local.lstat(path, options as Parameters<typeof local.lstat>[1]);
}) as typeof local.lstat;
export const stat: typeof local.stat = (async (path: PathLike, options?: unknown) => {
  const record = await recordFor(path);
  return record
    ? new mediaStats(record)
    : local.stat(path, options as Parameters<typeof local.stat>[1]);
}) as typeof local.stat;

export const realpath: typeof local.realpath = (async (path: PathLike, options?: unknown) => {
  if (await recordFor(path)) {
    const name = resolve(String(path));
    return options === "buffer" ||
      (typeof options === "object" &&
        options !== null &&
        "encoding" in options &&
        options.encoding === "buffer")
      ? Buffer.from(name)
      : name;
  }
  return local.realpath(path, options as Parameters<typeof local.realpath>[1]);
}) as typeof local.realpath;

export const access: typeof local.access = async (path, mode) => {
  if (await recordFor(path)) return;
  return local.access(path, mode);
};

export const readFile: typeof local.readFile = (async (
  path: PathLike | local.FileHandle,
  options?: BufferEncoding | { encoding?: BufferEncoding | null; signal?: AbortSignal },
) => {
  const record = await recordFor(path);
  if (!record) return local.readFile(path, options ?? null);
  const bytes = await readObjectFile(
    record,
    typeof options === "object" ? options?.signal : undefined,
  );
  const encoding = typeof options === "string" ? options : options?.encoding;
  return encoding ? bytes.toString(encoding) : bytes;
}) as typeof local.readFile;

export async function writeAtomic(
  path: string,
  content: string | Uint8Array,
  options: { exclusive?: boolean; mode?: number } = {},
) {
  if (!objectFilePath(resolve(path)) || !(await objectConfig()))
    return local.writeAtomic(path, content, options);
  return local.withFileAccess([path], "write", async () => {
    if (
      options.exclusive &&
      (await local.lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      }))
    )
      throw Object.assign(new Error("已存在同名文件"), { code: "EEXIST" });
    await writeObjectFile(
      resolve(path),
      typeof content === "string" ? Buffer.from(content) : content,
      options.exclusive ?? false,
      mimeTypeFor(path),
    );
  });
}

export const writeFile: typeof local.writeFile = (async (
  path: PathLike | local.FileHandle,
  data: unknown,
  options?:
    | BufferEncoding
    | { encoding?: BufferEncoding | null; flag?: string; signal?: AbortSignal },
) => {
  if (typeof path !== "string" || !objectFilePath(resolve(path)) || !(await objectConfig()))
    return local.writeFile(path, data as Parameters<typeof local.writeFile>[1], options);
  if (typeof data !== "string" && !(data instanceof Uint8Array))
    throw new TypeError("远端素材需要完整的字节内容");
  const encoding = typeof options === "string" ? options : options?.encoding;
  const flag = typeof options === "object" ? options?.flag : "w";
  if (flag && !["w", "wx", "w+", "wx+"].includes(flag))
    throw Object.assign(new Error("远端素材不支持原地追加，请完整保存"), { code: "EINVAL" });
  return writeAtomic(
    path,
    typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : data,
    { exclusive: !!flag?.includes("x") },
  );
}) as typeof local.writeFile;

export const appendFile: typeof local.appendFile = (async (
  path: PathLike | local.FileHandle,
  data: unknown,
  options?: BufferEncoding | { encoding?: BufferEncoding | null; signal?: AbortSignal },
) => {
  if (typeof path !== "string" || !objectFilePath(resolve(path)) || !(await objectConfig()))
    return local.appendFile(path, data as Parameters<typeof local.appendFile>[1], options);
  const previous = await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  });
  if (typeof data !== "string" && !(data instanceof Uint8Array))
    throw new TypeError("远端素材需要完整的字节内容");
  const encoding = typeof options === "string" ? options : options?.encoding;
  const next = typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : data;
  return writeAtomic(path, Buffer.concat([previous, next]));
}) as typeof local.appendFile;

export const opendir: typeof local.opendir = (async (
  path: PathLike,
  options?: Parameters<typeof local.opendir>[1],
) => {
  const directory = await local.opendir(path, options);
  if (typeof path !== "string" || objectDirectoryPath(resolve(path)) === undefined)
    return directory;
  const remote = await objectChildren(resolve(path));
  if (!remote.length) return directory;
  const names = new Map(remote.map((record) => [basename(record.path), record]));
  const iterator = directory[Symbol.asyncIterator].bind(directory);
  directory[Symbol.asyncIterator] = async function* () {
    for await (const entry of iterator()) if (!names.has(entry.name)) yield entry;
    for (const record of names.values()) yield new mediaDirent(record, path);
    return undefined;
  };
  return directory;
}) as typeof local.opendir;

export const readdir: typeof local.readdir = (async (path: PathLike, options?: unknown) => {
  if (
    typeof path !== "string" ||
    objectDirectoryPath(resolve(path)) === undefined ||
    !(await objectConfig())
  )
    return local.readdir(path, options as Parameters<typeof local.readdir>[1]);
  const directory = await opendir(path);
  const result: Dirent[] = [];
  for await (const entry of directory) result.push(entry);
  if (options && typeof options === "object" && "withFileTypes" in options && options.withFileTypes)
    return result;
  return result.map((entry) => entry.name);
}) as typeof local.readdir;

export const unlink: typeof local.unlink = async (path) => {
  if (typeof path === "string" && (await removeObjectFile(resolve(path)))) {
    await local.unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return;
  }
  return local.unlink(path);
};

export const copyFile: typeof local.copyFile = async (source, target, mode) => {
  if (typeof source === "string" && typeof target === "string") {
    const remote = await objectFile(resolve(source));
    if (
      remote &&
      mode &&
      mode & local.constants.COPYFILE_EXCL &&
      (await local.lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      }))
    )
      throw Object.assign(new Error("已存在同名文件"), { code: "EEXIST" });
    if (
      remote &&
      objectFilePath(resolve(target)) &&
      (await moveObjectFiles(
        resolve(source),
        resolve(target),
        true,
        !!(mode && mode & local.constants.COPYFILE_EXCL),
      ))
    )
      return;
    if (objectFilePath(resolve(target)) && (await objectConfig())) {
      if (remote)
        await writeAtomic(target, await readObjectFile(remote), {
          exclusive: !!(mode && mode & local.constants.COPYFILE_EXCL),
        });
      else
        await writeObjectFromFile(
          resolve(target),
          source,
          !!(mode && mode & local.constants.COPYFILE_EXCL),
          mimeTypeFor(target),
        );
      return;
    }
    if (remote) {
      const temporary = await materializeObject(source);
      try {
        await local.copyFile(temporary.path, target, mode);
      } finally {
        await temporary.dispose();
      }
      return;
    }
  }
  return local.copyFile(source, target, mode);
};

export const link: typeof local.link = async (source, target) => {
  if (
    typeof source === "string" &&
    typeof target === "string" &&
    objectFilePath(resolve(target)) &&
    (await objectConfig())
  )
    return copyFile(source, target, local.constants.COPYFILE_EXCL);
  return local.link(source, target);
};

export const rename: typeof local.rename = async (source, target) => {
  if (
    typeof source !== "string" ||
    typeof target !== "string" ||
    (objectDirectoryPath(source) === undefined &&
      objectFilePath(source) === undefined &&
      objectDirectoryPath(target) === undefined &&
      objectFilePath(target) === undefined) ||
    !(await objectConfig())
  )
    return local.rename(source, target);
  if (await objectFile(resolve(source))) {
    if (!objectFilePath(resolve(target))) {
      await copyFile(source, target, local.constants.COPYFILE_EXCL);
      await unlink(source);
      return;
    }
    if (await moveObjectFiles(resolve(source), resolve(target), false, false)) return;
  }
  if (objectFilePath(resolve(target)) && (await local.lstat(source)).isFile()) {
    await copyFile(source, target, local.constants.COPYFILE_EXCL);
    await local.unlink(source);
    return;
  }
  await local.rename(source, target);
  try {
    await moveObjectFiles(resolve(source), resolve(target), false);
  } catch (error) {
    await local.rename(target, source);
    throw error;
  }
};

export const cp: typeof local.cp = async (source, target, options) => {
  if (
    typeof source !== "string" ||
    typeof target !== "string" ||
    objectDirectoryPath(resolve(source)) === undefined ||
    !(await objectConfig())
  )
    return local.cp(source, target, options);
  if (await objectFile(resolve(source))) {
    if (options?.filter && !(await options.filter(source, target))) return;
    if (
      options?.force === false &&
      !options.errorOnExist &&
      (await lstat(target).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return false;
        },
      ))
    )
      return;
    await local.mkdir(dirname(target), { recursive: true });
    return copyFile(
      source,
      target,
      options?.force === false ? local.constants.COPYFILE_EXCL : undefined,
    );
  }
  await local.cp(source, target, options);
  const copyRemote = async (from: string, to: string): Promise<void> => {
    for await (const entry of await opendir(from)) {
      const input = resolve(from, entry.name),
        output = resolve(to, entry.name);
      if (options?.filter && !(await options.filter(input, output))) continue;
      if (entry.isDirectory()) {
        await local.mkdir(output, { recursive: true });
        await copyRemote(input, output);
      } else if (await objectFile(input)) {
        if (
          options?.force === false &&
          !options.errorOnExist &&
          (await lstat(output).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
              return false;
            },
          ))
        )
          continue;
        await copyFile(
          input,
          output,
          options?.force === false ? local.constants.COPYFILE_EXCL : undefined,
        );
      }
    }
  };
  await copyRemote(source, target);
};

export const rmdir: typeof local.rmdir = async (path) => {
  if (typeof path === "string" && (await objectChildren(resolve(path))).length)
    throw Object.assign(new Error("文件夹非空"), { code: "ENOTEMPTY" });
  return local.rmdir(path);
};

export const open: typeof local.open = async (path, flags, mode) => {
  if (typeof path !== "string" || !objectFilePath(resolve(path)) || !(await objectConfig()))
    return local.open(path, flags, mode);
  if (typeof flags !== "string")
    throw Object.assign(new Error("远端素材不支持数值打开标记"), { code: "EINVAL" });
  const writing = /[wa+]/.test(flags);
  const record = await objectFile(resolve(path));
  if (
    flags.includes("x") &&
    (record ||
      (await local.lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      })))
  )
    throw Object.assign(new Error("已存在同名文件"), { code: "EEXIST" });
  let temporary: { path: string; dispose: () => Promise<void> };
  if (record && !flags.startsWith("w")) temporary = await materializeObject(path);
  else {
    if (!writing) return local.open(path, flags, mode);
    const { directory } = await createObjectTemporary(path);
    temporary = {
      path: resolve(directory, basename(path)),
      dispose: () => local.rm(directory, { recursive: true, force: true }),
    };
  }
  let handle: local.FileHandle;
  try {
    handle = await local.open(temporary.path, flags, mode);
  } catch (error) {
    await temporary.dispose();
    throw error;
  }
  const close = handle.close.bind(handle);
  let closed: Promise<void> | undefined;
  handle.close = () =>
    (closed ??= (async () => {
      try {
        if (writing) await handle.sync();
        await close();
        if (writing && (await local.lstat(temporary.path)).size)
          await writeObjectFromFile(
            resolve(path),
            temporary.path,
            flags.includes("x"),
            record?.mimeType ?? mimeTypeFor(path),
          );
      } finally {
        if (handle.fd >= 0) await close().catch(() => {});
        await temporary.dispose();
      }
    })());
  return handle;
};

export const rm: typeof local.rm = async (path, options) => {
  if (typeof path === "string") {
    if (await objectFile(resolve(path))) {
      await unlink(path);
      return;
    }
    if (
      options?.recursive &&
      objectDirectoryPath(resolve(path)) !== undefined &&
      (await objectConfig())
    ) {
      const removeChildren = async (directory: string): Promise<void> => {
        for await (const entry of await opendir(directory)) {
          const child = resolve(directory, entry.name);
          if (entry.isDirectory()) await removeChildren(child);
          else if (entry.isFile()) await unlink(child);
        }
      };
      await removeChildren(path);
    }
  }
  return local.rm(path, options);
};

export function createReadStream(
  path: PathLike,
  options?: Parameters<typeof local.createReadStream>[1],
): Readable {
  if (typeof path !== "string" || !objectFilePath(resolve(path)))
    return local.createReadStream(path, options);
  const output = new PassThrough();
  const controller = new AbortController();
  output.once("close", () => controller.abort());
  void local
    .withFileAccess(
      [path],
      "read",
      async () => {
        const record = await objectFile(resolve(path));
        if (!record) {
          await pipeline(local.createReadStream(path, options), output, {
            signal: controller.signal,
          });
          return;
        }
        const config = await objectConfig();
        if (!config || config.bucket !== record.bucket) throw new Error("对象存储暂不可用");
        const headers: Record<string, string> = {};
        if (typeof options === "object" && options) {
          if (options.start !== undefined || options.end !== undefined)
            headers.Range = `bytes=${options.start ?? 0}-${options.end ?? ""}`;
        }
        const response = await objectRequest(
          config,
          "GET",
          record.key,
          undefined,
          headers,
          controller.signal,
        );
        if (
          ![200, 206].includes(response.status) ||
          !response.body ||
          response.headers.get("X-Amz-Meta-Sha256") !== record.sha256
        ) {
          await response.body?.cancel();
          throw new Error("对象存储暂不可用");
        }
        await pipeline(Readable.fromWeb(response.body), output, { signal: controller.signal });
      },
      controller.signal,
    )
    .catch((error) => output.destroy(error instanceof Error ? error : new Error("素材读取失败")));
  return output;
}

export function createWriteStream(
  path: PathLike,
  options?: Parameters<typeof local.createWriteStream>[1],
): Writable {
  if (typeof path !== "string" || !objectFilePath(resolve(path)))
    return local.createWriteStream(path, options);
  const settings = typeof options === "string" ? { encoding: options } : options;
  let handle: local.FileHandle | undefined;
  let temporary: { directory: string; path: string } | undefined;
  const writing = new Writable({
    construct(callback) {
      void (async () => {
        const config = await objectConfig();
        if (!config) {
          handle = await local.open(path, settings?.flags ?? "w", settings?.mode);
          return;
        }
        const flags = settings?.flags ?? "w";
        if (typeof flags !== "string" || !["w", "wx"].includes(flags))
          throw new Error("远端素材流仅支持完整保存");
        if (
          flags === "wx" &&
          ((await objectFile(resolve(path))) ||
            (await local.lstat(path).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            })))
        )
          throw Object.assign(new Error("已存在同名文件"), { code: "EEXIST" });
        const { directory } = await createObjectTemporary(path);
        temporary = { directory, path: resolve(directory, basename(path)) };
        handle = await local.open(temporary.path, "wx", 0o600);
      })().then(
        () => callback(),
        (error) => callback(error),
      );
    },
    write(chunk, _encoding, callback) {
      void handle!.writeFile(chunk).then(
        () => callback(),
        (error) => callback(error),
      );
    },
    final(callback) {
      void (async () => {
        await handle!.sync();
        await handle!.close();
        if (temporary)
          await writeObjectFromFile(
            resolve(path),
            temporary.path,
            settings?.flags === "wx",
            mimeTypeFor(path),
          );
      })().then(
        () => callback(),
        (error) => callback(error),
      );
    },
    destroy(error, callback) {
      void (async () => {
        if (handle && handle.fd >= 0) await handle.close();
        if (temporary) await local.rm(temporary.directory, { recursive: true, force: true });
      })().then(
        () => callback(error),
        (failure) => callback(error ?? failure),
      );
    },
  });
  if (settings?.signal) {
    const cancel = () =>
      writing.destroy(
        settings.signal!.reason instanceof Error
          ? settings.signal!.reason
          : new Error("素材传输已取消"),
      );
    settings.signal.addEventListener("abort", cancel, { once: true });
    writing.once("close", () => settings.signal?.removeEventListener("abort", cancel));
    if (settings.signal.aborted) cancel();
  }
  return writing;
}

export function mimeTypeFor(path: string) {
  const types: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".avif": "image/avif",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".srt": "application/x-subrip",
    ".vtt": "text/vtt",
  };
  return types[path.slice(path.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream";
}
