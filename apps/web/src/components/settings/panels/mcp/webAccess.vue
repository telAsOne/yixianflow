<template>
  <div class="webMcpPanel">
    <section class="mcpSection" aria-labelledby="webMcpTitle">
      <div class="sectionHeading">
        <h3 id="webMcpTitle">画布 MCP</h3>
        <el-switch :modelValue="enabled" :loading="busy" aria-label="开启画布 MCP" @change="value => setEnabled(value === true)" />
      </div>
      <p>让你自己的 Agent 读取、编辑画布并传入文本、图片和视频。实时节点操作需要保持项目的画布网页打开。</p>
      <el-input :modelValue="endpoint" readonly aria-label="MCP 服务地址" />
      <p>每个凭证只授权一个项目，30 天有效，可随时撤销。素材传输单文件最多 20 MiB，生成、整理和 Agent 委托按账户正常计费。</p>
    </section>

    <section class="mcpSection" aria-labelledby="webMcpCreateTitle">
      <h3 id="webMcpCreateTitle">连接你的 Agent</h3>
      <el-form labelPosition="top" @submit.prevent="createAccess">
        <el-form-item label="授权项目">
          <el-select v-model="projectId" :disabled="busy || !enabled" aria-label="授权项目" filterable>
            <el-option v-for="project in workspaceStore.projectList" :key="project.directory" :label="project.name" :value="project.directory" />
          </el-select>
        </el-form-item>
        <el-form-item label="连接名称">
          <el-input v-model="name" :maxlength="100" :disabled="busy || !enabled" aria-label="连接名称" />
        </el-form-item>
        <el-form-item label="允许操作">
          <el-select v-model="permission" :disabled="busy || !enabled" aria-label="允许操作">
            <el-option label="仅读取" value="read" />
            <el-option label="读取和编辑" value="edit" />
          </el-select>
        </el-form-item>
        <el-form-item label="扩展能力">
          <el-checkbox-group v-model="scopes" class="scopeOptions" :disabled="busy || !enabled || permission !== 'edit'" aria-label="MCP 扩展能力">
            <el-checkbox v-for="scope in scopeOptions" :key="scope.value" :value="scope.value">{{ scope.label }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item v-if="scopes.includes('localComputer')" label="授权本机设备">
          <el-select v-model="deviceId" :disabled="busy" aria-label="授权本机设备">
            <el-option v-for="device in devices" :key="device.id" :value="device.id" :label="`${device.name}（${device.online ? '在线' : '离线'}）`" />
          </el-select>
          <p>仅限自己已绑定的设备，按当前 Windows 用户权限操作文件和执行命令，沿用本地助手的确认与自动执行设置。设备须在线并已授权。</p>
        </el-form-item>
        <el-button type="primary" nativeType="submit" :loading="busy" :disabled="!enabled || !projectId || !name.trim() || (scopes.includes('localComputer') && !deviceId)">生成连接配置</el-button>
      </el-form>
    </section>

    <section class="mcpSection" aria-labelledby="webMcpAccessTitle">
      <div class="sectionHeading"><h3 id="webMcpAccessTitle">已授权连接</h3><el-button text :loading="loading" @click="refresh">刷新</el-button></div>
      <p v-if="error" class="errorMessage" role="status">{{ error }}</p>
      <article v-for="access in accesses" :key="access.id" class="accessRow">
        <div class="accessDetails"><strong>{{ access.name }}</strong><span>{{ access.projectName }} · {{ access.permission === 'edit' ? '读取和编辑' : '仅读取' }}</span><span v-if="access.scopes?.length">{{ access.scopes.map(scope => scopeOptions.find(option => option.value === scope)?.label).filter(Boolean).join('、') }}</span><small>{{ formatExpiry(access.expiresAt) }} 到期</small></div>
        <el-button text type="danger" :disabled="busy" @click="revokeAccess(access.id)">撤销</el-button>
      </article>
    </section>

    <el-dialog v-model="configVisible" title="Agent 连接配置" width="min(680px, calc(100vw - 32px))" alignCenter appendToBody @closed="config = ''" @opened="configInput?.select()">
      <p class="configHint">将配置添加到 Agent 的 MCP 设置中。凭证仅在此处显示一次，请妥善保存。</p>
      <el-input ref="configInput" :modelValue="config" type="textarea" dir="ltr" :autosize="{ minRows: 10, maxRows: 18 }" readonly aria-label="Agent MCP 连接配置" />
      <template #footer><el-button @click="configVisible = false">关闭</el-button><el-button type="primary" @click="copyConfig">复制配置</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage, type InputInstance } from "element-plus";
import api, { errorMessage } from "@/lib/api";
import { writeClipboardText } from "@/lib/clipboard";
import { saveSettings, settings } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";

type Scope = "generateImage" | "generateVideo" | "arrangeCanvas" | "runAgent" | "localComputer";
type Access = { id: string; name: string; projectName: string; permission: "read" | "edit"; scopes: Scope[]; expiresAt: string };
type Device = { id: string; name: string; online: boolean };
const scopeOptions: { value: Scope; label: string }[] = [
  { value: "generateImage", label: "图片生成" }, { value: "generateVideo", label: "视频生成" },
  { value: "arrangeCanvas", label: "智能整理" }, { value: "runAgent", label: "内置 Agent 委托" }, { value: "localComputer", label: "本机工具" },
];
const workspaceStore = useWorkspaceStore();
const enabled = computed(() => (settings.value.mcp as { enabled?: boolean } | undefined)?.enabled === true);
const projectId = ref(workspaceStore.project?.directory ?? "");
const name = ref("");
const permission = ref<"read" | "edit">("edit");
const scopes = ref<Scope[]>([]);
const devices = ref<Device[]>([]);
const deviceId = ref<string>();
watch(permission, value => { if (value === "read") scopes.value = []; });
const endpoint = ref("");
const accesses = ref<Access[]>([]);
const busy = ref(false);
const loading = ref(false);
const error = ref("");
const config = ref("");
const configVisible = ref(false);
const configInput = ref<InputInstance>();
const formatExpiry = (value: string) => new Date(value).toLocaleDateString();

async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    const [status, list, helper] = await Promise.all([
      api.get<{ data: { endpoint: string } }>("/api/mcp/status"),
      api.get<{ data: Access[] }>("/api/mcp/access/list"),
      api.get<{ data: { devices: Device[]; selectedId: string | null } }>("/api/localHelper/status"),
    ]);
    endpoint.value = status.data.data.endpoint;
    accesses.value = list.data.data;
    devices.value = helper.data.data.devices;
    if (!devices.value.some(device => device.id === deviceId.value)) deviceId.value = helper.data.data.selectedId ?? undefined;
  } catch (cause) { error.value = errorMessage(cause, "读取 MCP 配置失败"); }
  finally { loading.value = false; }
}

async function setEnabled(value: boolean) {
  if (busy.value) return;
  busy.value = true;
  try {
    await saveSettings(current => ({ mcp: { ...(current.mcp as Record<string, unknown> | undefined), enabled: value } }));
    await refresh();
  } catch (cause) { ElMessage.error(errorMessage(cause, "保存 MCP 设置失败")); }
  finally { busy.value = false; }
}

async function createAccess() {
  if (busy.value || !enabled.value || !projectId.value || !name.value.trim()) return;
  busy.value = true;
  try {
    const { data } = await api.post<{ data: { token: string; endpoint: string } }>("/api/mcp/access/create", {
      projectId: projectId.value, name: name.value.trim(), permission: permission.value, scopes: scopes.value,
      ...(scopes.value.includes("localComputer") ? { deviceId: deviceId.value } : {}),
    });
    config.value = JSON.stringify({ mcpServers: { unionFlowCanvas: { url: data.data.endpoint, headers: { Authorization: `Bearer ${data.data.token}` } } } }, null, 2);
    configVisible.value = true;
    name.value = "";
    await refresh();
  } catch (cause) { ElMessage.error(errorMessage(cause, "生成 MCP 配置失败")); }
  finally { busy.value = false; }
}

async function revokeAccess(id: string) {
  if (busy.value) return;
  busy.value = true;
  try { await api.delete("/api/mcp/access/revoke", { data: { id } }); await refresh(); }
  catch (cause) { ElMessage.error(errorMessage(cause, "撤销 MCP 授权失败")); }
  finally { busy.value = false; }
}

async function copyConfig() {
  try { await writeClipboardText(config.value); ElMessage.success("MCP 配置已复制"); }
  catch { configInput.value?.select(); ElMessage.info("请选中配置后手动复制"); }
}

onMounted(refresh);
</script>

<style scoped lang="scss">
.webMcpPanel {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-width: 0;
  .mcpSection {
    min-width: 0;
    h3 { margin: 0 0 12px; font-size: 15px; }
    p { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.7; }
    .sectionHeading { display: flex; align-items: center; justify-content: space-between; gap: 12px; h3 { margin: 0; } }
    .el-select { width: 100%; }
    .scopeOptions { display: flex; flex-wrap: wrap; gap: 4px 20px; :deep(.el-checkbox) { margin-right: 0; } }
    .errorMessage { color: var(--el-color-danger); }
    .accessRow {
      display: flex; align-items: center; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--el-border-color-lighter);
      .accessDetails { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 5px; overflow-wrap: anywhere; span, small { color: var(--el-text-color-secondary); } }
    }
  }
}
.configHint { margin-top: 0; color: var(--el-text-color-secondary); line-height: 1.7; }
</style>
