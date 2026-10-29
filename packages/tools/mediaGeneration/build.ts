import { createToolConfig } from "@toonflow/tools-scaffold";

await createToolConfig({
  name: "mediaGeneration",
  displayName: "媒体生成",
  description: "查询已配置的媒体模型，生成图片、视频或音频并保存到工作区。",
  author: "Toonflow",
  github: "https://github.com/HBAI-Ltd/Toonflow-app",
  prompt: `生成前使用可用的 listMediaModels 查询模型，providerId、modelId、模式、画幅、分辨率、时长和音频能力以返回值为准，不根据模型名称猜测。
参考输入以模型能力为准：referenceImageInput 为 url 的视频模型可使用 referenceImageUrls 中公开可访问的 HTTPS 图片直链，或在 images 中传已存在的工作区参考图，由「设置 → 素材存储」中已启用的阿里云 OSS 自动上传。本地图片在前、链接在后，合计最多 9 张；不能把本机路径填入 referenceImageUrls。未配置存储时引导用户在应用设置中填写，不索取密钥。其他参考图片、视频、音频及首尾帧使用已存在的工作区相对路径，并确认所选模型支持相应输入。附件消息只提供文件信息，不表示模型已经看过图片或播放过视频。
本轮具备画布节点工具且用户要求在节点内制作时，优先使用该节点已经注册的生成函数，让结果保留在对应节点；独立素材制作使用本轮可用的媒体生成工具。
独立视频生成省略 outputDirectory 时会隔离任务。生成中断或失败后先用 getVideoTask 查询返回的输出目录，恢复时使用记录中的 operationId 调用 resumeVideoTask，不要反复 generateVideo；旧版未指定目录的任务可省略目录查询。running 只表示本地正在等待，不能据此断言远端已取消。提交回执未知且没有任务编号时须在视频专栏核查，不能自动补发。旧任务不应阻塞其他创作；用户需要新创作时使用新节点或独立任务，节点支持 createNewGeneration 时可复制配置和参考连线继续，不自动生成或删除旧任务，不编造取消或恢复入口。
只生成用户要求的数量与范围，优先复用已有结果；失败后先处理原因，避免重复消耗算力。等待工具返回已保存的文件路径后再交付，不编造文件或用 Base64 代替产物链接。注意除非用户明确要求让Agent生成，否则统一在画布中处理`,
  configRules: [
    { type: "switch", field: "allowImage", title: "允许 AI 生成图片", value: true, props: { "aria-label": "允许 AI 生成图片" } },
    { type: "switch", field: "allowVideo", title: "允许 AI 生成视频", value: true, props: { "aria-label": "允许 AI 生成视频" } },
    { type: "switch", field: "allowAudio", title: "允许 AI 生成音频", value: true, props: { "aria-label": "允许 AI 生成音频" } },
  ],
}, import.meta.url);
