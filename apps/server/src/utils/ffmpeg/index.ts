import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { lstat, opendir } from "@toonflow/file";
import { downloadSources, type BrowserFfmpegRequest, type DownloadState, type FfmpegFactory } from "@toonflow/ffmpeg";
import { createBrowserFfmpeg } from "@toonflow/ffmpeg/browser";
import { validateFfmpegRequest } from "@toonflow/ffmpeg/validateRequest";
import type { FfmpegRemoteEvent } from "@toonflow/ffmpeg/remote";
import { localMediaStatus } from "@toonflow/local-helper/protocol";
import { callDevice, getMediaStatus, setMediaStatus } from "@/utils/localHelper";
import { executeMedia, requireMediaDevice } from "@/utils/localHelper/media";
import { isWithin, resolveWorkspacePath } from "@/utils/workspace/files";
import { beginWorkspaceOperation } from "@/utils/workspace/activity";
import { webContext } from "@/lib/webContext";
import conf from "@/utils/conf";

export { executeRemoteFfmpeg } from "@toonflow/ffmpeg";
export { validateFfmpegRequest } from "@toonflow/ffmpeg/validateRequest";

const requiredListeners = new Map<() => void, string | undefined>();
const installations = new Map<string, { controller: AbortController; state: DownloadState }>();
const commands = new Map<string, { controller: AbortController; finished: Promise<void> }>();

export function onRequired(listener: () => void) {
  requiredListeners.set(listener, webContext.getStore()?.sessionHash);
  return () => { requiredListeners.delete(listener); };
}

function notifyRequired() {
  const session = webContext.getStore()?.sessionHash;
  for (const [listener, owner] of requiredListeners) if (owner === session) listener();
}

export async function executeWorkspaceFfmpeg(cwd: string, input: BrowserFfmpegRequest, emit: (event: FfmpegRemoteEvent) => void, signal: AbortSignal) {
  const releaseOperation = beginWorkspaceOperation(cwd);
  try {
    const request = structuredClone(input);
    request.directory = cwd;
    const isLocalPath = (path: string) => /^[a-zA-Z]:[\\/]/.test(path) && !isWithin(cwd, path);
    const mapPath = (path: string) => isLocalPath(path) ? path : relative(cwd, path).split(sep).join("/") || ".";
    const localDirectory = request.options.cwd && isLocalPath(request.options.cwd);
    const plan = localDirectory ? { files: new Set<string>(), outputs: new Set<string>(), folders: new Set<string>(), manifests: new Map<string, string>() }
      : await validateFfmpegRequest(request, async value => {
      if (isLocalPath(value)) return value;
      const path = isAbsolute(value) ? relative(cwd, value) : value;
      return (await resolveWorkspacePath(cwd, path)).path;
    }, true, { mapPath, isLocalPath });
    const files = new Set<string>();
    async function addFile(path: string) {
      if (isLocalPath(path)) return;
      signal.throwIfAborted();
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT" || !/%\d*d/.test(path)) throw error; return null; });
      if (!info) {
        const pattern = new RegExp("^" + basename(path).split(/(%\d*d)/).map(part => /^%\d*d$/.test(part) ? "[0-9]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("") + "$");
        for await (const item of await opendir(dirname(path))) if (item.isFile() && pattern.test(item.name))
          await addFile((await resolveWorkspacePath(cwd, mapPath(join(dirname(path), item.name)))).path);
        return;
      }
      if (info.isDirectory()) {
        for await (const item of await opendir(path)) await addFile((await resolveWorkspacePath(cwd, mapPath(join(path, item.name)))).path);
      } else {
        files.add(path);
        if (files.size > 20) throw new Error("本地媒体任务每次最多传输 20 个输入文件");
      }
    }
    for (const path of plan.files) await addFile(path);
    try {
      await executeMedia({ request, inputs: [...files].map(path => ({ name: mapPath(path), path, content: plan.manifests.get(path) })),
        outputs: [...plan.outputs].filter(path => !isLocalPath(path)).map(path => ({ name: mapPath(path), path })),
        folders: [...plan.folders].filter(path => !isLocalPath(path)).map(path => ({ name: mapPath(path), path })) }, emit, signal);
    } catch (error) {
      if ((error as { status?: number }).status === 424) notifyRequired();
      throw error;
    }
  } finally { releaseOperation(); }
}

async function transport(input: BrowserFfmpegRequest, signal?: AbortSignal) {
  const key = input.requestId;
  if (input.operation.method === "prepare") {
    try { await requireMediaDevice(); }
    catch (error) { notifyRequired(); throw error; }
    return Response.json({ code: 200 });
  }
  if (input.operation.method === "cancel") {
    const command = commands.get(key);
    command?.controller.abort();
    await command?.finished;
    return Response.json({ code: 200 });
  }
  const controller = new AbortController();
  const finished = Promise.withResolvers<void>();
  let closed = false;
  commands.set(key, { controller, finished: finished.promise });
  const stream = new ReadableStream<Uint8Array>({
    start(output) {
      const emit = (event: FfmpegRemoteEvent) => { if (!closed) output.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); };
      void executeWorkspaceFfmpeg(input.directory, input, emit, signal ? AbortSignal.any([controller.signal, signal]) : controller.signal)
        .catch(error => emit({ event: "error", args: [{ name: error.name, message: error.message, code: error.code }] }))
        .finally(() => { commands.delete(key); finished.resolve(); if (!closed) { closed = true; output.close(); } });
    },
    cancel() { closed = true; controller.abort(); return finished.promise; },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

export async function createWorkspaceFfmpeg(cwd: string, signal?: AbortSignal): Promise<FfmpegFactory> {
  // ACT: 复用文件型 fluent 桥接；服务器不再提供 Node Stream 或子进程入口。
  return await createBrowserFfmpeg(cwd, signal, transport) as unknown as FfmpegFactory;
}

export async function executeFileFfmpeg(source: string, output: string | undefined, calls: BrowserFfmpegRequest["calls"],
  operation: BrowserFfmpegRequest["operation"], signal: AbortSignal) {
  const inputName = `input${/\.[a-z0-9]+$/i.exec(source)?.[0] ?? ".bin"}`;
  let terminal: FfmpegRemoteEvent | undefined;
  await executeMedia({ request: { requestId: crypto.randomUUID(), directory: dirname(source),
    options: { source: inputName }, calls, operation },
    inputs: [{ name: inputName, path: source }], outputs: output ? [{ name: "output" + (/\.[a-z0-9]+$/i.exec(output)?.[0] ?? ".bin"), path: output }] : [],
  }, event => { if (["end", "result"].includes(event.event)) terminal = event; }, signal);
  return terminal?.args[0];
}

export async function getProgress() {
  const device = await requireMediaDevice();
  const state = installations.get(device.id)?.state;
  const progress = getMediaStatus(device.id)?.download;
  return state && ["downloading", "verifying", "installing"].includes(state.phase)
    ? progress && ["downloading", "verifying", "installing"].includes(progress.phase) ? progress : state
    : state ?? progress ?? { phase: "idle", received: 0 };
}

export async function getStatus(refresh = false, signal?: AbortSignal) {
  const device = await requireMediaDevice();
  const cached = getMediaStatus(device.id);
  const status = localMediaStatus.parse(!cached || refresh ? await callDevice(device, { action: "ffmpegStatus" }, signal) : cached);
  setMediaStatus(device.id, status);
  const raw = conf.get("settings", {}).ffmpeg as { source?: string } | undefined;
  return { ...status, execution: "localHelper", device: { id: device.id, name: device.name },
    config: { mode: "download", source: downloadSources.find(source => source.id === raw?.source)?.id ?? "npmmirror" },
    sources: downloadSources.map(({ id, label, description, available, homepage }) => ({ id, label, description, available, homepage })),
    download: await getProgress() };
}

export async function startDownload(source: string) {
  const device = await requireMediaDevice();
  if (!downloadSources.some(item => item.id === source && item.available)) throw Object.assign(new Error("此下载源暂不可用"), { status: 400 });
  const previous = installations.get(device.id);
  if (previous && ["downloading", "verifying", "installing"].includes(previous.state.phase)) throw Object.assign(new Error("本地助手正在安装 FFmpeg"), { status: 409 });
  const entry = { controller: new AbortController(), state: { phase: "downloading", received: 0 } as DownloadState };
  installations.set(device.id, entry);
  void callDevice(device, { action: "ffmpegInstall", source }, entry.controller.signal)
    .then(result => { setMediaStatus(device.id, localMediaStatus.parse(result)); entry.state = { phase: "completed", received: 0 }; })
    .catch(error => { entry.state = { phase: entry.controller.signal.aborted ? "cancelled" : "error", received: 0, error: error.message }; })
    .finally(() => {
      const timer = setTimeout(() => { if (installations.get(device.id) === entry) installations.delete(device.id); }, 60000);
      timer.unref();
    });
  return entry.state;
}

export async function cancelDownload() {
  const device = await requireMediaDevice();
  installations.get(device.id)?.controller.abort();
  return { phase: "cancelled", received: 0 } as DownloadState;
}
