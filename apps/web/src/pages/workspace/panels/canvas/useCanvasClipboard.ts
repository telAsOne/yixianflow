import { nextTick, onBeforeUnmount, onMounted, provide, type Ref } from "vue";
import type { useVueFlow, XYPosition } from "@vue-flow/core";
import { ElMessage } from "element-plus";
import { useNodeEvent } from "@toonflow/nodes-scaffold/nodeEvent";
import type { NodeOutput } from "@toonflow/nodes-scaffold/values";
import { readClipboardFiles, readClipboardText, writeClipboardImage } from "@/lib/clipboard";
import { getShortcutBindings, shortcutLabel } from "@/lib/canvasShortcuts";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { generalSettings } from "@/stores/settings";
import { copyNodeToClipboard, copyNodesToClipboard, nodeClipboardCommand, readClipboardNodes } from "./nodeClipboard";
import { getClipboardMediaFiles, importCanvasFiles } from "./canvasDrop";
import { getSelectionTree } from "./selectionNodes";

const isDesktop = new URLSearchParams(window.location.search).get("desktop") === "1";

// 画布复制粘贴：节点快照、图片输出、剪贴板文件与文本，并注册文档级剪贴板事件。
export function useCanvasClipboard(flow: ReturnType<typeof useVueFlow>, options: {
  active: () => boolean;
  settingsVisible: () => boolean;
  canvasId: Ref<string>;
  directory: () => string | undefined;
  canvasElement: Ref<HTMLElement | undefined>;
  pointer: () => XYPosition | undefined;
  signal: () => AbortSignal;
  availableNodes: Ref<{ type: string; label: string }[]>;
  batchHistory: (action: () => Promise<void>) => Promise<void>;
}) {
  const { addNodes, addEdges, findNode, toObject, screenToFlowCoordinate } = flow;
  let copyingNodes = false;

  provide("copyNodeToClipboard", async (node: Parameters<typeof copyNodeToClipboard>[0]) => {
    const directory = options.directory();
    if (!directory) throw new Error("请先选择工作目录");
    if (await copyImageNodeToClipboard(directory, node)) return;
    await copyNodeToClipboard(node, directory);
  });

  function canUseCanvasClipboard(event: Event) {
    const target = event.target;
    return options.active() && !event.defaultPrevented && !options.settingsVisible() && !!options.canvasId.value && !!options.directory()
      && target instanceof Element
      && !target.closest("input, textarea, select, button, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='slider'], [role='dialog'], #agentPanel")
      && (target === document.body || target === document.documentElement || options.canvasElement.value?.contains(target));
  }

  function beforeClipboard(event: Event) {
    if (!canUseCanvasClipboard(event)) return;
    if (event.type === "beforecopy" && (!flow.getSelectedNodes.value.length || window.getSelection()?.toString())) return;
    // ACT: WKWebView 通过 beforecopy/beforepaste 判定非输入区能否使用原生编辑菜单。
    event.preventDefault();
  }

  function copyNode(event: ClipboardEvent) {
    if (!canUseCanvasClipboard(event) || !flow.getSelectedNodes.value.length || window.getSelection()?.toString()) return;
    event.preventDefault();
    void copySelectedNodes();
  }

  function imageOutput(data: { outputs?: Record<string, NodeOutput | undefined> } | undefined) {
    for (const output of Object.values(data?.outputs ?? {})) {
      if (output?.dataType !== "IMAGE" || !output.value || typeof output.value !== "object") continue;
      if (typeof output.value.url === "string" && output.value.url) return output.value;
    }
  }

  async function copyImageNodeToClipboard(directory: string, node: Parameters<typeof copyNodeToClipboard>[0]) {
    const output = imageOutput(node.data);
    if (!output) return false;
    const content = await useWorkspaceFiles(directory).read(output.url);
    await writeClipboardImage(new Blob([content], { type: output.mimeType || "image/png" }));
    return true;
  }

  async function copySelectedNodes() {
    const directory = options.directory();
    if (copyingNodes || !directory) return;
    const nodes = getSelectionTree(flow.getSelectedNodes.value, flow.getNodes.value);
    if (!nodes.length) return;
    const signal = options.signal();
    copyingNodes = true;
    try {
      if (nodes.length === 1 && await copyImageNodeToClipboard(directory, { data: nodes[0]!.data ?? {} })) {
        ElMessage.success("已复制图片");
        return;
      }
      const ids = new Set(nodes.map(node => node.id));
      const snapshot = toObject();
      const savedNodes = new Map(snapshot.nodes.map(node => [node.id, node]));
      const copies = await Promise.all(nodes.map(async node => {
        const patch = await useNodeEvent(node.id, flow).emit("copy");
        const saved = savedNodes.get(node.id)!;
        const parentNode = ids.has(saved.parentNode ?? "") ? saved.parentNode : undefined;
        return { ...saved, data: { ...saved.data, ...patch }, parentNode,
          ...(saved.parentNode && !parentNode ? { extent: undefined, expandParent: false } : {}),
          position: parentNode ? { ...saved.position } : { x: node.computedPosition.x, y: node.computedPosition.y } };
      }));
      signal.throwIfAborted();
      if (nodes.some(node => findNode(node.id) !== node)) throw new Error("节点已变化，请重新复制");
      const edges = snapshot.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target));
      await copyNodesToClipboard(copies, edges, directory);
    } catch (error) {
      if (!signal.aborted) ElMessage.error(error instanceof Error ? error.message : "节点复制失败");
    } finally {
      copyingNodes = false;
    }
  }

  async function pasteNode(event: ClipboardEvent) {
    if (!canUseCanvasClipboard(event)) return;
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (nodeClipboardCommand.test(text)) {
      event.preventDefault();
      await pasteNodeAtCenter(text);
      return;
    }
    const canvasSignal = options.signal();
    let files = getClipboardMediaFiles(event);
    if (files.length || text.trim()) event.preventDefault();
    // ACT: 部分 WebView 不向 paste 事件暴露剪贴板文件，桌面端回退到原生剪贴板读取。
    if (!files.length && isDesktop) files = await readClipboardFiles().catch(() => []);
    if (canvasSignal.aborted) return;
    if (!files.length && text.trim()) files = [new File([text], "粘贴文本.txt", { type: "text/plain" })];
    if (!files.length) return;
    event.preventDefault();
    const position = pastePosition();
    if (position) await importCanvasContent(files, position);
  }

  function pastePosition() {
    const rect = options.canvasElement.value?.getBoundingClientRect();
    if (!rect) return;
    const pointer = options.pointer();
    const point = pointer && pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top && pointer.y <= rect.bottom
      ? pointer
      : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    return screenToFlowCoordinate(point);
  }

  async function pasteNodeAtCenter(command?: string) {
    const position = pastePosition();
    if (position) await pasteClipboardNode(position, command);
  }

  async function importCanvasContent(files: File[], position: { x: number; y: number }) {
    const directory = options.directory();
    if (!directory) return false;
    const canvasSignal = options.signal();
    try {
      await options.batchHistory(() => importCanvasFiles(files, position, { directory, availableNodes: options.availableNodes.value, signal: canvasSignal, flow }));
      return true;
    } catch (error) {
      if (!canvasSignal.aborted) ElMessage.error(error instanceof Error ? error.message : "剪贴板内容导入失败");
      return false;
    }
  }

  async function pasteClipboardNode(position: { x: number; y: number }, command?: string) {
    const directory = options.directory();
    if (!options.active() || !options.canvasId.value || !directory) return false;
    const canvasSignal = options.signal();
    try {
      const text = command ?? (await readClipboardText());
      const snapshot = await readClipboardNodes(text, directory);
      if (canvasSignal.aborted) return false;
      if (snapshot) {
        if (snapshot.nodes.some(node => node.type !== "canvasGroup" && !options.availableNodes.value.some(item => item.type === node.type))) {
          throw new Error("请先安装并启用对应的节点插件");
        }
        const ids = new Map(snapshot.nodes.map(node => [node.id, crypto.randomUUID()]));
        const roots = snapshot.nodes.filter(node => !node.parentNode);
        const left = Math.min(...roots.map(node => node.position.x));
        const top = Math.min(...roots.map(node => node.position.y));
        await options.batchHistory(async () => {
          flow.removeSelectedElements();
          addNodes(snapshot.nodes.map(node => ({ ...node, id: ids.get(node.id)!, parentNode: ids.get(node.parentNode ?? ""), selected: true,
            position: node.parentNode ? node.position : { x: position.x + node.position.x - left, y: position.y + node.position.y - top } })));
          await nextTick();
          if (canvasSignal.aborted) return;
          addEdges(snapshot.edges.map(edge => ({ ...edge, id: crypto.randomUUID(), source: ids.get(edge.source)!, target: ids.get(edge.target)! })));
        });
        return true;
      }
      const files = await readClipboardFiles().catch((error): File[] => {
        if (text.trim()) return [];
        throw error;
      });
      if (canvasSignal.aborted) return false;
      if (!files.length && text.trim()) files.push(new File([text], "粘贴文本.txt", { type: "text/plain" }));
      if (!files.length) throw new Error("剪贴板中没有可粘贴的节点、文本、图片、视频或音频");
      return await importCanvasContent(files, position);
    } catch (error) {
      const pasteShortcut = generalSettings.value.canvasShortcuts.paste;
      const clipboardMessage = getShortcutBindings(pasteShortcut).some(binding => /^(Ctrl|Meta)\+KeyV$/.test(binding))
        ? `无法读取剪贴板，请在画布上按 ${shortcutLabel(pasteShortcut)} 粘贴`
        : "无法读取剪贴板，请允许浏览器访问剪贴板";
      if (!canvasSignal.aborted)
        ElMessage.error(
          error instanceof DOMException && error.name === "NotAllowedError" ? clipboardMessage : error instanceof Error ? error.message : "剪贴板内容粘贴失败"
        );
      return false;
    }
  }

  onMounted(() => {
    document.addEventListener("paste", pasteNode);
    document.addEventListener("copy", copyNode);
    document.addEventListener("beforecopy", beforeClipboard);
    document.addEventListener("beforepaste", beforeClipboard);
  });
  onBeforeUnmount(() => {
    document.removeEventListener("paste", pasteNode);
    document.removeEventListener("copy", copyNode);
    document.removeEventListener("beforecopy", beforeClipboard);
    document.removeEventListener("beforepaste", beforeClipboard);
  });

  return { copySelectedNodes, pasteNodeAtCenter, pasteClipboardNode };
}
