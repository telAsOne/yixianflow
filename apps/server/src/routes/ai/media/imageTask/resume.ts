import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success, errorFromCause } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096), outputDirectory: z.string().min(1).max(2048), operationId: z.uuid() }), async (req, res) => {
  const cwd = await u.workspace.resolveWorkspace(req, req.body.directory);
  const request = await u.mediaGeneration.getImageTaskRequest(cwd, req.body.outputDirectory, req.body.operationId);
  const close = () => clearInterval(heartbeat);
  res.once("close", close);
  res.set({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) res.write("\n"); }, 20000);
  try {
    const result = await u.mediaGeneration.generateMedia(cwd, "image", request, AbortSignal.timeout(10 * 60_000));
    if (!res.destroyed) res.write(JSON.stringify(success(result)));
  } catch (error) {
    if (!res.destroyed) res.write(JSON.stringify(errorFromCause(error)));
  } finally {
    clearInterval(heartbeat);
    res.off("close", close);
    res.end();
  }
});
