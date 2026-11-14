export type MediaFrame = {
  requestedSeconds: number;
  seconds: number;
  timestampKind: "decodedFrame" | "browserSeek";
  path: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
};

export type MediaMetadata = {
  duration: number;
  videoDuration?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
  streams?: unknown[];
};

export type BrowserMediaRequest = {
  path: string;
  revision: string;
  outputDirectory: string;
  times: number[];
  maxEdge: number;
  crop?: { x: number; y: number; width: number; height: number };
};

export type BrowserMediaResult = {
  revision: string;
  metadata: MediaMetadata;
  frames: MediaFrame[];
};

export type BrowserMediaReader = (request: BrowserMediaRequest, signal?: AbortSignal) => Promise<BrowserMediaResult>;
