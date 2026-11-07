import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { mkdir, writeAtomic } from "@toonflow/file";
import { unzipSync } from "fflate";

// 显式准备构建依赖；build 不下载或安装 WebView2 SDK。
const version = "1.0.4078.44";
const digest = "dc4d1d9168df26b830398303e50210b6e1729f6ce5a7ac69d2c766852f489962";
const response = await fetch(`https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${version}/microsoft.web.webview2.${version}.nupkg`, { signal: AbortSignal.timeout(120000) });
if (!response.ok) throw new Error(`WebView2 SDK 下载失败（HTTP ${response.status}）`);
const archive = new Uint8Array(await response.arrayBuffer());
if (createHash("sha256").update(archive).digest("hex") !== digest) throw new Error("WebView2 SDK SHA-256 不匹配");
const files = unzipSync(archive);
const directory = resolve(import.meta.dirname, "../../../build/localHelperSdk/webView2");
await mkdir(directory, { recursive: true });
for (const [source, target] of [
  ["lib/net462/Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.Core.dll"],
  ["lib/net462/Microsoft.Web.WebView2.WinForms.dll", "Microsoft.Web.WebView2.WinForms.dll"],
  ["runtimes/win-x64/native/WebView2Loader.dll", "WebView2Loader.dll"],
  ["LICENSE.txt", "webView2License.txt"],
]) {
  if (!files[source]?.length) throw new Error(`WebView2 SDK 缺少 ${source}`);
  await writeAtomic(resolve(directory, target), files[source]);
}
console.log(`WebView2 SDK ${version} 已准备：${directory}`);
