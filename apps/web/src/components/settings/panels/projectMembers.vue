<template>
  <section class="projectMembers" aria-label="项目成员与协作">
    <div class="groupHeader">
      <div class="memberSummary"><icon-users :size="18" aria-hidden="true" /><strong>{{ visibleMembers.length }} 位成员</strong></div>
      <span class="connectionStatus" :class="{ disconnected: !collaboration.connected }" role="status"><i aria-hidden="true" />{{ collaboration.connected ? '已连接' : '重新连接中' }}</span>
    </div>
    <el-segmented v-model="tab" class="groupTabs" :options="tabs" aria-label="项目协作" />
    <p v-if="collaboration.error" class="groupError" role="status">{{ collaboration.error }}</p>
    <div v-if="tab === 'members'" class="groupMembers">
      <div class="memberList">
        <article v-for="member in visibleMembers" :key="member.userId" class="groupMember">
          <div class="memberIdentity">
            <span class="memberAvatar" aria-hidden="true">{{ (member.name || `用户 ${member.userId}`).slice(0, 1) }}</span>
            <div class="memberDetails">
              <strong :title="member.name || `用户 ${member.userId}`">{{ member.name || `用户 ${member.userId}` }}</strong>
              <div v-for="online in collaboration.presence.filter(item => item.userId === member.userId)" :key="online.sessionId" class="memberPresence">
                <i :class="{ away: !online.visible }" aria-hidden="true" />
                <span>{{ online.name }} · {{ online.activity || (online.visible ? '浏览中' : '暂离') }}</span>
                <el-button v-if="online.viewport" text size="small" @click="collaboration.following = collaboration.following === online.sessionId ? '' : online.sessionId">{{ collaboration.following === online.sessionId ? '停止跟随' : '跟随' }}</el-button>
              </div>
            </div>
          </div>
          <div v-if="collaboration.canManage && member.role !== 'owner' && member.role !== 'admin'" class="memberActions">
            <el-select :modelValue="member.role" size="small" aria-label="成员权限" @change="value => changeRole(member.userId, value)"><el-option label="可编辑" value="editor" /><el-option label="仅查看" value="viewer" /></el-select>
            <el-button text type="danger" size="small" :disabled="busy" @click="removeMember(member.userId)">移除</el-button>
          </div>
          <span v-else class="memberRole"><icon-shield-check v-if="member.role === 'owner' || member.role === 'admin'" :size="14" aria-hidden="true" />{{ roleNames[member.role] }}</span>
        </article>
      </div>
      <section v-if="collaboration.canManage" class="groupInvites" aria-label="邀请成员">
        <h3><icon-user-plus :size="18" aria-hidden="true" />邀请成员</h3>
        <div class="inviteControls">
          <el-select v-model="inviteRole" aria-label="邀请权限"><el-option label="可编辑" value="editor" /><el-option label="仅查看" value="viewer" /></el-select>
          <el-button type="primary" :loading="busy" @click="createInvite"><icon-link :size="16" aria-hidden="true" />创建邀请链接</el-button>
        </div>
        <div v-if="inviteUrl" class="inviteResult">
          <div class="inviteLink"><el-input :modelValue="inviteUrl" readonly aria-label="邀请链接" /><el-button @click="copyInvite"><icon-copy :size="15" aria-hidden="true" />复制</el-button></div>
          <p>链接 7 天有效，供一位成员登录后加入。</p>
        </div>
        <div v-if="collaboration.invites.length" class="inviteList">
          <div v-for="invite in collaboration.invites" :key="invite.id" class="inviteRow">
            <icon-link :size="16" aria-hidden="true" />
            <div><strong>{{ invite.role === 'editor' ? '可编辑' : '仅查看' }}</strong><span>{{ formatTime(invite.expiresAt) }} 到期</span></div>
            <el-button text type="danger" size="small" :disabled="busy" @click="revokeInvite(invite.id)">撤销</el-button>
          </div>
        </div>
      </section>
      <el-button v-if="collaboration.role === 'editor' || collaboration.role === 'viewer'" class="leaveProject" text type="danger" @click="removeMember(webUserId!)"><icon-logout :size="16" aria-hidden="true" />退出项目</el-button>
    </div>
    <div v-if="tab === 'activity'" class="groupActivity">
      <button v-for="activity in collaboration.activities" :key="activity.id" type="button" @click="locate(activity)">
        <span class="activityMarker" aria-hidden="true"><icon-history :size="16" /></span>
        <span class="activityDetails"><span class="activityHeading"><strong>{{ activity.name }}</strong><time>{{ formatTime(activity.createdAt) }}</time></span><span class="activityAction">{{ activity.action }}</span><small v-if="activity.path">{{ activity.path }}</small></span>
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import api, { errorMessage } from "@/lib/api";
import { writeClipboardText } from "@/lib/clipboard";
import { useCollaborationStore } from "@/stores/collaboration";
import { webUserId } from "@/lib/webRuntime";
import type { ProjectActivity } from "@toonflow/server/collaboration";

const collaboration = useCollaborationStore();
const props = defineProps<{ visible: boolean }>();
watch([() => props.visible, () => collaboration.projectId], ([visible, id]) => {
  if (visible && id) void collaboration.refresh().catch(cause => ElMessage.error(errorMessage(cause, "读取项目成员失败")));
}, { immediate: true });
const visibleMembers = computed(() => {
  const members = new Map(collaboration.members.map(member => [member.userId, member]));
  for (const member of collaboration.presence) if (!members.has(member.userId)) members.set(member.userId, { userId: member.userId, name: member.name, role: member.admin ? "admin" : "editor" });
  return [...members.values()];
});
const tabs = [{ value: "members", label: "成员与邀请" }, { value: "activity", label: "最近操作" }];
const roleNames = { owner: "项目管理员", admin: "Union 管理员", editor: "可编辑", viewer: "仅查看" };
const tab = ref("members");
const busy = ref(false);
const inviteRole = ref("editor");
const inviteUrl = ref("");
const formatTime = (value: string) => new Date(value).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

async function perform(action: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  try { await action(); } catch (cause) { ElMessage.error(errorMessage(cause, "操作失败")); } finally { busy.value = false; }
}
async function createInvite() {
  await perform(async () => {
    const { data } = await api.post<{ data: { url: string } }>("/api/projects/invites/create", { id: collaboration.projectId, role: inviteRole.value });
    inviteUrl.value = data.data.url;
    await collaboration.refresh();
  });
}
async function copyInvite() { try { await writeClipboardText(inviteUrl.value); ElMessage.success("邀请链接已复制"); } catch (cause) { ElMessage.error(errorMessage(cause, "请手动复制邀请链接")); } }
async function changeRole(userId: number, role: unknown) { await perform(async () => { await api.put("/api/projects/members/save", { id: collaboration.projectId, userId, role }); await collaboration.refresh(); }); }
async function removeMember(userId: number) {
  try { await ElMessageBox.confirm(userId === webUserId.value ? "退出后需重新获得邀请才能访问项目，确定退出？" : "确定移除此成员的项目访问权限？", "项目成员", { type: "warning" }); } catch { return; }
  await perform(async () => { await api.delete("/api/projects/members/remove", { data: { id: collaboration.projectId, userId } }); await collaboration.refresh(); });
}
async function revokeInvite(hash: string) { await perform(async () => { await api.delete("/api/projects/invites/revoke", { data: { id: collaboration.projectId, hash } }); await collaboration.refresh(); }); }
function locate(activity: ProjectActivity) { if (activity.path) window.dispatchEvent(new CustomEvent("toonflow:locate-collaboration", { detail: activity })); }
</script>

<style scoped lang="scss">
.projectMembers {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
  color: var(--el-text-color-primary);

  .groupHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;

    .memberSummary {
      display: flex;
      align-items: center;
      gap: 9px;
      font-size: 13px;
      > svg { color: var(--el-text-color-secondary); }
      > strong { font-weight: 500; }
    }

    .connectionStatus {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 9px;
      border: 1px solid var(--el-border-color-lighter);
      border-radius: 20px;
      color: var(--el-text-color-secondary);
      font-size: 11px;
      line-height: 1.5;
      > i { width: 6px; height: 6px; border-radius: 50%; background: var(--el-color-success); }
      &.disconnected > i { background: var(--el-color-warning); }
    }
  }

  .groupTabs {
    --el-segmented-bg-color: var(--el-fill-color-light);
    --el-segmented-item-selected-bg-color: var(--el-bg-color-overlay);
    --el-segmented-item-selected-color: var(--el-text-color-primary);
    align-self: flex-start;
    min-height: 36px;
    padding: 3px;
    font-size: 12px;
    :deep(.el-segmented__item) { padding: 0 16px; }
    :deep(.el-segmented__item-selected) { box-shadow: var(--el-box-shadow-lighter); }
  }

  .groupError { margin: 0; padding: 10px 12px; border-radius: var(--ui-radius); background: var(--el-color-danger-light-9); color: var(--el-color-danger); font-size: 12px; }

  .groupMembers {
    display: flex;
    flex-direction: column;
    gap: 24px;

    .memberList {
      border: 1px solid var(--el-border-color-light);
      border-radius: var(--ui-radius-large);
      overflow: hidden;

      .groupMember {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 16px;
        & + .groupMember { border-top: 1px solid var(--el-border-color-lighter); }

        .memberIdentity {
          display: flex;
          align-items: center;
          flex: 1;
          gap: 12px;
          min-width: 0;

          .memberAvatar {
            display: grid;
            place-items: center;
            flex-shrink: 0;
            width: 36px;
            height: 36px;
            border: 1px solid var(--el-border-color-lighter);
            border-radius: var(--ui-radius-large);
            background: var(--el-fill-color-light);
            color: var(--el-text-color-regular);
            font-size: 14px;
            font-weight: 500;
          }

          .memberDetails {
            display: flex;
            flex-direction: column;
            gap: 5px;
            min-width: 0;
            > strong { overflow: hidden; font-size: 13px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }

            .memberPresence {
              display: flex;
              align-items: center;
              flex-wrap: wrap;
              gap: 6px;
              color: var(--el-text-color-secondary);
              font-size: 12px;
              line-height: 1.6;
              > i { flex-shrink: 0; width: 5px; height: 5px; border-radius: 50%; background: var(--el-color-success); &.away { background: var(--el-text-color-placeholder); } }
              > span { min-width: 0; overflow-wrap: anywhere; }
              > .el-button { height: 20px; margin: 0; padding: 0 4px; font-size: 11px; }
            }
          }
        }

        .memberRole { display: inline-flex; align-items: center; flex-shrink: 0; gap: 5px; padding: 4px 8px; border-radius: var(--ui-radius-small); background: var(--el-fill-color-light); color: var(--el-text-color-secondary); font-size: 11px; }
        .memberActions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; .el-select { width: 100px; } .el-button { margin: 0; } }
      }
    }

    .groupInvites {
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 20px;
      border: 1px solid var(--el-border-color-light);
      border-radius: var(--ui-radius-large);
      background: var(--el-fill-color-extra-light);

      > h3 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 13px; font-weight: 500; > svg { color: var(--el-text-color-secondary); } }
      .el-button { margin: 0; :deep(> span) { gap: 6px; } }
      .inviteControls { display: flex; flex-wrap: wrap; gap: 10px; > .el-select { width: 120px; } }
      .inviteResult {
        display: flex;
        flex-direction: column;
        gap: 8px;
        .inviteLink { display: flex; align-items: center; gap: 8px; min-width: 0; > .el-input { flex: 1; min-width: 0; } }
        > p { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
      }
      .inviteList {
        border-top: 1px solid var(--el-border-color-light);
        .inviteRow {
          display: flex;
          align-items: center;
          gap: 10px;
          padding-top: 14px;
          > svg { flex-shrink: 0; color: var(--el-text-color-placeholder); }
          > div { display: flex; flex: 1; flex-wrap: wrap; align-items: center; gap: 6px 12px; min-width: 0; font-size: 12px; > strong { font-weight: 500; } > span { color: var(--el-text-color-secondary); } }
        }
      }
    }

    .leaveProject { align-self: flex-start; margin: 0; :deep(> span) { gap: 6px; } }
  }

  .groupActivity {
    > button {
      display: flex;
      gap: 12px;
      width: 100%;
      padding: 14px 10px;
      border: 0;
      border-radius: var(--ui-radius);
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
      transition: background-color 0.15s;
      &:hover { background: var(--el-fill-color-extra-light); }
      &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }

      .activityMarker { display: grid; place-items: center; flex-shrink: 0; width: 30px; height: 30px; border: 1px solid var(--el-border-color-lighter); border-radius: 50%; color: var(--el-text-color-secondary); }
      .activityDetails {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: 6px;
        min-width: 0;
        .activityHeading { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 6px 12px; font-size: 12px; > strong { font-weight: 500; overflow-wrap: anywhere; } > time { color: var(--el-text-color-secondary); font-size: 11px; } }
        .activityAction { font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
        > small { color: var(--el-text-color-secondary); font-size: 11px; overflow-wrap: anywhere; }
      }
    }
  }

  @media (max-width: 700px) {
    gap: 16px;
    .groupMembers {
      .memberList .groupMember { flex-wrap: wrap; gap: 12px; padding: 12px; .memberIdentity { flex-basis: 100%; } .memberActions, .memberRole { margin-left: 48px; } }
      .groupInvites { padding: 16px; }
    }
  }
}
</style>
