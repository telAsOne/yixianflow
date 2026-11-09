import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { mkdir, readFile, readdir, stat } from "@toonflow/file";
import { canvasOperations } from "@toonflow/tool-canvas/runtime";
import type { McpTool } from "@toonflow/mcp";
import type { CanvasContext } from "@toonflow/tools-scaffold/runtime";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentToolContext, createAgentTools } from "@/agent/tools";
import { run as runAgent } from "@/agent";
import { getSettings } from "@/utils/conf";
import { getWebProject, resolveWebProject } from "@/utils/web/projects";
import { beginWorkspaceOperation } from "@/utils/workspace/activity";
import { lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";
import { notifyFileChange } from "@/utils/workspace/canvasSync";
import { callControl, getConnection, listConnections } from "./control";
import { assertWebMcpScope, requireWebMcpAccess, runWebMcpCall, runWebMcpOperation, type WebMcpScope } from "./webAccess";

const targetSchema = z.strictObject({ connectionId: z.uuid().optional(), directory: z.uuid().optional(), canvasId: z.string().min(1).max(256).optional() });
type Target = z.infer<typeof targetSchema>;
const readOperations = new Set(["getCanvas", "findCanvasNodes", "getCanvasNodes", "getCanvasEdges", "getNodeTools"]);
const readNodeFunctions = ["node:getConfig", "node:getPrompt", "node:getGenerationStatus", "node:getSubtitleStatus"];
const editNodeFunctions = ["node:setText", "node:setPrompt", "node:setConfig", "node:setImage", "node:setVideo", "node:setAudio", "node:setSubtitle", "node:saveSubtitle"];
const generationScopes = ["generateImage", "generateVideo"] as const;

function operationScope(name: string, args: Record<string, unknown>): WebMcpScope | undefined {
  const method = name === "nodeTools" && typeof args.name === "string" ? args.name.slice(5) : name;
  if (generationScopes.some(scope => scope === method) || ["arrangeCanvas", "runAgent", "localComputer"].includes(method)) return method as WebMcpScope;
  return method === "resumeVideoTask" ? "generateVideo" : undefined;
}

function resolveConnection(target: Target) {
  const { projectId } = requireWebMcpAccess();
  if (target.directory && target.directory !== projectId) throw new Error("此 MCP 凭证未授权目标项目");
  const connections = listConnections().filter(item => item.state.directory === projectId);
  if (!target.connectionId && connections.length > 1) throw new Error("此项目有多个页面，请通过 target.connectionId 指定目标");
  const connection = target.connectionId ? getConnection(target.connectionId) : connections[0];
  if (!connection || connection.state.directory !== projectId) throw new Error("请保持已授权项目的画布网页打开，再调用 getAppState");
  if (target.canvasId && target.canvasId !== connection.state.canvasId) throw new Error("目标画布已切换，请重新调用 getAppState");
  return connection;
}

function createTool<T extends z.ZodType>(name: string, description: string, argsSchema: T, edit: boolean | ((args: z.output<T>) => boolean), execute: (args: z.output<T>, target: Target, signal: AbortSignal) => Promise<unknown>): McpTool {
  const schema = z.strictObject({ target: targetSchema.optional(), requestId: z.uuid().optional(), args: argsSchema });
  return {
    name, description, inputSchema: z.toJSONSchema(schema, { io: "input" }),
    async execute(input, signal) {
      const { args, target = {}, requestId } = schema.parse(input) as { args: z.output<T>; target?: Target; requestId?: string };
      if (target.directory && target.directory !== requireWebMcpAccess().projectId) throw new Error("此 MCP 凭证未授权目标项目");
      return runWebMcpCall(signal, typeof edit === "function" ? edit(args) : edit, currentSignal => {
        const scope = operationScope(name, args as Record<string, unknown>);
        if (scope) assertWebMcpScope(scope);
        if (!scope || name === "resumeVideoTask") return execute(args, target, currentSignal);
        return runWebMcpOperation(requestId, { name, args, target }, () => execute(args, target, currentSignal));
      });
    },
  };
}

export async function getWebMcpTools(): Promise<McpTool[]> {
  const access = requireWebMcpAccess();
  const editable = access.permission === "edit";
  const nodeFunctions = [...readNodeFunctions, ...(editable ? editNodeFunctions : []), ...generationScopes.filter(scope => editable && access.scopes.includes(scope)).map(scope => `node:${scope}`)];
  const tools: McpTool[] = [{
    name: "getAppState", description: "读取已授权项目及自己打开的画布页面。先获取 connectionId 和 canvasId；后续工具使用 {target:{connectionId,directory,canvasId},args:{...}}。directory 是项目 ID，凭证只允许此项目。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: (_input, signal) => runWebMcpCall(signal, false, async () => {
      const project = await getWebProject(access.projectId);
      const connections = listConnections().filter(item => item.state.directory === access.projectId).map(({ id, state }) => ({
        id, state: { directory: state.directory, canvasId: state.canvasId, panel: state.panel },
      }));
      return { project: { id: project.id, name: project.name, permission: access.permission, scopes: access.scopes }, connections, requiresOpenPage: true };
    }),
  }];
  for (const operation of canvasOperations) {
    if (operation.name === "nodeTools" || operation.name === "arrangeCanvas" && !access.scopes.includes("arrangeCanvas")) continue;
    const edit = !readOperations.has(operation.name);
    if (edit && !editable) continue;
    tools.push(createTool(operation.name, operation.description, operation.parameters, edit, async (args, target, signal) => {
      const connection = resolveConnection(target);
      let parameters: Record<string, unknown> = args;
      if (operation.name === "addMediaNodes") {
        const directory = await resolveWebProject(access.projectId);
        for (const path of (args as { paths: string[] }).paths) await resolvePublicPath(directory, path);
      }
      if (operation.name === "getNodeTools") {
        const requested = (args as { names?: string[] }).names;
        if (requested?.some(name => !nodeFunctions.includes(name))) throw new Error("请求的节点函数不在此 MCP Key 的授权范围内");
        parameters = { ...args, names: requested ?? nodeFunctions };
      }
      return callControl(connection.id, operation.name, parameters, signal, access.projectId);
    }));
  }
  tools.push(createTool("nodeTools", "调用 getNodeTools 返回的节点函数，生成能力由 Key 权限控制。生成时必须在顶层提供唯一 UUID requestId；重复请求沿用原 requestId，避免重复提交。", z.strictObject({
    nodeId: z.string().min(1).max(256), name: z.enum(nodeFunctions as [string, ...string[]]), args: z.record(z.string(), z.json()),
  }), args => !readNodeFunctions.includes(args.name), async (args, target, signal) => {
    const connection = resolveConnection(target);
    const path = args.args.path;
    if (typeof path === "string") await resolvePublicPath(await resolveWebProject(access.projectId), path);
    return callControl(connection.id, "nodeTools", args, signal, access.projectId);
  }));
  const fileSchema = z.strictObject({
    action: z.enum(["list", "readText", "readBinary", "writeText", "writeBinary"]), path: z.string().max(2048).default(""),
    text: z.string().max(1_000_000).optional(), base64: z.string().max(28_000_000).optional(),
  });
  tools.push(createTool("workspaceFiles", "读项目文件或传入文本、图片、视频等素材，单文件最多 20 MiB。上传 path 必须位于 assets/mcp/，只新建、不覆盖。上传返回相对路径，再用 addMediaNodes 或节点函数放入画布；不读取个人对话及内部目录。", fileSchema,
    args => args.action === "writeText" || args.action === "writeBinary", async (args, _target, signal) => {
      const writing = args.action === "writeText" || args.action === "writeBinary";
      const directory = await resolveWebProject(access.projectId, writing ? "edit" : "read");
      const releaseOperation = beginWorkspaceOperation(directory);
      try {
        const normalized = args.path.replaceAll("\\", "/");
        if (writing && (!normalized.startsWith("assets/mcp/") || normalized.endsWith("/"))) throw new Error("上传文件的 path 必须位于 assets/mcp/ 目录");
        const source = await resolvePublicPath(directory, args.path, writing);
        signal.throwIfAborted();
        if (args.action === "list") return (await readdir(source.path, { withFileTypes: true })).filter(item => !item.name.startsWith(".") && (item.isFile() || item.isDirectory()))
          .map(item => ({ name: item.name, type: item.isDirectory() ? "directory" : "file" }));
        if (!writing) {
          const info = await stat(source.path);
          if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error("只能读取不超过 20 MiB 的普通文件");
          const bytes = await readFile(source.path, { signal });
          return args.action === "readText" ? { path: args.path, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) } : { path: args.path, base64: bytes.toString("base64") };
        }
        if (args.action === "writeText" ? args.text === undefined : args.base64 === undefined) throw new Error("writeText 需要 text，writeBinary 需要 base64");
        const bytes = args.action === "writeText" ? Buffer.from(args.text!) : Buffer.from(args.base64!, "base64");
        if (bytes.length > 20 * 1024 * 1024) throw new Error("上传文件不能超过 20 MiB");
        if (args.action === "writeBinary" && bytes.toString("base64") !== args.base64) throw new Error("base64 必须是有效的标准 Base64 编码");
        const release = lockWorkspaceFiles([source.path]);
        try {
          await mkdir(dirname(source.path), { recursive: true });
          signal.throwIfAborted();
          await writeWorkspaceFile(source.path, bytes, true);
        } finally { release(); }
        notifyFileChange(directory, source.path);
        return { path: normalized, bytes: bytes.length };
      } finally { releaseOperation(); }
    }));
  const directory = await resolveWebProject(access.projectId);
  const stub: CanvasContext = { id: "mcp", tools: [], async call() { throw new Error("请先指定已打开的画布页面"); } };
  if (editable && access.scopes.some(scope => generationScopes.includes(scope as typeof generationScopes[number]) || scope === "localComputer")) {
    const definitions = await createAgentTools(directory, stub);
    for (const definition of definitions) {
      const name = definition.name;
      if (!["generateImage", "generateVideo", "listMediaModels", "getVideoTask", "resumeVideoTask", "localComputer"].includes(name)) continue;
      const scope = operationScope(name, {});
      if (!scope && !["listMediaModels", "getVideoTask"].includes(name)) continue;
      if (scope && !access.scopes.includes(scope)) continue;
      if (name === "getVideoTask" && !access.scopes.includes("generateVideo")) continue;
      if (name === "listMediaModels" && !access.scopes.some(scope => generationScopes.includes(scope as typeof generationScopes[number]))) continue;
      const rawSchema = JSON.parse(JSON.stringify(definition.parameters).replace(/"\$ref":"#(?=\/|")/g, '"$ref":"#/properties/args'));
      const schema = z.record(z.string(), z.unknown());
      const tool = createTool(name, `${definition.description}\n生成和本机操作须在顶层提供唯一 UUID requestId，重试沿用原值。`, schema, !["listMediaModels", "getVideoTask"].includes(name), async (args, target, signal) => {
        if (name === "localComputer") validateLocalRequest(args);
        await validateMediaPaths(directory, args);
        const connection = listConnections().some(item => item.state.directory === access.projectId) ? resolveConnection(target) : undefined;
        if (name !== "localComputer" && !connection) throw new Error("请保持授权项目的画布页面打开");
        const canvas = connection ? canvasContext(target, signal) : undefined;
        const current = (await createAgentTools(directory, canvas)).find(item => item.name === name);
        if (!current) throw new Error("工具已禁用或指定本机设备未绑定，请检查项目和设备设置");
        const context = new Proxy({ cwd: directory, mode: "rpc", hasUI: false, signal }, { get(value, key) {
          if (Reflect.has(value, key)) return Reflect.get(value, key);
          throw new Error(`MCP 不提供此会话能力：${String(key)}`);
        } }) as unknown as ExtensionContext;
        const result = await current.execute(crypto.randomUUID(), args, signal, undefined, context);
        if (name !== "listMediaModels") return result;
        const models = (result.details as { type: string }[]).filter(model => access.scopes.includes(`generate${model.type[0]!.toUpperCase()}${model.type.slice(1)}` as WebMcpScope));
        return { models };
      });
      (tool.inputSchema.properties as Record<string, unknown>).args = rawSchema;
      tools.push(tool);
    }
  }
  if (editable && access.scopes.includes("runAgent")) {
    tools.push(createTool("listAgentModels", "查询可用于内置 Agent 委托的文本模型，返回 providerId、modelId 和名称，不包含访问密钥。", z.strictObject({}), false, async () => {
      assertWebMcpScope("runAgent");
      const providers = getSettings().customProviders as { id: string; models?: { id: string; label?: string; think?: boolean }[] }[] | undefined;
      return { models: (providers ?? []).flatMap(provider => (provider.models ?? []).map(model => ({ providerId: provider.id, modelId: model.id, label: model.label, thinking: model.think }))) };
    }));
    tools.push(createTool("runAgent", "委托内置 Agent 在此项目执行任务，按当前账户模型计费。先 listAgentModels 查询模型；必须在顶层提供唯一 UUID requestId。委托 Agent 仅使用此 Key 已授权的能力，不扩大项目、生成或本机权限。", z.strictObject({
      prompt: z.string().trim().min(1).max(100000), providerId: z.string().min(1).max(100), modelId: z.string().min(1).max(256),
      thinkingLevel: z.enum(["off", "low", "medium", "high"]).optional(),
    }), true, async (args, target, signal) => {
      const connection = resolveConnection(target);
      const agentTarget = { ...target, connectionId: connection.id };
      const canvas = canvasContext(agentTarget, signal);
      const customTools = tools.filter(tool => tool.name !== "runAgent").map(tool => defineTool({
        name: tool.name, label: tool.name, description: tool.description, executionMode: "sequential",
        parameters: tool.name === "getAppState" ? tool.inputSchema : JSON.parse(JSON.stringify((tool.inputSchema.properties as Record<string, unknown>).args)
          .replace(/"\$ref":"#\/properties\/args(?=\/|")/g, '"$ref":"#')),
        async execute(id, parameters, currentSignal) {
          const digest = createHash("sha256").update(`${access.id}:${id}`).digest("hex").slice(0, 32);
          const requestId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`;
          const result = await tool.execute(tool.name === "getAppState" ? {} : { args: parameters, target: agentTarget, requestId }, currentSignal ?? signal);
          if (["addCanvas", "switchCanvas", "renameCanvas"].includes(tool.name) && typeof (result as { canvasId?: unknown })?.canvasId === "string")
            agentTarget.canvasId = (result as { canvasId: string }).canvasId;
          if (tool.name === "getAppState") {
            const state = (result as { connections: { id: string; state: { canvasId: string | null } }[] }).connections.find(item => item.id === connection.id)?.state;
            if (state?.canvasId) agentTarget.canvasId = state.canvasId;
          }
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        },
      }));
      const skills = createAgentToolContext(directory).skills!;
      const skillSchema = z.strictObject({ action: z.enum(["list", "read"]), name: z.string().min(1).optional(), path: z.string().min(1).optional(), scope: z.enum(["workspace", "global"]).optional() });
      customTools.push(defineTool({ name: "skillOperator", label: "读取创作技能", description: "仅读取本项目及已安装的创作技能，不能编辑或安装技能。", parameters: z.toJSONSchema(skillSchema),
        async execute(_id, parameters, currentSignal) {
          const input = skillSchema.parse(parameters);
          const result = await runWebMcpCall(currentSignal ?? signal, false, async activeSignal => {
            assertWebMcpScope("runAgent");
            if (input.action === "list") return { skills: skills.list(input.scope) };
            if (!input.name) throw new Error("读取技能需要 name");
            return skills.read({ name: input.name, path: input.path, scope: input.scope }, activeSignal);
          });
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        },
      }));
      const blocks = new Map<string, string>();
      let sessionFile: string | undefined;
      await runAgent({ ...args, cwd: directory, canvas, signal: AbortSignal.any([signal, AbortSignal.timeout(60 * 60_000)]) }, event => {
        if (event.type === "session") sessionFile = event.file;
        if (event.type === "text") blocks.set(event.blockId, event.content ?? (blocks.get(event.blockId) ?? "") + (event.delta ?? ""));
      }, customTools);
      return { sessionFile, text: [...blocks.values()].join("\n") };
    }));
  }
  return tools;
}

function canvasContext(target: Target, signal: AbortSignal): CanvasContext {
  const connection = resolveConnection(target);
  const { projectId } = requireWebMcpAccess();
  return { id: connection.state.canvasId ?? "mcp", tools: connection.state.tools,
    call: (request, currentSignal) => {
      resolveConnection({ ...target, connectionId: connection.id });
      return callControl(connection.id, request.name, request.args, currentSignal ?? signal, projectId);
    } };
}

function validateLocalRequest(args: Record<string, unknown>) {
  const { projectId } = requireWebMcpAccess();
  if (args.action === "projects") throw new Error("此 Key 仅授权当前项目；请使用 getAppState 查询项目");
  if (args.projectId !== undefined && args.projectId !== projectId) throw new Error("本机传输不能访问未授权的项目");
  if ((args.action === "upload" || args.action === "download") && Array.isArray(args.files)) {
    for (const entry of args.files as { path: string; target: string }[]) {
      const path = args.action === "upload" ? entry.target : entry.path;
      if (path.split(/[\\/]/).some(part => part.startsWith("."))) throw new Error("本机传输不能访问项目内部目录");
    }
  }
}

async function validateMediaPaths(directory: string, args: Record<string, unknown>) {
  if (typeof args.outputDirectory === "string") await resolvePublicPath(directory, args.outputDirectory, true);
  for (const key of ["images", "videos", "audios"]) if (Array.isArray(args[key])) {
    for (const reference of args[key] as { path?: string }[]) if (reference.path) await resolvePublicPath(directory, reference.path);
  }
  for (const key of ["firstFrame", "lastFrame"]) {
    const reference = args[key] as { path?: string } | undefined;
    if (reference?.path) await resolvePublicPath(directory, reference.path);
  }
}

function resolvePublicPath(directory: string, path: string, allowMissingParents = false) {
  if (path.split(/[\\/]/).some(part => part.startsWith("."))) throw new Error("MCP 不允许访问内部目录或个人对话");
  return resolveWorkspacePath(directory, path, allowMissingParents);
}
