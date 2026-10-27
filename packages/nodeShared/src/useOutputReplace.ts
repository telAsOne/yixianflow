import { validateMediaFiles } from "./mediaLimits";
import { onScopeDispose, ref } from "vue";
import type { useNode } from "@toonflow/nodes-scaffold/runtime";
import { showNodeError } from "./showNodeError";

export function useOutputReplace(kind: "image" | "video" | "audio", files: ReturnType<typeof useNode>["files"],
  isBusy: () => boolean, setOutput: (value: { url: string; mimeType: string }) => void) {
  const label = { image: "图片", video: "视频", audio: "音频" }[kind];
  const uploading = ref(false);
  let disposed = false;
  onScopeDispose(() => { disposed = true; });

  async function replaceOutput(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || disposed || uploading.value || isBusy()) return;
    if (!file.type.startsWith(`${kind}/`)) return void showNodeError(`请选择${label}文件`, `${label}替换失败`);
    uploading.value = true;
    try {
      await validateMediaFiles([file]);
      const workspace = files.getWorkspaceFiles();
      const url = await files.uploadFile(file);
      if (disposed) { await workspace.remove(url); return; }
      // ACT: 替换不删除历史文件，保留撤销记录及复制节点的引用。
      setOutput({ url, mimeType: file.type });
    } catch (error) { showNodeError(error, `${label}替换失败`); }
    finally { uploading.value = false; }
  }

  return { uploading, replaceOutput };
}
