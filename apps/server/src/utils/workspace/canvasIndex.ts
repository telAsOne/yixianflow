import { join, relative, sep } from "node:path";
import { open, readFile, readdir, stat } from "@/utils/media/objectFiles";
import { cacheFile, readCache, writeCache } from "@/utils/cache";
import { resolveWorkspacePath } from "@/utils/workspace/files";

type CanvasEntry = { name: string; path: string; type: "file" | "directory"; empty?: boolean };
type CanvasIndex = { version: 1; files: Record<string, { revision: string; canvas: boolean }>; entries: CanvasEntry[] };
const pending = new Map<string, Promise<CanvasEntry[]>>();

export function listCanvasIndex(directory: string) {
  const previous = pending.get(directory);
  if (previous) return previous;
  const request = scanCanvasIndex(directory).finally(() => pending.delete(directory));
  pending.set(directory, request);
  return request;
}

async function scanCanvasIndex(directory: string) {
  const path = cacheFile("projectIndex", directory);
  const stored = await readCache<CanvasIndex>(path);
  const previous = stored?.version === 1 ? stored.files : undefined;
  const files: CanvasIndex["files"] = {};
  const entries: CanvasEntry[] = [];
  const folders = [directory];
  while (folders.length) {
    await Promise.all(folders.splice(0, 4).map(async folder => {
      const target = await resolveWorkspacePath(directory, relative(directory, folder));
      const children = await readdir(target.path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (folder !== directory && ["ENOENT", "ENOTDIR"].includes(error.code ?? "")) return [];
        throw error;
      });
      if (folder !== directory) entries.push({ name: folder.split(/[\\/]/).at(-1)!, path: relative(directory, folder).split(sep).join("/"), type: "directory", empty: children.length === 0 });
      for (const child of children) {
        const source = join(folder, child.name);
        if (child.isDirectory()) {
          if (!["assets", ".agent", ".toonflow", ".git"].includes(child.name.toLowerCase())) folders.push(source);
          continue;
        }
        if (!child.isFile() || !/\.json$/i.test(child.name)) continue;
        const key = relative(directory, source).split(sep).join("/");
        const resolved = await resolveWorkspacePath(directory, key);
        const info = await stat(resolved.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        if (!info) continue;
        const revision = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
        let canvas = previous?.[key]?.revision === revision && typeof previous[key]?.canvas === "boolean" ? previous[key]!.canvas : undefined;
        if (canvas === undefined) {
          const handle = await open(resolved.path, "r");
          let header: string;
          try {
            const buffer = Buffer.alloc(Math.min(4096, info.size));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            header = buffer.subarray(0, bytesRead).toString("utf8").trimStart();
          } finally { await handle.close(); }
          if (/^\{\s*"toonflowCanvas"\s*:\s*true\s*[,}]/.test(header)) canvas = true;
          else {
            try { canvas = (JSON.parse(info.size > 4096 ? await readFile(resolved.path, "utf8") : header) as { toonflowCanvas?: unknown })?.toonflowCanvas === true; }
            catch (error) { if (!(error instanceof SyntaxError)) throw error; canvas = false; }
          }
        }
        files[key] = { revision, canvas };
        if (canvas) entries.push({ name: child.name.slice(0, -5), path: key, type: "file" });
      }
    }));
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, "zh-CN", { numeric: true }));
  if (JSON.stringify(files) !== JSON.stringify(previous) || JSON.stringify(entries) !== JSON.stringify(stored?.entries)) await writeCache(path, { version: 1, files, entries } satisfies CanvasIndex);
  return entries;
}
