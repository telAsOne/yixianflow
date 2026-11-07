import type { CanvasElement } from "./canvasMerge";

export type RecycleEntry = {
  id: string;
  kind: "nodes" | "canvas";
  canvasPath: string;
  label: string;
  deletedAt: number;
  expiresAt: number;
  nodeCount: number;
  assetBytes: number;
  reclaimableBytes: number;
  preview?: { path: string; mimeType: string };
  error?: string;
};

export type RecycleOverview = {
  entries: RecycleEntry[];
  retentionDays: number;
  assetBytes: number;
  reclaimableBytes: number;
  orphanBytes: number;
  orphanCount: number;
  pendingCleanupCount: number;
  cleanupErrors: string[];
};

export function recycleAssetRoots(value: unknown) {
  const roots = new Set<string>();
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string") {
      for (const match of item.replaceAll("\\", "/").replace(/\/+/g, "/").matchAll(/\bassets\/([^/\s"'<>?#{}]+)(?:\/|$)/g)) roots.add(`assets/${match[1]}`);
    } else if (item && typeof item === "object" && !visited.has(item)) {
      visited.add(item);
      if (Array.isArray(item)) pending.push(...item);
      else for (const child of Object.values(item)) pending.push(child);
    }
  }
  return roots;
}

export function recycleNodeRoots(nodes: CanvasElement[]) {
  const roots = recycleAssetRoots(nodes.map(node => node.data));
  for (const node of nodes) if (/^[\p{L}\p{N}_-][\p{L}\p{N}._-]{0,499}$/u.test(node.id)) roots.add(`assets/${node.id}`);
  return roots;
}
