<template>
  <div class="localHelper">
    <section class="downloadSection">
      <div>
        <h3>Windows 本地助手</h3>
        <p>启动后驻留系统托盘，让网页 AI 读取本机文件、调用本地程序、运行命令和安装工具。</p>
        <p>Windows 10 / 11，64 位。解压后运行 unionFlfowHelper.exe，已包含 FFmpeg 和 ffprobe。</p>
      </div>
      <a v-if="status?.downloadAvailable" class="downloadLink" :href="downloadUrl" download="unionFlfowHelper.zip">下载 Windows 版 · {{ status.version }}</a>
      <el-button v-else :disabled="true">{{ loading ? '读取下载信息…' : '安装包尚未发布' }}</el-button>
    </section>

    <section class="pairSection" aria-label="绑定本地电脑">
      <h3>绑定这台电脑</h3>
      <p>在 Windows 托盘里查看 12 位配对码，填入后，在本机确认连接。</p>
      <el-form class="pairForm" @submit.prevent="bind">
        <el-input v-model="pairCode" maxlength="20" aria-label="本机配对码" placeholder="输入托盘中的配对码" :disabled="busy" />
        <el-button type="primary" nativeType="submit" :loading="busy" :disabled="!validCode">绑定电脑</el-button>
      </el-form>
    </section>

    <section class="deviceSection" aria-label="AI 操作的本地电脑">
      <div class="sectionHeader">
        <h3>AI 操作的电脑</h3>
        <el-button text :loading="loading" :disabled="busy" @click="refresh">刷新</el-button>
      </div>
      <p>此选择用于当前网页登录会话。对话运行期间切换设备，请重新发起对话。</p>
      <el-radio-group :modelValue="status?.selectedId || ''" class="deviceList" :disabled="busy" aria-label="选择本地电脑" @change="select">
        <el-radio value="">关闭本机工具</el-radio>
        <div v-for="device in status?.devices || []" :key="device.id" class="deviceRow">
          <el-radio :value="device.id">{{ device.name }}</el-radio>
          <el-tag :type="device.online && device.approved && !device.paused ? 'success' : 'info'" size="small">{{ deviceLabel(device) }}</el-tag>
          <span v-if="device.autoExecute" class="automaticLabel">本次运行自动执行</span>
          <el-button type="danger" link @click="revoke(device)">解除绑定</el-button>
        </div>
      </el-radio-group>
    </section>

    <p class="permissionInfo">本机确认连接后，读取的文件内容会用于网页 AI 对话。写入、删除、命令和安装默认逐次在本机确认；可在托盘开启本次运行的自动执行，随时暂停或解除绑定。操作权限与当前 Windows 用户相同。</p>
    <el-alert v-if="notice" :title="notice" type="success" :closable="false" showIcon />
    <el-alert v-if="failure" :title="failure" type="error" :closable="false" showIcon />
  </div>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import api, { errorMessage } from "@/lib/api";
import { appBasePath } from "@/lib/appPath";
import type { LocalHelperDevice, LocalHelperStatus } from "@toonflow/local-helper/protocol";

const props = defineProps<{ visible: boolean }>();
const status = ref<LocalHelperStatus>();
const pairCode = ref("");
const busy = ref(false);
const loading = ref(false);
const failure = ref("");
const notice = ref("");
const validCode = computed(() => /^[a-f\d]{12}$/i.test(pairCode.value.replace(/[\s-]/g, "")));
const downloadUrl = `${appBasePath}/api/localHelper/download`;
let interval: ReturnType<typeof setInterval> | undefined;
let pending: AbortController | undefined;

function deviceLabel(device: LocalHelperDevice) {
  if (!device.online) return "离线";
  if (device.paused) return "已暂停";
  return device.approved ? "已连接" : "等待本机确认";
}

async function refresh() {
  if (pending) return;
  const controller = new AbortController();
  pending = controller;
  loading.value = true;
  try {
    const response = await api.get<{ data: LocalHelperStatus }>("/api/localHelper/status", { signal: controller.signal, timeout: 15000 });
    status.value = response.data.data;
    failure.value = "";
  } catch (error) {
    if (!controller.signal.aborted) failure.value = errorMessage(error, "无法读取本地助手状态");
  } finally { if (pending === controller) pending = undefined; loading.value = false; }
}

async function bind() {
  if (busy.value || !validCode.value) return;
  busy.value = true; notice.value = "";
  try {
    await api.post("/api/localHelper/bind", { code: pairCode.value.replace(/[\s-]/g, "").toUpperCase() });
    pairCode.value = "";
    notice.value = "绑定成功，请在这台 Windows 电脑上确认连接。确认后即可让 AI 操作本机。";
    await refresh();
  } catch (error) { failure.value = errorMessage(error, "绑定失败"); }
  finally { busy.value = false; }
}

async function select(value: string | number | boolean | undefined) {
  if (busy.value) return;
  busy.value = true; notice.value = "";
  try {
    await api.put("/api/localHelper/select", { id: value || null });
    await refresh();
  } catch (error) { failure.value = errorMessage(error, "切换电脑失败"); }
  finally { busy.value = false; }
}

async function revoke(device: LocalHelperDevice) {
  try { await ElMessageBox.confirm(`解除 ${device.name} 的绑定并取消其正在运行的本机任务？`, "解除绑定", { type: "warning", confirmButtonText: "解除绑定", cancelButtonText: "取消" }); }
  catch { return; }
  busy.value = true; notice.value = "";
  try {
    await api.delete("/api/localHelper/revoke", { data: { id: device.id } });
    await refresh();
  } catch (error) { failure.value = errorMessage(error, "解除绑定失败"); }
  finally { busy.value = false; }
}

watch(() => props.visible, visible => {
  clearInterval(interval);
  if (!visible) { pending?.abort(); return; }
  void refresh();
  interval = setInterval(() => { if (!busy.value) void refresh(); }, 5000);
}, { immediate: true });
onScopeDispose(() => { clearInterval(interval); pending?.abort(); });
</script>

<style scoped lang="scss">
.localHelper {
  display: flex;
  flex-direction: column;
  gap: 24px;
  h3 { margin: 0 0 8px; font-size: 15px; }
  p { color: var(--el-text-color-secondary); line-height: 1.7; margin: 6px 0; font-size: 13px; }
  .downloadSection {
    display: flex;
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
    .downloadLink { padding: 10px 16px; color: var(--el-color-white); background: var(--el-color-primary); border-radius: 8px; text-decoration: none; }
  }
  .pairSection {
    .pairForm { display: flex; gap: 12px; max-width: 480px; margin-top: 12px; }
  }
  .deviceSection {
    .sectionHeader { display: flex; align-items: center; justify-content: space-between; h3 { margin: 0; } }
    .deviceList {
      display: flex;
      align-items: flex-start;
      flex-direction: column;
      width: 100%;
      .deviceRow { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; width: 100%; .el-radio { margin-right: auto; } .automaticLabel { font-size: 12px; color: var(--el-text-color-secondary); } }
    }
  }
  .permissionInfo { border-top: 1px solid var(--el-border-color-lighter); padding-top: 16px; }
}
</style>
