import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { createReadStream, readFile, stat } from "@toonflow/file";
import { helperUpdateInfo } from "@toonflow/local-helper/protocol";
import { authenticateDevice, getDownloadPath } from "./index";
import type { Request, Response } from "express";
import { z } from "zod";

let cached: { key: string; info: z.infer<typeof helperUpdateInfo> } | undefined;
export async function getUpdate(req: Request) {
  const device = await authenticateDevice(req);
  if (device.ownerId === null) throw Object.assign(new Error("请先把本机绑定到账户，再检查或下载更新"), { status: 403 });
  const path = getDownloadPath();
  const metadataPath = join(dirname(path), "download.json");
  const metadataStat = await stat(metadataPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw Object.assign(new Error("尚未发布助手更新包与清单"), { status: 404 });
    throw error;
  });
  if (!metadataStat.isFile() || metadataStat.size > 16000) throw Object.assign(new Error("更新清单无效或过大"), { status: 503 });
  const metadata = z
    .object({
      version: helperUpdateInfo.shape.version,
      file: z.string(),
      sha256: helperUpdateInfo.shape.sha256,
      notes: helperUpdateInfo.shape.notes,
    })
    .parse(JSON.parse(await readFile(metadataPath, "utf8")));
  if (metadata.file !== basename(path)) throw Object.assign(new Error("更新清单与安装包名称不一致"), { status: 503 });
  const details = await stat(path);
  if (!details.isFile()) throw Object.assign(new Error("更新包不可用"), { status: 503 });
  const key = `${path}:${details.size}:${details.mtimeMs}:${metadata.sha256}:${metadata.version}:${metadata.notes ?? ""}`;
  if (cached?.key === key) return cached.info;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== metadata.sha256) throw Object.assign(new Error("更新包摘要与清单不匹配，暂不提供更新"), { status: 503 });
  const info = helperUpdateInfo.parse({
    version: metadata.version,
    sha256: metadata.sha256,
    size: details.size,
    platform: "windowsX64",
    notes: metadata.notes,
  });
  cached = { key, info };
  return info;
}

export async function downloadUpdate(req: Request, res: Response) {
  const info = await getUpdate(req);
  if (req.query.sha256 !== info.sha256) throw Object.assign(new Error("更新版本已变化，请重新检查"), { status: 409 });
  res.set("Cache-Control", "no-store");
  await new Promise<void>((resolveDownload, reject) =>
    res.download(getDownloadPath(), "unionFlfowHelper.zip", (error) => (error ? reject(error) : resolveDownload())),
  );
}
