# FFmpeg 媒体处理

为 Agent 提供 `ffmpeg` 和 `ffprobe`，直接连接 `context.ffmpeg()`，复用插件市场配置的执行程序及节点已有的调用桥接。

内置 AI、桌面 MCP 和已授权本机工具的网页 MCP 共用这套能力。可处理已有音频：提取视频音轨、截取、变速、调音量、拼接、混音，以及将已有音频配入视频；工作区结果可通过 `addMediaNodes` 加到画布。网页 MCP 使用 Key 绑定的设备，项目文件仍受项目和内部目录边界限制；每次本机操作提供唯一 `requestId`，重试沿用原值。

检查生成视频的声音时，先用 `node:getConfig` 确认模型的 `audio` 能力。`native` 没有独立声音开关，声音设计留在提示词中；不能把旧 `generateAudio=false` 当成静音。生成后可用 `ffprobe` 查看实际音轨，但有音轨不等于有可听声音或所需音效。FFmpeg 处理已有文件，不代替音效生成或试听验收。

## 调用方式

`ffprobe` 接收文件路径和可选的原生参数：

```json
{ "path": "assets/input.mp4", "options": ["-count_frames"] }
```

`ffmpeg` 的 `steps` 按顺序调用 fluent 方法，`operation` 指定最后执行的方法，省略时使用 `run()`。例如输出图片序列：

```json
{
  "steps": [
    { "method": "input", "args": ["assets/input.mp4"] },
    { "method": "fps", "args": [1] },
    { "method": "output", "args": ["assets/frame%03d.png"] }
  ]
}
```

也可使用 `operation: { "method": "save", "args": ["assets/output.mp4"] }`，或者原生的 `screenshots`、`concat` 等操作。查询可用编码器、编解码器、格式、滤镜时，省略 `steps`，将 `operation.method` 设为 `availableEncoders`、`availableCodecs`、`availableFormats` 或 `availableFilters`。

### 无损拼接

`concat`、`concatenate`、`mergeToFile` 是 fluent 的滤镜拼接，会重新编码。需要无损拼接时，先创建工作区清单，例如 `assets/concat.txt`：

```text
ffconcat version 1.0
file 'first.mp4'
file 'second.mp4'
```

文件路径相对清单所在目录，支持单引号和反斜杠转义；Windows 路径建议使用 `/`。清单只接受 `file`、`duration`、`inpoint`、`outpoint`、版本声明、空行和注释，清单及引用文件均须通过工作区路径校验。

```json
{
  "steps": [
    { "method": "input", "args": ["assets/concat.txt"] },
    { "method": "inputFormat", "args": ["concat"] },
    { "method": "inputOptions", "args": [["-safe", "0"]] },
    { "method": "outputOptions", "args": [["-map", "0", "-c", "copy"]] }
  ],
  "operation": { "method": "save", "args": ["assets/merged.mp4"] }
}
```

也可用 `inputOptions(["-f", "concat", "-safe", "0"])` 指定清单格式；`ffprobe` 的同名选项同样会校验清单。`-c copy` 直接复制压缩数据，源文件的流布局、编码参数和时间基准须兼容；不兼容时报告错误，不自动改用重新编码。

`options` 对应宿主支持的 fluent 构造选项：`source`、`cwd`、`niceness`、`priority`、`stdoutLines`、`timeout`。`steps` 沿用宿主的配置方法和别名；参数须通过下述允许列表与路径校验，`undefinedArgs` 可指定要传入 `undefined` 的位置。

## 原生能力与执行

- 原始参数只允许常用编解码、质量、时长、映射与探测选项；额外输入、脚本、日志文件、协议覆盖和不明选项会拒绝。所有输入追加 `-protocol_whitelist file,pipe`。
- 支持工作区内的图片序列、多输入多输出、concat 清单无损拼接及常用裁剪、转码。禁止显式指定 HLS/DASH/SDP 清单格式及 lavfi 输入格式；不开放 `concat:` 等协议路径。
- 不重定向到临时文件，不强制设置执行时长。输出目录按原生要求准备，已有文件的覆盖遵循 FFmpeg 原生规则；未要求覆盖时应使用新文件名。
- 保留宿主已有的显式工作区路径检查、缺少 FFmpeg 时的安装提示、错误传播和转换取消。取消或失败可能留下原生处理产生的部分文件，工具不自动删除素材。

此工具传递 JSON 调用数据，不接收 JavaScript、回调或 Node 流；可执行文件由插件市场配置。工具校验显式路径和允许的滤镜参数；媒体容器自身的间接文件引用仍不是文件系统沙箱。配对设备的 JSON 桥接不接受原始参数或滤镜，宿主自身的 FFmpeg 工厂保持原能力。FFprobe 和能力查询的原生接口不暴露子进程，取消会停止等待，底层查询自行退出。

带文件的滤镜使用结构化参数，例如 `videoFilters([{ filter: "subtitles", options: { filename: "assets/captions.srt" } }])`。文件名必须为工作区内的相对路径，不包含协议、上级目录、引号或转义符。复杂表达式和未列入允许列表的滤镜会明确报错，不会跳过后继续执行。
