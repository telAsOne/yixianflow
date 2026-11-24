import { readdir } from "@/utils/media/objectFiles";
import { join, relative, sep } from "node:path";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();
export default router.get("/", validateFields({ path: z.string().max(4096).optional(), offset: z.coerce.number().int().nonnegative().optional(), directoriesOnly: z.enum(["true", "false"]).optional(), query: z.string().max(256).optional(), cursor: z.string().max(128).optional() }, "query"), async (req, res) => {
  if (typeof req.query.query === "string" && req.query.query.trim()) {
    const result = await u.assets.queryAssets({ query: req.query.query, path: req.query.path as string | undefined, cursor: req.query.cursor as string | undefined, limit: 50 });
    res.set("Cache-Control", "no-store").json(success({ entries: result.items, nextCursor: result.nextCursor }));
    return;
  }
  const directory = await u.assets.getAssetsDirectory();
  const target = await u.workspaceFile.resolveWorkspacePath(directory, (req.query.path as string | undefined) || ".");
  const entries = (await readdir(target.path, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() || entry.isFile() && req.query.directoriesOnly !== "true")
    .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
  const offset = Number(req.query.offset ?? 0);
  res.set("Cache-Control", "no-store").json(success({ entries: entries.slice(offset, offset + 200).map(entry => ({
    name: entry.name, path: relative(directory, join(target.path, entry.name)).split(sep).join("/"), type: entry.isDirectory() ? "directory" : "file", leaf: entry.isFile(),
  })), nextOffset: offset + 200 < entries.length ? offset + 200 : undefined }));
});
