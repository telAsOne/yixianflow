import { lstat } from "@toonflow/file";
import { resolve } from "node:path";
import { z } from "zod";
import { getNodeConfig, nodesDirectory, readNode } from "@/utils/plugins/nodes";
import { whisperModels } from "./types";

export { checkWhisper, startWhisper, getWhisperTask, cancelWhisper, subtitleInput, subtitleEvent, cancelledSubtitles } from "./runtime";
export { whisperModels } from "./types";
export type { WhisperCheckResult, WhisperModel, WhisperRequest, WhisperStartInput, WhisperTask, WhisperTaskPhase } from "./types";

export async function readWhisperConfig() {
  const node = await readNode("subtitleNode").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw Object.assign(new Error("字幕节点未安装"), { status: 404 });
    throw error;
  });
  const disabled = await lstat(resolve(nodesDirectory, "subtitleNode.disabled")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (disabled) throw Object.assign(new Error("节点已禁用"), { status: 404 });
  const config = getNodeConfig(node);
  return z.object({
    defaultModel: z.enum(whisperModels).default("auto"),
  }).parse({ defaultModel: config.defaultModel || undefined });
}
