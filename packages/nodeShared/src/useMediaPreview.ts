import { computed, nextTick, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import { useNodeFiles } from "@toonflow/nodes-scaffold/workspaceFiles";
import type { NodeMediaValue } from "@toonflow/nodes-scaffold/values";

export function useMediaPreview(file: MaybeRefOrGetter<NodeMediaValue | undefined>, allowRetry: () => boolean = () => true) {
  const media = computed(() => toValue(file));
  const direct = computed(() => /^(https?:|blob:|data:)/i.test(media.value?.url ?? "") ? media.value?.url : undefined);
  const source = useNodeFiles().useFileUrl(() => direct.value ? undefined : media.value, () => {});
  const directUrl = ref("");
  const directReload = ref(0);
  const failure = ref("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retried = false;
  let resumeTime = 0;
  let player: HTMLMediaElement | undefined;
  const url = computed(() => direct.value ? directUrl.value : source.value);
  const loading = computed(() => source.loading.value || !!direct.value && !directUrl.value);
  const canRetry = computed(allowRetry);
  const error = computed(() => {
    const reason = source.error.value as { response?: { data?: { message?: string } }; message?: string } | undefined;
    return reason?.response?.data?.message || reason?.message || (reason ? "媒体读取失败" : failure.value);
  });

  watch([direct, directReload], async ([value], _previous, onCleanup) => {
    let cancelled = false;
    onCleanup(() => { cancelled = true; });
    directUrl.value = "";
    if (!value) return;
    await nextTick();
    if (!cancelled) directUrl.value = value;
  }, { immediate: true });
  watch(() => JSON.stringify([media.value?.url, media.value?.mimeType]), () => {
    clearTimeout(timer);
    retried = false;
    resumeTime = 0;
    failure.value = "";
  }, { flush: "sync" });
  function releasePlayer() {
    player?.pause();
    player?.removeAttribute("src");
    player?.load();
    player = undefined;
  }
  watch(url, releasePlayer, { flush: "sync" });
  onScopeDispose(() => { clearTimeout(timer); releasePlayer(); });

  function retry() {
    if (!canRetry.value) return;
    clearTimeout(timer);
    failure.value = "";
    if (direct.value) directReload.value++;
    else source.reload();
  }

  function onError(event?: Event) {
    if (!media.value) return;
    const element = event?.target;
    if (element instanceof HTMLMediaElement) {
      if (!element.error || element.currentSrc && element.currentSrc !== url.value) return;
      resumeTime = element.currentTime;
      player = element;
    }
    failure.value = "媒体加载失败，请重试预览";
    // ACT: 每份素材只自动恢复一次；损坏文件保留手动重试入口。
    if (retried || !canRetry.value) return;
    retried = true;
    timer = setTimeout(retry, 800);
  }

  function onReady(event?: Event) {
    failure.value = "";
    const element = event?.target;
    if (element instanceof HTMLMediaElement) player = element;
    if (element instanceof HTMLMediaElement && resumeTime && Number.isFinite(element.duration)) {
      element.currentTime = Math.min(resumeTime, Math.max(0, element.duration - 0.001));
      resumeTime = 0;
    }
  }

  return { url, loading, error, canRetry, retry, onError, onReady };
}

export type MediaPreview = ReturnType<typeof useMediaPreview>;
