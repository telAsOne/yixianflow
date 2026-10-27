import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, readFile, stat, unlink, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import type { ProviderTools } from "@toonflow/providers";
import conf from "@/utils/conf";

const pending = new Map<string, Promise<unknown>>();
const entrySchema = z.object({
  ref: z.string().min(1).max(4096).optional(), expiresAt: z.number().finite().positive(),
  source: z.string().max(4096).optional(), fallbackReason: z.string().max(1000).optional(),
});

export function createReferenceCache(id: string, config: Record<string, unknown>, cwd?: string, signal?: AbortSignal): ProviderTools["withReferenceCache"] {
  return async action => {
    const scope = createHash("sha256").update(JSON.stringify([id, new URL(String(config.apiUrl)).origin, config.userId ?? String(config.apiKey ?? "").trim()])).digest("hex");
    const directory = join(dirname(conf.path), "mediaReferenceCache", id, scope);
    const pathFor = (digest: string) => {
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("素材缓存须使用 SHA-256 摘要");
      return join(directory, `${digest}.json`);
    };
    // ACT: 同一账号串行查重和上传；不同账号独立。等待者取消后不再执行上传。
    const previous = pending.get(directory);
    const operation = (async () => {
      if (previous) await previous.catch(() => {});
      signal?.throwIfAborted();
      return action({
        async get(digest) {
          const path = pathFor(digest);
          const info = await stat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
          if (!info) return undefined;
          if (!info.isFile() || info.size > 16384) throw new Error("素材缓存文件无效，请保留记录并检查");
          return entrySchema.parse(JSON.parse(await readFile(path, "utf8")));
        },
        async set(digest, entry) {
          signal?.throwIfAborted();
          const value = entrySchema.parse(entry);
          await mkdir(directory, { recursive: true });
          await writeAtomic(pathFor(digest), JSON.stringify({ ...value, workspace: cwd }));
        },
        async remove(digest) {
          await unlink(pathFor(digest)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        },
      });
    })();
    pending.set(directory, operation);
    try { return await operation; }
    finally { if (pending.get(directory) === operation) pending.delete(directory); }
  };
}
