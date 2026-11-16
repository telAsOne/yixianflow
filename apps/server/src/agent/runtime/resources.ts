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
  const canvasGuidance = tools.some(tool => ["getCanvasNodes", "getCanvasEdges", "nodeTools"].includes(tool.name))
    ? `## 画布任务执行核对
- 从本轮请求提取目标、约束和依赖；沿用相关且已确认的项目决定，当前画布状态优先于旧对话描述。只在影响结果且无法从剧本、素材或画布查证时，合并提出必要问题。
- 视频节点先判断是否需要续接，并区分原生续接绑定和普通视频参考；按任务核对场景/风格、角色、音色等所需参考。以实际入边、输出状态和素材内容为准，提示词提及或存在文件路径不代表已连接。
- 对用户已授权且意图明确的连接和提示词直接完成。完成前回读目标提示词与入边，逐项核对并修复遗漏；素材视觉适用性影响决策时先读实际图片。无法修复时说明具体缺项和原因。
- 全画布多节点盘点可委派明确只读的子任务产出简短清单；同一画布的写入与最终回读由主会话串行完成。`
    : "";
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
      canvasGuidance,
    ].filter(Boolean),
  });
  await resourceLoader.reload();
  return { agentDir, settingsManager: settings, resourceLoader };
}
