import { nextTick, type Ref } from "vue";
import axios from "axios";
import { debounce } from "lodash-es";
import { ElMessage } from "element-plus";
import type { useVueFlow } from "@vue-flow/core";
import { useNodeEvent } from "@toonflow/nodes-scaffold/nodeEvent";
import type { CanvasSnapshot } from "@toonflow/server/canvasMerge";
import type { useCanvasSync } from "./useCanvasSync";

export function useCanvasSave(flow: ReturnType<typeof useVueFlow>, sync: ReturnType<typeof useCanvasSync>, state: {
  directory(): string | undefined; path(): string; ready(): boolean; readOnly?(): boolean; dirty: Ref<boolean>; error: Ref<string>;
}) {
  let saving = Promise.resolve();
  let flushing = Promise.resolve();
  let saveError: unknown;
  let savePaused = false;
  let saveCancelled = false;
  let changedWhilePaused = false;
  let saveRevision = 0;
  let writtenRevision = -1;
  const saveCanvas = debounce((directory: string, fileName: string) => {
    const requestedRevision = saveRevision;
    // 同页保存串行取最新修改，主机按节点与字段合并其他成员的更新。
    saving = saving.then(async () => {
      if (requestedRevision <= writtenRevision) return;
      try {
        if (!state.ready()) throw new Error("画布尚未就绪");
        if (directory !== state.directory() || fileName !== state.path()) throw new Error("画布已切换，无法将当前内容保存到原画布");
        const revision = saveRevision;
        const dirty = await sync.save();
        writtenRevision = revision;
        saveError = undefined;
        state.error.value = "";
        state.dirty.value = dirty || revision !== saveRevision;
      } catch (err) {
        const previousError = state.error.value;
        saveError = err;
        state.error.value = axios.isAxiosError<{ message?: string }>(err) ? err.response?.data.message || err.message : err instanceof Error ? err.message : "画布保存失败";
        if (!sync.conflict.value && state.error.value !== previousError) ElMessage.error({ message: state.error.value, grouping: true });
      }
    });
  }, 500);

  function scheduleCanvasSave() {
    if (state.readOnly?.()) return;
    if (sync.applying.value) return;
    if (saveCancelled || !state.directory() || !state.path()) return;
    state.dirty.value = true;
    saveRevision++;
    if (sync.conflict.value) { sync.scheduleBackup(); return; }
    if (savePaused) {
      changedWhilePaused = true;
      return;
    }
    const directory = state.directory();
    if (directory && state.path()) saveCanvas(directory, state.path());
  }


  function resetSavedState(disk: { canvas: CanvasSnapshot; revision: string }) {
    sync.initialize(disk);
    state.dirty.value = false;
    state.error.value = "";
    saveError = undefined;
    changedWhilePaused = false;
  }


  function flushCanvasSave(action?: () => Promise<void>): Promise<void> {
    // ACT: 完整保存及其文件操作串行执行，重命名暂停期间的显式保存也必须等待。
    const next = flushing.then(() => saveCanvasState(action)).then(() => { state.error.value = ""; }, error => {
      state.error.value = axios.isAxiosError<{ message?: string }>(error) ? error.response?.data.message || error.message : error instanceof Error ? error.message : "画布保存失败";
      throw error;
    });
    flushing = next.catch(() => {});
    return next;
  }

  async function saveCanvasState(action?: () => Promise<void>) {
    if (state.readOnly?.()) { if (action) throw new Error("当前项目为仅查看权限"); return; }
    if (saveCancelled) throw new Error("画布保存已取消");
    if (sync.conflict.value) { await sync.flushRecovery(); throw new Error(sync.conflict.value.message); }
    await Promise.all(flow.getNodes.value.map((node) => useNodeEvent(node.id, flow).emit("save")));
    await nextTick();
    if (saveCancelled) throw new Error("画布保存已取消");
    if (sync.isDirty()) scheduleCanvasSave();
    else if (saveError && state.directory() && state.path()) saveCanvas(state.directory()!, state.path());
    if (action) savePaused = true;
    try {
      let revision: number;
      do {
        if (saveCancelled) throw new Error("画布保存已取消");
        revision = saveRevision;
        if (changedWhilePaused && state.directory() && state.path()) {
          saveCanvas(state.directory()!, state.path());
          changedWhilePaused = false;
        }
        saveCanvas.flush();
        await saving;
        if (saveError) throw saveError;
        // 画布写入期间节点可能完成生成，等新增落盘后重新保存变化。
        await Promise.all(flow.getNodes.value.map((node) => useNodeEvent(node.id, flow).emit("save")));
        await nextTick();
      } while (revision !== saveRevision);
      if (saveCancelled) throw new Error("画布保存已取消");
      await action?.();
    } finally {
      if (action && !saveCancelled) {
        savePaused = false;
        if (changedWhilePaused && state.directory() && state.path()) saveCanvas(state.directory()!, state.path());
        changedWhilePaused = false;
      }
    }
  }

  function cancelCanvasSave() {
    saveCancelled = true;
    savePaused = true;
    changedWhilePaused = false;
    saveCanvas.cancel();
  }
  return { scheduleCanvasSave, resetSavedState, flushCanvasSave, cancelCanvasSave,
    get revision() { return saveRevision; }, get paused() { return savePaused; },
    clearError() { saveError = undefined; }, flush() { saveCanvas.flush(); } };
}
