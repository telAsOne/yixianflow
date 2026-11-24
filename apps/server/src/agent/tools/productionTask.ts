import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdir, readFile, writeAtomic } from "@/utils/media/objectFiles";
import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getAgentDirectory, lockWorkspaceFiles } from "@/utils/workspace/files";

const taskSchema = z.strictObject({
  id: z.uuid(), canvasId: z.string().min(1).max(256),
  nodeIds: z.array(z.string().min(1).max(256)).min(1).max(20),
  goal: z.string().min(1).max(2000),
  preserve: z.array(z.string().min(1).max(500)).max(12),
  remaining: z.array(z.string().min(1).max(500)).max(12),
  state: z.enum(["preparing", "waiting", "needsInput", "ready", "completed", "cancelled"]),
  updatedAt: z.string(),
});
const inputSchema = z.strictObject({
  action: z.enum(["read", "save"]),
  revision: z.string().length(64).optional(),
  taskId: z.uuid().optional(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(10).default(5),
  task: taskSchema.omit({ id: true, updatedAt: true }).extend({ id: z.uuid().optional() }).optional(),
});
const recordSchema = z.strictObject({ version: z.literal(1), tasks: z.array(taskSchema).max(30) });
const revision = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function readProductionTasks(cwd: string) {
  const path = join(getAgentDirectory(cwd), "productionTasks.json");
  try { return recordSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 as const, tasks: [] }; throw error; }
}

export function createProductionTaskTool(cwd: string): ToolDefinition {
  return {
    name: "productionTask", label: "保存制作进度",
    description: "读取或保存当前账号在本项目的制作交接。记录目标画布、具体节点、用户意图、必须保留项和真正未完成的事项，跨对话沿用。read 默认返回最近5项简短索引，nextOffset续读；taskId读取该项完整目标、保留项和待办。read 返回 revision；save 必须携带该版本，避免覆盖其他对话的进度。原任务使用其 id 更新。记录不执行节点操作，不启动生成或审查，不构成新的授权。",
    promptGuidelines: ["准备单段时保存目标与保留项；遇到上游生成依赖、缺素材或中断前保存 remaining，完成后更新 ready/completed。用户说‘接好了’‘图好了’时先沿用这份交接并读取现场，不要求复述编号和历史。旧任务只供查证，不能扩展本轮目标或覆盖用户最新要求。"],
    parameters: inputSchema.toJSONSchema({ io: "input", target: "draft-07" }),
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const input = inputSchema.parse(params);
      const path = join(getAgentDirectory(cwd), "productionTasks.json");
      const release = input.action === "save" ? lockWorkspaceFiles([path]) : () => {};
      try {
        signal?.throwIfAborted();
        const current = await readProductionTasks(cwd);
        if (input.action === "save") {
          if (!input.task || input.revision !== revision(current)) throw new Error("制作进度已变化或未读取，请先 read，再合并本轮实际变化");
          if (input.task.id && !current.tasks.some(task => task.id === input.task!.id)) throw new Error("原制作任务不存在，请读取当前进度");
          const task = taskSchema.parse({ ...input.task, id: input.task.id ?? crypto.randomUUID(), updatedAt: new Date().toISOString() });
          const tasks = current.tasks.filter(item => item.id !== task.id);
          if (tasks.length >= 30) {
            const done = tasks.findIndex(item => ["completed", "cancelled"].includes(item.state));
            if (done < 0) throw new Error("已有30项未归档制作任务，请先完成或取消不再需要的任务");
            tasks.splice(done, 1);
          }
          tasks.push(task);
          const next = recordSchema.parse({ version: 1, tasks });
          await mkdir(getAgentDirectory(cwd), { recursive: true });
          signal?.throwIfAborted();
          await writeAtomic(path, JSON.stringify(next));
          return { content: [{ type: "text", text: JSON.stringify({ revision: revision(next), task }) }], details: { task } };
        }
        const tasks = input.taskId ? current.tasks.filter(task => task.id === input.taskId) : current.tasks.toReversed();
        const page = tasks.slice(input.offset, input.offset + input.limit).map(task => input.taskId ? task : {
          id: task.id, canvasId: task.canvasId, nodeIds: task.nodeIds, state: task.state, updatedAt: task.updatedAt,
          goal: task.goal.slice(0, 300), remainingCount: task.remaining.length, details: "按taskId读取完整交接",
        });
        return { content: [{ type: "text", text: JSON.stringify({ revision: revision(current), tasks: page,
          nextOffset: input.offset + input.limit < tasks.length ? input.offset + input.limit : null }) }], details: {} };
      } finally { release(); }
    },
  };
}
