import { z } from "zod";
import type { CanvasContext, GeneratedMedia, ToolDefinition, ToolPlugin } from "@toonflow/tools-scaffold/runtime";
import { audioGenerationSchema, imageGenerationSchema, listMediaModelsSchema, resumeVideoTaskSchema, videoGenerationSchema, videoTaskSchema } from "./runtime";

const configSchema = z.strictObject({
  allowImage: z.boolean().default(true),
  allowVideo: z.boolean().default(true),
  allowAudio: z.boolean().default(true),
});

async function videoOperationId(toolCallId: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`mediaGeneration:generateVideo:${toolCallId}`))).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = Array.from(digest, value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function mediaResult(result: GeneratedMedia[], target?: { id: string; context: CanvasContext }, signal?: AbortSignal) {
  let text = result.map(asset => {
    const url = asset.path.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
    const preview = asset.mediaType === "image" ? `![生成图片](<${url}>)` : `[${asset.mediaType === "audio" ? "播放生成音频" : "查看生成视频"}](<${url}>)`;
    return `${preview}\n工作区文件：${asset.path}`;
  }).join("\n\n");
  const paths = result.filter(asset => asset.mediaType === "image" || asset.mediaType === "video").map(asset => asset.path);
  if (target && paths.length) {
    try {
      for (let offset = 0; offset < paths.length; offset += 64) {
        const receipt = await target.context.call({ name: "addMediaNodes", args: { canvasId: target.id, paths: paths.slice(offset, offset + 64) } }, signal);
        text += `\n\n画布节点已保存：${JSON.stringify(receipt)}。已有相同文件的节点已复用，无需再次添加。`;
      }
    } catch (error) {
      text += `\n\n媒体文件已生成并保存，但添加到目标画布未完成：${error instanceof Error ? error.message : String(error)}。请在目标画布导入以上已有文件，不要重新生成。`;
    }
  }
  return { content: [{ type: "text" as const, text }], details: result };
}

const plugin: ToolPlugin = {
  validateConfig: config => configSchema.parse(config),
  createTools({ media, config, canvas }) {
    if (!media) return [];
    const permissions = configSchema.parse(config);
    async function getTargetCanvas(signal?: AbortSignal) {
      if (!canvas) return;
      const { id } = await canvas.call({ name: "getCanvas", args: {} }, signal) as { id: string };
      return { id, context: canvas };
    }
    const generationTools = ([
      { name: "generateImage", mediaType: "image", enabled: permissions.allowImage, label: "生成图片", parameters: imageGenerationSchema, description: "根据提示词和可选的工作区参考图生成图片。" },
      { name: "generateVideo", mediaType: "video", enabled: permissions.allowVideo, label: "生成视频", parameters: videoGenerationSchema, description: "根据提示词和可选的工作区图片、视频、音频、首尾帧生成视频。referenceImageInput 为 url 的模型可使用 referenceImageUrls 中的公网 HTTPS 图片直链；也可在 images 中传工作区参考图，由已启用的阿里云 OSS 自动上传。本地图片在前、链接在后，合计最多 9 张。首尾帧模式通过 firstFrame、lastFrame 分别传工作区图片 { path, mimeType }；referenceImageInput 为 url 时也可传 { url } HTTPS 直链，本地帧图片经 OSS 上传。startEndRequired 要求两帧均提供，不混入 images、referenceImageUrls、音频或视频。referenceAudioInput 为 url 时，audios 中的工作区音频也通过 OSS 上传；上传的单个本地素材最多 20 MiB，图片与音频合计最多 300 MiB。未配置存储时请引导用户在设置中填写，禁止索取密钥。supportsSeed 为 true 时可传非负安全整数 seed（含 0），优先于供应商默认值，省略则使用供应商默认。按模型能力设置生成模式、时长、分辨率和音频。" },
      { name: "generateAudio", mediaType: "audio", enabled: permissions.allowAudio, label: "生成音频", parameters: audioGenerationSchema, description: "根据文本或提示词和可选的工作区参考图片和音频生成音频。按模型能力设置音色、语速、音量、语种、采样率和格式。" },
    ] as const).filter(operation => operation.enabled);
    if (!generationTools.length) return [];
    const listTool: ToolDefinition = {
      name: "listMediaModels",
      label: "查询媒体模型",
      description: "查询已允许生成的媒体模型，返回 providerId、modelId、类型、模式及支持的画幅、时长、分辨率或音色。生成前先查询，不能猜测模型 ID。",
      parameters: z.toJSONSchema(listMediaModelsSchema, { io: "input", target: "draft-07" }),
      async execute(_id, params, signal) {
        listMediaModelsSchema.parse(params);
        signal?.throwIfAborted();
        const result = (await media.listModels()).filter(model => generationTools.some(operation => operation.mediaType === model.type));
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    };
    const videoTaskTools: ToolDefinition[] = permissions.allowVideo ? [{
      name: "getVideoTask",
      label: "查询原视频任务",
      description: "查询工作区中指定输出目录的本地视频任务记录。使用生成失败信息里的 outputDirectory，旧版默认目录可省略；节点目录为 assets/节点ID。返回 operationId、阶段、原任务编号和结果；running 仅表示本地是否正在等待，不表示远端已取消。此操作不会提交或补发生成。",
      parameters: z.toJSONSchema(videoTaskSchema, { io: "input", target: "draft-07" }),
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        const { outputDirectory } = videoTaskSchema.parse(params);
        const task = await media.getVideoTask(outputDirectory);
        signal?.throwIfAborted();
        const result = { outputDirectory, task };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }, {
      name: "resumeVideoTask",
      label: "恢复原视频任务",
      description: "按 getVideoTask 返回的 operationId 和 outputDirectory 恢复原参数下的查询或下载，不新建视频。原任务仍在本地等待时返回状态；已完成时直接返回已有结果。提交回执未知且没有任务编号时无法自动恢复，须在视频专栏核查；其他独立创作可以继续。",
      parameters: z.toJSONSchema(resumeVideoTaskSchema, { io: "input", target: "draft-07" }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        const request = resumeVideoTaskSchema.parse(params);
        const target = await getTargetCanvas(signal);
        const task = await media.getVideoTask(request.outputDirectory);
        signal?.throwIfAborted();
        if (!task || task.operationId !== request.operationId) throw new Error("原视频任务不存在或已变化，请重新查询 getVideoTask");
        if (task.result) return mediaResult(task.result, target, signal);
        if (task.running) {
          const result = { status: "waiting", outputDirectory: request.outputDirectory, task };
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        }
        if (task.phase === "submitting" && !task.taskId) throw new Error("原视频提交回执尚未确认且没有任务编号，请在视频专栏核查；不会自动补发，其他独立创作可以继续");
        if (task.phase === "failed") throw new Error(task.error || "原视频任务已失败，无法恢复；如需重新生成请创建新任务");
        return mediaResult(await media.resumeVideoTask(request, signal), target, signal);
      },
    }] : [];
    return [listTool, ...videoTaskTools, ...generationTools.map<ToolDefinition>(operation => ({
      name: operation.name,
      label: operation.label,
      description: `${operation.description}providerId 和 modelId 必须来自 listMediaModels。引用素材的 path 及 outputDirectory 均为工作区相对路径；${operation.mediaType === "video" ? "省略输出目录会为本次视频任务隔离目录，旧任务不会阻塞新创作；中断后用 getVideoTask 查询、resumeVideoTask 恢复，不能反复提交同一生成。" : "省略输出目录使用默认媒体目录。"}等待生成完成后返回已保存的文件路径，不返回 Base64。${operation.mediaType === "audio" ? "" : "有目标画布时，成功结果自动加入任务开始时的画布；已有相同文件的节点会复用，无需另外创建。"}`,
      promptSnippet: "生成媒体前先查询 listMediaModels，复用实际模型和工作区参考素材。",
      parameters: z.toJSONSchema(operation.parameters, { io: "input", target: "draft-07" }),
      executionMode: "sequential",
      async execute(id, params, signal) {
        signal?.throwIfAborted();
        const request = operation.parameters.parse(params);
        const target = operation.mediaType === "audio" ? undefined : await getTargetCanvas(signal);
        if (operation.mediaType !== "video") return mediaResult(await media[operation.name](request, signal), target, signal);
        const operationId = "operationId" in request && request.operationId || await videoOperationId(id);
        const outputDirectory = request.outputDirectory ?? `assets/generated/video${operationId.replaceAll("-", "")}`;
        try {
          return mediaResult(await media.generateVideo({ ...request, operationId, outputDirectory }, signal), target, signal);
        } catch (error) {
          throw new Error(`${error instanceof Error ? error.message : String(error)}\n本次操作编号：${operationId}\noutputDirectory：${outputDirectory}\n先用 getVideoTask 查询此目录，有可恢复记录时使用 resumeVideoTask；勿重复提交本次生成。其他独立创作可以继续。`, { cause: error });
        }
      },
    }))];
  },
};

export default plugin;
