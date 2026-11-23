import { computed, ref, shallowRef } from "vue";
import { defineStore } from "pinia";
import api, { errorMessage } from "@/lib/api";
import { webUserId } from "@/lib/webRuntime";
import { isAxiosError } from "axios";
import type { ProjectActivity, ProjectEvent, ProjectMember, ProjectPresence, ProjectRole } from "@toonflow/server/collaboration";

export const useCollaborationStore = defineStore("collaboration", () => {
  const projectId = ref("");
  const role = ref<ProjectRole>("viewer");
  const members = shallowRef<ProjectMember[]>([]);
  const presence = shallowRef<ProjectPresence[]>([]);
  const activities = shallowRef<ProjectActivity[]>([]);
  const invites = shallowRef<{ id: string; role: string; expiresAt: string }[]>([]);
  const connected = ref(false);
  const error = ref("");
  const accessLost = ref(false);
  const panel = ref<"ai" | "records">("ai");
  const following = ref("");
  const canManage = computed(() => ["owner", "admin"].includes(role.value) && !accessLost.value);
  const canEdit = computed(() => role.value !== "viewer" && !accessLost.value);
  const sessionId = crypto.randomUUID();
  let controller: AbortController | undefined;
  let refreshPending: Promise<void> | undefined;
  let refreshId = "";
  let generation = 0;

  async function refresh() {
    const id = projectId.value;
    if (refreshPending && refreshId === id) return refreshPending;
    if (!id) return;
    refreshId = id;
    const version = generation;
    const pending: Promise<void> = (async () => {
      const [memberResponse, activityResponse] = await Promise.all([
        api.get<{ data: { project: { role: ProjectRole }; members: ProjectMember[]; invites: typeof invites.value } }>("/api/projects/members/list", { params: { id } }),
        api.get<{ data: ProjectActivity[] }>("/api/projects/activity", { params: { id } }),
      ]);
      if (projectId.value !== id || version !== generation) return;
      role.value = memberResponse.data.data.project.role;
      members.value = memberResponse.data.data.members;
      invites.value = memberResponse.data.data.invites;
      activities.value = activityResponse.data.data;
      accessLost.value = false;
    })().catch(cause => {
      if (projectId.value === id && version === generation) { error.value = errorMessage(cause, "读取协作信息失败"); if (isAxiosError(cause) && [401, 403, 404].includes(cause.response?.status ?? 0)) accessLost.value = true; }
      throw cause;
    }).finally(() => { if (refreshPending === pending) refreshPending = undefined; });
    refreshPending = pending;
    return refreshPending;
  }

  function receive(event: ProjectEvent) {
    if (event.type === "presence") presence.value = event.members;
    if (event.type === "presenceDelta") {
      const members = new Map(presence.value.map(member => [member.sessionId, member]));
      for (const id of event.removed) members.delete(id);
      for (const member of event.members) members.set(member.sessionId, member);
      presence.value = [...members.values()];
    }
    if (event.type === "activity") activities.value = [event.activity, ...activities.value.filter(item => item.id !== event.activity.id)].slice(0, 50);
    if (event.type === "permissions") void refresh().catch(() => {});
    if (event.type === "ready") {
      void refresh().catch(() => {});
      window.dispatchEvent(new CustomEvent("toonflow:canvas-update", { detail: { directory: projectId.value } }));
    }
    if (event.type === "canvas") window.dispatchEvent(new CustomEvent("toonflow:canvas-update", { detail: { directory: projectId.value, event } }));
    if (event.type === "file") window.dispatchEvent(new CustomEvent("toonflow:workspace-file-update", { detail: { directory: projectId.value, path: event.path } }));
  }

  async function connect(id: string, signal: AbortSignal) {
    while (!signal.aborted) {
      const attempt = new AbortController();
      let watchdog = setTimeout(() => attempt.abort(new Error("协作连接超时")), 35000);
      try {
        const response = await fetch(`/api/projects/events?id=${encodeURIComponent(id)}&presenceMode=delta`, { signal: AbortSignal.any([signal, attempt.signal]), cache: "no-store",
          headers: { "x-toonflow-workspace": "1", "x-yixianflow-user": String(webUserId.value) } });
        if (response.status === 401) window.dispatchEvent(new Event("toonflow:sign-in"));
        if (!response.ok || !response.body) throw new Error("协作连接中断，请检查登录和项目权限");
        connected.value = true;
        error.value = "";
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            clearTimeout(watchdog);
            watchdog = setTimeout(() => attempt.abort(new Error("协作连接超时")), 35000);
            buffer += decoder.decode(value, { stream: true });
            if (buffer.length > 2 * 1024 * 1024) throw new Error("协作消息过大");
            let end: number;
            while ((end = buffer.indexOf("\n\n")) !== -1) {
              const line = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              if (line.startsWith("data: ")) receive(JSON.parse(line.slice(6)) as ProjectEvent);
            }
          }
        } finally { await reader.cancel().catch(() => {}); }
      } catch (cause) {
        if (!signal.aborted) error.value = errorMessage(cause, "协作连接中断");
      } finally { clearTimeout(watchdog); }
      if (projectId.value === id) connected.value = false;
      if (!signal.aborted) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, 2000);
        signal.addEventListener("abort", finish, { once: true });
      });
    }
  }

  function start(id: string) {
    stop();
    projectId.value = id;
    controller = new AbortController();
    void connect(id, controller.signal);
  }

  function stop() {
    if (projectId.value) void api.post("/api/projects/presence", { id: projectId.value, sessionId, path: "", panel: "canvas", visible: false, activity: "", selected: [], leave: true }).catch(() => {});
    generation++;
    refreshPending = undefined;
    refreshId = "";
    controller?.abort();
    projectId.value = "";
    connected.value = false;
    presence.value = [];
    activities.value = [];
    members.value = [];
    invites.value = [];
    following.value = "";
    panel.value = "ai";
    error.value = "";
    accessLost.value = false;
    role.value = "viewer";
  }

  async function updatePresence(state: { path: string; panel: "canvas" | "document"; visible: boolean; activity: string; selected: string[];
    cursor?: { x: number; y: number }; viewport?: { x: number; y: number; zoom: number }; leave?: boolean }) {
    if (!projectId.value) return;
    await api.post("/api/projects/presence", { id: projectId.value, sessionId, compact: true, ...state });
  }

  return { projectId, role, members, presence, activities, invites, connected, error, accessLost, panel, following,
    sessionId, canManage, canEdit, start, stop, refresh, updatePresence };
});
