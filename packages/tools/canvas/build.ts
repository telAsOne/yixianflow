import { createToolConfig } from "@toonflow/tools-scaffold";

await createToolConfig({
  name: "canvas",
  displayName: "画布操作",
  description: "新增、切换、重命名和自动整理画布，操作节点、连线和视口，并调用节点注册的函数。",
  author: "Toonflow",
  github: "https://github.com/HBAI-Ltd/Toonflow-app",
  prompt: `getCanvas 默认只读画布概览，按需用 include 查询画布列表或可用节点类型。findCanvasNodes 按名称、ID、类型或选择状态定位节点；已知 ID 时直接用 getCanvasNodes 读取必要字段，用 getCanvasEdges 查询局部连线，用 getNodeTools 查询目标节点函数。用户可能同时编辑画布，状态变化后重新查询，不把旧快照当作当前状态。
所有读取都有条数和体积上限，检查 hasMore/nextCursor 与截断信息；空列表但 hasMore 为 true 仍需继续扫描。继续分页时保留原查询参数，只替换 cursor，游标失效时重新查询。全图任务逐批完成，只保留进度摘要和游标，不将全部节点详情累积到上下文。
使用实际提供的画布操作工具修改画布，不直接写入画布 JSON 代替界面操作。新建或切换画布后，后续操作针对返回的新画布。
节点业务参数和执行行为通过已注册的 nodeTools 操作；nodeId、node:functionName 和参数结构以 getNodeTools 返回值为准，args 根据用户任务填写，不能猜测未注册的函数或字段。
连线前核对输出端口、输入端口及类型兼容性；节点位置使用画布坐标，合理留出内容和连线空间。已有节点能够复用时不要重复创建。
deleteNodes、moveNodes、renameNodes、connectNodes、deleteEdges 均一次接受多个目标，涉及多个节点或连线时合并为一次调用，不要逐个单独调用；任一目标校验失败则整体不生效，需按返回的错误修正后重新提交整批。
每次操作等待返回回执，用 getCanvasNodes/getCanvasEdges 只核对受影响节点、连接和业务输出；节点函数不存在或画布离线时说明具体问题。
媒体节点返回 generating/running 只表示后台生成已启动。默认继续完成已授权且不依赖该结果的工作，然后简短告知生成中的节点并结束本轮，让用户在同一对话继续安排其他任务；即使存在状态工具，也不循环调用 getGenerationStatus、getCanvasNodes、getConfig 或读取文件等待生成完成。用户查询进度时按需查询一次；只有明确要求等待结果时才按实际工具能力等待。依赖未完成结果的后续工作记为待办，不能使用旧输出或重复提交生成；结果在原节点更新，不承诺自动唤醒对话或完成通知。`,
  configRules: [],
  components: Object.fromEntries([
    "addNode", "addMediaNodes", "moveNodes", "renameNodes", "nodeTools", "connectNodes",
    "deleteEdges", "selectNodes", "arrangeCanvas", "fitCanvas",
  ].map(name => [name, "src/nodeFocusCard.vue"])),
}, import.meta.url);
