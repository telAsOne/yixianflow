import { $ } from "bun";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { copyFile, existsSync, mkdir, readFile, writeAtomic } from "@toonflow/file";
import { getToolStatus, installFfmpeg } from "@toonflow/ffmpeg";
import { helperVersion } from "../src/protocol";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("请在 Windows x64 使用仓库固定的 Bun 构建");
const root = resolve(import.meta.dirname, "../../..");
const destination = resolve(process.argv[2] || join(root, "build/localHelper"));
if (existsSync(destination)) throw new Error("产物目录已存在，请传入新的目录以保留历史产物");
const bundle = join(destination, "unionFlfowHelper");
await mkdir(bundle, { recursive: true });
const windowsDirectory = process.env.SystemRoot || "C:\\Windows";
const powershell = join(windowsDirectory, "System32/WindowsPowerShell/v1.0/powershell.exe");
const csc = join(windowsDirectory, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");

// 沿用 UnionAigc 图标的 96×96 几何图形，通过系统绘图库生成 ICO，不增加构建依赖。
const iconScript = `Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap(96,96)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = 'AntiAlias'
$background = New-Object System.Drawing.Drawing2D.GraphicsPath
$background.AddArc(0,0,48,48,180,90); $background.AddArc(48,0,48,48,270,90); $background.AddArc(48,48,48,48,0,90); $background.AddArc(0,48,48,48,90,90); $background.CloseFigure()
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#121212'))
$graphics.FillPath($brush,$background)
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White,11)
$pen.StartCap = 'Round'; $pen.EndCap = 'Round'
$curve = New-Object System.Drawing.Drawing2D.GraphicsPath
$curve.AddLine(28,28,28,49); $curve.AddArc(28,29,40,40,180,-180); $curve.AddLine(68,49,68,28)
$graphics.DrawPath($pen,$curve)
$star = New-Object System.Drawing.Drawing2D.GraphicsPath
$star.AddBezier(48,21,49.1,28.3,51.2,30.4,58.5,31.5); $star.AddBezier(58.5,31.5,51.2,32.6,49.1,34.7,48,42); $star.AddBezier(48,42,46.9,34.7,44.8,32.6,37.5,31.5); $star.AddBezier(37.5,31.5,44.8,30.4,46.9,28.3,48,21)
$starBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#b794ff'))
$graphics.FillPath($starBrush,$star)
$stream = New-Object System.IO.MemoryStream
$bitmap.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png)
[Convert]::ToBase64String($stream.ToArray())
$stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose(); $background.Dispose(); $brush.Dispose(); $pen.Dispose(); $curve.Dispose(); $star.Dispose(); $starBrush.Dispose()`;
const png = Buffer.from((await $`${powershell} -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(iconScript, "utf16le").toString("base64")}`.text()).trim(), "base64");
const icon = Buffer.alloc(22 + png.length);
icon.writeUInt16LE(1, 2); icon.writeUInt16LE(1, 4); icon[6] = 96; icon[7] = 96;
icon.writeUInt16LE(1, 10); icon.writeUInt16LE(32, 12); icon.writeUInt32LE(png.length, 14); icon.writeUInt32LE(22, 18); png.copy(icon, 22);
const iconPath = join(bundle, "unionIcon.ico");
await writeAtomic(iconPath, icon);
await $`${csc} /nologo /codepage:65001 /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /win32icon:${iconPath} /out:${join(bundle, "unionFlfowHelper.exe")} ${join(root, "apps/localHelper/native/tray.cs")}`;
await $`${process.execPath} build ${join(root, "apps/localHelper/src/index.ts")} --compile --target=bun-windows-x64 --minify --outfile ${join(bundle, "localWorker.exe")}`.cwd(root);

console.log("准备内置 FFmpeg 和 ffprobe 6.1.1（下载时校验固定 SHA-256）");
let phase = "";
await installFfmpeg(join(bundle, "tools"), "npmmirror", AbortSignal.timeout(15 * 60000), progress => {
  const next = `${progress.file || "tools"} ${progress.phase}`;
  if (next !== phase) { phase = next; console.log(next); }
});
const versions = await getToolStatus(join(bundle, "tools"), "download");
if (Object.values(versions).some(tool => !tool.version || tool.error)) throw new Error("内置媒体工具无法运行");
await mkdir(join(bundle, "licenses"));
for (const [name, url] of [
  ["ffmpegLicense.txt", "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/win32-x64.LICENSE"],
  ["ffmpegReadme.txt", "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/win32-x64.README"],
  ["bunLicense.txt", "https://raw.githubusercontent.com/oven-sh/bun/bun-v1.3.14/LICENSE.md"],
] as const) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`许可证下载失败：${url} (${response.status})`);
  const content = await response.text();
  if (!content.trim() || content.length > 2000000 || /<!doctype html/i.test(content)) throw new Error("许可证响应无效");
  await writeAtomic(join(bundle, "licenses", name), content);
}
await copyFile(join(root, "LICENSE"), join(bundle, "licenses/projectLicense.txt"));
await copyFile(join(root, "docs/localHelperWindows.md"), join(bundle, "readme.md"));
const files = ["unionFlfowHelper.exe", "localWorker.exe", "tools/ffmpeg.exe", "tools/ffprobe.exe"];
const hashes = Object.fromEntries(await Promise.all(files.map(async path => [path, createHash("sha256").update(await readFile(join(bundle, path))).digest("hex")])));
await writeAtomic(join(bundle, "manifest.json"), JSON.stringify({ version: helperVersion, platform: "windowsX64", bunVersion: Bun.version,
  ffmpegVersion: "6.1.1", server: "https://yixian.lol/flow/", hashes }, null, 2));
const zip = join(destination, "unionFlfowHelper.zip");
await $`${join(windowsDirectory, "System32/tar.exe")} -a -cf ${zip} -C ${dirname(bundle)} unionFlfowHelper`;
const digest = createHash("sha256").update(await readFile(zip)).digest("hex");
await writeAtomic(join(destination, "download.json"), JSON.stringify({ version: helperVersion, file: "unionFlfowHelper.zip", sha256: digest }, null, 2));
console.log(`Windows 包：${zip}\nSHA-256：${digest}`);
