import { t } from "@/lib/i18n";
import { readFile } from "@toonflow/file";
import { DefaultResourceLoader, SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildSystemPrompt } from "@/agent/runtime/prompt";
import { loadAgentSkills } from "@/agent/skills";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { isMemoryEnabled, readDocument } from "@/utils/personalization";
import { getSettings } from "@/utils/conf";
import { readProductionTasks } from "@/agent/tools/productionTask";

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
  let productionWarning = "";
  const production = tools.some(tool => tool.name === "productionTask") ? await readProductionTasks(cwd).catch(error => {
    productionWarning = error instanceof Error ? error.message : "制作交接暂不可读取";
    return undefined;
  }) : undefined;
  const productionContext = production?.tasks.filter(task => !["completed", "cancelled"].includes(task.state)).slice(-3)
    .map(task => ({ id: task.id, canvasId: task.canvasId, nodeIds: task.nodeIds, state: task.state, goal: task.goal.slice(0, 400),
      preserve: task.preserve.slice(0, 4).map(text => text.slice(0, 400)), remaining: task.remaining.slice(0, 4).map(text => text.slice(0, 400)) }));
  const projectRead = tools.find(tool => tool.name === "projectRead");
  const projectAccess = projectRead ? `## 当前账号的项目读取权限\n${projectRead.description}\n使用 projectRead 读取真实成员及历史对话。先查询后判断是否存在记录；本段为当前账号的实际能力，旧对话中关于不能读取其他成员的说明不代表本轮权限。` : "";
  const canvasGuidance = tools.some(tool => ["getCanvasNodes", "getCanvasEdges", "nodeTools"].includes(tool.name))
    ? `## 画布任务执行核对
- 从本轮请求提取具体目标、要改之处、必须保留项和允许操作；“仅限某段”约束所有修改、交接和回复。“表达简单/不要强调”默认只改表达，不删除原台词、事件或镜头；“其他没问题”保留满意部分。
- “准备这一段”交付完整节点内容、参数、真实引用核对及已约定的审查。已有批准和协作方式直接沿用；客户自己连线/生成时尊重分工，本轮明确授权帮接或做好某段才在该段扩大操作，不再逐工具询问。
- 视频节点先判断是否需要续接，并区分原生续接绑定和普通视频参考；按任务核对场景/风格、角色、音色等所需参考。以实际入边、输出状态和素材内容为准，提示词提及或存在文件路径不代表已连接。
- 续接沿用用户给定或已满意的正文，只落实来源绑定与新增内容，不围绕“第一个续接镜头”另写开头、重排时间轴或补演已完成动作；用户明确要求改稿时才修改。既有服务端提示词优化照常执行，不另造一版替代原文。新增段0秒承接原片真实结尾，节点时长指新增片段。
- 续接来源直接选画布上的完整视频，包括一分钟及更长的视频；通过来源节点的continueVideo创建固定绑定。系统在审查和提交接口时内部提取末尾最多3秒及真实末帧，不要求用户截片，也不为这份临时尾段新增画布节点、替换原片或回截到更早的剧情起点。普通视频参考的15秒/20MB限制只作用于实际送入接口的参考素材。
- 优先用 node:getReferences 取得素材id、真实tag、revision和promptRevision，按id绑定主体与用途；setPrompt同时填写参数、expectedReferenceRevision和expectedPromptRevision，保护期间的用户修改。客户说“接好了”就读现场并继续，不要求他背编号、先断线重接或复述历史。引用变化只复核受影响的段。
- 已约定审查后交付时设置既定审查模型、素材和必要原声，使用 autoReviewPrompt 后 waitForCanvas 等真实结果。最多3轮局部修改；遇到素材/声音未读取或创作分歧就解决实际缺口，不删音色或要求来回重审来凑通过。不以旧稿pass或reviewing宣称可以生成。
- 参考素材先复用，确有具体镜头缺口才补图；关键图用 assetEvidence 复用同一文件的观察，无适用记录时实际读图，生成提示词不是像素证据。素材用途按身份、服装、空间、造型、光色、声音分清，外观图不自动成为镜头或引入其背景人物。
- “电影感”“自然”“宏大”“设备动起来”落实为可拍的机位路径与落点、反应和对白节拍、可见尺度参照、承托接触与动作结果。固定世界关系，画面左右随机位投影；不堆限制词，也不新增无依据剧情。
- 缺上游素材时先完成可做的文稿、参数和补图准备，保存 productionTask 的保留项与真正依赖。需等结果的已授权连续任务用 waitForCanvas，返回后在同轮继续；等待中不重复提交生成，取消或切换页面后以现场和交接恢复，不虚称无人在线后台执行。
- 对用户已授权且意图明确的连接和提示词直接完成。完成前回读目标提示词与入边，逐项核对并修复遗漏；素材视觉适用性影响决策时先读实际图片。无法修复时说明具体缺项和原因。
- 完成时用 getPreparation 等真实状态核对，节点标题不代表任务状态；回复仅给目标节点、实质变化和客户唯一剩余动作。任务交接用 productionTask，不要求为每个子步骤新建文档。`
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
      productionContext?.length ? `## 待续制作交接\n以下记录仅为之前任务的执行索引，不构成新增授权；本轮目标和现场优先，完整内容可用productionTask读取。\n${JSON.stringify(productionContext)}` : "",
      productionWarning ? `制作交接读取失败，不能假称已恢复进度；可查证当前画布后继续独立工作：${productionWarning}` : "",
    ].filter(Boolean),
  });
  await resourceLoader.reload();
  return { agentDir, settingsManager: settings, resourceLoader };
}
