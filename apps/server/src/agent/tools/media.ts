import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BrowserMediaReader } from "@/utils/media/readTypes";
import { mediaReadSchema, readMedia } from "@/utils/media/read";

export function createMediaReadTool(cwd: string, browser?: BrowserMediaReader): ToolDefinition {
  return {
    name: "readMedia", label: "读取视频和声音证据",
    description: "读取视频节点、附件的工作区路径，或选定本机的 Windows 绝对路径。info 查询媒体；frames 返回带原片时间的实际图片，times 精确指定位置，或 start/end 加 interval/fps 连续取样；cursor 原样续读，按传输预算分页，不限制视频总长或总帧数。detect 查 scene/black/freeze/silence 候选位置；audio 提取片段；transcribe 启动本地转写、transcript 查询并读取结果；history 恢复读取进度；note 保存有证据的审查观察。执行优先本地助手，工作区视频可用网页解码补位。",
    promptSnippet: "用 readMedia 真正查看视频画面并按需加密、裁剪、续读；长视频保存证据和观察后继续读取。",
    promptGuidelines: [
      "视频节点和附件的路径不是画面。需要判断时调用 readMedia；按用户问题自主选择范围、间隔、尺寸和裁剪，不要求用户手工截帧。快速动作可提高 fps 或逐帧取样，细节可 maxEdge=0 保留原尺寸。",
      "frames 返回的是采样图像；读完一页后按 cursor 继续，不能把抽样或本地扫描称为已看完全片。原片时间由 seconds 给出，browserSeek 表示网页定位而非精确帧时间。",
      "按需要组合 info、frames、detect、audio 和转写；检测只定位候选异常，不自动判定创作质量。发现疑点可直接回看或裁剪，无需遵循固定审片步骤。",
      "读取记录只证明证据已返回，note 用于保存自己的观察与 evidenceIds。未提供图片、原声或相应音频理解能力的项目不能宣称通过；转写不证明音色、说话人或口型同步，audio 返回文件不表示已经听过。",
      "本机绝对路径在当前选定电脑读取；工作区路径使用本轮项目。源视频版本改变后旧 cursor 失效，使用 history 查看原记录并重新读取。",
    ],
    parameters: mediaReadSchema.toJSONSchema({ io: "input", target: "draft-07" }),
    executionMode: "sequential",
    execute(_id, params, signal, onUpdate) { return readMedia(cwd, mediaReadSchema.parse(params), browser, signal, onUpdate); },
  };
}
