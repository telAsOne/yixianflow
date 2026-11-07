import { z } from "@toonflow/nodes-scaffold/nodeTools";

const cameraPresetsSchema = z.array(z.object({
  id: z.string().min(1).max(128).regex(/^[^{}\r\n]+$/),
  name: z.string().min(1).max(100),
})).max(128);

export type CameraPreset = z.infer<typeof cameraPresetsSchema>[number] & { tag: string };

export async function getCameraPresets(signal?: AbortSignal): Promise<CameraPreset[]> {
  const requestSignal = AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
  const response = await fetch("/api/account/cameraPresets", {
    headers: { "X-Toonflow-Workspace": "1" }, cache: "no-store", signal: requestSignal,
  });
  const body = await response.json();
  if (!response.ok || body?.code !== 200) throw new Error(typeof body?.message === "string" && body.message ? body.message : "读取运镜库失败");
  requestSignal.throwIfAborted();
  return cameraPresetsSchema.parse(body.data).map(preset => ({ ...preset, tag: `{{CameraPreset ${preset.id}}}` }));
}
