import { z } from "@toonflow/nodes-scaffold/nodeTools";
import type { NodeInputValue } from "@toonflow/nodes-scaffold/values";

export const assetIdentitySchema = z.strictObject({
  kind: z.enum(["character", "scene", "prop", "effect", "detail"]),
  identity: z.string().trim().min(1).max(128),
  state: z.string().trim().min(1).max(200),
  baseNodeId: z.string().trim().min(1).max(256).optional(),
});
export type AssetIdentity = z.infer<typeof assetIdentitySchema>;

export function validateAssetIdentity(nodeId: string, asset: AssetIdentity, nodes: { id: string; data: Record<string, unknown> }[], references: NodeInputValue[], requireReady = false) {
  const baseId = asset.baseNodeId ?? nodeId;
  if (asset.baseNodeId) {
    if (asset.baseNodeId === nodeId) throw new Error("资产底图不能指向自身");
    const base = nodes.find(node => node.id === asset.baseNodeId);
    const identity = assetIdentitySchema.safeParse(base?.data.assetIdentity);
    if (!identity.success || identity.data.identity !== asset.identity || identity.data.baseNodeId) throw new Error("底图必须是同一资产身份的基础节点，请先用底图节点的 setConfig 登记 assetIdentity；不同形态直接共用该底图");
    if (requireReady && !references.some(item => item.source === baseId && item.dataType === "IMAGE" && item.value?.url)) throw new Error("变体尚未接入真实底图，请连接 baseNodeId 的图片输出，并等待底图生成后再启动变体");
  }
  if (asset.kind !== "character") return;
  // ACT: 当前按画布已有资产做 O(n) 身份核验；大规模资产库再按 identity 建索引。
  for (const node of nodes) {
    if (node.id === nodeId) continue;
    const other = assetIdentitySchema.safeParse(node.data.assetIdentity);
    if (other.success && other.data.kind === "character" && other.data.identity === asset.identity
      && (other.data.baseNodeId ?? node.id) !== baseId) throw new Error(`人物 ${asset.identity} 已有另一张身份底图；请沿用同一 baseNodeId，不能把不同形态分别当独立人物生成`);
  }
}
