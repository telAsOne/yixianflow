import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { localComputerRequest, localComputerParameters, localComputerDescription, localComputerGuidelines } from "@toonflow/local-helper/protocol";
import { callDevice, getSelectedDevice } from "./index";

export async function createLocalComputerTools(): Promise<ToolDefinition[]> {
  const device = await getSelectedDevice();
  if (!device) return [];
  return [{
    name: "localComputer", label: "操作本地电脑",
    description: `操作用户显式选择的 Windows 电脑 ${JSON.stringify(device.name)}。${localComputerDescription}`,
    promptSnippet: "用户的本机文件、程序、命令和软件安装使用 localComputer。",
    promptGuidelines: [
      ...localComputerGuidelines,
      "服务器工作区文件使用原工作区工具；只有用户明确要求在本机和网页项目之间传输时，才使用 upload/download。",
      "软件安装优先 install，先确认准确包名。不能规避本机确认或权限边界。网页断开会取消本机调用，只按工具实际结果报告成功。",
    ],
    parameters: localComputerParameters,
    executionMode: "sequential",
    async execute(_id, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: `等待本地电脑 ${device.name} 执行；需要确认时请查看 Windows 托盘。` }], details: {} });
      const details = await callDevice(device, localComputerRequest.parse(params), signal);
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  }];
}
