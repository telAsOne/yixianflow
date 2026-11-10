import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, readFile, readdir, stat, unlink, writeAtomic } from "@toonflow/file";
import conf from "@/utils/conf";

type CacheKind = "mediaPreviews" | "projectIndex" | "sessionIndex" | "aiImages";
export const cacheDirectory = join(dirname(conf.path), "cache");
const cacheKinds: CacheKind[] = ["mediaPreviews", "projectIndex", "sessionIndex", "aiImages"];
let pruning: Promise<void> | undefined;
let pruneTimer: ReturnType<typeof setTimeout> | undefined;
const recentFiles = new Map<string, number>();

export function touchCache(path: string) { recentFiles.set(path, Date.now()); }

export function cacheFile(kind: CacheKind, identity: string, extension = "json") {
  return join(cacheDirectory, kind, `${createHash("sha256").update(identity).digest("hex")}.${extension}`);
}

export async function readCache<T>(path: string): Promise<T | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as T;
    touchCache(path);
    return value;
  }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export async function writeCache(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, JSON.stringify(value));
  touchCache(path);
  scheduleCachePrune();
}

export function scheduleCachePrune() {
  if (pruneTimer || pruning) return;
  pruneTimer = setTimeout(() => {
    pruneTimer = undefined;
    pruning = pruneCache().catch(error => console.warn("清理预览缓存失败：", error)).finally(() => { pruning = undefined; });
  }, 30000);
  pruneTimer.unref();
}

async function pruneCache() {
  const files: { path: string; size: number; touched: number }[] = [];
  for (const kind of cacheKinds) {
    const directory = join(cacheDirectory, kind);
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.(json|png|jpg)$/.test(entry.name)) continue;
      const path = join(directory, entry.name);
      const info = await stat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      if (info) files.push({ path, size: info.size, touched: Math.max(info.atimeMs, info.mtimeMs, recentFiles.get(path) ?? 0) });
    }
  }
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files.sort((left, right) => left.touched - right.touched)) {
    if (total <= 1024 * 1024 * 1024) break;
    if (Date.now() - file.touched < 60000) continue;
    await unlink(file.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    recentFiles.delete(file.path);
    total -= file.size;
  }
  const retained = new Set(files.map(file => file.path));
  for (const path of recentFiles.keys()) if (!retained.has(path)) recentFiles.delete(path);
}
