import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, hostname, release } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { link, lstat, mkdir, open, opendir, realpath, rm, rmdir, stat, unlink, writeAtomic } from "@toonflow/file";
import type { Stats } from "@toonflow/file";
import type { LocalComputerRequest } from "./protocol";

export const toolsDirectory = resolve(dirname(process.execPath), "tools");
const windowsDirectory = process.env.SystemRoot || "C:\\Windows";
const powershell = join(windowsDirectory, "System32/WindowsPowerShell/v1.0/powershell.exe");

export function fileRevision(info: Stats) {
  return createHash("sha256").update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`).digest("hex");
}

export async function localPath(value: string, missing = false) {
  if (!/^[a-z]:[\\/]/i.test(value) || /[\x00-\x1f]/.test(value)) throw new Error("只支持 Windows 本机磁盘绝对路径");
  if (value.slice(3).split(/[\\/]/).some(part => /[:<>"|?*]|[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("文件路径无效");
  const target = resolve(value);
  let parent = target;
  while (true) {
    try {
      const actual = resolve(await realpath(parent), target.slice(parent.length).replace(/^[\\/]/, ""));
      if (!/^[a-z]:[\\/]/i.test(actual)) throw new Error("不能通过链接访问网络或设备路径");
      return actual;
    } catch (error) {
      if (!missing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if ((await lstat(parent).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== "ENOENT") throw cause; return null; }))?.isSymbolicLink())
        throw new Error("不能操作悬空链接");
      const ancestor = dirname(parent);
      if (ancestor === parent) throw error;
      parent = ancestor;
    }
  }
}

function protectRoot(path: string) {
  if (parse(path).root.toLowerCase() === path.toLowerCase()) throw new Error("不能修改或删除磁盘根目录");
}

export async function runProgram(executable: string, args: string[], cwd: string, signal: AbortSignal, input?: string) {
  signal.throwIfAborted();
  return new Promise<{ exitCode: number; stdout: string; stderr: string; truncated: boolean }>((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: `${toolsDirectory};${process.env.PATH ?? process.env.Path ?? ""}`, FFREPORT: undefined } });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
    const output = { stdout: "", stderr: "", truncated: false };
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const receive = (name: "stdout" | "stderr", chunk: Buffer) => {
      const text = decoders[name].write(chunk);
      const remaining = 128000 - output[name].length;
      if (text.length > remaining) output.truncated = true;
      output[name] += text.slice(0, Math.max(0, remaining));
    };
    child.stdout.on("data", chunk => receive("stdout", chunk));
    child.stderr.on("data", chunk => receive("stderr", chunk));
    const abort = () => {
      if (!child.pid) return;
      const killer = spawn(join(windowsDirectory, "System32/taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => child.kill());
      killer.on("exit", code => { if (code !== 0) child.kill(); });
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.on("error", error => { signal.removeEventListener("abort", abort); reject(error); });
    child.on("close", code => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) return reject(new Error("本地进程已取消或超时，已终止进程树；请核对取消前已发生的操作"));
      for (const name of ["stdout", "stderr"] as const) output[name] += decoders[name].end();
      resolveResult({ ...output, exitCode: code ?? -1 });
    });
  });
}

export async function operate(request: Exclude<LocalComputerRequest, { action: "projects" | "upload" | "download" }>, signal: AbortSignal, readLimit = 65536): Promise<unknown> {
  signal.throwIfAborted();
  if (request.action === "subtitleEnvironment" || request.action === "subtitleScan" || request.action === "subtitleStart"
    || request.action === "subtitleStatus" || request.action === "subtitleCancel" || request.action === "subtitleRender")
    throw new Error("字幕操作须通过字幕任务入口执行");
  if (request.action === "readBatch") {
    const files = [];
    const limit = Math.min(65536, Math.floor(256 * 1024 / request.files.length));
    for (const file of request.files) {
      signal.throwIfAborted();
      try { files.push({ path: file.path, ok: true, result: await operate({ ...file, action: "read" }, signal, limit) }); }
      catch (error) {
        signal.throwIfAborted();
        files.push({ path: file.path, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { files, completed: files.filter(file => file.ok).length, failed: files.filter(file => !file.ok).length };
  }
  if (request.action === "status") {
    const drives = (await Promise.all(Array.from({ length: 26 }, async (_, index) => {
      const path = `${String.fromCharCode(65 + index)}:\\`;
      return await stat(path).then(info => info.isDirectory() ? path : null).catch(() => null);
    }))).filter(Boolean);
    const searchPath = `${toolsDirectory};${process.env.PATH ?? process.env.Path ?? ""}`;
    return { computer: hostname(), platform: "windows", version: release(), home: homedir(), drives,
      tools: Object.fromEntries(["ffmpeg", "ffprobe", "winget", "python", "node", "git"].map(name => [name, Bun.which(`${name}.exe`, { PATH: searchPath })])), powershell };
  }
  if (request.action === "execute" || request.action === "install") {
    const cwd = await localPath(request.action === "execute" && request.cwd ? request.cwd : homedir());
    if (!(await stat(cwd)).isDirectory()) throw new Error("命令工作目录必须是文件夹");
    const timeout = request.timeoutSeconds ?? (request.action === "install" ? 1200 : 60);
    signal = AbortSignal.any([signal, AbortSignal.timeout(timeout * 1000)]);
    if (request.action === "install") {
      const winget = Bun.which("winget.exe");
      if (!winget) throw new Error("未找到 winget，请先从 Microsoft Store 安装或更新“应用安装程序”");
      return runProgram(winget, ["install", "--id", request.packageId, "--exact", "--source", "winget", "--scope", "user",
        "--accept-source-agreements", "--accept-package-agreements", "--disable-interactivity"], cwd, signal);
    }
    const script = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $OutputEncoding = [Console]::OutputEncoding; $ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = 0; trap { [Console]::Error.WriteLine($_.ToString()); exit 1 }; & {\n${request.command}\n}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
    // ACT: stdin 避开 Windows 32767 字符的命令行上限，也避免 EncodedCommand 强制的 CLIXML 错误输出。
    const input = `& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(script).toString("base64")}'))))\n\n`;
    return runProgram(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-InputFormat", "Text", "-OutputFormat", "Text", "-Command", "-"], cwd, signal, input);
  }
  const path = await localPath(request.path ?? homedir(), ["write", "mkdir", "move"].includes(request.action));
  if (request.action === "list") {
    const offset = request.offset ?? 0;
    const directory = await opendir(path);
    const entries = [];
    let index = 0;
    let more = false;
    for await (const entry of directory) {
      signal.throwIfAborted();
      if (index++ < offset) continue;
      if (entries.length === 200) { more = true; break; }
      entries.push({ name: entry.name, path: join(path, entry.name), type: entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "directory" : "file" });
    }
    return { path, entries, nextOffset: more ? offset + entries.length : null };
  }
  if (request.action === "read") {
    const handle = await open(path, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error("读取目标必须是普通文件");
      const revision = fileRevision(before);
      const offset = request.offset ?? 0;
      if (offset && !request.revision) throw new Error("续读需要提供首次读取的 revision");
      if (request.revision && request.revision !== revision) throw new Error("文件已变化，请从头重新读取");
      if (offset > before.size) throw new Error("读取偏移超过文件大小");
      const buffer = Buffer.alloc(Math.min(readLimit, before.size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      let bytes = buffer.subarray(0, bytesRead);
      let content: string;
      if (request.encoding === "base64") content = bytes.toString("base64");
      else {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let trim = 0;
        while (true) {
          try { content = decoder.decode(bytes); break; }
          catch {
            if (offset + bytesRead >= before.size || ++trim > 3) throw new Error("文件不是 UTF-8 文本，请用 base64 读取二进制，或通过命令调用本地工具解析");
            bytes = buffer.subarray(0, bytesRead - trim);
          }
        }
      }
      if (fileRevision(await handle.stat()) !== revision) throw new Error("读取期间文件已变化，请重试");
      return { path, content, encoding: request.encoding ?? "utf8", size: before.size, revision,
        nextOffset: offset + bytes.length < before.size ? offset + bytes.length : null };
    } finally { await handle.close(); }
  }
  protectRoot(path);
  if (request.action === "write") {
    const before = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
    if (before && (!before.isFile() || before.isSymbolicLink())) throw new Error("只能写入普通文件");
    if (before && (!request.overwrite || !request.revision || request.revision !== fileRevision(before)))
      throw new Error("覆盖文件前必须读取最新 revision 并显式设置 overwrite=true");
    if (!before && request.revision) throw new Error("原文件已消失，请核对后重新操作");
    if (request.encoding === "base64" && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.content)) throw new Error("Base64 内容无效");
    await writeAtomic(path, Buffer.from(request.content, request.encoding ?? "utf8"), { exclusive: !before });
    return { path, revision: fileRevision(await stat(path)), saved: true };
  }
  if (request.action === "mkdir") { await mkdir(path); return { path, created: true }; }
  if (request.action === "move") {
    if (!(await lstat(path)).isFile()) throw new Error("move 仅移动普通文件；目录移动请使用经本机确认的 PowerShell 命令");
    const target = await localPath(request.target, true);
    protectRoot(target);
    // ACT: 同一磁盘用硬链接原子占用目标，再移除源；跨磁盘由用户确认的命令完成，不覆盖任何目标。
    await link(path, target);
    await unlink(path);
    return { path, target, moved: true };
  }
  if (request.action === "remove") {
    const info = await lstat(path);
    if (info.isDirectory() && !request.recursive) await rmdir(path);
    else await rm(path, { recursive: request.recursive ?? false });
    return { path, removed: true };
  }
}
