import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { lstat, opendir, readFile, readdir } from "@toonflow/file";
import { whisperCatalog } from "@toonflow/node-subtitle/whisperModels";
import { operate } from "./operations";

export type WhisperLocations = { pythonPaths: string[]; modelDirectories: string[]; incomplete: boolean };

export async function installedWhisperPythons() {
  const script = [
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "$subtitlePythons = @(Get-Command python.exe,python3.exe -All -CommandType Application -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })",
    "foreach ($subtitleRegistry in @('HKCU:\\Software\\Python\\*\\*\\InstallPath', 'HKLM:\\Software\\Python\\*\\*\\InstallPath', 'HKLM:\\Software\\WOW6432Node\\Python\\*\\*\\InstallPath')) {",
    " foreach ($subtitleKey in @(Get-Item -Path $subtitleRegistry -ErrorAction SilentlyContinue)) {",
    "  $subtitleExecutable = $subtitleKey.GetValue('ExecutablePath')",
    "  if ($subtitleExecutable) { $subtitlePythons += $subtitleExecutable } elseif ($subtitleKey.GetValue('')) { $subtitlePythons += Join-Path $subtitleKey.GetValue('') 'python.exe' }",
    " }",
    "}",
    "$subtitlePythons += @(Get-Command whisper.exe -All -CommandType Application -ErrorAction SilentlyContinue | ForEach-Object { Join-Path (Split-Path (Split-Path $_.Source -Parent) -Parent) 'python.exe' })",
    "$subtitleLauncher = Get-Command py.exe -CommandType Application -ErrorAction SilentlyContinue",
    "if ($subtitleLauncher) {",
    " $subtitlePreference = $ErrorActionPreference; $ErrorActionPreference = 'Continue'",
    " & $subtitleLauncher.Source -0p 2>&1 | ForEach-Object { if ($_ -match '([a-zA-Z]:\\\\.*?python(?:[0-9.]*)?\\.exe)\\s*\\*?\\s*$') { $subtitlePythons += $Matches[1] } }",
    " $ErrorActionPreference = $subtitlePreference",
    "}",
    "ConvertTo-Json -InputObject @($subtitlePythons | Select-Object -Unique) -Compress",
    "exit 0",
  ].join("\n");
  const result = await operate({ action: "execute", command: script, timeoutSeconds: 15 }, AbortSignal.timeout(20000)) as { stdout: string; exitCode: number };
  const candidates: unknown = result.exitCode === 0 ? JSON.parse(result.stdout.trim()) : [];
  if (!Array.isArray(candidates) || candidates.some(path => typeof path !== "string")) throw new Error("Python 路径检测结果无效");
  const paths = candidates as string[];
  const prefixes = [process.env.VIRTUAL_ENV, process.env.CONDA_PREFIX,
    ...["miniconda3", "anaconda3", "miniforge3", "mambaforge"].map(name => join(homedir(), name))].filter((path): path is string => !!path);
  const condaList = join(homedir(), ".conda/environments.txt");
  try {
    if ((await lstat(condaList)).size <= 64 * 1024) prefixes.push(...(await readFile(condaList, "utf8")).split(/\r?\n/).map(path => path.trim()).filter(path => /^[a-z]:[\\/]/i.test(path)));
  } catch { /* Conda 未安装或其清单不可读时，继续其他本机发现方式。 */ }
  const containers = [join(homedir(), ".virtualenvs"), join(homedir(), ".conda/envs"), process.env.WORKON_HOME,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs/Python"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "pypoetry/Cache/virtualenvs"),
    process.env.APPDATA && join(process.env.APPDATA, "uv/python"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Python"),
    ...prefixes.map(prefix => join(prefix, "envs"))];
  for (const container of containers) {
    if (!container) continue;
    try {
      for (const entry of (await readdir(container, { withFileTypes: true })).slice(0, 64)) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) prefixes.push(join(container, entry.name));
      }
    } catch { /* 不存在或不可读的安装位置不阻断其余候选。 */ }
  }
  for (const prefix of prefixes.slice(0, 64)) paths.push(join(prefix, "python.exe"), join(prefix, "Scripts/python.exe"));
  return [...new Set(paths)];
}

export function pythonModelDirectories(pythonPath: string) {
  const directory = dirname(pythonPath);
  const root = basename(directory).toLowerCase() === "scripts" ? dirname(directory) : directory;
  return [join(root, "models"), join(root, ".cache/whisper"), join(dirname(root), "models"), join(dirname(root), "cache/whisper")];
}

export async function searchWhisperDisks(disks: string[], progress: (directories: number) => void): Promise<WhisperLocations> {
  const result: WhisperLocations = { pythonPaths: [], modelDirectories: [], incomplete: false };
  const modelFiles = new Set(whisperCatalog.map(model => model.file));
  const skipped = new Set(["windows", "$recycle.bin", "system volume information", "node_modules", ".git", ".svn", "site-packages", "__pycache__", "code cache", "gpucache"]);
  const started = Date.now();
  let visitedTotal = 0;
  let publishedAt = 0;
  const entryBudget = Math.floor(300000 / Math.max(1, disks.length));
  const folderBudget = Math.floor(20000 / Math.max(1, disks.length));
  // ACT: 各本机盘独立按层搜索，共用 15 秒并平分 30 万项、2 万目录预算，最多 10 层；超限明确提示，可选择目录继续。
  await Promise.all(disks.map(async disk => {
    const folders = [{ path: `${disk}\\`, depth: 0 }];
    let entries = 0;
    for (let visited = 0; visited < folders.length; visited++) {
      if (Date.now() - started > 15000 || entries >= entryBudget) { result.incomplete = true; break; }
      const folder = folders[visited];
      try {
        for await (const entry of await opendir(folder.path)) {
          if (++entries > entryBudget || Date.now() - started > 15000) { result.incomplete = true; break; }
          if (entry.isSymbolicLink()) continue;
          const path = join(folder.path, entry.name);
          if (entry.isDirectory()) {
            if (skipped.has(entry.name.toLowerCase())) continue;
            if (folder.depth >= 10 || folders.length >= folderBudget) { result.incomplete = true; continue; }
            folders.push({ path, depth: folder.depth + 1 });
          } else if (entry.isFile() && modelFiles.has(entry.name.toLowerCase())) {
            if (!result.modelDirectories.includes(folder.path) && result.modelDirectories.length < 64) result.modelDirectories.push(folder.path);
          } else if (entry.isFile() && /^python(?:3(?:\.\d+)?)?\.exe$/i.test(entry.name) && result.pythonPaths.length < 24) {
            const root = basename(folder.path).toLowerCase() === "scripts" ? dirname(folder.path) : folder.path;
            // 只对具有识别依赖目录的便携环境继续做实际导入检测，避免逐个运行磁盘中的同名程序。
            const modules = await Promise.all(["whisper/__init__.py", "torch/__init__.py"].map(name => lstat(join(root, "Lib/site-packages", name)).catch(() => undefined)));
            if (modules.every(info => info?.isFile() && !info.isSymbolicLink())) result.pythonPaths.push(path);
          }
        }
      } catch { result.incomplete = true; }
      visitedTotal++;
      if (Date.now() - publishedAt > 500) { progress(visitedTotal); publishedAt = Date.now(); }
    }
  }));
  return result;
}
