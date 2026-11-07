import { z } from "zod";
import { chainMethods, executeRemoteFfmpeg, queryMethods, runMethods } from "@toonflow/ffmpeg/remote";
import type { BrowserFfmpegRequest } from "@toonflow/ffmpeg";
import type { ToolPlugin } from "@toonflow/tools-scaffold/runtime";

const configSchema = z.strictObject({});
const probeSchema = z.strictObject({
  path: z.string().min(1).describe("工作区媒体相对路径，或选定本地助手电脑上的 Windows 绝对路径"),
  options: z.array(z.string()).optional().describe("允许的 ffprobe 探测选项；不接受额外输入、脚本或协议覆盖"),
});
const processSchema = z.strictObject({
  options: z.strictObject({
    source: z.string().optional(),
    cwd: z.string().optional(),
    niceness: z.number().optional(),
    priority: z.number().optional(),
    stdoutLines: z.number().optional(),
    timeout: z.number().optional(),
  }).optional().describe("原生 fluent 构造选项；不设置固定超时"),
  steps: z.array(z.strictObject({
    method: z.enum(chainMethods),
    args: z.array(z.json()),
    undefinedArgs: z.array(z.number().int().nonnegative()).optional().describe("需要传 undefined 的参数位置，其他参数保持原值"),
  })).default([]).describe("按 fluent-ffmpeg 顺序配置；支持本机 Windows 绝对路径与网页工作区相对路径"),
  operation: z.strictObject({
    method: z.enum([...runMethods, ...queryMethods]),
    args: z.array(z.json()),
    undefinedArgs: z.array(z.number().int().nonnegative()).optional(),
  }).default({ method: "run", args: [] }).describe("最后执行的方法，默认 run；也可 save、screenshots、concat 或查询编码器、格式、滤镜等"),
});

const plugin: ToolPlugin = {
  validateConfig: config => configSchema.parse(config),
  createTools(context) {
    async function execute(request: z.infer<typeof processSchema>, signal?: AbortSignal) {
      const input: BrowserFfmpegRequest = {
        directory: context.cwd, requestId: crypto.randomUUID(), options: request.options ?? {}, calls: request.steps, operation: request.operation,
      };
      const ffmpeg = await context.ffmpeg(signal);
      let details: unknown;
      let error: Error | undefined;
      let filenames: unknown;
      await executeRemoteFfmpeg(ffmpeg, input, event => {
        if (event.event === "error") {
          const failure = event.args[0] as { message?: string };
          error = Object.assign(new Error(failure.message ?? "FFmpeg 执行失败"), failure);
        } else if (event.event === "result") details = event.args[0];
        else if (event.event === "filenames") filenames = event.args[0];
        else if (event.event === "end") details = { stdout: event.args[0], stderr: event.args[1], ...(filenames ? { filenames } : {}) };
      }, signal ?? new AbortController().signal);
      signal?.throwIfAborted();
      if (error) throw error;
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    }

    return [{
      name: "ffprobe",
      label: "查询媒体信息",
      description: "通过选定的本地助手运行 FFprobe，读取本机路径或工作区媒体的格式、时长、尺寸、帧率和音轨等信息。Windows 绝对路径直接在本机读取，不先上传素材。",
      parameters: z.toJSONSchema(probeSchema, { io: "input", target: "draft-07" }),
      execute(_id, params, signal) {
        const { path, options } = probeSchema.parse(params);
        return execute({ steps: [{ method: "input", args: [path] }], operation: { method: "ffprobe", args: options ? [options] : [] } }, signal);
      },
    }, {
      name: "ffmpeg",
      label: "处理媒体",
      description: "通过选定本地助手的 fluent-ffmpeg 处理本机或网页工作区媒体。steps 按顺序传入链式方法和 args，支持剪辑、字幕滤镜、多输入、多输出、图片序列及 concat 清单无损拼接。Windows 绝对输入路径直接读取本机文件，绝对输出路径保存到本机；相对路径使用网页工作区并自动传输素材和结果。options.cwd 为本机绝对目录时，整条命令直接在该本机目录运行，清单及滤镜按当前 Windows 用户权限读取文件。operation 默认 run，也支持 save、screenshots、concat 和能力查询；concat/mergeToFile 会重新编码。输出使用新文件名。",
      promptSnippet: "使用 ffmpeg 处理本地媒体，ffprobe 查询媒体信息；按用户要求选择输出位置。",
      promptGuidelines: [
        "Windows 绝对输入路径直接读取选定电脑的文件，Windows 绝对输出路径保存到本机；相对路径使用当前网页工作区并自动下载素材、上传输出。options.cwd 使用本机 Windows 绝对目录时，整条命令都在该本机目录执行，相对输入和输出也留在本机。",
        '截帧示例：{"steps":[{"method":"input","args":["assets/input.mp4"]},{"method":"seekInput","args":[1]},{"method":"frames","args":[1]},{"method":"output","args":["assets/frame.png"]}]}。',
        '无损拼接：先写 concat 清单，每行 file 后跟单引号包裹的文件名，路径相对清单所在目录；再调用 input(清单路径)、inputFormat("concat")、inputOptions(["-safe", "0"])、outputOptions(["-map", "0", "-c", "copy"])，最后 save(输出路径)。也支持 inputOptions(["-f", "concat", "-safe", "0"])。源文件的流布局和编码参数须兼容；失败时报告原因，不改用 concat/mergeToFile 或滤镜重新编码。',
        'inputOptions/outputOptions 仅使用允许的编解码、质量、时长、映射和探测选项。含空格的元数据使用 args:["-metadata","title=a b"]。先用 operation={"method":"availableEncoders","args":[]} 等查询实际能力；查询结果不代表工具允许所有原生选项和滤镜。',
        '工作区字幕示例：{"method":"videoFilters","args":[[{"filter":"subtitles","options":{"filename":"assets/captions.srt"}}]]}。文件参数不得包含协议、上级目录、引号或转义符；复杂表达式及不在允许列表中的滤镜会被拒绝。',
        "输出使用新文件名，不覆盖已有文件。本机路径按当前 Windows 用户权限读取；工作区素材由宿主处理下载和结果回传。",
      ],
      parameters: z.toJSONSchema(processSchema, { io: "input", target: "draft-07" }),
      executionMode: "sequential",
      execute(_id, params, signal) {
        return execute(processSchema.parse(params), signal);
      },
    }];
  },
};

export default plugin;
