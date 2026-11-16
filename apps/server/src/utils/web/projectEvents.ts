import { EventEmitter } from "node:events";
import type { ProjectEvent } from "@/types/collaboration";

// ACT: 与画布文件锁共用单进程部署；多副本时需同时迁移锁与房间事件，不能只横向扩容 HTTP。
const events = new EventEmitter();
events.setMaxListeners(256);

export function publishProjectEvent(id: string, event: ProjectEvent) {
  events.emit(id, event);
}

export function subscribeProject(id: string, receive: (event: ProjectEvent) => void) {
  events.on(id, receive);
  return () => events.off(id, receive);
}
