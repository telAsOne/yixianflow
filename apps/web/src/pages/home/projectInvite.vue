<template>
  <el-dialog v-model="visible" class="projectInviteDialog" title="加入协作项目" width="min(440px, calc(100vw - 32px))" alignCenter :closeOnClickModal="false" @closed="dismiss">
    <div class="projectInviteContent">
      <div v-if="invite" class="inviteSummary">
        <span class="projectIcon" aria-hidden="true"><icon-layout-dashboard :size="24" /></span>
        <div class="projectInfo"><h3>{{ invite.name }}</h3><p>{{ invite.ownerName || '项目所有者' }} 邀请你加入</p></div>
        <span class="invitePermission"><icon-pencil v-if="invite.role === 'editor'" :size="14" aria-hidden="true" /><icon-eye v-else :size="14" aria-hidden="true" />{{ invite.role === 'editor' ? '可编辑' : '仅查看' }}</span>
      </div>
      <p v-if="failure" class="inviteError" role="alert"><icon-alert-circle :size="17" aria-hidden="true" /><span>{{ failure }}</span></p>
    </div>
    <template #footer><div class="inviteFooter"><el-button @click="visible = false">取消</el-button><el-button type="primary" :disabled="!invite" :loading="joining" @click="join">加入项目<icon-arrow-up-right :size="16" aria-hidden="true" /></el-button></div></template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import api, { errorMessage } from "@/lib/api";
import { webUserId } from "@/lib/webRuntime";
import { signInVisible } from "@/stores/account";
import { useWorkspaceStore } from "@/stores/workspace";

const route = useRoute();
const router = useRouter();
const workspace = useWorkspaceStore();
const visible = ref(false);
const joining = ref(false);
const failure = ref("");
const invite = ref<{ name: string; ownerName: string; role: string }>();
let token = "";
watch([() => route.query.projectInvite, webUserId], async ([value, userId], _old, onCleanup) => {
  let active = true;
  onCleanup(() => { active = false; });
  try {
    token = typeof value === "string" ? value : sessionStorage.getItem("projectInvite") || "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    sessionStorage.setItem("projectInvite", token);
  } catch { token = typeof value === "string" ? value : ""; }
  if (!token) return;
  if (!userId) { signInVisible.value = true; return; }
  visible.value = true;
  invite.value = undefined;
  failure.value = "";
  try {
    const { data } = await api.post<{ data: typeof invite.value }>("/api/projects/invites/preview", { token });
    if (active) invite.value = data.data;
  } catch (cause) { if (active) failure.value = errorMessage(cause, "无法读取邀请"); }
}, { immediate: true });

function clearPending() {
  try { sessionStorage.removeItem("projectInvite"); } catch { /* 当前页面仍可完成加入。 */ }
  token = "";
}
async function dismiss() {
  if (joining.value) return;
  clearPending();
  if (route.query.projectInvite) await router.replace({ query: { ...route.query, projectInvite: undefined } });
}
async function join() {
  if (joining.value || !invite.value || !token) return;
  joining.value = true;
  try {
    const { data } = await api.post<{ data: { id: string } }>("/api/projects/invites/accept", { token });
    await workspace.openProject(data.data.id);
    clearPending();
    await router.push("/workspace");
  } catch (cause) { failure.value = errorMessage(cause, "加入项目失败"); } finally { joining.value = false; }
}
</script>

<style scoped lang="scss">
.projectInviteContent {
  padding: 8px 0;

  .inviteSummary {
    display: grid;
    grid-template-columns: 48px minmax(0, 1fr);
    align-items: center;
    gap: 12px 14px;
    padding: 20px;
    border: 1px solid var(--el-border-color-light);
    border-radius: var(--ui-radius-large);
    background: var(--el-fill-color-extra-light);

    .projectIcon { display: grid; place-items: center; flex-shrink: 0; width: 48px; height: 48px; border: 1px solid var(--el-border-color-light); border-radius: var(--ui-radius-large); background: var(--el-bg-color); color: var(--el-text-color-secondary); box-shadow: var(--el-box-shadow-lighter); }
    .projectInfo { flex: 1; min-width: 0; > h3 { margin: 0 0 5px; color: var(--el-text-color-primary); font-size: 16px; font-weight: 600; overflow-wrap: anywhere; } > p { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; } }
    .invitePermission { display: inline-flex; grid-column: 2; justify-self: start; align-items: center; gap: 5px; padding: 4px 8px; border-radius: var(--ui-radius-small); background: var(--el-fill-color); color: var(--el-text-color-regular); font-size: 11px; }
  }

  .inviteError { display: flex; align-items: flex-start; gap: 8px; margin: 12px 0 0; padding: 12px; border-radius: var(--ui-radius); background: var(--el-color-danger-light-9); color: var(--el-color-danger); font-size: 13px; line-height: 1.6; > svg { flex-shrink: 0; margin-top: 2px; } > span { min-width: 0; overflow-wrap: anywhere; } }
}

.inviteFooter { display: flex; justify-content: flex-end; gap: 8px; > .el-button { margin: 0; :deep(> span) { gap: 6px; } } }
</style>
