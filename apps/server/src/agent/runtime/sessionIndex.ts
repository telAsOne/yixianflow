import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createReadStream, readdir, stat } from "@/utils/media/objectFiles";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { cacheFile, readCache, writeCache } from "@/utils/cache";

type SessionSummary = { file: string; name: string; modified: string; messageCount: number };
type SummaryPage = { items: SessionSummary[]; nextOffset?: number; snapshot: string };

export async function listSessionPage(directory: string, offset: number, snapshot?: string): Promise<SummaryPage> {
  const pagePath = (revision: string, start: number) => cacheFile("sessionIndex", JSON.stringify(["sessionList", directory, revision, start]));
  if (snapshot) {
    const start = Math.floor(offset / 30) * 30;
    const cached = await readCache<SummaryPage>(pagePath(snapshot, start));
    const next = cached && offset !== start && cached.nextOffset !== undefined ? await readCache<SummaryPage>(pagePath(snapshot, cached.nextOffset)) : undefined;
    if (!cached || (offset !== start && cached.nextOffset !== undefined && !next)) {
      throw Object.assign(new Error("历史列表缓存已更新，请重新打开历史菜单"), { status: 409 });
    }
    const items = [...cached.items, ...(next?.items ?? [])];
    const hasMore = offset - start + 30 < items.length || (next ?? cached).nextOffset !== undefined;
    return { items: items.slice(offset - start, offset - start + 30), nextOffset: hasMore ? offset + 30 : undefined, snapshot };
  }
  const items = await listSessionSummaries(directory);
  const revision = createHash("sha256").update(JSON.stringify(items)).digest("hex");
  // ACT: 每次打开列表核对文件，后续翻页读取同一摘要快照，避免每页重新扫描所有会话。
  for (let start = 0; start < Math.max(1, items.length); start += 30) {
    await writeCache(pagePath(revision, start), { items: items.slice(start, start + 30), nextOffset: start + 30 < items.length ? start + 30 : undefined, snapshot: revision });
  }
  return { items: items.slice(offset, offset + 30), nextOffset: offset + 30 < items.length ? offset + 30 : undefined, snapshot: revision };
}

export async function listSessionSummaries(directory: string) {
  const entries = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && /^[\w-]+\.jsonl$/.test(entry.name));
  const summaries: SessionSummary[] = [];
  for (let offset = 0; offset < entries.length; offset += 4) {
    const page = await Promise.all(entries.slice(offset, offset + 4).map(async entry => {
      const source = join(directory, entry.name);
      const info = await stat(source);
      const revision = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      const path = cacheFile("sessionIndex", source);
      const cached = await readCache<{ revision: string; summary: SessionSummary | null }>(path);
      if (cached?.revision === revision) return cached.summary;
      const stream = createReadStream(source, { encoding: "utf8" });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      let name: string | undefined;
      let firstMessage = "";
      let messageCount = 0;
      let modified = 0;
      let valid = false;
      let child = false;
      try {
        for await (const line of lines) {
          const item = parseSessionEntries(line)[0];
          if (!item) continue;
          if (!valid) {
            if (item.type !== "session") break;
            valid = true;
            child = !!item.parentSession;
            if (child) break;
            continue;
          }
          if (item.type === "session_info") name = item.name?.trim() || undefined;
          if (item.type !== "message") continue;
          messageCount++;
          const time = Date.parse(item.timestamp);
          if (Number.isFinite(time)) modified = Math.max(modified, time);
          if (!firstMessage && item.message.role === "user") {
            const content = item.message.content;
            firstMessage = (typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join(" ")).trim().slice(0, 60);
          }
        }
      } finally { lines.close(); stream.destroy(); }
      const summary = valid && !child ? { file: entry.name, name: name || firstMessage || "新对话", modified: new Date(modified || info.mtimeMs).toISOString(), messageCount } : null;
      const after = await stat(source);
      if (after.size === info.size && after.mtimeMs === info.mtimeMs && after.ctimeMs === info.ctimeMs) await writeCache(path, { revision, summary });
      return summary;
    }));
    summaries.push(...page.filter((item): item is SessionSummary => !!item));
  }
  return summaries.sort((left, right) => Date.parse(right.modified) - Date.parse(left.modified));
}
