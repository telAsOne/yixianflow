import { inject, nextTick, ref, shallowRef, toValue, watch, type MaybeRefOrGetter } from "vue";
import type { NodeMediaValue } from "./values";
import { useNodePreviewReady } from "./useNodePreviewReady";

export interface WorkspaceFiles {
  importImage?(url: string): Promise<{ path: string; mimeType: string }>;
  getMediaInfo?(path: string): Promise<{ width?: number; height?: number; duration?: number }>;
  list(path?: string): Promise<{ directory: string; entries: { name: string; path: string; type: "file" | "directory" }[] }>;
  read(path: string): Promise<ArrayBuffer>;
  acquireUrl?(path: string, mimeType: string, preview?: boolean, refresh?: boolean): { url: Promise<string>; release(): void };
  readText(path: string): Promise<string>;
  readTextSnapshot(path: string): Promise<{ text: string; revision: string; encoding: "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" }>;
  writeTextSnapshot(path: string, text: string, snapshot: { revision: string; encoding: "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" }): Promise<string>;
  readJson<T = unknown>(path: string): Promise<T>;
  write(path: string, content: string | Blob | ArrayBuffer, exclusive?: boolean, signal?: AbortSignal, onUploadProgress?: (loaded: number, total?: number) => void): Promise<void>;
  writeJson(path: string, data: unknown, exclusive?: boolean): Promise<void>;
  rename(path: string, target: string): Promise<void>;
  remove(path: string, recursive?: boolean): Promise<void>;
  mkdir(path: string): Promise<void>;
}

function getNodeDirectory(nodeId: string) {
  if (!nodeId || /[\\/]/.test(nodeId) || nodeId === "." || nodeId === "..") throw new Error("节点 ID 不能作为文件夹名称");
  return `assets/${nodeId}`;
}

export async function uploadNodeFile(files: WorkspaceFiles, nodeId: string, file: File, onUploadProgress?: (loaded: number, total?: number) => void) {
  const directory = getNodeDirectory(nodeId);
  for (const path of ["assets", directory]) {
    await files.mkdir(path).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
      if (error.response?.data?.data?.code !== "EEXIST") throw error;
    });
  }
  const extension = file.name.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0].toLowerCase() ?? "";
  const path = `${directory}/${crypto.randomUUID()}${extension}`;
  await files.write(path, file, true, undefined, onUploadProgress);
  return path;
}

export function useNodeFiles() {
  const createFiles = inject<(() => WorkspaceFiles) | undefined>("workspaceFiles", undefined);
  const retainNodeFiles = inject("retainNodeFiles", false);
  const getWorkspaceDirectory = inject<() => string>("workspaceDirectory", () => { throw new Error("当前画布未提供工作目录"); });
  const reportedErrors = new WeakSet<Error>();
  function reportError(error: unknown, onError: (error: unknown) => void) {
    if (error instanceof Error) {
      if (reportedErrors.has(error)) return;
      reportedErrors.add(error);
    }
    onError(error);
  }

  function getWorkspaceFiles() {
    if (!createFiles) throw new Error("当前画布未提供工作区文件能力");
    return createFiles();
  }

  function uploadFile(nodeId: string, file: File) {
    // ACT: 多步上传共用开始时的工作区，避免切换项目后写入另一目录。
    return uploadNodeFile(getWorkspaceFiles(), nodeId, file);
  }

  async function removeNodeFiles(nodeId: string) {
    const directory = getNodeDirectory(nodeId);
    // ACT: 支持撤销的画布保留节点素材，不随节点删除物理文件。
    if (retainNodeFiles) return;
    await getWorkspaceFiles().remove(directory, true).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
      if (error.response?.data?.data?.code !== "ENOENT") throw error;
    });
  }

  function useFileUrl(file: MaybeRefOrGetter<NodeMediaValue | undefined>, onError: (error: unknown) => void, preview = false) {
    const fileUrl = ref("");
    const loading = ref(false);
    const error = shallowRef<unknown>();
    const reloadRequest = ref(0);
    const previewReady = useNodePreviewReady();
    watch([() => toValue(file), previewReady, reloadRequest], async ([value, ready, reload], previous, onCleanup) => {
      let cancelled = false;
      let url = "";
      let cancelRetry: (() => void) | undefined;
      let shared: ReturnType<NonNullable<WorkspaceFiles["acquireUrl"]>> | undefined;
      onCleanup(() => {
        cancelled = true;
        cancelRetry?.();
        shared?.release();
        if (url) URL.revokeObjectURL(url);
      });
      fileUrl.value = "";
      loading.value = false;
      error.value = undefined;
      if (!value || !ready) return;
      loading.value = true;
      try {
        const files = getWorkspaceFiles();
        // 同一地址也先移除旧视图，让浏览器能重新加载已经失败的资源。
        await nextTick();
        for (let attempt = 0; attempt < 2 && !cancelled; attempt++) {
          try {
            shared = files.acquireUrl?.(value.url, value.mimeType, preview, attempt > 0 || reload > 0 && reload !== previous[2]);
            const nextUrl = shared ? await shared.url : await files.read(value.url).then(content => {
              if (cancelled) return "";
              return url = URL.createObjectURL(new Blob([content], { type: value.mimeType }));
            });
            if (!cancelled) fileUrl.value = nextUrl;
            return;
          } catch (failure) {
            shared?.release();
            shared = undefined;
            if (cancelled) return;
            if (attempt) {
              error.value = failure;
              reportError(failure, onError);
              return;
            }
            // ACT: 只重试一次文件读取；写入和生成请求不参与恢复。
            await new Promise<void>(resolve => {
              const timer = setTimeout(resolve, 800);
              cancelRetry = () => { clearTimeout(timer); resolve(); };
            });
            cancelRetry = undefined;
          }
        }
      } catch (failure) {
        if (!cancelled) { error.value = failure; reportError(failure, onError); }
      } finally { if (!cancelled) loading.value = false; }
    }, { immediate: true });
    return Object.assign(fileUrl, { loading, error, reload: () => { reloadRequest.value++; } });
  }

  function useMediaInfo(file: MaybeRefOrGetter<NodeMediaValue | undefined>, onError: (error: unknown) => void) {
    const info = ref<{ width?: number; height?: number; duration?: number }>();
    const ready = useNodePreviewReady();
    watch([() => toValue(file), ready], async ([value, visible], _previous, onCleanup) => {
      let cancelled = false;
      onCleanup(() => { cancelled = true; });
      info.value = undefined;
      if (!value || !visible) return;
      try {
        const data = await getWorkspaceFiles().getMediaInfo?.(value.url);
        if (!cancelled) info.value = data;
      } catch (error) { if (!cancelled) reportError(error, onError); }
    }, { immediate: true });
    return info;
  }

  return { getWorkspaceFiles, getWorkspaceDirectory, uploadFile, removeNodeFiles, useFileUrl, useMediaInfo };
}
