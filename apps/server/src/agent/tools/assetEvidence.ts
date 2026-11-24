import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdir, readFile, stat, writeAtomic } from "@/utils/media/objectFiles";
import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getAgentDirectory, lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";

const inputSchema = z.strictObject({
  action: z.enum(["recall", "inspect", "note"]), path: z.string().min(1).max(4096),
  evidenceId: z.string().length(64).optional(),
  purpose: z.string().min(1).max(1000).optional(),
  observation: z.string().min(1).max(4000).optional(),
  exclude: z.array(z.string().min(1).max(500)).max(12).optional(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(5).default(3),
});
const recordSchema = z.strictObject({
  version: z.literal(1), evidenceId: z.string().length(64), suppliedAt: z.string().optional(),
  notes: z.array(z.strictObject({ purpose: z.string(), observation: z.string(), exclude: z.array(z.string()), createdAt: z.string() })).max(20),
});

export function createAssetEvidenceTool(cwd: string, read: ToolDefinition): ToolDefinition {
  return {
    name: "assetEvidence", label: "核对与复用图片素材",
    description: "按实际文件SHA-256复用图片观察。recall 查询此版本已保存的用途、画面观察和应排除元素，不把图片重复送给模型；inspect 通过真实图片读取工具返回画面，之后可 note 保存观察。note 必须使用 inspect 返回的 evidenceId。图片变更后旧观察不适用。只读当前工作区的普通图片，最多20MiB，不触发付费图片生成。",
    promptGuidelines: ["首次采用或关键图片变更先 recall；无适用观察时 inspect 真正看图，再按本段用途 note。备注区分实际看见、创作要求和未知，不以生成提示词替代实际画面；只引用与本镜相关的外观、空间或光色，明确不采用的元素。相同文件的观察可复用，不能据此保证视频生成结果。"],
    parameters: inputSchema.toJSONSchema({ io: "input", target: "draft-07" }),
    executionMode: "sequential",
    async execute(id, params, signal, onUpdate, context) {
      const input = inputSchema.parse(params);
      if (!/\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(input.path)) throw new Error("图片观察只支持工作区中的普通图片；视频使用 readMedia");
      const { path } = await resolveWorkspacePath(cwd, input.path);
      const before = await stat(path);
      if (!before.isFile() || !before.size || before.size > 20 * 1024 * 1024) throw new Error("请选择不超过20MiB的非空图片");
      const bytes = await readFile(path, { signal });
      const evidenceId = createHash("sha256").update(bytes).digest("hex");
      const root = join(getAgentDirectory(cwd), "assetEvidence");
      const target = join(root, `${evidenceId}.json`);
      const release = lockWorkspaceFiles([target]);
      try {
        const saved = await readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
        const record = saved === undefined ? { version: 1 as const, evidenceId, notes: [] as z.infer<typeof recordSchema>["notes"], suppliedAt: undefined as string | undefined }
          : recordSchema.parse(JSON.parse(saved));
        if (record.evidenceId !== evidenceId) throw new Error("素材观察版本无效，请重新读取图片");
        let imageResult: Awaited<ReturnType<ToolDefinition["execute"]>> | undefined;
        if (input.action === "inspect") {
          imageResult = await read.execute(id, { path: input.path }, signal, onUpdate, context);
          if (!imageResult.content.some(part => part.type === "image")) throw new Error("读取工具未返回真实图片，未登记画面证据");
          record.suppliedAt = new Date().toISOString();
        }
        if (input.action === "note") {
          if (input.evidenceId !== evidenceId || !record.suppliedAt || !input.purpose || !input.observation) throw new Error("请先 inspect 当前图片，并提供其 evidenceId、purpose 和实际 observation");
          const note = { purpose: input.purpose, observation: input.observation, exclude: input.exclude ?? [], createdAt: new Date().toISOString() };
          record.notes = [...record.notes.filter(item => item.purpose !== input.purpose), note].slice(-20);
        }
        const after = await stat(path);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("读取期间图片已变化，请重新核对新版本");
        signal?.throwIfAborted();
        if (input.action !== "recall") { await mkdir(root, { recursive: true }); await writeAtomic(target, JSON.stringify(recordSchema.parse(record))); }
        const notes = record.notes.toReversed();
        const details = { path: input.path, evidenceId, suppliedAt: record.suppliedAt, notes: notes.slice(input.offset, input.offset + input.limit),
          nextOffset: input.offset + input.limit < notes.length ? input.offset + input.limit : null,
          imageSuppliedThisCall: input.action === "inspect", limitation: "观察为此前模型记录；不证明生成结果或未读取的视频内容。" };
        return { content: [{ type: "text", text: JSON.stringify(details) }, ...(imageResult?.content.filter(part => part.type === "image") ?? [])], details };
      } finally { release(); }
    },
  };
}
