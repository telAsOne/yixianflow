import axios from "axios";
import { computed, ref, shallowRef } from "vue";
import type { updateSnapshot } from "@toonflow/server/desktop";
import { isRemoteConnection } from "@/lib/mobile";

export const desktopUpdateSnapshot = shallowRef<updateSnapshot | null>(null);
export const desktopUpdateAction = ref<"read" | "check" | "download" | "apply" | null>(null);
export const desktopUpdateChecking = computed(() => desktopUpdateAction.value === "check");
export const desktopUpdateError = ref("");
export const hasDesktopUpdate = computed(() => desktopUpdateSnapshot.value?.channel !== "dev"
  && !!(desktopUpdateSnapshot.value?.updateAvailable || desktopUpdateSnapshot.value?.updateReady));

let pendingUpdate: Promise<updateSnapshot> | undefined;
let updateController: AbortController | undefined;

function getUpdateError(error: unknown) {
  return axios.isAxiosError<{ message?: string }>(error) ? error.response?.data?.message || error.message : String(error);
}

function publishUpdate(snapshot: updateSnapshot) {
  desktopUpdateSnapshot.value = snapshot;
  desktopUpdateError.value = snapshot.error;
  return snapshot;
}

function waitForUpdateRead(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, 1500);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

async function readUpdate(signal: AbortSignal, attempts = 3, timeout = 10000): Promise<updateSnapshot> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { data } = await axios.get<{ data: updateSnapshot }>("/api/desktop/update", { signal, timeout });
      signal.throwIfAborted();
      return publishUpdate(data.data);
    } catch (error) {
      if (signal.aborted || attempt >= attempts) throw error;
      await waitForUpdateRead(signal);
    }
  }
}

async function observeDownloadProgress(signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      await waitForUpdateRead(signal);
      await readUpdate(signal, 1);
    } catch {
      // ACT: 下载请求负责最终结果；进度查询短暂失败只等下一次读取，不重发下载。
    }
  }
}

async function observeUpdate(snapshot: updateSnapshot, signal: AbortSignal) {
  // ACT: 仅重复读取状态，最多观察三分钟；短暂断连不代表宿主已成功退出，不重发更新请求。
  const deadline = performance.now() + 180000;
  while (snapshot.updating && !snapshot.installFailure) {
    if (performance.now() >= deadline) throw new Error("暂时无法确认更新结果，请稍后重新读取状态，或重新打开客户端。");
    await waitForUpdateRead(signal);
    if (performance.now() >= deadline) continue;
    try { snapshot = await readUpdate(signal, 1, Math.max(1, Math.min(10000, deadline - performance.now()))); }
    catch (error) { if (signal.aborted) throw error; }
  }
  return snapshot;
}

export function stopDesktopUpdateObservation() {
  updateController?.abort();
}

export function checkDesktopUpdate(readFirst = false) {
  return runDesktopUpdate("check", readFirst);
}

export function runDesktopUpdate(nextAction: NonNullable<typeof desktopUpdateAction.value>, readFirst = false) {
  if (isRemoteConnection) return Promise.reject(new Error("连接其他设备时无法更新本机客户端，请断开并独立运行后重试。"));
  if (pendingUpdate) return pendingUpdate;
  // 上轮观察超时后只能重新读取，不能因客户端没有收到结果而再次提交安装。
  if (desktopUpdateSnapshot.value?.updating) nextAction = "read";
  const controller = new AbortController();
  updateController = controller;
  desktopUpdateAction.value = nextAction;
  desktopUpdateError.value = "";
  pendingUpdate = (async () => {
    if (nextAction === "read" || readFirst) {
      const snapshot = await readUpdate(controller.signal);
      if (nextAction === "read" || snapshot.channel === "dev" || snapshot.updating
        || snapshot.updateAvailable || snapshot.updateReady || snapshot.installFailure)
        return observeUpdate(snapshot, controller.signal);
    }
    let snapshot: updateSnapshot;
    if ((nextAction === "download" || nextAction === "apply") && desktopUpdateSnapshot.value)
      desktopUpdateSnapshot.value = { ...desktopUpdateSnapshot.value, updating: true, updateProgress: undefined };
    const progressController = nextAction === "download" ? new AbortController() : undefined;
    const progressTask = progressController && observeDownloadProgress(AbortSignal.any([controller.signal, progressController.signal]));
    try {
      const { data } = await axios.post<{ data: updateSnapshot }>(`/api/desktop/update/${nextAction}`, null, {
        headers: { "x-toonflow-desktop": "1" }, signal: controller.signal,
        timeout: nextAction === "check" ? 45000 : nextAction === "apply" ? 180000 : 0,
      }).finally(async () => {
        progressController?.abort();
        await progressTask;
      });
      controller.signal.throwIfAborted();
      snapshot = publishUpdate(data.data);
    } catch (error) {
      if (controller.signal.aborted) throw error;
      // POST 断连也可能已经交接，只读回查；请求随 App 存活，不随关于页卸载而取消。
      try { snapshot = await readUpdate(controller.signal); }
      catch (readError) {
        if (!desktopUpdateSnapshot.value?.updating || controller.signal.aborted) throw readError;
        return observeUpdate(desktopUpdateSnapshot.value, controller.signal);
      }
      if (!snapshot.updating && !snapshot.error && !snapshot.installFailure) throw error;
    }
    return observeUpdate(snapshot, controller.signal);
  })().catch(error => {
    if (!controller.signal.aborted)
      desktopUpdateError.value = desktopUpdateSnapshot.value?.installFailure?.message || getUpdateError(error);
    throw error;
  }).finally(() => {
    pendingUpdate = undefined;
    updateController = undefined;
    desktopUpdateAction.value = null;
  });
  return pendingUpdate;
}
