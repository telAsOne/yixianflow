import { readonly, ref, shallowRef, toValue, watch, type MaybeRefOrGetter } from "vue";
import type { LocalHelperStatus } from "@toonflow/local-helper/protocol";
import api, { errorMessage } from "@/lib/api";
import { webMode } from "@/lib/webRuntime";

const status = shallowRef<LocalHelperStatus>();
const loading = ref(false);
const failure = ref("");
let consumers = 0;
let interval: ReturnType<typeof setInterval> | undefined;
let pending: AbortController | undefined;

async function refresh() {
  pending?.abort();
  const controller = new AbortController();
  pending = controller;
  loading.value = true;
  try {
    const response = await api.get<{ data: LocalHelperStatus }>("/api/localHelper/status", { signal: controller.signal, timeout: 15000 });
    if (pending !== controller) return;
    status.value = response.data.data;
    failure.value = "";
  } catch (error) {
    if (!controller.signal.aborted) failure.value = errorMessage(error, "无法读取本地助手状态");
  } finally {
    if (pending === controller) {
      pending = undefined;
      loading.value = false;
    }
  }
}

function poll() {
  if (!document.hidden && !pending) void refresh();
}

function updateVisibility() {
  if (!document.hidden) { void refresh(); return; }
  pending?.abort();
}

export default function useLocalHelper(active: MaybeRefOrGetter<boolean> = true) {
  watch(() => toValue(active) && webMode.value, (enabled, previous, onCleanup) => {
    if (!enabled) return;
    consumers++;
    if (consumers === 1) {
      document.addEventListener("visibilitychange", updateVisibility);
      window.addEventListener("focus", poll);
      interval = setInterval(poll, 5000);
    }
    poll();
    onCleanup(() => {
      consumers--;
      if (consumers) return;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", updateVisibility);
      window.removeEventListener("focus", poll);
      pending?.abort();
    });
  }, { immediate: true });
  return { status: readonly(status), loading: readonly(loading), failure: readonly(failure), refresh };
}
