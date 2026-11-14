import type { BrowserMediaReader, BrowserMediaResult } from "@/utils/media/readTypes";
import type { AgentEvent } from "@/agent/runtime/types";
import { isWebMode, requireWebAccount } from "@/lib/webContext";
import { resolve } from "node:path";

type PendingMedia = { cwd: string; ownerId?: number; finish(result?: BrowserMediaResult, error?: string): void };
// ACT: 浏览器执行通道随当前聊天连接释放；进度和已落盘画面由媒体读取记录恢复。
const pendingMedia = new Map<string, PendingMedia>();

export function createBrowserMediaReader(cwd: string, send: (event: AgentEvent) => void) {
  cwd = resolve(cwd);
  const ownerId = isWebMode() ? requireWebAccount().user.id : undefined;
  const calls = new Set<string>();
  let disposed = false;
  const read: BrowserMediaReader = (request, signal) => new Promise((resolve, reject) => {
    if (disposed || signal?.aborted) return reject(signal?.reason ?? new Error("媒体读取对话已结束"));
    const callId = crypto.randomUUID();
    const finish = (result?: BrowserMediaResult, error?: string) => {
      if (!pendingMedia.delete(callId)) return;
      calls.delete(callId);
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(new Error(error));
      else if (result) resolve(result);
      else reject(new Error("网页没有返回媒体读取结果"));
    };
    const abort = () => finish(undefined, "媒体读取已取消，可从已有记录继续");
    // 单次网页解码等待，超时不改变可读取的视频总长和续读位置。
    const timer = setTimeout(() => finish(undefined, "网页媒体读取未及时返回，请保持页面打开后续读"), 180000);
    calls.add(callId);
    pendingMedia.set(callId, { cwd, ownerId, finish });
    signal?.addEventListener("abort", abort, { once: true });
    try { send({ type: "mediaCall", callId, request }); }
    catch (error) { finish(undefined, error instanceof Error ? error.message : "媒体读取请求发送失败"); }
  });
  return { read, dispose() { disposed = true; for (const id of calls) pendingMedia.get(id)?.finish(undefined, "媒体读取对话已结束"); } };
}

export function finishBrowserMediaRead(cwd: string, callId: string, response: { result?: BrowserMediaResult; error?: string }) {
  const pending = pendingMedia.get(callId);
  if (!pending) return;
  if (pending.cwd !== resolve(cwd) || pending.ownerId !== undefined && pending.ownerId !== requireWebAccount().user.id)
    throw Object.assign(new Error("媒体读取调用不属于当前对话"), { status: 403 });
  pending.finish(response.result, response.error);
}
