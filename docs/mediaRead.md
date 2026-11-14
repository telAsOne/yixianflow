# 网页 AI 视频读取

网页聊天内置 `readMedia`，将视频节点和附件作为可读取引用。画面以真正的图像内容返回模型，同时携带来源版本、原片时间、证据 ID 和文件路径。视频附件不会在每轮聊天中重复传入整片；文字节点显式视频参考保留原供应商接口。

## 执行位置

- 网页版优先通过已选择的本地助手执行 FFmpeg/FFprobe。本机 Windows 绝对路径直接在选定电脑读取。
- 当前桌面 Windows 运行环境可以复用本机 FFmpeg；程序仍按当前用户权限访问文件。
- 项目视频在助手未连接或素材超过现有助手传输预算时，可经发起聊天的网页解码，不将大文件整体塞入模型。
- `engine` 可指定 `auto`、`local` 或 `browser`。网页当前支持探测视频和读取画面，声音与信号扫描使用本地工具；不支持的浏览器格式会明确报错。

## 工具操作

| action | 用途 |
| --- | --- |
| `info` | 实际时长、画面时长、尺寸、帧率、音轨及流信息 |
| `frames` | 按 `times` 或 `start/end` 加 `interval/fps` 读取图片；可裁剪、调整 `maxEdge`，0 保留尺寸 |
| `detect` | 按 `detection=scene/black/freeze/silence` 查找候选变化时间 |
| `audio` | 提取指定区间 PCM 音轨，默认保留采样率和声道，可指定 `sampleRate/channels` |
| `transcribe` | 提取转写用音频并提交既有本地字幕任务，返回 operationId |
| `transcript` | 查询 operationId，成功时将字幕时间还原到原片时间轴 |
| `history` | 查询已解码/已返回证据、观察和续读位置；可指定旧版 recordId |
| `note` | 引用本版本已经返回的 evidenceIds 保存 observation |

连续读取示例：

```json
{"path":"assets/input.mp4","action":"frames","start":12,"end":18,"fps":12,"maxEdge":960}
```

后续调用携带相同 path 和原样 cursor；单次默认返回 8 帧，沿用现有助手每批 20 文件的传输能力，后续页数与总采样数没有业务上限。`pageSize/maxBytes` 控制本次请求预算，实际达到预算后给出新 cursor。请求时间与实际解码时间分别保留。`history/transcript` 列表使用返回的 `nextOffset` 作为下次 `offset`；信号扫描以可调整的 `windowSeconds` 分段并返回 cursor。

读取进度、图片和观察保存在当前用户在该项目的 `.agent/mediaReads`，跨会话和服务重启保留。源文件版本改变后旧 cursor 被拒绝。上下文接近预算时，本次模型请求可以省略较早的 readMedia 图片，保留时间、路径、文字证据与完整会话；需要比较时可重新读取。

## 证据含义

- `decodedFrame` 使用实际解码帧时间；`browserSeek` 只承诺网页播放定位。
- 本地扫描、工具返回图像、Agent 保存观察分别记录。抽样不等于检查中间全部运动。
- audio 返回文件不表示文字/视觉模型听过声音。ASR 不认证说话人、音色、音效含义或口型同步。
- 网页执行随当前聊天取消而释放，已有记录可续读；本地字幕沿用既有后台任务与显式取消机制。
- 逐帧取样仍通过视觉图像输入，不能据此宣称任意模型具备原生连续视频或原声理解。
