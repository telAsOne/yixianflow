import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { createReadStream, lstat, readFile, readdir, rename, rm, unlink, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import { dataDirectory, flushLogs, initializeLogs, logError, logEvent } from "./logger";
import { helperVersion } from "./protocol";

export const updatePlanSchema = z.strictObject({
  transactionId: z.uuid(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  installDirectory: z.string().min(4).max(4096),
  parentPid: z.number().int().positive(),
  workerPid: z.number().int().positive(),
  createdAt: z.number().int().positive(),
});

export function validUpdatePath(path: string) {
  return (
    path.length > 0 &&
    !/[\\:\x00-\x1f<>"|?*]/.test(path) &&
    path
      .split("/")
      .every(
        (part) =>
          part && part !== "." && part !== ".." && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}

async function verifyStage(directory: string, version: string, expectedDigest: string) {
  const text = await readFile(join(directory, "manifest.json"), "utf8");
  if (createHash("sha256").update(text).digest("hex") !== expectedDigest) throw new Error("更新程序清单在准备后发生变化");
  const manifest = z
    .object({
      version: z.literal(version),
      platform: z.literal("windowsX64"),
      hashes: z.record(z.string().refine(validUpdatePath), z.string().regex(/^[a-f0-9]{64}$/)),
    })
    .parse(JSON.parse(text));
  const names: string[] = [];
  async function visit(path: string, prefix: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("更新程序目录不能包含链接");
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(path, entry.name), name + "/");
      else if (entry.isFile()) names.push(name);
      else throw new Error("更新程序只能包含普通文件");
    }
  }
  await visit(directory, "");
  if (names.length !== Object.keys(manifest.hashes).length + 1) throw new Error("更新程序文件集合发生变化");
  for (const name of names) {
    if (name === "manifest.json") continue;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(join(directory, name))) hash.update(chunk);
    if (hash.digest("hex") !== manifest.hashes[name]) throw new Error("更新程序文件校验失败");
  }
}

export function updatePaths(installDirectory: string, transactionId: string) {
  z.uuid().parse(transactionId);
  const install = resolve(installDirectory);
  if (dirname(install) === install) throw new Error("不能更新磁盘根目录");
  return {
    install,
    cache: join(dataDirectory, "updates", transactionId),
    stage: join(dirname(install), `.unionFlowStage${transactionId}`),
    backup: join(dirname(install), `.unionFlowPrevious${transactionId}`),
    failed: join(dirname(install), `.unionFlowFailed${transactionId}`),
  };
}

async function plainDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("更新目录必须是普通目录，不能使用链接");
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function launch(path: string) {
  return new Promise<ReturnType<typeof spawn>>((resolveLaunch, reject) => {
    const child = spawn(path, ["--controlCenter"], { detached: true, windowsHide: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolveLaunch(child);
    });
  });
}

export async function acknowledgeUpdate() {
  const pendingPath = join(dataDirectory, "updates/pending.json");
  try {
    const pending = updatePlanSchema.parse(JSON.parse(await readFile(pendingPath, "utf8")));
    if (pending.version !== helperVersion || resolve(pending.installDirectory).toLowerCase() !== dirname(process.execPath).toLowerCase())
      return;
    const paths = updatePaths(pending.installDirectory, pending.transactionId);
    await writeAtomic(join(paths.cache, "healthy.json"), JSON.stringify({ version: helperVersion, pid: process.pid, at: Date.now() }), {
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") await logError("updateHealthFailed", error);
  }
}

export async function applyUpdate(path: string) {
  await initializeLogs("tray");
  let paths: ReturnType<typeof updatePaths> | undefined;
  let plan: z.infer<typeof updatePlanSchema> | undefined;
  let moved = false;
  let committed = false;
  let launched: ReturnType<typeof spawn> | undefined;
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("更新计划不能是链接");
    plan = updatePlanSchema.parse(JSON.parse(await readFile(path, "utf8")));
    paths = updatePaths(plan.installDirectory, plan.transactionId);
    if (
      resolve(path).toLowerCase() !== join(paths.cache, "plan.json").toLowerCase() ||
      resolve(process.execPath).toLowerCase() !== join(paths.cache, "updater.exe").toLowerCase() ||
      Date.now() - plan.createdAt > 10 * 60000 ||
      plan.createdAt > Date.now() + 60000 ||
      plan.parentPid === process.pid ||
      plan.workerPid === process.pid
    )
      throw new Error("更新计划位置或有效期无效");
    for (const directory of [paths.install, paths.stage, paths.cache]) await plainDirectory(directory);
    const dataRelative = relative(paths.install, dataDirectory);
    if (!isAbsolute(dataRelative) && dataRelative !== ".." && !dataRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
      throw new Error("用户数据不能位于待替换的程序目录内");
    await verifyStage(paths.stage, plan.version, plan.manifestSha256);
    // 就绪回执在退出旧程序之前发送；启动更新器失败时旧托盘继续运行。
    process.stdout.write("updateReady\n");
    const deadline = Date.now() + 60000;
    while (alive(plan.parentPid) || alive(plan.workerPid)) {
      if (Date.now() > deadline) throw new Error("旧托盘或工作进程未退出，未替换程序文件");
      await Bun.sleep(250);
    }
    await rename(paths.install, paths.backup);
    moved = true;
    await rename(paths.stage, paths.install);
    await writeAtomic(join(dataDirectory, "updates/pending.json"), JSON.stringify(plan), { mode: 0o600 });
    launched = await launch(join(paths.install, "unionFlfowHelper.exe"));
    const healthDeadline = Date.now() + 30000;
    let healthy = false;
    while (Date.now() < healthDeadline && launched.pid && alive(launched.pid)) {
      try {
        const health = z
          .strictObject({ version: z.string(), pid: z.number().int().positive(), at: z.number().int().positive() })
          .parse(JSON.parse(await readFile(join(paths.cache, "healthy.json"), "utf8")));
        healthy = health.version === plan.version && health.at >= plan.createdAt && alive(health.pid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (healthy) break;
      await Bun.sleep(250);
    }
    if (!healthy) throw new Error("新版本未完成启动确认，将恢复原程序");
    committed = true;
    let previous: z.infer<typeof updatePlanSchema> | undefined;
    try {
      previous = updatePlanSchema.parse(JSON.parse(await readFile(join(dataDirectory, "updates/lastSuccessful.json"), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") await logError("updateHistoryReadFailed", error);
    }
    await writeAtomic(join(dataDirectory, "updates/lastSuccessful.json"), JSON.stringify(plan), { mode: 0o600 });
    await writeAtomic(
      join(dataDirectory, "updates/result.json"),
      JSON.stringify({ version: plan.version, success: true, at: Date.now() }),
      { mode: 0o600 },
    );
    await unlink(join(dataDirectory, "updates/pending.json"));
    if (
      previous &&
      previous.transactionId !== plan.transactionId &&
      resolve(previous.installDirectory).toLowerCase() === paths.install.toLowerCase()
    ) {
      const old = updatePaths(previous.installDirectory, previous.transactionId);
      // ACT: 只清理上一笔已成功事务的精确目录；当前回滚副本与所有用户数据保留。
      for (const directory of [old.backup, old.cache]) {
        try {
          await plainDirectory(directory);
          await rm(directory, { recursive: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") await logError("updateCleanupFailed", error);
        }
      }
    }
    await logEvent("info", "updateInstalled", { source: "helper", targetVersion: plan.version });
  } catch (error) {
    if (committed) {
      await logError("updateFinalizeFailed", error);
      return;
    }
    let rollbackFailed = false;
    let restoredProgram: string | undefined;
    if (moved && paths) {
      try {
        if (launched?.pid && alive(launched.pid)) {
          const killer = spawn(
            join(process.env.SystemRoot || "C:\\Windows", "System32/taskkill.exe"),
            ["/PID", String(launched.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore" },
          );
          await new Promise<void>((resolveKill, reject) => {
            killer.once("error", reject);
            killer.once("exit", (code) => (code === 0 ? resolveKill() : reject(new Error("新版本进程未能退出"))));
          });
        }
        const current = await lstat(paths.install).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code !== "ENOENT") throw cause;
          return null;
        });
        if (current) {
          await plainDirectory(paths.install);
          await rename(paths.install, paths.failed);
        }
        await rename(paths.backup, paths.install);
        restoredProgram = join(paths.install, "unionFlfowHelper.exe");
      } catch (rollbackError) {
        rollbackFailed = true;
        await logError("updateRollbackFailed", rollbackError);
      }
    }
    try {
      await writeAtomic(
        join(dataDirectory, "updates/result.json"),
        JSON.stringify({
          version: plan?.version,
          success: false,
          error:
            (rollbackFailed ? "自动恢复未完成，请保留程序目录旁的 .unionFlowPrevious 备份并手动恢复。" : "") +
            (error instanceof Error ? error.message : String(error)),
          at: Date.now(),
        }),
        { mode: 0o600 },
      );
      await logError("updateInstallFailed", error);
    } finally {
      if (restoredProgram) {
        try {
          await launch(restoredProgram);
        } catch (launchError) {
          await logError("updateRollbackStartFailed", launchError);
        }
      }
    }
  } finally {
    await flushLogs();
  }
}
