import axios from "axios";
import { nextTick, reactive } from "vue";
import { validateMediaFiles } from "@toonflow/node-shared/mediaLimits";
import { ElMessage } from "element-plus";
import type { useVueFlow } from "@vue-flow/core";
import { uploadNodeFile } from "@toonflow/nodes-scaffold/workspaceFiles";
import type { NodeOutput } from "@toonflow/nodes-scaffold/values";
import useWorkspaceFiles from "@/lib/workspaceFiles";

const assetDragType = "application/toonflow-asset";
const fileMimeTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  avif: "image/avif", apng: "image/apng", bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac",
  txt: "text/plain", md: "text/markdown", markdown: "text/markdown", csv: "text/csv", log: "text/plain",
  json: "application/json", xml: "application/xml", html: "text/html", css: "text/css", js: "text/javascript", ndjson: "application/x-ndjson",
};

const mediaExtensions: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
  "image/apng": "apng", "image/bmp": "bmp", "image/svg+xml": "svg", "image/x-icon": "ico",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/aac": "aac", "audio/flac": "flac",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/x-matroska": "mkv", "video/x-msvideo": "avi",
};

function inferredMediaType(file: Pick<File, "type" | "name">) {
  const type = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (/^(image|audio|video|text)\//.test(type) || /^application\/(json|xml|javascript|x-ndjson)$/.test(type)) return type;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return fileMimeTypes[extension] ?? "";
}

function clipboardMediaName(type: string, index: number) {
  const extension = mediaExtensions[type] ?? (type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin");
  return "pasted-media-" + Date.now() + "-" + (index + 1) + "." + extension;
}

export function createClipboardMediaFile(blob: Blob, index = 0) {
  const file = blob instanceof File ? blob : undefined;
  const type = (file && inferredMediaType(file)) || (/^(image|audio|video)\//.test(blob.type) ? blob.type : "application/octet-stream");
  return new File([blob], clipboardMediaName(type, index), { type });
}

export function getClipboardMediaFiles(event: ClipboardEvent) {
  const transfer = event.clipboardData;
  if (!transfer) return [];
  const files: File[] = [];
  for (const item of transfer.items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && inferredMediaType(file)) files.push(file);
  }
  if (!files.length) files.push(...Array.from(transfer.files).filter(file => !!inferredMediaType(file)));
  return files.map((file, index) => createClipboardMediaFile(file, index));
}

export function startAssetDrag(event: DragEvent, entry: { type: string; path: string }) {
  if (entry.type !== "file" || !event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(assetDragType, entry.path);
}

export function isCanvasFileDrag(event: DragEvent) {
  return event.dataTransfer?.types.some(type => type === assetDragType || type === "Files") ?? false;
}

export type CanvasFileImport = {
  id: string;
  name: string;
  kind: "image" | "audio" | "video" | "text";
  position: { x: number; y: number };
  status: "queued" | "reading" | "uploading" | "error";
  progress: number;
  previewUrl: string;
  error: string;
  retry(): void;
  remove(): void;
};

type CanvasFileContext = {
  directory: string;
  availableNodes: { type: string }[];
  signal: AbortSignal;
  imports: Map<string, CanvasFileImport>;
  flow: Pick<ReturnType<typeof useVueFlow>, "addNodes" | "screenToFlowCoordinate">;
};

export async function dropCanvasFiles(event: DragEvent, context: CanvasFileContext) {
  const transfer = event.dataTransfer;
  if (!transfer) return;
  const path = transfer.getData(assetDragType);
  const { signal, flow } = context;
  const position = flow.screenToFlowCoordinate({ x: event.clientX, y: event.clientY });
  try {
    signal.throwIfAborted();
    await importCanvasFiles(path ? [path] : Array.from(transfer.files), position, context);
  } catch (error) {
    if (!signal.aborted) showError(error);
  }
}

export async function importCanvasFiles(droppedFiles: (File | string)[], position: { x: number; y: number }, context: CanvasFileContext) {
  const { signal, flow, availableNodes } = context;
  signal.throwIfAborted();
  const files = useWorkspaceFiles(context.directory);
  const tasks: { item: CanvasFileImport; run(): Promise<void> }[] = [];
  for (const [index, source] of droppedFiles.entries()) {
    const name = typeof source === "string" ? source.split("/").pop()! : source.name;
    const mimeType = inferredMediaType(typeof source === "string" ? { name, type: "" } : source);
    const kind = mimeType.startsWith("image/") ? "image" : mimeType.startsWith("audio/") ? "audio" : mimeType.startsWith("video/") ? "video"
      : mimeType.startsWith("text/") || /^application\/(json|xml|javascript|x-ndjson)$/.test(mimeType) ? "text" : undefined;
    if (!kind) { showError(new Error(`${name}：该文件类型暂不支持导入画布`)); continue; }
    const type = `remote-${kind}Node`;
    if (!availableNodes.some(node => node.type === type)) { showError(new Error(`${name}：请先安装并启用对应的基础节点`)); continue; }
    const id = crypto.randomUUID();
    const previewUrl = typeof source !== "string" && kind === "image" ? URL.createObjectURL(source) : "";
    let pending = false;
    const item = reactive<CanvasFileImport>({
      id, name, kind, position: { x: position.x + index % 3 * 304, y: position.y + Math.floor(index / 3) * 236 },
      status: "queued", progress: 0, previewUrl, error: "",
      retry() { if (!pending && !signal.aborted) void run(); },
      remove() {
        context.imports.delete(id);
        signal.removeEventListener("abort", item.remove);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
      },
    });
    // ACT: 上传卡片只存在于当前视图；正式文件落盘后才进入画布和撤销历史，不保存本地预览地址或半成品节点。
    context.imports.set(id, item);
    signal.addEventListener("abort", item.remove, { once: true });
    async function run() {
      if (signal.aborted || pending) return;
      pending = true;
      item.status = "reading";
      item.progress = 0;
      item.error = "";
      let copiedPath: string | undefined;
      try {
        let file: File;
        if (typeof source === "string") {
          const { data } = await axios.get<Blob>("/api/assets/read", { params: { path: source }, responseType: "blob", signal });
          file = new File([data], name, { type: data.type });
        } else file = source;
        if (kind !== "text") await validateMediaFiles([{ type: mimeType, size: file.size }]);
        signal.throwIfAborted();
        let output: NodeOutput | undefined;
        let textSnapshot: string | undefined;
        if (kind === "text") textSnapshot = await file.text();
        else {
          item.status = "uploading";
          copiedPath = await uploadNodeFile(files, id, file, loaded => {
            item.progress = Math.min(100, Math.floor(loaded / file.size * 100));
          });
          output = { dataType: kind === "image" ? "IMAGE" : kind === "audio" ? "AUDIO" : "VIDEO", value: { url: copiedPath, mimeType } };
        }
        signal.throwIfAborted();
        flow.addNodes({ id, type, position: { ...item.position },
          data: kind === "text" ? { label: name, textSnapshot } : { label: name, outputs: { [item.kind]: output } } });
        copiedPath = undefined;
        await nextTick();
        item.remove();
      } catch (error) {
        if (copiedPath) await files.remove(copiedPath).catch(showError);
        if (!signal.aborted) { item.status = "error"; item.error = errorMessage(error); }
      } finally {
        pending = false;
      }
    }
    tasks.push({ item, run });
  }
  try {
    await validateMediaFiles(droppedFiles.filter((file): file is File => typeof file !== "string")
      .map(file => ({ type: inferredMediaType(file), size: file.size })).filter(file => /^(image|audio|video)\//.test(file.type)));
  } catch (error) {
    tasks.forEach(({ item }) => item.remove());
    throw error;
  }
  for (const task of tasks) { if (signal.aborted) break; await task.run(); }
}

function errorMessage(error: unknown) {
  if (axios.isAxiosError(error) && error.code === "ERR_NETWORK") return "网络连接失败，请检查网络后重试";
  return axios.isAxiosError<{ message: string }>(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "文件导入失败";
}

function showError(error: unknown) { ElMessage.error(errorMessage(error)); }
