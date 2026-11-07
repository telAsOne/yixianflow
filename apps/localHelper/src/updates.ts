import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, isAbsolute } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { copyFile, createWriteStream, mkdir, readFile, realpath, writeAtomic } from "@toonflow/file";
import { unzipSync } from "fflate";
import { z } from "zod";
import { helperUpdateInfo, helperVersion } from "./protocol";
import { deviceRequest } from "./connection";
import { dataDirectory, logError, logEvent } from "./logger";
import { sendControl, updateVersion } from "./activity";
import { updatePaths, updatePlanSchema, validUpdatePath } from "./applyUpdate";
import type { HelperUpdateState } from "./controlProtocol";

const preferencesSchema = z.strictObject({ autoCheck: z.boolean(), autoInstall: z.boolean() });
const state: HelperUpdateState = { phase: "idle", currentVersion: helperVersion, bytes: 0, total: 0, autoCheck: true, autoInstall: false };
const preferencesPath = join(dataDirectory, "updatePreferences.json");
let info: z.infer<typeof helperUpdateInfo> | undefined;
let prepared: ReturnType<typeof updatePaths> | undefined;
let preparedDigest = "";
let manifestDigest = "";
let busy = false;
let failedAutomatically = false;
function publish() {
  updateVersion({ ...state });
}
function fail(error: unknown) {
  state.phase = "failed";
  const status = (error as { status?: number }).status;
  state.error =
    status === 401
      ? "更新服务未能验证本机连接。请在「设备与连接」核对绑定；若设备已连接，请联系平台处理。"
      : status === 404
      ? "平台尚未发布更新接口，请先使用完整安装包更新"
      : error instanceof Error
        ? error.message
        : String(error);
  publish();
  void logError("updateFailed", error);
}

export function createUpdates(server: URL, token: () => string | undefined, idle: () => boolean) {
  async function check() {
    if (busy || state.phase === "installing") return;
    busy = true;
    state.phase = "checking";
    state.error = undefined;
    publish();
    try {
      const credential = token();
      if (!credential) throw new Error("请先绑定账户并确认本机连接后，再检查更新");
      info = helperUpdateInfo.parse(await deviceRequest(server, credential, "update", undefined, AbortSignal.timeout(20000), "GET"));
      if (preparedDigest !== info.sha256) prepared = undefined;
      state.checkedAt = Date.now();
      state.version = info.version;
      state.total = info.size;
      state.notes = info.notes;
      state.phase = Bun.semver.order(info.version, helperVersion) > 0 ? (prepared ? "ready" : "available") : "current";
      void logEvent("info", "updateChecked", { source: "helper", targetVersion: info.version });
      publish();
    } catch (error) {
      state.checkedAt = Date.now();
      fail(error);
    } finally {
      busy = false;
    }
  }

  async function download() {
    if (busy || state.phase === "installing") return;
    if (!info || Bun.semver.order(info.version, helperVersion) <= 0) {
      await check();
      if (!info || Bun.semver.order(info.version, helperVersion) <= 0) return;
    }
    busy = true;
    state.phase = "downloading";
    state.bytes = 0;
    state.error = undefined;
    publish();
    try {
      if (!/localWorker\.exe$/i.test(process.execPath)) throw new Error("开发运行不执行自更新，请使用完整 Windows 程序包");
      const credential = token();
      if (!credential) throw new Error("设备尚未注册，无法下载更新");
      const install = await realpath(dirname(process.execPath));
      const dataRelative = relative(install, await realpath(dataDirectory));
      if (!isAbsolute(dataRelative) && dataRelative !== ".." && !dataRelative.startsWith("..\\"))
        throw new Error("请先把用户数据目录移到程序目录之外，再执行更新");
      const paths = updatePaths(install, randomUUID());
      await mkdir(paths.cache, { recursive: true });
      const archivePath = join(paths.cache, "package.zip");
      const url = new URL("api/localHelper/device/updatePackage", server);
      url.searchParams.set("sha256", info!.sha256);
      const response = await fetch(url, {
        redirect: "error",
        headers: { Authorization: `Bearer ${credential}` },
        signal: AbortSignal.timeout(15 * 60000),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`更新下载失败（HTTP ${response.status}）`);
      }
      let notifiedAt = 0;
      const hash = createHash("sha256");
      await pipeline(
        Readable.fromWeb(response.body),
        new Transform({
          transform(chunk, _encoding, done) {
            state.bytes += chunk.length;
            hash.update(chunk);
            if (state.bytes > info!.size) return done(new Error("更新包超过清单允许的大小"));
            if (Date.now() - notifiedAt > 250) {
              notifiedAt = Date.now();
              publish();
            }
            done(null, chunk);
          },
        }),
        createWriteStream(archivePath, { flags: "wx" }),
      );
      if (state.bytes !== info!.size || hash.digest("hex") !== info!.sha256) throw new Error("更新包不完整或 SHA-256 不匹配，未安装");
      let expanded = 0;
      let count = 0;
      // ACT: 固定 ZIP 包最多 512 MiB 解压内容、500 个文件；在内存解包并只创建普通文件，拒绝目录穿越与链接语义。
      const files = unzipSync(await readFile(archivePath), {
        filter(file) {
          if (!file.name.startsWith("unionFlfowHelper/")) throw new Error("更新包根目录不正确");
          const path = file.name.slice("unionFlfowHelper/".length);
          if (!path || path.endsWith("/")) {
            if (path && !validUpdatePath(path.slice(0, -1))) throw new Error("更新包目录无效");
            return false;
          }
          if (!validUpdatePath(path) || ++count > 500 || (expanded += file.originalSize) > 512 * 1024 * 1024)
            throw new Error("更新包路径或解压大小超出限制");
          return true;
        },
      });
      const manifestBytes = files["unionFlfowHelper/manifest.json"];
      if (!manifestBytes || manifestBytes.length > 200000) throw new Error("更新包缺少有效程序清单");
      const manifest = z
        .object({
          version: z.literal(info!.version),
          platform: z.literal("windowsX64"),
          hashes: z.record(z.string().refine(validUpdatePath), z.string().regex(/^[a-f0-9]{64}$/)),
        })
        .parse(JSON.parse(Buffer.from(manifestBytes).toString("utf8")));
      for (const required of [
        "unionFlfowHelper.exe",
        "localWorker.exe",
        "ui/index.html",
        "tools/ffmpeg.exe",
        "tools/ffprobe.exe",
        "Microsoft.Web.WebView2.Core.dll",
        "Microsoft.Web.WebView2.WinForms.dll",
        "WebView2Loader.dll",
      ])
        if (!manifest.hashes[required]) throw new Error(`更新清单缺少 ${required}`);
      for (const [name, content] of Object.entries(files)) {
        const path = name.slice("unionFlfowHelper/".length);
        if (path === "manifest.json") continue;
        if (manifest.hashes[path] !== createHash("sha256").update(content).digest("hex")) throw new Error("更新包文件摘要不匹配");
      }
      if (Object.keys(manifest.hashes).length !== Object.keys(files).length - 1) throw new Error("更新清单包含缺失文件");
      await mkdir(paths.stage);
      for (const [name, content] of Object.entries(files)) {
        const target = join(paths.stage, name.slice("unionFlfowHelper/".length));
        await mkdir(dirname(target), { recursive: true });
        await writeAtomic(target, content, { exclusive: true });
      }
      await copyFile(process.execPath, join(paths.cache, "updater.exe"));
      prepared = paths;
      preparedDigest = info!.sha256;
      manifestDigest = createHash("sha256").update(manifestBytes).digest("hex");
      state.phase = "ready";
      publish();
      void logEvent("info", "updatePrepared", { source: "helper", targetVersion: info!.version, bytes: state.bytes });
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
    }
  }

  async function install() {
    if (busy || state.phase === "installing") return;
    if (!prepared || state.phase !== "ready") throw new Error("请先下载并校验更新包");
    if (!idle()) throw new Error("当前仍有任务、对话或待回传结果，请等待全部完成后安装更新");
    const plan = updatePlanSchema.parse({
      transactionId: prepared.cache.split(/[\\/]/).pop(),
      version: info!.version,
      manifestSha256: manifestDigest,
      installDirectory: prepared.install,
      parentPid: process.ppid,
      workerPid: process.pid,
      createdAt: Date.now(),
    });
    const path = join(prepared.cache, "plan.json");
    await writeAtomic(path, JSON.stringify(plan), { mode: 0o600 });
    state.phase = "installing";
    publish();
    sendControl({ type: "applyUpdate", path });
  }

  return {
    check,
    download,
    install,
    installing() {
      return state.phase === "installing";
    },
    rejectInstall(error: string) {
      state.phase = prepared ? "ready" : "failed";
      state.error = error.slice(0, 1000);
      failedAutomatically = true;
      publish();
    },
    async initialize() {
      try {
        Object.assign(state, preferencesSchema.parse(JSON.parse(await readFile(preferencesPath, "utf8"))));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          state.error = "更新偏好读取失败，已保留原文件";
          state.autoCheck = false;
          state.autoInstall = false;
          void logError("updatePreferencesFailed", error);
        }
      }
      try {
        const result = JSON.parse(await readFile(join(dataDirectory, "updates/result.json"), "utf8"));
        if (result.success === false && /^\d+\.\d+\.\d+$/.test(result.version) && Bun.semver.order(result.version, helperVersion) > 0) {
          state.phase = "failed";
          state.error = `上次更新未完成：${String(result.error).slice(0, 1000)}`;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") void logError("updateResultReadFailed", error);
      }
      publish();
    },
    async preferences(value: { autoCheck: boolean; autoInstall: boolean }) {
      const preferences = preferencesSchema.parse(value);
      await writeAtomic(preferencesPath, JSON.stringify(preferences), { mode: 0o600 });
      Object.assign(state, preferences);
      failedAutomatically = false;
      publish();
    },
    async tick() {
      if (busy || failedAutomatically || state.phase === "installing") return;
      if (state.autoCheck && Date.now() - (state.checkedAt ?? 0) > 60 * 60000 && token()) await check();
      if (!state.autoInstall || !idle()) return;
      if (state.phase === "available") await download();
      if (state.phase === "ready" && idle()) await install();
      if (state.phase === "failed") failedAutomatically = true;
    },
  };
}
