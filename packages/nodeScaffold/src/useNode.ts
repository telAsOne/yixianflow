import { computed, getCurrentInstance, inject, readonly, ref, type Component, type Ref } from "vue";
import { useNode as useFlowNode, useVueFlow } from "@vue-flow/core";
import { isTypeCompatible, type NodeData, type NodeHandle } from "./connection";
import { isNodeOutput, type NodeOutputs } from "./values";
import { useNodeEvent } from "./nodeEvent";
import { nodeTools } from "./nodeTools";
import { useNodeFiles } from "./workspaceFiles";
import { useNodeAi } from "./nodeAi";
import { useNodeFfmpeg } from "./nodeFfmpeg";
import { useNodePreviewReady } from "./useNodePreviewReady";
import type { NodeDocumentContext } from "./nodeDocument";

export type NodeOptions<T extends NodeOutputs = NodeOutputs> = {
  label?: string;
  icon?: Component;
  handles?: NodeHandle[];
  outputs?: T;
};

export function useNode<T extends NodeOutputs = NodeOutputs>(options: NodeOptions<T> = {}) {
  const { id, node } = useFlowNode<NodeData>();
  const documentContext = inject<NodeDocumentContext | undefined>("nodeDocument", undefined);
  const getNodeConfig = inject<((nodeType: string) => Record<string, unknown>) | undefined>("nodeConfig", undefined);
  const config = computed(() => readonly(getNodeConfig?.(node.type ?? "") ?? {}));
  const retainPreview = ref(false);
  const previewReady = useNodePreviewReady(retainPreview);
  const canvasOverview = inject<Readonly<Ref<boolean>>>("canvasOverview", ref(false));
  const previewDetailed = computed(() => !canvasOverview.value || node.selected || retainPreview.value || !!documentContext?.targets.has(id));
  const canvasCompactOverview = inject<Readonly<Ref<boolean>> | undefined>("canvasCompactOverview", undefined);
  const compactPreview = computed(() => !!canvasCompactOverview?.value && !previewDetailed.value);
  const { updateNodeInternals } = useVueFlow();
  const defaults = getCurrentInstance()?.type as Pick<NodeOptions, "handles" | "icon"> | undefined;
  const handles = ref<NodeHandle[]>(options.handles ?? structuredClone(defaults?.handles ?? []));
  const savedOutputs = Object.fromEntries(Object.entries(node.data.outputs ?? {}).filter(([handleId, output]) => {
    const handle = handles.value.find(item => item.type === "source" && item.id === handleId);
    const defaultOutput = options.outputs?.[handleId];
    return handle && isNodeOutput(output) && isTypeCompatible(output.dataType, handle.dataType)
      && (!defaultOutput || defaultOutput.dataType === output.dataType);
  }));
  const outputs = ref({ ...options.outputs, ...savedOutputs }) as Ref<T>;
  const nodeProps = computed(() => ({
    previewReady: previewReady.value,
    previewDetailed: previewDetailed.value,
    compactPreview: compactPreview.value,
    label: node.data.label ?? options.label,
    icon: options.icon ?? defaults?.icon,
    handles: handles.value,
    outputs: outputs.value,
  }));
  const nodeEvent = useNodeEvent();
  const { getWorkspaceFiles, getWorkspaceDirectory, uploadFile, removeNodeFiles, useFileUrl, useMediaInfo } = useNodeFiles();

  return {
    id,
    node,
    config,
    previewReady,
    retainPreview,
    compactPreview,
    nodeProps,
    handles,
    outputs,
    nodeEvent,
    nodeTools,
    ai: useNodeAi(),
    ffmpeg: useNodeFfmpeg(),
    files: {
      getWorkspaceFiles,
      getWorkspaceDirectory,
      useFileUrl,
      useMediaInfo,
      uploadFile: (file: File) => uploadFile(id, file),
      removeNodeFiles: () => removeNodeFiles(id),
    },
    updateNodeInternals: () => {
      if (!documentContext?.targets.has(id)) updateNodeInternals([id]);
    },
  };
}
