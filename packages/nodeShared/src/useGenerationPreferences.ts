import { inject, nextTick } from "vue";

const preferenceFields: Record<string, Record<string, string>> = {
  image: { model: "string", size: "string", ratio: "string" },
  video: { duration: "number", resolution: "string", ratio: "string", mode: "string", generateAudio: "boolean" },
  audio: { model: "string", language: "string", sampleRate: "number", format: "string" },
  text: { model: "string" },
};

export function useGenerationPreferences(type: "image" | "video" | "audio" | "text", data: () => Record<string, unknown>) {
  const storage = inject<Pick<Storage, "getItem" | "setItem">>("nodePreferences");
  const key = `toonflow:generation:${type}`;
  const fields = preferenceFields[type]!;
  const current = data();
  if (!current.model && storage) {
    let saved: Record<string, unknown> = {};
    try { saved = JSON.parse(storage.getItem(key) ?? "{}"); }
    catch { /* 无效的偏好记录不影响节点打开。 */ }
    for (const [name, valueType] of Object.entries(fields)) {
      const value = saved?.[name];
      if ((current[name] === undefined || current[name] === "") && typeof value === valueType) current[name] = value;
    }
  }

  return async function remember() {
    await nextTick();
    const current = data();
    if (!storage || !current.model) return;
    const value = Object.fromEntries(Object.entries(fields).filter(([name, valueType]) => typeof current[name] === valueType).map(([name]) => [name, current[name]]));
    storage.setItem(key, JSON.stringify(value));
  };
}
