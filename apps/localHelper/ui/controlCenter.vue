<template>
  <div class="controlCenter" :class="{ chatWorkspace: page === 'chat' }">
    <aside class="sidebar">
      <div class="brand">
        <span class="brandMark">
          ∪
          <i>✦</i>
        </span>
        <div>
          UnionFlow
          <small>本地执行中心</small>
        </div>
      </div>
      <div class="navGroup">工作空间</div>
      <nav aria-label="控制中心导航">
        <button
          v-for="item in navigation"
          :key="item.id"
          :class="{ selected: page === item.id }"
          :aria-current="page === item.id ? 'page' : undefined"
          @click="page = item.id">
          <component :is="item.icon" :size="19" :strokeWidth="1.6" />
          <span>{{ item.label }}</span>
          <b v-if="item.id === 'permissions' && state.approvals.length">{{ state.approvals.length }}</b>
        </button>
      </nav>
      <div class="sidebarBottom">
        <button class="webLink" :disabled="!shellOnline" @click="send('openAccount')">
          <icon-external-link :size="17" />
          登录 UnionAIGC / 绑定本机
        </button>
        <button class="webLink" :disabled="!shellOnline" @click="send('openWeb')">
          <icon-external-link :size="17" />
          打开网页工作台
          <icon-arrow-up-right :size="15" />
        </button>
        <div class="deviceSummary">
          <span class="connectionDot" :class="{ online: runtime?.connected }"></span>
          <div>
            {{ runtime?.computer || "本机设备" }}
            <small>{{ runtime?.connected ? "平台已连接" : "等待平台连接" }}</small>
          </div>
          <span class="version">v{{ runtime?.version || "0.4.0" }}</span>
        </div>
      </div>
    </aside>

    <div class="workspace">
      <header class="topbar">
        <span>
          本地助手
          <span class="breadcrumb">/</span>
          {{ currentPage?.label }}
        </span>
        <div>
          <span class="connectionPill" :class="{ online: ready }">
            <span class="connectionDot" :class="{ online: ready }"></span>
            {{ runtime?.paused ? "已暂停接收" : ready ? "设备就绪" : "等待连接与授权" }}
          </span>
          <button class="iconButton" aria-label="刷新运行状态" :disabled="!shellOnline" @click="send('snapshot')">
            <icon-refresh :size="18" />
          </button>
        </div>
      </header>
      <main>
        <div v-if="notice" class="notice" role="alert">
          <icon-alert-circle :size="18" />
          <span>{{ notice }}</span>
          <button aria-label="关闭提示" @click="notice = ''">×</button>
        </div>
        <div v-if="!shellOnline" class="notice" role="status">尚未连接本地托盘进程，请从托盘打开控制中心。</div>
        <div class="pageHeading">
          <div>
            <div class="eyebrow">{{ page === "overview" ? "LOCAL AGENT RUNTIME" : "UNIONFLOW / LOCAL" }}</div>
            <h1>{{ currentPage?.label }}</h1>
            <p>{{ pageDescriptions[page] }}</p>
          </div>
          <button
            v-if="page === 'overview'"
            class="secondaryButton"
            :disabled="!shellOnline"
            @click="send('pause', { value: !runtime?.paused })">
            <icon-player-pause v-if="!runtime?.paused" :size="17" />
            <icon-player-play v-else :size="17" />
            {{ runtime?.paused ? "继续接收任务" : "暂停接收并取消运行任务" }}
          </button>
        </div>

        <template v-if="page === 'overview'">
          <section class="statusBanner">
            <div class="runtimeIcon"><icon-cpu :size="29" :strokeWidth="1.5" /></div>
            <div>
              <h2>{{ runtime?.message || "正在等待本地进程" }}</h2>
              <p>{{ runtime?.owner ? `绑定账户 · ${runtime.owner}` : "在网页「设置 → 本地助手」完成设备绑定" }}</p>
            </div>
            <button class="bannerButton" @click="page = state.approvals.length ? 'permissions' : 'devices'">
              {{ state.approvals.length ? "查看待授权操作" : "查看设备连接" }}
              <icon-arrow-up-right :size="17" />
            </button>
          </section>
          <section class="metrics" aria-label="本次运行概览">
            <article v-for="metric in metrics" :key="metric.label">
              <div>
                <span>{{ metric.label }}</span>
                <component :is="metric.icon" :size="19" :strokeWidth="1.6" />
              </div>
              <strong>{{ metric.value }}</strong>
              <small>{{ metric.detail }}</small>
            </article>
          </section>
          <section class="panel">
            <div class="panelHeader">
              <div>
                <h2>最近任务</h2>
                <span>网页与本机对话共用执行队列</span>
              </div>
              <button class="textButton" @click="page = 'tasks'">
                全部任务
                <icon-arrow-right :size="16" />
              </button>
            </div>
            <div v-if="!state.tasks.length" class="emptyState">
              <icon-stack-2 :size="34" :strokeWidth="1.3" />
              <strong>本次运行暂无任务</strong>
              <p>网页下发的本机操作和托盘工具调用会显示在这里。</p>
            </div>
            <button v-for="task in state.tasks.slice(0, 5)" :key="task.id" class="taskRow" @click="selectedTask = task.id">
              <span class="taskIcon"><component :is="task.action === 'execute' ? IconTerminal2 : IconFile" :size="20" /></span>
              <div class="taskName">
                <strong>{{ actionLabel(task.action) }}</strong>
                <small>{{ task.source === "web" ? "网页任务" : "本机对话" }} · {{ time(task.createdAt) }}</small>
              </div>
              <span class="stateBadge" :class="task.state">{{ stateLabel(task.state) }}</span>
              <span class="duration">{{ duration(task) }}</span>
              <icon-chevron-right :size="17" />
            </button>
          </section>
          <div class="overviewFoot">
            <icon-shield-check :size="18" />
            <span>文件写入与命令默认逐次确认</span>
            <span class="separator">·</span>
            <span>批量文件每次最多 20 个</span>
            <button class="textButton" @click="page = 'logs'">
              诊断日志已保留
              <icon-arrow-right :size="15" />
            </button>
          </div>
        </template>

        <section v-if="page === 'tasks'" class="panel">
          <div class="panelHeader">
            <div class="filterTabs">
              <button
                v-for="filter in taskFilters"
                :key="filter.id"
                :class="{ active: taskFilter === filter.id }"
                @click="taskFilter = filter.id">
                {{ filter.label }}
              </button>
            </div>
            <span class="muted">本次进程 · {{ state.tasks.length }} 项</span>
          </div>
          <div v-if="!filteredTasks.length" class="emptyState">
            <icon-stack-2 :size="34" :strokeWidth="1.3" />
            <strong>暂无符合条件的任务</strong>
          </div>
          <div v-for="task in filteredTasks" :key="task.id" class="taskRow">
            <button class="taskMain" @click="selectedTask = task.id">
              <span class="taskIcon">
                <icon-terminal-2 v-if="task.action === 'execute'" :size="20" />
                <icon-file v-else :size="20" />
              </span>
              <div class="taskName">
                <strong>{{ actionLabel(task.action) }}</strong>
                <small>{{ task.source === "web" ? "网页任务" : "本机对话" }} · {{ time(task.createdAt) }}</small>
              </div>
            </button>
            <span class="stateBadge" :class="task.state">{{ stateLabel(task.state) }}</span>
            <span class="duration">{{ duration(task) }}</span>
            <button
              v-if="!task.finishedAt"
              class="textButton dangerText"
              :disabled="!shellOnline"
              @click="send('taskCancel', { id: task.id })">
              取消
            </button>
            <button v-else class="textButton" @click="selectedTask = task.id">详情</button>
          </div>
        </section>

        <subtitlePanel v-if="page === 'subtitles'" :online="shellOnline" :snapshot="subtitleSnapshot" @command="(type, payload) => send(type, payload)" />

        <chatPanel
          v-if="page === 'chat'"
          :entries="state.chat"
          :sessions="state.conversations || []"
          :activeId="state.conversationId"
          :running="state.chatRunning"
          :ready="!!ready || shellOnline"
          :authorized="!!runtime?.approved"
          :owner="runtime?.owner"
          @send="sendChat"
          @stop="send('chatCancel')"
          @newChat="send('chatNew')"
          @selectChat="(id) => send('chatSelect', { id })"
          @renameChat="(id, title) => send('chatRename', { id, title })"
          @deleteChat="(id) => send('chatDelete', { id })"
          @copy="(text) => send('copyText', { text })"
          @openLink="(url) => send('openLink', { url })" />

        <section v-if="page === 'transfers'" class="panel">
          <div class="panelHeader">
            <div>
              <h2>上传与下载</h2>
              <span>单文件 ≤ 100 MiB · 每批 ≤ 200 MiB · 每批 ≤ 20 个文件</span>
            </div>
          </div>
          <div v-if="!state.transfers.length" class="emptyState">
            <icon-arrows-down-up :size="34" :strokeWidth="1.3" />
            <strong>本次运行暂无文件传输</strong>
            <p>由网页或本机对话发起的上传、下载会在这里显示。</p>
          </div>
          <article v-for="transfer in state.transfers" :key="transfer.id" class="transferItem">
            <span class="taskIcon">
              <icon-upload v-if="transfer.direction === 'upload'" :size="21" />
              <icon-download v-else :size="21" />
            </span>
            <div class="transferBody">
              <div class="transferTitle">
                <strong>{{ filename(transfer.direction === "upload" ? transfer.path : transfer.target) }}</strong>
                <span class="stateBadge" :class="transfer.state">{{ stateLabel(transfer.state) }}</span>
              </div>
              <div class="transferPaths">
                {{ transfer.path }}
                <span>→</span>
                {{ transfer.target }}
              </div>
              <progress
                :value="!transfer.total && transfer.state === 'completed' ? 1 : transfer.bytes"
                :max="transfer.total || 1"
                :aria-label="`${filename(transfer.path)}传输进度`"></progress>
              <div class="transferMeta">
                <span>{{ bytes(transfer.bytes) }} / {{ bytes(transfer.total) }}</span>
                <span v-if="transfer.state === 'running'">{{ transferSpeed(transfer) }} · {{ transferRemaining(transfer) }}</span>
                <span v-else>{{ transfer.state === "confirming" ? "正在确认文件，尚未完成" : time(transfer.updatedAt) }}</span>
              </div>
              <p v-if="transfer.error" class="errorText">{{ transfer.error }}</p>
            </div>
            <button
              v-if="['running', 'confirming'].includes(transfer.state)"
              class="textButton dangerText"
              @click="send('taskCancel', { id: transfer.taskId })">
              取消
            </button>
            <button
              v-else
              class="textButton"
              @click="
                selectedTask = transfer.taskId;
                page = 'tasks';
              ">
              任务
            </button>
          </article>
        </section>

        <template v-if="page === 'devices'">
          <section class="panel devicePanel">
            <div class="deviceIllustration">
              <icon-device-desktop :size="62" :strokeWidth="1.1" />
              <span class="connectionPill" :class="{ online: runtime?.connected }">{{ runtime?.connected ? "平台在线" : "正在连接" }}</span>
            </div>
            <div class="deviceDetails">
              <h2>{{ runtime?.computer || "本机设备" }}</h2>
              <dl>
                <dt>UnionAIGC 账户</dt>
                <dd>{{ runtime?.owner || "尚未绑定" }}</dd>
                <dt>平台地址</dt>
                <dd>{{ runtime?.server || "—" }}</dd>
                <dt>本机授权</dt>
                <dd>{{ runtime?.approved ? "已确认连接" : "等待本机确认" }}</dd>
                <dt>设备版本</dt>
                <dd>{{ runtime?.version || "—" }} · Windows x64</dd>
                <dt>设备编号</dt>
                <dd class="mono">{{ runtime?.deviceId || "等待注册" }}</dd>
              </dl>
            </div>
          </section>
          <section class="panel pairingPanel">
            <div>
              <h2>设备配对</h2>
              <p>登录 UnionAIGC 账户后，在网页「设置 → 本地助手」输入配对码，然后在本机确认连接。</p>
            </div>
            <div class="pairCode">{{ runtime?.code?.match(/.{1,4}/g)?.join(" − ") || "等待注册" }}</div>
            <div class="buttonRow">
              <button class="secondaryButton" :disabled="!runtime?.code" @click="send('copyCode')">
                <icon-copy :size="16" />
                复制配对码
              </button>
              <button class="primaryButton" :disabled="!shellOnline" @click="send('openAccount')">
                登录 UnionAIGC / 绑定本机
                <icon-external-link :size="16" />
              </button>
            </div>
          </section>
          <section class="panel settingRow">
            <div>
              <h2>解除设备绑定</h2>
              <p>撤销当前账户的本机访问权限，取消任务并生成新配对码。</p>
            </div>
            <button class="secondaryButton dangerText" :disabled="!shellOnline" @click="send('resetBinding')">解除绑定</button>
          </section>
        </template>

        <template v-if="page === 'permissions'">
          <section class="permissionSummary">
            <icon-shield-check :size="24" />
            <div>
              <strong>{{ runtime?.autoExecute ? "本次运行已开启自动执行" : "敏感操作逐次确认" }}</strong>
              <p>权限与当前 Windows 用户相同；写入、传输、删除、命令和安装默认需要本机确认。</p>
            </div>
          </section>
          <section class="panel">
            <div class="panelHeader">
              <h2>
                待确认操作
                <span class="count">{{ state.approvals.length }}</span>
              </h2>
            </div>
            <div v-if="!state.approvals.length" class="emptyState">
              <icon-shield-check :size="34" :strokeWidth="1.3" />
              <strong>当前没有待确认操作</strong>
            </div>
            <article v-for="approval in state.approvals" :key="approval.id" class="approvalCard">
              <div class="approvalHeading">
                <h3>{{ approval.title }}</h3>
                <span class="stateBadge approval">剩余 {{ Math.max(0, Math.ceil((approval.expiresAt - now) / 1000)) }} 秒</span>
              </div>
              <pre>{{ approval.detail }}</pre>
              <div class="buttonRow">
                <button class="primaryButton" @click="send('reviewApproval', { id: approval.id })">
                  打开本机确认窗口
                  <icon-arrow-up-right :size="16" />
                </button>
              </div>
            </article>
          </section>
          <section class="panel settingRow">
            <div>
              <h2>本次运行自动执行</h2>
              <p>开启前会在本机确认，退出或解除绑定后失效。</p>
            </div>
            <button class="secondaryButton" :disabled="!shellOnline" @click="send('automatic')">
              {{ runtime?.autoExecute ? "关闭自动执行" : "设置自动执行" }}
            </button>
          </section>
        </template>

        <section v-if="page === 'tools'" class="panel">
          <div class="panelHeader">
            <div>
              <h2>本机工具环境</h2>
              <span>
                {{
                  state.environment
                    ? `最近检测 · ${state.environment.platform} ${state.environment.version}`
                    : "按需检测当前进程可访问的工具"
                }}
              </span>
            </div>
            <button class="secondaryButton" :disabled="!shellOnline" @click="send('tools')">
              <icon-refresh :size="16" />
              检测工具
            </button>
          </div>
          <div v-if="!state.environment" class="emptyState">
            <icon-tool :size="34" :strokeWidth="1.3" />
            <strong>尚未检测工具环境</strong>
            <p>检测只读取当前工具路径，不会安装或修改环境。</p>
          </div>
          <template v-else>
            <div
              v-for="(path, name) in { PowerShell: state.environment.powershell, ...state.environment.tools }"
              :key="name"
              class="toolRow">
              <span class="taskIcon"><icon-terminal-2 :size="20" /></span>
              <div>
                <strong>{{ name }}</strong>
                <small>{{ path || "当前进程 PATH 中未找到" }}</small>
              </div>
              <span class="stateBadge" :class="path ? 'completed' : 'queued'">{{ path ? "已找到" : "未找到" }}</span>
            </div>
            <div class="panelNote">路径检测不代表模型、依赖或编码器已通过运行验证。安装仍通过现有本机任务与审批流程执行。</div>
          </template>
        </section>

        <section v-if="page === 'logs'" class="panel logPanel">
          <div class="panelHeader">
            <div>
              <h2>运行日志</h2>
              <span>实时显示最近 300 条脱敏事件；历史日志保存在本机</span>
            </div>
            <button class="secondaryButton" :disabled="!shellOnline" @click="send('openLogs')">
              <icon-folder-open :size="16" />
              打开日志文件夹
            </button>
          </div>
          <div class="logToolbar">
            <label class="searchField">
              <icon-search :size="17" />
              <input v-model="logQuery" aria-label="搜索日志事件或任务编号" placeholder="搜索事件、任务编号…" />
            </label>
            <select v-model="logLevel" aria-label="日志级别">
              <option value="">所有级别</option>
              <option value="info">信息</option>
              <option value="warn">警告</option>
              <option value="error">错误</option>
            </select>
            <button class="secondaryButton" :class="{ pressed: logsPaused }" @click="toggleLogs">
              <icon-player-play v-if="logsPaused" :size="15" />
              <icon-player-pause v-else :size="15" />
              {{ logsPaused ? "继续刷新" : "暂停刷新" }}
            </button>
          </div>
          <div class="logEntries">
            <div v-if="!filteredLogs.length" class="emptyState">
              <icon-file-text :size="32" :strokeWidth="1.3" />
              <strong>暂无符合条件的日志</strong>
            </div>
            <details v-for="(entry, index) in filteredLogs" :key="`${entry.at}:${index}`" class="logEntry">
              <summary>
                <time>{{ time(entry.at) }}</time>
                <span :class="entry.level">{{ entry.level.toUpperCase() }}</span>
                <strong>{{ entry.event }}</strong>
                <code>{{ entry.taskId || entry.kind || entry.httpStatus || "" }}</code>
              </summary>
              <pre>{{ JSON.stringify(entry, null, 2) }}</pre>
            </details>
          </div>
          <div class="panelNote">
            <icon-lock :size="15" />
            保留 7 天 · 每日 ZIP 归档 · 16 MiB 切分 · 不记录密钥、文件正文与聊天内容
          </div>
        </section>

        <template v-if="page === 'settings'">
          <updatePanel
            :update="state.update"
            :version="runtime?.version || '0.4.0'"
            :online="shellOnline"
            :bound="!!runtime?.owner"
            @account="send('openAccount')"
            @check="send('updateCheck')"
            @download="send('updateDownload')"
            @install="send('updateInstall')"
            @preferences="(autoCheck, autoInstall) => send('updatePreferences', { autoCheck, autoInstall })" />
          <section class="panel">
            <div class="settingRow">
              <div>
                <h2>开机启动</h2>
                <p>登录 Windows 时启动托盘；移动程序后需要重新设置。</p>
              </div>
              <button
                class="switchButton"
                :class="{ enabled: startupEnabled }"
                role="switch"
                :aria-checked="startupEnabled"
                aria-label="开机启动"
                :disabled="!shellOnline"
                @click="send('startup')">
                <span></span>
              </button>
            </div>
            <div class="settingRow">
              <div>
                <h2>任务接收</h2>
                <p>暂停会停止接收，并取消正在运行的本机任务与对话。</p>
              </div>
              <button class="secondaryButton" :disabled="!shellOnline" @click="send('pause', { value: !runtime?.paused })">
                {{ runtime?.paused ? "继续接收" : "暂停并取消运行任务" }}
              </button>
            </div>
            <div class="settingRow">
              <div>
                <h2>重新连接进程</h2>
                <p>工作进程停止后可重新启动，原任务不会自动重新执行。</p>
              </div>
              <button class="secondaryButton" :disabled="!shellOnline" @click="send('restart')">重新连接</button>
            </div>
          </section>
          <section class="panel settingRow">
            <div>
              <h2>日志与排障</h2>
              <p>沿用原数据目录、设备身份及日志归档规则。关闭控制中心后托盘继续运行。</p>
            </div>
            <button class="secondaryButton" :disabled="!shellOnline" @click="send('openLogs')">打开日志文件夹</button>
          </section>
          <div class="versionNote">UnionFlow 本地助手 {{ runtime?.version || "0.4.0" }} · Windows x64</div>
        </template>
      </main>
    </div>

    <dialog
      ref="detailDialog"
      class="detailBackdrop"
      aria-labelledby="taskDetailTitle"
      @click.self="selectedTask = ''"
      @cancel.prevent="selectedTask = ''">
      <section v-if="taskDetail" class="detailPanel">
        <div class="panelHeader">
          <div>
            <h2 id="taskDetailTitle">{{ actionLabel(taskDetail.action) }}</h2>
            <span>{{ taskDetail.source === "web" ? "网页任务" : "本机对话" }}</span>
          </div>
          <button class="iconButton" aria-label="关闭任务详情" @click="selectedTask = ''"><icon-x :size="20" /></button>
        </div>
        <div class="detailBody">
          <span class="stateBadge" :class="taskDetail.state">{{ stateLabel(taskDetail.state) }}</span>
          <dl>
            <dt>任务编号</dt>
            <dd class="mono">{{ taskDetail.id }}</dd>
            <dt>开始时间</dt>
            <dd>{{ dateTime(taskDetail.createdAt) }}</dd>
            <dt>耗时</dt>
            <dd>{{ duration(taskDetail) }}</dd>
            <template v-if="taskDetail.completed !== undefined">
              <dt>成功 / 失败</dt>
              <dd>{{ taskDetail.completed }} / {{ taskDetail.failed || 0 }}</dd>
            </template>
            <template v-if="taskDetail.exitCode !== undefined">
              <dt>退出码</dt>
              <dd>{{ taskDetail.exitCode }}</dd>
            </template>
          </dl>
          <p v-if="taskDetail.error" class="errorText">{{ taskDetail.error }}</p>
          <p v-if="taskDetail.truncated" class="errorText">命令输出已截断，请核对完整结果。</p>
          <h3>执行事件</h3>
          <ol class="timeline">
            <li v-for="(event, index) in state.logs.filter((entry) => entry.taskId === taskDetail?.id)" :key="index">
              <span></span>
              <div>
                <strong>{{ event.event }}</strong>
                <small>{{ time(event.at) }}</small>
              </div>
            </li>
          </ol>
          <button v-if="!taskDetail.finishedAt" class="secondaryButton dangerText" @click="send('taskCancel', { id: taskDetail.id })">
            取消此任务
          </button>
        </div>
      </section>
    </dialog>
  </div>
  <actionDialog
    :key="activePrompt?.id || 'none'"
    :open="!!activePrompt"
    :title="activePrompt?.title || ''"
    :description="decision ? decision.description : '请核对操作详情，再决定是否允许。'"
    :details="activePrompt?.detail"
    :permission="!decision"
    :danger="decision?.danger"
    :confirmLabel="decision?.confirmLabel || '允许本次操作'"
    :cancelLabel="decision ? '取消' : '拒绝操作'"
    :countdown="!decision && activePrompt ? '剩余 ' + Math.max(0, Math.ceil((activePrompt.expiresAt - now) / 1000)) + ' 秒' : undefined"
    @close="resolvePrompt(false)"
    @confirm="resolvePrompt(true)" />
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import {
  IconActivity,
  IconAlertCircle,
  IconArrowRight,
  IconArrowUp,
  IconArrowUpRight,
  IconArrowsDownUp,
  IconChevronRight,
  IconCopy,
  IconCpu,
  IconDeviceDesktop,
  IconDownload,
  IconExternalLink,
  IconFile,
  IconFileText,
  IconFolderOpen,
  IconLayoutDashboard,
  IconLock,
  IconMessageCircle,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconShieldCheck,
  IconStack2,
  IconTerminal2,
  IconTool,
  IconUpload,
  IconX,
} from "@tabler/icons-vue";
import type { HelperChatEntry, HelperLog, HelperSnapshot, HelperTask, HelperTransfer } from "../src/controlProtocol";
import chatPanel from "./chatPanel.vue";
import actionDialog from "./actionDialog.vue";
import updatePanel from "./updatePanel.vue";
import subtitlePanel from "./subtitlePanel.vue";
import type { SubtitleSnapshot } from "../src/subtitleProtocol";

type NativeBridge = {
  postMessage: (message: unknown) => void;
  addEventListener: (type: string, handler: (event: MessageEvent) => void) => void;
  removeEventListener: (type: string, handler: (event: MessageEvent) => void) => void;
};
const bridge = (window as Window & { chrome?: { webview?: NativeBridge } }).chrome?.webview;
const shellOnline = ref(false);
const subtitleSnapshot = ref<SubtitleSnapshot>();
const startupEnabled = ref(false);
const state = ref<HelperSnapshot>({ tasks: [], transfers: [], approvals: [], chat: [], chatRunning: false, logs: [] });
const runtime = computed(() => state.value.runtime);
const ready = computed(() => shellOnline.value && runtime.value?.connected && runtime.value.approved && !runtime.value.paused);
const navigation = [
  { id: "overview", label: "总览", icon: IconLayoutDashboard },
  { id: "tasks", label: "任务中心", icon: IconStack2 },
  { id: "subtitles", label: "批量字幕", icon: IconFileText },
  { id: "chat", label: "本机对话", icon: IconMessageCircle },
  { id: "transfers", label: "文件传输", icon: IconArrowsDownUp },
  { id: "devices", label: "设备与连接", icon: IconDeviceDesktop },
  { id: "permissions", label: "权限中心", icon: IconShieldCheck },
  { id: "tools", label: "工具环境", icon: IconTool },
  { id: "logs", label: "日志中心", icon: IconFileText },
  { id: "settings", label: "设置", icon: IconSettings },
];
const pageDescriptions: Record<string, string> = {
  overview: "查看设备状态，跟进本机任务与需要你处理的事项。",
  tasks: "跟进网页指令与本机工具的真实执行过程。",
  subtitles: "本机批量识别、自动校对和字幕合成。",
  chat: "使用绑定账户的文本模型，协助处理本机任务。",
  transfers: "查看逐文件传输进度，以及最终确认结果。",
  devices: "管理本机与网页账户的配对和连接。",
  permissions: "查看本机授权与等待确认的操作。",
  tools: "检查本机工具路径与当前可用环境。",
  logs: "按事件、级别与任务编号定位运行问题。",
  settings: "管理托盘启动、后台运行与排障入口。",
};
const page = ref("overview");
const currentPage = computed(() => navigation.find((item) => item.id === page.value));
const notice = ref("");
const decision = ref<{
  id: string;
  title: string;
  description: string;
  detail: string;
  danger: boolean;
  confirmLabel: string;
  expiresAt: number;
}>();
const activePrompt = computed(() => decision.value || state.value.approvals[0]);
function resolvePrompt(allowed: boolean) {
  const prompt = activePrompt.value;
  if (!prompt) return;
  send(decision.value ? "nativeDecision" : "approval", { id: prompt.id, allowed });
  if (decision.value) decision.value = undefined;
}
function sendChat(text: string) {
  send("chat", { text });
  state.value.chatRunning = true;
}
const now = ref(Date.now());
const taskFilter = ref("all");
const selectedTask = ref("");
const taskDetail = computed(() => state.value.tasks.find((task) => task.id === selectedTask.value));
const detailDialog = ref<HTMLDialogElement>();
const logQuery = ref("");
const logLevel = ref("");
const logsPaused = ref(false);
const frozenLogs = ref<HelperLog[]>([]);
const taskFilters = [
  { id: "all", label: "全部" },
  { id: "active", label: "进行中" },
  { id: "completed", label: "已完成" },
  { id: "failed", label: "失败与取消" },
];
const filteredTasks = computed(() =>
  state.value.tasks.filter(
    (task) =>
      taskFilter.value === "all" ||
      (taskFilter.value === "active"
        ? !task.finishedAt
        : taskFilter.value === "failed"
          ? ["failed", "cancelled"].includes(task.state)
          : task.state === taskFilter.value),
  ),
);
const filteredLogs = computed(() =>
  (logsPaused.value ? frozenLogs.value : state.value.logs)
    .filter(
      (entry) =>
        (!logLevel.value || entry.level === logLevel.value) &&
        (!logQuery.value || JSON.stringify(entry).toLowerCase().includes(logQuery.value.toLowerCase())),
    )
    .slice()
    .reverse(),
);
const metrics = computed(() => [
  { label: "进行中", value: state.value.tasks.filter((task) => !task.finishedAt).length, detail: "含排队与等待确认", icon: IconActivity },
  { label: "等待授权", value: state.value.approvals.length, detail: "需要你在本机确认", icon: IconShieldCheck },
  {
    label: "文件传输",
    value: state.value.transfers.filter((item) => ["running", "confirming"].includes(item.state)).length,
    detail: "上传 / 下载与文件确认",
    icon: IconArrowsDownUp,
  },
  {
    label: "已完成",
    value: state.value.tasks.filter((task) => task.state === "completed").length,
    detail: "本次运行的完成任务",
    icon: IconStack2,
  },
]);
function send(type: string, fields: Record<string, unknown> = {}) {
  bridge?.postMessage({ type, ...fields });
}
function actionLabel(action: string) {
  return (
    (
      {
        status: "本机状态检测",
        list: "读取目录",
        read: "读取文件",
        readBatch: "批量读取文件",
        projects: "读取网页项目",
        upload: "上传文件",
        download: "下载文件",
        write: "写入文件",
        mkdir: "创建目录",
        move: "移动文件",
        remove: "删除文件",
        execute: "执行 PowerShell",
        install: "安装软件",
        ffmpeg: "处理工作区媒体",
        ffmpegStatus: "检测本机媒体组件",
        ffmpegInstall: "安装本机媒体组件",
      } as Record<string, string>
    )[action] || action
  );
}
function stateLabel(value: string) {
  return (
    (
      {
        queued: "排队中",
        approval: "等待授权",
        running: "执行中",
        confirming: "确认中",
        completed: "已完成",
        failed: "失败",
        cancelled: "已取消",
      } as Record<string, string>
    )[value] || value
  );
}
function time(value: number | string) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
}
function dateTime(value: number) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
function duration(task: HelperTask) {
  const seconds = Math.max(0, Math.floor(((task.finishedAt || now.value) - task.createdAt) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
function filename(path: string) {
  return path.split(/[\\/]/).pop() || path;
}
function bytes(value: number) {
  return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
function transferSpeed(item: HelperTransfer) {
  return `${bytes(Math.round((item.bytes * 1000) / Math.max(1000, item.updatedAt - item.startedAt)))}/s（平均）`;
}
function transferRemaining(item: HelperTransfer) {
  if (!item.bytes) return "估算剩余时间中";
  const seconds = Math.ceil(((item.total - item.bytes) * (item.updatedAt - item.startedAt)) / item.bytes / 1000);
  return `约剩 ${seconds < 60 ? `${seconds} 秒` : `${Math.ceil(seconds / 60)} 分钟`}`;
}
function toggleLogs() {
  if (!logsPaused.value) frozenLogs.value = [...state.value.logs];
  logsPaused.value = !logsPaused.value;
}
function upsert<T extends { id: string }>(items: T[], item: T, max: number) {
  const index = items.findIndex((entry) => entry.id === item.id);
  if (index < 0) items.unshift(item);
  else items[index] = item;
  if (items.length > max) items.splice(max);
}
function receive(event: MessageEvent) {
  const message = event.data;
  if (!message || typeof message !== "object") return;
  if (message.type === "shellState") {
    shellOnline.value = true;
    startupEnabled.value = message.startupEnabled === true;
  }
  if (message.type === "navigate" && navigation.some((item) => item.id === message.page)) page.value = message.page;
  if (message.type === "snapshot") state.value = message.snapshot;
  if (message.type === "subtitleSnapshot") subtitleSnapshot.value = message.snapshot;
  if (message.type === "status") state.value.runtime = message;
  if (message.type === "decisionRequest") decision.value = message;
  if (message.type === "decisionDismiss") decision.value = undefined;
  if (message.type === "update") state.value.update = message.update;
  if (message.type === "conversations") {
    state.value.conversations = message.conversations;
    state.value.conversationId = message.conversationId;
    if (Array.isArray(message.chat)) state.value.chat = message.chat;
  }
  if (message.type === "task") upsert(state.value.tasks, message.task, 150);
  if (message.type === "transfer") upsert(state.value.transfers, message.transfer, 250);
  if (message.type === "approvals") state.value.approvals = message.approvals;
  if (message.type === "chatEntry") {
    state.value.chat.push(message.entry as HelperChatEntry);
  }
  if (message.type === "chatState") state.value.chatRunning = message.running === true;
  if (message.type === "chat" && message.done) state.value.chatRunning = false;
  if (message.type === "chatReset") state.value.chat = [];
  if (message.type === "environment") state.value.environment = message.environment;
  if (message.type === "logEntry") {
    state.value.logs.push(message.entry);
    if (state.value.logs.length > 300) state.value.logs.shift();
  }
  if (message.type === "notice") notice.value = message.message;
  if (message.type === "logFailure") notice.value = `诊断日志写入或归档失败，请检查磁盘空间与权限。错误码：${message.code}`;
  if (message.type === "workerStopped") {
    state.value.chatRunning = false;
    state.value.approvals = [];
    decision.value = undefined;
    if (state.value.runtime) {
      state.value.runtime.connected = false;
      state.value.runtime.approved = false;
      state.value.runtime.message = "本地进程已停止，请重新连接";
    }
  }
}
watch(selectedTask, async (id) => {
  await nextTick();
  if (id && taskDetail.value) detailDialog.value?.showModal();
  else detailDialog.value?.close();
});
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  bridge?.addEventListener("message", receive);
  send("ready");
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});
onUnmounted(() => {
  bridge?.removeEventListener("message", receive);
  clearInterval(timer);
});
</script>

<style lang="scss">
:root {
  font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif;
  color: #292b36;
  background: #f7f8fb;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  overflow: hidden;
}
button,
input,
textarea,
select {
  font: inherit;
}
button {
  cursor: pointer;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
button:focus-visible,
input:focus-visible,
textarea:focus-visible,
select:focus-visible,
summary:focus-visible {
  outline: 2px solid #8b72df;
  outline-offset: 3px;
}
button {
  color: inherit;
}
.controlCenter {
  display: flex;
  height: 100dvh;
  overflow: hidden;
  font-size: 13px;
  .sidebar {
    position: fixed;
    width: 214px;
    height: 100vh;
    background: #fff;
    border-right: 1px solid #e9ebf1;
    display: flex;
    flex-direction: column;
    padding: 30px 16px 0;
    .brand {
      display: flex;
      align-items: center;
      gap: 11px;
      padding: 0 9px 34px;
      font-size: 20px;
      font-weight: 680;
      letter-spacing: -0.6px;
      small {
        display: block;
        font-size: 11px;
        letter-spacing: 1.4px;
        font-weight: 400;
        color: #737686;
        margin-top: 4px;
      }
      .brandMark {
        position: relative;
        background: #272633;
        color: white;
        font-size: 36px;
        width: 38px;
        height: 39px;
        line-height: 30px;
        text-align: center;
        border-radius: 12px;
        i {
          font-size: 16px;
          color: #c5b0ff;
          position: absolute;
          top: -3px;
          left: 14px;
          font-style: normal;
        }
      }
    }
    .navGroup {
      color: #737686;
      font-size: 11px;
      letter-spacing: 1.5px;
      padding: 0 13px 12px;
    }
    nav {
      display: flex;
      flex-direction: column;
      gap: 5px;
      button {
        display: flex;
        align-items: center;
        gap: 12px;
        border: 0;
        background: transparent;
        border-radius: 8px;
        padding: 12px 14px;
        color: #777b8b;
        text-align: left;
        span {
          flex: 1;
        }
        b {
          background: #e7dfff;
          color: #7150c7;
          font-size: 11px;
          padding: 2px 6px;
          border-radius: 5px;
        }
        &:hover {
          background: #f7f5fc;
          color: #7856c9;
        }
        &.selected {
          background: #f0eafb;
          color: #7751c9;
          font-weight: 600;
        }
      }
    }
    .sidebarBottom {
      margin-top: auto;
      .webLink {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin: 28px 4px 18px;
        border: 0;
        background: transparent;
        font-size: 11px;
        color: #818493;
      }
      .deviceSummary {
        display: flex;
        align-items: center;
        gap: 8px;
        border-top: 1px solid #eeeef3;
        padding: 19px 0;
        font-size: 11px;
        div {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        small {
          display: block;
          color: #737686;
          font-size: 11px;
          margin-top: 4px;
        }
        .version {
          margin-left: auto;
          color: #737686;
          font-size: 11px;
        }
      }
    }
  }
  .connectionDot {
    width: 6px;
    height: 6px;
    flex-shrink: 0;
    border-radius: 50%;
    background: #c2c4ce;
    &.online {
      background: #47aa86;
      box-shadow: 0 0 0 3px #47aa8612;
    }
  }
  .workspace {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    min-width: 0;
    margin-left: 214px;
    width: calc(100% - 214px);
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 60px;
      flex-shrink: 0;
      padding: 0 34px;
      border-bottom: 1px solid #e9ebf1;
      background: #ffffffc9;
      color: #687084;
      font-size: 11px;
      .breadcrumb {
        padding: 0 13px;
        color: #ccd0db;
      }
      > div {
        display: flex;
        align-items: center;
        gap: 18px;
      }
    }
    main {
      flex: 1;
      min-height: 0;
      overflow: auto;
      width: 100%;
      padding: 28px;
      max-width: 1440px;
      margin: 0 auto;
    }
  }
  .connectionPill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: #8b8e9c;
    font-size: 11px;
    &.online {
      color: #3c9273;
    }
  }
  .pageHeading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 26px;
    .eyebrow {
      font-size: 11px;
      letter-spacing: 2px;
      color: #9b91b2;
      margin-bottom: 9px;
    }
    h1 {
      font-size: 26px;
      line-height: 1.3;
      font-weight: 650;
      margin: 0 0 9px;
      letter-spacing: -0.5px;
    }
    p {
      color: #707588;
      font-size: 12px;
      margin: 0;
      line-height: 1.7;
    }
  }
  .primaryButton,
  .secondaryButton,
  .bannerButton {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 9px 14px;
    border-radius: 7px;
    font-size: 11px;
    white-space: nowrap;
    border: 1px solid #e3e4ed;
    background: #fff;
    transition: background 0.15s;
    &:hover {
      background: #f6f4fc;
    }
  }
  .primaryButton {
    background: #8563d4;
    border-color: #8563d4;
    color: white;
    &:hover {
      background: #7655c2;
    }
  }
  .textButton {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    border: 0;
    background: none;
    font-size: 11px;
    color: #8b70c8;
    white-space: nowrap;
    padding: 7px 0;
  }
  .iconButton {
    border: 0;
    background: transparent;
    display: inline-flex;
    align-items: center;
    padding: 5px;
    color: #9a9ca9;
  }
  .dangerText {
    color: #c56c72;
  }
  .muted {
    color: #a0a3b1;
    font-size: 11px;
  }
  .notice {
    display: flex;
    align-items: center;
    gap: 10px;
    background: #fff7e7;
    border: 1px solid #f4e6c8;
    color: #a08652;
    padding: 12px 16px;
    border-radius: 8px;
    margin-bottom: 20px;
    span {
      flex: 1;
    }
    button {
      border: 0;
      background: transparent;
      font-size: 20px;
    }
  }
  .statusBanner {
    display: flex;
    align-items: center;
    gap: 18px;
    background: linear-gradient(110deg, #f0eafb, #eeecfa 62%, #e9edf9);
    border: 1px solid #e5def3;
    border-radius: 12px;
    padding: 25px;
    margin-bottom: 23px;
    .runtimeIcon {
      display: flex;
      align-items: center;
      justify-content: center;
      background: #ffffffb5;
      border: 1px solid #ffffffd9;
      border-radius: 12px;
      width: 52px;
      height: 52px;
      color: #9675d0;
    }
    h2 {
      font-size: 15px;
      font-weight: 600;
      margin: 0 0 9px;
      color: #615176;
    }
    p {
      margin: 0;
      font-size: 11px;
      color: #766987;
    }
    .bannerButton {
      margin-left: auto;
      color: #8f73ba;
      border-color: #d9cce9;
      background: #ffffff4d;
    }
  }
  .metrics {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
    margin-bottom: 25px;
    article {
      background: #fff;
      border: 1px solid #e9eaf1;
      border-radius: 10px;
      padding: 21px;
      > div {
        display: flex;
        align-items: center;
        justify-content: space-between;
        color: #6d7285;
        font-size: 11px;
        svg {
          color: #b3a4cf;
        }
      }
      strong {
        display: block;
        font-size: 31px;
        font-weight: 500;
        margin: 13px 0 8px;
        color: #41404e;
      }
      small {
        font-size: 11px;
        color: #767889;
      }
    }
  }
  .panel {
    background: #fff;
    border: 1px solid #e7e9f0;
    border-radius: 11px;
    overflow: hidden;
    margin-bottom: 21px;
  }
  .panelHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 21px 24px;
    border-bottom: 1px solid #f0f0f5;
    h2 {
      font-weight: 600;
      font-size: 13px;
      margin: 0;
    }
    > div > span {
      display: block;
      font-size: 11px;
      color: #767687;
      margin-top: 7px;
    }
  }
  .emptyState {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 230px;
    gap: 14px;
    padding: 28px;
    color: #c6c2d2;
    strong {
      font-size: 12px;
      color: #9291a2;
      font-weight: 400;
    }
    p {
      margin: 0;
      font-size: 11px;
      color: #767889;
      text-align: center;
      line-height: 1.8;
    }
  }
  .taskRow {
    display: flex;
    align-items: center;
    gap: 16px;
    width: 100%;
    padding: 18px 24px;
    background: transparent;
    border: 0;
    border-bottom: 1px solid #f2f3f7;
    text-align: left;
    &:last-child {
      border-bottom: 0;
    }
    > svg {
      color: #b5b7c5;
    }
    .taskMain {
      display: flex;
      align-items: center;
      gap: 15px;
      flex: 1;
      border: 0;
      background: transparent;
      text-align: left;
      padding: 0;
    }
    .taskName {
      flex: 1;
      strong {
        display: block;
        font-size: 12px;
        font-weight: 500;
      }
      small {
        display: block;
        margin-top: 6px;
        font-size: 11px;
        color: #74798a;
      }
    }
    .duration {
      min-width: 58px;
      text-align: right;
      color: #74798a;
      font-size: 11px;
    }
  }
  .taskIcon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 35px;
    height: 37px;
    border-radius: 8px;
    background: #f5f3fa;
    color: #a995c9;
  }
  .stateBadge {
    display: inline-flex;
    padding: 4px 8px;
    border-radius: 5px;
    background: #f1f2f6;
    color: #737686;
    font-size: 11px;
    white-space: nowrap;
    &.running,
    &.confirming {
      background: #eef2fc;
      color: #536fa8;
    }
    &.approval {
      background: #fff4e1;
      color: #8f6a2b;
    }
    &.completed {
      background: #edf7f2;
      color: #3d795d;
    }
    &.failed,
    &.cancelled {
      background: #fcf0f1;
      color: #a64c58;
    }
  }
  .filterTabs {
    display: flex;
    gap: 18px;
    button {
      background: transparent;
      border: 0;
      color: #a5a6b3;
      font-size: 11px;
      padding: 6px 0;
      &.active {
        color: #8461cd;
        font-weight: 600;
      }
    }
  }
  .overviewFoot {
    display: flex;
    align-items: center;
    gap: 9px;
    font-size: 11px;
    color: #74798a;
    padding: 0 2px;
    > svg {
      color: #b0a6c6;
    }
    .separator {
      margin: 0 3px;
    }
    .textButton {
      margin-left: auto;
      font-size: 11px;
    }
  }
  .chatPanel {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 230px);
    min-height: 440px;
    .chatMessages {
      flex: 1;
      overflow: auto;
      padding: 24px;
      .chatMessage {
        margin: 0 0 25px;
        max-width: 95%;
        .messageRole {
          display: flex;
          gap: 12px;
          color: #8666be;
          font-size: 11px;
          margin-bottom: 10px;
          time {
            color: #737686;
            font-size: 11px;
          }
        }
        pre {
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          font: inherit;
          font-size: 12px;
          line-height: 1.9;
          margin: 0;
          color: #676a79;
        }
        &.user {
          border-left: 2px solid #dcd0f4;
          padding: 0 0 0 13px;
        }
        &.tool {
          background: #f7f7fb;
          padding: 14px;
          border-radius: 7px;
          pre {
            max-height: 210px;
            overflow: auto;
            font-family: Consolas, monospace;
            font-size: 11px;
          }
        }
        &.error pre {
          color: #bf7b82;
        }
      }
      .chatWorking {
        font-size: 11px;
        color: #a28ac5;
        display: flex;
        align-items: center;
        gap: 8px;
        .workingDot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: #ab90d6;
          animation: pulse 1.2s infinite;
        }
      }
    }
    .chatComposer {
      margin: 0 20px 20px;
      border: 1px solid #e3dcee;
      border-radius: 9px;
      padding: 12px;
      textarea {
        border: 0;
        outline: none;
        resize: vertical;
        width: 100%;
        background: transparent;
        color: #656474;
        line-height: 1.6;
        font-size: 12px;
        &::placeholder {
          color: #767184;
        }
      }
      > div {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        > span {
          color: #767184;
          font-size: 11px;
        }
      }
    }
  }
  .transferItem {
    display: flex;
    gap: 16px;
    padding: 23px;
    border-bottom: 1px solid #f0f1f6;
    align-items: flex-start;
    .transferBody {
      min-width: 0;
      flex: 1;
      .transferTitle {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        strong {
          font-size: 12px;
          font-weight: 500;
          overflow-wrap: anywhere;
        }
      }
      .transferPaths {
        overflow-wrap: anywhere;
        margin: 9px 0 12px;
        font-size: 11px;
        color: #74798a;
        span {
          padding: 0 6px;
          color: #987bc7;
        }
      }
      progress {
        height: 5px;
        width: 100%;
        appearance: none;
        border: 0;
        border-radius: 6px;
        overflow: hidden;
        &::-webkit-progress-bar {
          background: #f0edf6;
        }
        &::-webkit-progress-value {
          background: #b19bd7;
        }
      }
      .transferMeta {
        display: flex;
        justify-content: space-between;
        color: #74798a;
        font-size: 11px;
        margin-top: 7px;
      }
    }
  }
  dl {
    display: grid;
    grid-template-columns: 90px 1fr;
    gap: 17px 12px;
    font-size: 11px;
    margin: 22px 0;
    dt {
      color: #74798a;
    }
    dd {
      margin: 0;
      color: #77798b;
      overflow-wrap: anywhere;
    }
  }
  .mono {
    font-family: Consolas, monospace;
    font-size: 11px;
  }
  .devicePanel {
    display: flex;
    padding: 30px;
    gap: 36px;
    .deviceIllustration {
      min-width: 140px;
      color: #b29bcf;
      background: #f7f4fb;
      border-radius: 10px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 25px;
    }
    .deviceDetails {
      flex: 1;
      h2 {
        font-size: 16px;
        font-weight: 500;
        margin: 6px 0 0;
      }
    }
  }
  .pairingPanel {
    padding: 25px;
    h2 {
      margin: 0;
      font-size: 13px;
      font-weight: 500;
    }
    p {
      color: #74798a;
      font-size: 11px;
      margin: 9px 0 0;
    }
    .pairCode {
      font-family: Consolas, monospace;
      font-size: 26px;
      color: #8d73b3;
      letter-spacing: 2px;
      margin: 28px 0;
    }
  }
  .buttonRow {
    display: flex;
    gap: 10px;
  }
  .settingRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 25px;
    border-bottom: 1px solid #f0f1f5;
    h2 {
      font-size: 12px;
      font-weight: 500;
      margin: 0 0 8px;
    }
    p {
      font-size: 11px;
      color: #74798a;
      margin: 0;
      line-height: 1.7;
    }
  }
  .permissionSummary {
    display: flex;
    gap: 15px;
    padding: 20px 23px;
    border-radius: 10px;
    background: #f0edf8;
    color: #9c83bf;
    margin-bottom: 24px;
    strong {
      font-size: 12px;
      font-weight: 500;
    }
    p {
      font-size: 11px;
      color: #756783;
      line-height: 1.7;
      margin: 8px 0 0;
    }
  }
  .count {
    color: #b3a2cd;
    font-size: 11px;
    padding: 0 8px;
  }
  .approvalCard {
    padding: 24px;
    .approvalHeading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      h3 {
        font-size: 13px;
        font-weight: 500;
        margin: 0;
      }
    }
    pre {
      background: #f8f7fb;
      border: 1px solid #efebf5;
      border-radius: 7px;
      padding: 16px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font:
        11px/1.9 Consolas,
        "Microsoft YaHei UI",
        monospace;
      color: #898091;
      max-height: 300px;
      overflow: auto;
      margin: 18px 0;
    }
  }
  .toolRow {
    display: flex;
    align-items: center;
    gap: 15px;
    padding: 20px 24px;
    border-bottom: 1px solid #f3f3f7;
    > div {
      flex: 1;
      min-width: 0;
      strong {
        display: block;
        font-size: 12px;
        font-weight: 500;
      }
      small {
        display: block;
        font-family: Consolas, monospace;
        font-size: 11px;
        color: #74798a;
        margin-top: 7px;
        overflow-wrap: anywhere;
      }
    }
  }
  .panelNote {
    padding: 16px 24px;
    color: #767184;
    background: #fcfbfe;
    font-size: 11px;
    line-height: 1.8;
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .logPanel {
    .logToolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 18px 23px;
      border-bottom: 1px solid #f0f0f5;
      .searchField {
        display: flex;
        align-items: center;
        flex: 1;
        gap: 9px;
        color: #b0a8bf;
        input {
          width: 100%;
          border: 0;
          outline: none;
          color: #7c748b;
          font-size: 11px;
          &::placeholder {
            color: #b9b2c4;
          }
        }
      }
      select {
        border: 1px solid #e9e4ee;
        border-radius: 6px;
        color: #9c93ac;
        background: #fff;
        padding: 8px;
        font-size: 11px;
      }
    }
    .logEntries {
      max-height: calc(100vh - 440px);
      min-height: 250px;
      overflow: auto;
      .logEntry {
        border-bottom: 1px solid #f5f3f8;
        summary {
          list-style: none;
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 13px 23px;
          font-family: Consolas, monospace;
          font-size: 11px;
          cursor: pointer;
          time {
            color: #767184;
          }
          > span {
            font-size: 11px;
            width: 35px;
            color: #42745f;
            &.warn {
              color: #8c6c2f;
            }
            &.error {
              color: #a04d59;
            }
          }
          strong {
            font-size: 11px;
            font-weight: 400;
            color: #8f879e;
          }
          code {
            margin-left: auto;
            color: #767184;
            max-width: 180px;
            overflow: hidden;
            text-overflow: ellipsis;
          }
        }
        pre {
          margin: 0;
          padding: 16px 24px;
          color: #9a90a7;
          background: #faf9fc;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          font-size: 11px;
          line-height: 1.8;
        }
      }
    }
  }
  .switchButton {
    width: 34px;
    height: 20px;
    padding: 2px;
    border: 0;
    background: #dddbe5;
    border-radius: 12px;
    flex-shrink: 0;
    span {
      display: block;
      width: 16px;
      height: 16px;
      background: #fff;
      border-radius: 50%;
      box-shadow: 0 1px 2px #0001;
      transition: transform 0.15s;
    }
    &.enabled {
      background: #ad92d5;
      span {
        transform: translateX(14px);
      }
    }
  }
  .versionNote {
    color: #767184;
    font-size: 11px;
    text-align: center;
    margin-top: 30px;
  }
  .errorText {
    color: #c0848d;
    font-size: 11px;
    line-height: 1.8;
    overflow-wrap: anywhere;
  }
  .detailBackdrop {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: none;
    justify-content: flex-end;
    width: 100%;
    max-width: none;
    height: 100%;
    max-height: none;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    &[open] {
      display: flex;
    }
    &::backdrop {
      background: #27233345;
    }
    .detailPanel {
      width: 440px;
      max-width: 90vw;
      background: white;
      height: 100%;
      overflow: auto;
      outline: 0;
      box-shadow: -8px 0 40px #26202f18;
      .detailBody {
        padding: 24px;
        h3 {
          font-size: 12px;
          font-weight: 500;
          color: #92829f;
          margin: 28px 0 20px;
        }
        .timeline {
          list-style: none;
          padding: 0;
          li {
            display: flex;
            gap: 15px;
            position: relative;
            padding-bottom: 24px;
            > span {
              width: 6px;
              height: 6px;
              border-radius: 50%;
              background: #c8b7df;
              margin-top: 3px;
            }
            &:not(:last-child)::before {
              content: "";
              position: absolute;
              width: 1px;
              background: #ede6f5;
              top: 9px;
              bottom: 0;
              left: 2px;
            }
            strong {
              display: block;
              font-size: 11px;
              font-weight: 400;
              color: #92829f;
            }
            small {
              display: block;
              color: #767184;
              font-size: 11px;
              margin-top: 7px;
            }
          }
        }
      }
    }
  }
}
@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation: none !important;
    transition: none !important;
  }
}
@media (max-width: 1050px) {
  .controlCenter {
    .sidebar {
      width: 190px;
      padding-right: 12px;
      padding-left: 12px;
    }
    .workspace {
      margin-left: 190px;
      width: calc(100% - 190px);
      main {
        padding: 25px;
      }
    }
    .pageHeading h1 {
      font-size: 24px;
    }
    .metrics {
      gap: 10px;
      article {
        padding: 16px;
      }
    }
    .statusBanner {
      padding: 20px;
      gap: 12px;
    }
  }
}

.controlCenter.chatWorkspace .workspace main {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 23px 27px 25px;
  max-width: none;
}
.controlCenter.chatWorkspace .pageHeading {
  flex-shrink: 0;
  margin-bottom: 18px;
  .eyebrow {
    display: none;
  }
  h1 {
    font-size: 22px;
    margin-bottom: 7px;
  }
  p {
    font-size: 11px;
  }
}
.controlCenter .pageHeading h1 {
  color: #33283f;
}
.controlCenter .panel {
  border-color: #e6dfef;
  box-shadow: 0 2px 10px #39205003;
}
.controlCenter .sidebar nav button.selected {
  background: #eee5fa;
  color: #7850b3;
}
.controlCenter .primaryButton {
  background: #8055be;
  border-color: #8055be;
  border-radius: 8px;
}
.controlCenter .statusBanner {
  border-radius: 14px;
  background: linear-gradient(110deg, #f0e7fa, #eeeafb 65%, #e8effa);
}
</style>
