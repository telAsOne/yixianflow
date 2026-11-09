import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { getWebBasePath } from "@/utils/web/store";

// 提示词标签写法为 {{CameraPreset ID}}，ID 不能包含空白或花括号。
const mediaFile = z.string().regex(/^[a-f0-9]{64}\.(?:jpg|png|webp|gif|mp4|webm)$/);
const presetSchema = z.object({
  id: z.string().regex(/^[^\s{}]{1,128}$/), name: z.string().min(1).max(100),
  preview: z.object({ cover: mediaFile.optional(), motion: mediaFile.optional(), video: mediaFile.optional() }).optional(),
});

export default Router().get("/", async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const account = u.account.requireAccount();
  const items = await u.account.accountFetch("/v1/toonflow/camera-presets");
  if (u.account.getAccount() !== account) throw Object.assign(new Error("账户已切换，请重新发起操作"), { status: 401 });
  if (!Array.isArray(items)) throw Object.assign(new Error("平台返回的运镜库格式无效"), { status: 502 });
  // ACT: 跳过不合规的预设，避免一条坏数据清空运镜库；最多保留前 128 个，超出后需改为分页。
  const presets = items.flatMap(item => {
    const preset = presetSchema.safeParse(item);
    if (!preset.success) return [];
    const { id, name, preview } = preset.data;
    const media = Object.fromEntries(Object.entries(preview ?? {}).filter(([, file]) => file).map(([kind, file]) => [kind,
      `${getWebBasePath()}/api/account/cameraPresets/media?${new URLSearchParams({ id, kind, version: file! })}`]));
    return [{ id, name, ...(Object.keys(media).length ? { preview: media } : {}) }];
  }).slice(0, 128);
  res.set("Cache-Control", "no-store").json(success(presets));
});
