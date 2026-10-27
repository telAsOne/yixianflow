import { ref } from "vue";
import api from "@/lib/api";
import { applyManagedSettings } from "@/stores/settings";
import type { AccountView } from "@toonflow/server/account";

export const accountView = ref<AccountView>();
export const signInVisible = ref(false);
export const refreshingModels = ref(false);

export async function refreshAccount() {
  const { data } = await api.get<{ data: AccountView }>("/api/account/get", { timeout: 35000 });
  const previous = accountView.value?.revision;
  if (data.data.revision !== previous) {
    const settings = await api.get("/api/settings/get");
    applyManagedSettings(settings.data.data);
  }
  accountView.value = data.data;
  return data.data;
}

export async function refreshModels() {
  if (refreshingModels.value) return;
  refreshingModels.value = true;
  try {
    const { data } = await api.post("/api/account/refreshModels", {}, { timeout: 35000 });
    applyManagedSettings(data.data);
    await refreshAccount();
  } finally { refreshingModels.value = false; }
}

export async function logout() {
  await api.post("/api/account/logout");
  accountView.value = undefined;
  applyManagedSettings({});
  await refreshAccount();
}
