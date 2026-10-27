import { $ } from "bun";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeAtomic } from "@toonflow/file";
import { file, write } from "@toonflow/file/bun";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import desktopConfig from "../../../electrobun.config";

if (process.platform !== "win32" || process.arch !== "x64" || process.argv.length !== 3) {
  throw new Error("用法：在 Windows x64 执行 bun apps/desktop/scripts/packagePortableWindows.ts <新的产物目录>");
}
const projectDir = realpathSync(resolve(import.meta.dirname, "../../.."));
const outputDirectory = resolve(process.argv[2]!);
if (existsSync(outputDirectory)) throw new Error("产物目录已经存在，请选择新目录，避免覆盖历史版本。");
const artifactDirectory = resolve(projectDir, desktopConfig.build.artifactFolder);
const manifest = await file(join(artifactDirectory, "stable-win-x64-update.json")).json();
if (manifest.version !== desktopConfig.app.version || manifest.identifier !== desktopConfig.app.identifier
  || manifest.artifact.file !== "stable-win-x64-toonflow.tar.zst") throw new Error("桌面构建与当前配置不一致，请先重新构建。");
const windowsDirectory = process.env.SystemRoot ?? process.env.windir ?? process.env.WINDIR!;
const tar = join(windowsDirectory, "System32/tar.exe");
const csc = join(windowsDirectory, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
const stagingDirectory = mkdtempSync(join(tmpdir(), "toonflowPortable"));
const portableDirectory = join(outputDirectory, "toonflowPortable");
try {
  const archive = await file(join(artifactDirectory, manifest.artifact.file)).arrayBuffer();
  const tarFile = join(stagingDirectory, "app.tar");
  await write(tarFile, Bun.zstdDecompressSync(archive));
  await $`${tar} -xf ${tarFile} -C ${stagingDirectory}`;
  mkdirSync(portableDirectory, { recursive: true });
  cpSync(join(stagingDirectory, "toonflow"), join(portableDirectory, "runtime"), { recursive: true });
  // 便携包使用独立更新清单，不提供安装和卸载入口。
  rmSync(join(portableDirectory, "runtime/Resources/uninstall"));
  const dependencies = await file(join(projectDir, ".hutch/dependencies.lock")).json();
  const electrobun = dependencies.objects.find((item: { type: string; platform: string }) => item.type === "electrobun" && item.platform === "windows-x64");
  copyFileSync(join(process.env.HUTCH_HOME ?? join(homedir(), ".hutch"), electrobun.relativeRoot, "WebView2Loader.dll"), join(portableDirectory, "runtime/bin/WebView2Loader.dll"));
  const icon = join(projectDir, "packages/assets/logo.ico");
  await $`${csc} /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll /win32icon:${icon} /out:${join(portableDirectory, "toonflow.exe")} ${join(projectDir, "apps/desktop/native/portableLauncher.cs")}`;
  await $`${csc} /nologo /target:exe /platform:x64 /optimize+ /out:${join(portableDirectory, "runtime/bin/checkWebView2.exe")} ${join(projectDir, "apps/desktop/installer/checkWebView2.cs")}`;
  copyFileSync(join(projectDir, "docs/windowsPortable.md"), join(portableDirectory, "readme.md"));
  copyFileSync(join(projectDir, "LICENSE"), join(portableDirectory, "license.txt"));
  const resources = join(portableDirectory, "runtime/Resources");
  const versionPath = join(resources, "version.json");
  const version = await file(versionPath).json();
  // 外层启动器也属于更新内容，不能只沿用 SDK 内层归档的构建号。
  const digest = createHash("sha256").update(Buffer.from(archive));
  for (const path of ["toonflow.exe", "runtime/bin/checkWebView2.exe", "runtime/bin/WebView2Loader.dll"]) {
    digest.update(Buffer.from(await file(join(portableDirectory, path)).arrayBuffer()));
  }
  const hash = digest.digest("hex");
  await writeAtomic(versionPath, JSON.stringify({ ...version, hash, distribution: "portable",
    baseUrl: desktopConfig.release.baseUrl }));
  copyFileSync(join(portableDirectory, "toonflow.exe"), join(resources, "app/portableLauncher.exe"));
  const updateRoot = join(stagingDirectory, "portableUpdate");
  mkdirSync(updateRoot);
  cpSync(join(portableDirectory, "runtime"), join(updateRoot, "toonflow"), { recursive: true });
  const portableTar = join(stagingDirectory, "portable.tar");
  await $`${tar} --format=ustar -cf ${portableTar} -C ${updateRoot} toonflow`;
  const updateFile = "stable-win-x64-toonflowPortable.tar.zst";
  const compressed = Bun.zstdCompressSync(await file(portableTar).arrayBuffer());
  await write(join(outputDirectory, updateFile), compressed);
  await write(join(outputDirectory, "stable-win-x64-portable-update.json"), JSON.stringify({
    ...manifest, hash, distribution: "portable", artifact: { file: updateFile, size: compressed.byteLength, sha256: createHash("sha256").update(compressed).digest("hex") },
  }));
  const zipFile = join(outputDirectory, "toonflowPortable.zip");
  await $`${tar} -a -cf ${zipFile} -C ${outputDirectory} toonflowPortable`;
  if (process.env.releaseNotesFile) copyFileSync(resolve(projectDir, process.env.releaseNotesFile), join(outputDirectory, "releaseNotes.json"));
  console.log(`便携目录：${portableDirectory}\n便携压缩包：${zipFile}\n更新包：${join(outputDirectory, updateFile)}`);
} finally {
  if (dirname(realpathSync(stagingDirectory)) !== realpathSync(tmpdir())) throw new Error("拒绝清理临时目录以外的路径。");
  rmSync(stagingDirectory, { recursive: true });
}
