# 画布 MCP

在 UnionFlow 网页的「设置 → MCP」开启画布 MCP，选择项目、连接名称和读取或编辑权限，生成连接配置。将显示的 JSON 配置添加到自己的 Agent 的 MCP 设置中。

凭证只显示一次，绑定创建者和一个项目，30 天有效；服务端只保存凭证哈希。在「已授权连接」中可以撤销凭证，关闭 MCP 会停止该账户的全部 MCP 调用。项目成员权限被移除或降为只读后，原凭证不能继续执行越权操作。

创建编辑凭证时可分别勾选图片生成、视频生成、智能整理、内置 Agent 委托、本机工具。旧凭证的权限保持不变；使用新增能力需要生成并勾选相应权限的新凭证。未勾选的工具不会开放，委托内置 Agent 也继承相同的项目与能力范围。

生成、整理和内置 Agent 按当前账户正常计费。本机工具必须额外选择自己已配对的设备，设备在线且已授权后沿用本地助手的逐项确认或用户已开启的自动执行设置。Key 不授予其他项目、其他成员的对话或其他人员的设备权限。撤销或关闭 Key 同时停止等待中的本机请求；已经提交的生成或已完成的电脑操作不会自动撤销。

每个 Key 每分钟最多 120 次 MCP 请求、同时执行 2 个操作、保留 4 个 MCP 会话；同一画布页面同时只执行一个控制命令。超过请求频率返回 HTTP 429 和 `Retry-After`，客户端应按该时间退避，不连续重试。

生成、整理、Agent 委托和本机调用另限每分钟 12 次，并须在请求顶层提供唯一 UUID `requestId`。超时或重试必须沿用原值；相同编号返回原结果或执行状态，不会重复发起。编号相同而参数不同会被拒绝。服务器中断后状态无法确认的操作需先核查原任务，不自动重放。

## 使用步骤

1. 登录网站，打开已授权项目的画布，并保持网页打开。
2. Agent 调用 `getAppState`，获取项目 ID、`connectionId` 和当前 `canvasId`。
3. 调用 `getCanvas` 获取节点类型，使用 `findCanvasNodes`、`getCanvasNodes`、`getCanvasEdges` 按需读取。
4. 使用 `addNode`、`moveNodes`、`connectNodes` 等工具编辑节点。先调用 `getNodeTools` 查询实际函数参数，再通过 `nodeTools` 写文本、提示词、参数或选择已有素材。
5. 使用 `workspaceFiles` 上传素材，得到相对路径后调用 `addMediaNodes` 或对应节点函数，把素材放到画布。

除 `getAppState` 使用 `{}` 外，业务工具参数为：

```json
{
  "target": {
    "connectionId": "getAppState 返回的页面连接 ID",
    "directory": "已授权项目 ID",
    "canvasId": "当前画布文件名"
  },
  "args": {}
}
```

`target` 可省略；同一项目打开多个页面时必须指定 `connectionId`。切换画布后重新调用 `getAppState` 更新目标，避免把旧命令发到新画布。只有创建凭证的账户自己打开的页面可作为目标。

## 内容和素材传输

`workspaceFiles` 支持 `list`、`readText`、`readBinary`、`writeText`、`writeBinary`。所有路径均为项目内相对路径，上传只允许新建 `assets/mcp/` 下的文件，不覆盖同名文件。二进制使用 Base64，单文件解码后最多 20 MiB。超过限制的素材需先通过网页上传。

例如，传入一份文稿：

```json
{
  "args": {
    "action": "writeText",
    "path": "assets/mcp/分镜稿.md",
    "text": "第一镜：清晨的街道……"
  }
}
```

文件上传和读取可以在画布页面关闭时使用；节点操作需要页面保持连接。文本节点通过 `node:setText` 写入，沿用画布的保存和文件冲突处理。

## 扩展工具

- `generateImage`、`generateVideo`：先调用 `listMediaModels` 查询实际模型，再提交提示词及工作区参考素材；图片和视频生成结果自动加入目标画布。节点内生成仍先查询 `getNodeTools`，再调用对应 `node:generateImage` 等函数。
- `getVideoTask`、`resumeVideoTask`：核对和恢复原视频任务，不重新提交已经受理的生成。
- `arrangeCanvas`：打开智能整理窗口，沿用画布的人工确认流程。
- `listAgentModels`、`runAgent`：先查询文本模型，再指定 `providerId`、`modelId`、`prompt` 委托任务；返回回复和个人对话文件。委托不扩大 Key 权限，也不会继续已有私人对话。
- `localComputer`：按当前 Windows 用户权限使用授权设备上的本机文件、程序、PowerShell、安装及传输能力，沿用托盘确认或本次运行已开启的自动执行设置；工具内的项目上传下载只能指向当前项目，不覆盖已有文件。
- `ffprobe`、`ffmpeg`：授权 `localComputer` 并选择已绑定设备后，可查询实际音轨，执行音轨提取、音频截取、变速、音量调整、拼接、混音及给视频配入已有音频。复用账户已启用的 FFmpeg 工具和设备上的执行程序；页面关闭时也可处理文件。调用须提供顶层 UUID `requestId`，重试沿用原值。项目路径仍限制在当前项目的公开文件内；处理结果通过 `addMediaNodes` 添加为音频或视频节点，已有同文件节点会复用。

例如，已授权图片生成的凭证可调用 `generateImage`：

```json
{
  "requestId": "为本次操作生成的 UUID",
  "target": { "connectionId": "页面连接 ID", "canvasId": "当前画布文件名" },
  "args": {
    "providerId": "listMediaModels 返回的 providerId",
    "modelId": "listMediaModels 返回的 modelId",
    "prompt": "清晨的街道"
  }
}
```

音频支持上传、传输、选择已有文件以及上述处理，不提供独立的音频生成或音色选择。FFmpeg 处理已有音频，不会凭空合成提示词里的键鼠声或音乐。插件管理和服务器终端未开放；本机终端只在明确授权本机工具后通过所选设备执行。

视频声音先读取 `node:getConfig` 返回的 `audio`。`optional` 才可通过 `generateAudio` 切换；`native` 表示由模型原生合成声音，保留提示词里的声音设计，不发送独立开关。H3 旧配置中的 `generateAudio=false` 不代表静音。`unknown` 表示模型未加载、未选择或未声明声音能力，不能据此认定提示词有冲突。没有可用模型时先处理模型可用性；审查是辅助功能，不阻止正常生成。实际结果须通过 FFprobe 查询音轨并播放核对，存在音轨不等于具体音效通过验收。

桌面版现有 HTTP 和 stdio MCP 配置入口继续在「设置 → MCP」提供。
