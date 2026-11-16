import { computed, ref, watch, type Ref } from "vue";
import { nodeTools, z } from "@toonflow/nodes-scaffold/nodeTools";
import { snapshotNodeOutputs, type NodeOutputs } from "@toonflow/nodes-scaffold/values";
import { useNode } from "@vue-flow/core";
import { useNodeEvent } from "@toonflow/nodes-scaffold/nodeEvent";

export type GenerationTiming = { startedAt: number; endedAt?: number; operationId?: string; status: "running" | "succeeded" | "failed" | "interrupted" };

export function useNodeGeneration(outputs: Readonly<Ref<NodeOutputs>>, cancel: () => void, cancelMessage = "生成已取消") {
  const { node } = useNode();
  const status = ref<"idle" | "running" | "succeeded" | "failed">("idle");
  const error = ref("");
  const observedTask = ref<GenerationTiming>();
  const generating = computed(() => status.value === "running");
  const nodeEvent = useNodeEvent();
  watch([status, error, observedTask], () => { void nodeEvent.emit("state"); });
  const getStatus = () => {
    const timing = node.data.generationTiming as GenerationTiming | undefined;
    const observed = observedTask.value?.operationId === timing?.operationId ? observedTask.value : undefined;
    const outputTask = node.data as { appliedVideoTaskId?: string; appliedImageTaskId?: string };
    return { status: generating.value ? "running" : observed?.status ?? (timing?.status === "running" ? "interrupted" : timing?.status) ?? status.value, outputs: snapshotNodeOutputs(outputs.value),
      operationId: timing?.operationId, startedAt: timing?.startedAt, endedAt: timing?.endedAt,
      outputOperationId: outputTask.appliedVideoTaskId ?? outputTask.appliedImageTaskId,
      ...(error.value ? { error: error.value } : {}) };
  };

  nodeTools.register({
    name: "getGenerationStatus",
    description: "查询真实生成状态（idle/running/succeeded/failed/interrupted）、持久化 operationId、时间、当前输出和最近错误；重新打开节点仍读取已保存的任务状态。输出可能来自旧任务，须核对 operationId 和当前文件。需要等待依赖时使用 waitForCanvas/waitCanvasNodes，避免模型反复轮询。",
    parameters: z.strictObject({}),
    execute: getStatus,
  });
  nodeTools.register({
    name: "cancelGeneration",
    description: "请求停止当前后台生成；cancellationRequested 表示已发出停止请求，随后用 getGenerationStatus 查询终止状态。不会删除已有输出，不能保证供应商撤销任务或费用",
    parameters: z.strictObject({}),
    execute() {
      const cancellationRequested = generating.value;
      if (cancellationRequested) cancel();
      return { ...getStatus(), cancellationRequested };
    },
  });

  function syncTask(task: { operationId: string; startedAt: number; endedAt?: number; phase: string; running: boolean }) {
    const previous = node.data.generationTiming as GenerationTiming | undefined;
    if (generating.value && previous?.operationId !== task.operationId) return;
    if (previous?.operationId !== task.operationId && previous && previous.startedAt > task.startedAt) return;
    const timing: GenerationTiming = { startedAt: task.startedAt, endedAt: task.endedAt, operationId: task.operationId,
      status: task.phase === "completed" ? "succeeded" : ["failed", "expired"].includes(task.phase) ? "failed" : task.running ? "running" : "interrupted" };
    observedTask.value = timing;
    if (JSON.stringify(previous) !== JSON.stringify(timing)) node.data.generationTiming = timing;
  }

  async function run<T>(task: () => Promise<T>, options: { startedAt?: number; operationId?: string } = {}): Promise<T> {
    if (generating.value) throw new Error("节点正在生成，请等待完成");
    status.value = "running";
    error.value = "";
    const previous = node.data.generationTiming as GenerationTiming | undefined;
    const timing: GenerationTiming = { startedAt: options.startedAt ?? (options.operationId && previous?.operationId === options.operationId ? previous.startedAt : Date.now()), operationId: options.operationId, status: "running" };
    node.data.generationTiming = timing;
    try {
      const result = await task();
      status.value = "succeeded";
      const current = node.data.generationTiming as GenerationTiming;
      node.data.generationTiming = { ...current, status: "succeeded", endedAt: current.endedAt ?? Date.now() };
      return result;
    } catch (failure) {
      status.value = "failed";
      const current = node.data.generationTiming as GenerationTiming;
      const httpStatus = (failure as { status?: number }).status;
      const rejected = httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && ![408, 409, 429].includes(httpStatus);
      if (!current.endedAt) node.data.generationTiming = options.operationId && !rejected || failure instanceof Error && failure.name === "AbortError"
        ? { ...current, status: "interrupted" } : { ...current, status: "failed", endedAt: Date.now() };
      const message = (failure as { response?: { data?: { message?: string } } })?.response?.data?.message;
      error.value = failure instanceof Error && failure.name === "AbortError" ? cancelMessage
        : message || (failure instanceof Error ? failure.message : "生成失败");
      throw failure;
    }
  }

  return { generating, run, syncTask };
}
