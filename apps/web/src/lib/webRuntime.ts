import { ref } from "vue";

export const webMode = ref(false);
export const webUserId = ref<number>();
export const webUserName = ref("");
export const webRuntimeLoaded = ref(false);

export async function loadWebRuntime() {
  const response = await fetch("/api/runtime", { cache: "no-store" });
  if (response.status === 404) { webRuntimeLoaded.value = true; return; }
  if (!response.ok) throw new Error("无法读取服务运行模式，请重试");
  const body = await response.json() as { data: { webMode: boolean; userId?: number; userName?: string } };
  webMode.value = body.data.webMode;
  webUserId.value = body.data.userId;
  webUserName.value = body.data.userName ?? "";
  webRuntimeLoaded.value = true;
}
