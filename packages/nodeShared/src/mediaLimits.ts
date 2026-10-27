type MediaLimits = { imageMaxBytes: number; audioMaxBytes: number; videoMaxBytes: number; requestTotalMaxBytes: number; maxReferencesPerRequest: number };
type LimitInfo = { limits: MediaLimits; messages: Record<string, string> };
const cacheKey = Symbol.for("toonflow.mediaLimits");
const host = globalThis as typeof globalThis & { [cacheKey]?: { expiresAt: number; language: string; pending?: Promise<LimitInfo> } };
if (!host[cacheKey]) {
  host[cacheKey] = { expiresAt: 0, language: "" };
  window.addEventListener("toonflow:plugin-installed", () => { host[cacheKey]!.expiresAt = 0; });
}

export async function getMediaLimits() {
  const cache = host[cacheKey]!;
  const language = document.documentElement.lang || navigator.language;
  if (!cache.pending || cache.expiresAt <= Date.now() || cache.language !== language) {
    cache.language = language;
    cache.expiresAt = Date.now() + 10 * 60_000;
    cache.pending = fetch("/api/account/limits", { headers: { "Accept-Language": language, "x-toonflow-workspace": "1" }, cache: "no-store" }).then(async response => {
      const result = await response.json();
      if (!response.ok || result.code !== 200) throw new Error(result.message);
      return result.data as LimitInfo;
    }).catch(error => { cache.expiresAt = 0; throw error; });
  }
  return cache.pending;
}

export async function validateMediaFiles(files: { type: string; size: number }[]) {
  if (!files.length) return;
  const { limits, messages } = await getMediaLimits();
  if (files.length > limits.maxReferencesPerRequest) throw new Error(messages.count);
  let total = 0;
  for (const file of files) {
    const type = file.type.split("/")[0];
    if (type !== "image" && type !== "audio" && type !== "video") throw new Error(messages.type);
    if (!file.size) throw new Error(messages.empty);
    if (file.size > limits[`${type}MaxBytes`]) throw new Error(messages[type]);
    total += file.size;
  }
  if (total > limits.requestTotalMaxBytes) throw new Error(messages.total);
}

export async function validateReferenceSelection(directory: string, references: { path: string; mimeType: string; mediaType: string }[], files: { type: string; size: number }[]) {
  await validateMediaFiles(files);
  const response = await fetch("/api/ai/media/validateReferences", { method: "POST", headers: {
    "Content-Type": "application/json", "x-toonflow-workspace": "1", "Accept-Language": document.documentElement.lang || navigator.language,
  }, body: JSON.stringify({ directory, references, files: files.map(file => ({ mimeType: file.type, size: file.size })) }) });
  const result = await response.json();
  if (!response.ok || result.code !== 200) throw new Error(result.message);
}
