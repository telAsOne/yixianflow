export const whisperModels = ["auto", "tiny", "base", "small", "medium", "large", "turbo"] as const;
export type WhisperModel = typeof whisperModels[number];
export type WhisperTaskPhase = "preparing" | "downloadingModel" | "transcribing" | "reviewing" | "writing" | "completed" | "failed" | "cancelled";

export type WhisperTask = {
  operationId: string;
  phase: WhisperTaskPhase;
  running: boolean;
  model: WhisperModel;
  output?: string;
  error?: string;
  updatedAt: number;
  progress?: number;
  review?: { state: string; changed: number; issueCount: number; error?: string };
};

export type WhisperStartInput = {
  directory: string;
  sourcePath: string;
  outputPath: string;
  model: WhisperModel;
  language?: string;
};

export type WhisperRequest = {
  directory: string;
  source: string;
  output: string;
  model?: WhisperModel;
  language?: string;
};

export type WhisperToolStatus = {
  path: string | null;
  version: string | null;
  error: string | null;
};

export type WhisperCheckResult = {
  models: readonly WhisperModel[];
  defaultModel?: WhisperModel;
  python: { path?: string; available: boolean; error?: string };
  whisper: { available: boolean; error?: string };
  torch: { available: boolean; version?: string; cuda: boolean; error?: string };
  device: "cuda" | "cpu" | "unavailable";
  ffmpeg: {
    supported: boolean;
    version: string;
    tools: { ffmpeg: WhisperToolStatus; ffprobe: WhisperToolStatus };
  };
  cacheDirectory: string;
  ready: boolean;
  errors: string[];
  execution?: "localHelper";
  localDevice?: { id: string; name: string };
  cachedModels?: readonly WhisperModel[];
};
