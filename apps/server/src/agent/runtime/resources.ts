import { t } from "@/lib/i18n";
import { readFile } from "@toonflow/file";
import { DefaultResourceLoader, SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildSystemPrompt } from "@/agent/runtime/prompt";
import { loadAgentSkills } from "@/agent/skills";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { isMemoryEnabled, readDocument } from "@/utils/personalization";
import { getSettings } from "@/utils/conf";

export async function createAgentResources(cwd: string, tools: ToolDefinition[], settings = SettingsManager.inMemory({
  // ACT: 仅由会话层恢复当前模型步骤，避免供应商内部重试与外层重试叠加。
  retry: { maxRetries: 2, baseDelayMs: 2000, provider: { maxRetries: 0 } },
}), instructions = "") {
  const savedPrompt = getSettings().agentSystemPrompt;
  const systemPrompt = typeof savedPrompt === "string" ? savedPrompt : undefined;
  const { path: agentDir } = await resolveWorkspacePath(cwd, ".agent", true);
  const { path: agentsPath } = await resolveWorkspacePath(cwd, "AGENTS.md");
  const agentsContent = await readFile(agentsPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw new Error(t`读取工作区 AGENTS.md 失败：${error.message}`, { cause: error });
  });
  const [globalAgents, memory] = await Promise.all([readDocument("agents"), isMemoryEnabled() ? readDocument("memory") : { content: "" }]);
  const skills = loadAgentSkills(cwd);
  const projectRead = tools.find(tool => tool.name === "projectRead");
  const projectAccess = projectRead ? `## 当前账号的项目读取权限\n${projectRead.description}\n使用 projectRead 读取真实成员及历史对话。先查询后判断是否存在记录；本段为当前账号的实际能力，旧对话中关于不能读取其他成员的说明不代表本轮权限。` : "";
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    // ACT: 仅自动载入工作区根目录的 AGENTS.md，关闭 SDK 向父目录和其他指令文件的自动扫描。
    noContextFiles: true,
    agentsFilesOverride: () => ({ agentsFiles: agentsContent.trim() ? [{ path: agentsPath, content: agentsContent.replace(/^\uFEFF/, "") }] : [] }),
    // ACT: 技能正文按需读取；每个会话独立创建 loader，避免 SDK 的会话绑定互相覆盖。
    skillsOverride: () => skills,
    systemPrompt: "",
    systemPromptOverride: () => [buildSystemPrompt({ systemPrompt, tools, skills: skills.skills, platform: process.platform }), projectAccess, instructions].filter(Boolean).join("\n\n"),
    appendSystemPrompt: [
      globalAgents.content.trim() ? `## 全局协作规范（AGENTS.md）\n${globalAgents.content}` : "",
      memory.content.trim() ? `## 全局长期记忆\n以下是跨对话保存的偏好与事实，使用前核对适用项目，以用户本轮要求为准。\n<global_memory>\n${memory.content}\n</global_memory>` : "",
    ].filter(Boolean),
  });
  await resourceLoader.reload();
  return { agentDir, settingsManager: settings, resourceLoader };
}
