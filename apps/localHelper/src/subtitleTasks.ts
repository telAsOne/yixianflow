import { basename, dirname, extname, join } from "node:path";
import { constants, copyFile, link, lstat, mkdir, mkdtemp, opendir, readFile, readdir, rm, unlink, writeAtomic } from "@toonflow/file";
import { createFfmpeg } from "@toonflow/ffmpeg/runtime";
import type { FfmpegCommand, FfprobeData } from "@toonflow/ffmpeg/types";
import { parseSrt, serializeSrt } from "@toonflow/node-shared/subtitleSrt";
import { transcribeWhisper } from "@toonflow/node-subtitle/whisperRuntime";
import { z } from "zod";
import { createWhisperEnvironment } from "./whisperInstall";
import { fileRevision, localPath } from "./operations";
import { dataDirectory, logError } from "./logger";
import { getMediaStatus } from "./media";
import { parseSubtitleReview, subtitleBatchLimit, subtitleTaskSchema, subtitleCommand, subtitleReviewInstruction } from "./subtitleProtocol";
import type { SubtitleCandidate, SubtitleReport, SubtitleSnapshot, SubtitleTask, SubtitleTaskSummary } from "./subtitleProtocol";
import type { LocalComputerRequest, LocalHelperRequest } from "./protocol";

type ChatMessage = { role: "system" | "user"; content: string };
type Dependencies = {
  send: (message: Record<string, unknown>) => void;
  account: () => string;
  review?: (messages: ChatMessage[], signal: AbortSignal) => Promise<string>;
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
};
const terminalStates = new Set(["completed", "noSpeech", "failed", "cancelled", "interrupted", "waitingEnvironment"]);
const videoExtensions = new Set([".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v", ".ts", ".mts", ".m2ts", ".wmv", ".flv"]);
const taskRoot = join(dataDirectory, "subtitleTasks");

async function info(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
}

function execute(command: FfmpegCommand, signal: AbortSignal, progress?: (percent: number) => void) {
  signal.throwIfAborted();
  const cancel = () => command.kill("SIGKILL");
  signal.addEventListener("abort", cancel, { once: true });
  return new Promise<void>((resolve, reject) => {
    command.on("start", () => { if (signal.aborted) command.kill("SIGKILL"); });
    command.on("progress", value => { if (Number.isFinite(value.percent)) progress?.(Math.min(99, value.percent!)); });
    command.on("error", error => reject(signal.aborted ? signal.reason : error));
    command.on("end", () => signal.aborted ? reject(signal.reason) : resolve());
    command.run();
  }).finally(() => signal.removeEventListener("abort", cancel));
}

async function publishFile(source: string, target: string) {
  try { await link(source, target); }
  catch (error) {
    if (!["EXDEV", "ENOSYS", "EPERM", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
    try { await copyFile(source, target, constants.COPYFILE_EXCL); }
    catch (cause) { throw new Error(`成片保存失败，可能存在未完成目标文件，请核对 ${target}`, { cause }); }
  }
}

export function createSubtitleTasks(dependencies: Dependencies) {
  const tasks = new Map<string, SubtitleTask>();
  const scans = new Map<string, { files: SubtitleCandidate[]; account: string }>();
  const requests = new Map<string, string[]>();
  const pending: { id: string; renderOnly: boolean }[] = [];
  let page = 0;
  let paused = false;
  let active: { id: string; controller: AbortController } | undefined;
  let pumping: Promise<void> | undefined;
  let writes = Promise.resolve();
  let admissions = Promise.resolve();
  let lastProgress = 0;
  let synchronizing: Promise<void> | undefined;
  const environment = createWhisperEnvironment(() => sendSnapshot());
  const visibleForAccount = (task: SubtitleTask) => task.accountScope === "local" || task.accountScope === dependencies.account();

  function summary(task: SubtitleTask): SubtitleTaskSummary {
    const { segments, review, renders, remote, ...rest } = task;
    return { ...rest, segmentCount: segments.length,
      review: { state: review.state, changed: review.changed, issueCount: review.issues.length, error: review.error }, output: renders.at(-1), synced: remote?.delivered };
  }

  function sendSnapshot() {
    const visible = [...tasks.values()].filter(visibleForAccount).sort((a, b) => b.createdAt - a.createdAt);
    page = Math.min(page, Math.max(0, Math.ceil(visible.length / 20) - 1));
    const snapshot: SubtitleSnapshot = { environment: environment.snapshot(), tasks: visible.slice(page * 20, page * 20 + 20).map(summary),
      total: visible.length, page, paused };
    dependencies.send({ type: "subtitleSnapshot", snapshot });
  }

  async function save(task: SubtitleTask) {
    task.updatedAt = Date.now();
    const content = JSON.stringify(subtitleTaskSchema.parse(task));
    if (Buffer.byteLength(content) > 16 * 1024 * 1024) throw new Error("本条字幕任务记录超过 16 MiB，未覆盖旧记录");
    const write = writes.then(() => writeAtomic(join(taskRoot, task.id, "task.json"), content, { mode: 0o600 }));
    writes = write.catch(() => {});
    await write;
    sendSnapshot();
  }

  function find(id: string) {
    const task = tasks.get(id);
    if (!task || !visibleForAccount(task)) throw new Error("字幕任务不存在或不属于当前账户");
    return task;
  }

  function detail(task: SubtitleTask, offset = 0) {
    dependencies.send({ type: "subtitleDetail", task: summary(task), offset, segments: task.segments.slice(offset, offset + 50),
      issues: task.review.issues.filter(issue => issue.index >= offset && issue.index < offset + 50).slice(0, 30)
        .map(issue => ({ ...issue, before: issue.before?.slice(0, 2000), after: issue.after?.slice(0, 2000) })) });
  }

  async function recoverPublication(task: SubtitleTask) {
    const receipt = join(taskRoot, task.id, "publication.json");
    if (!await info(receipt)) return;
    const publication = z.strictObject({ output: z.string(), outputSrt: z.string(), revision: z.number().int().nonnegative(), id: z.string().regex(/^[a-f0-9]{32}$/) })
      .parse(JSON.parse(await readFile(receipt, "utf8")));
    const prefix = `${basename(task.sourcePath)}.字幕版.r${publication.revision}.${task.id.slice(0, 8)}.`;
    for (const path of [publication.output, publication.outputSrt]) {
      if (dirname(path) !== dirname(task.sourcePath) || !basename(path).startsWith(prefix)) throw new Error("上次成片发布记录的目标不属于本任务，未处理");
    }
    if (!await info(publication.output) || !await info(publication.outputSrt)) {
      task.error = `上次成片发布未全部完成，已有文件保留：${publication.output}`;
      return;
    }
    if (!task.renders.some(render => render.path === publication.output)) {
      const tools = await getMediaStatus();
      if (!tools.tools.ffprobe.path) { task.error = "上次已有成片待核对，请修复 ffprobe 后继续"; return; }
      const ffmpeg = createFfmpeg(dirname(task.sourcePath), { localFiles: true });
      ffmpeg.setFfprobePath(tools.tools.ffprobe.path);
      const media = await new Promise<FfprobeData>((resolve, reject) => ffmpeg(publication.output).ffprobe((error, data) => error ? reject(error) : resolve(data)));
      if (!media.streams.some(stream => stream.codec_type === "video") || !task.duration || !Number.isFinite(Number(media.format.duration))
        || Math.abs(Number(media.format.duration) - task.duration) > Math.max(1, task.duration * .01)) throw new Error("上次发布成片时长无效，未记录为成功");
      if (!parseSrt(await readFile(publication.outputSrt, "utf8")).length) throw new Error("上次发布的字幕为空，未记录为成功");
      task.renders.push({ id: crypto.randomUUID(), revision: publication.revision, path: publication.output, subtitlePath: publication.outputSrt, at: Date.now() });
    }
    task.state = "completed"; task.progress = 100; task.error = undefined;
    await save(task);
    await unlink(receipt);
  }

  function updateProgress(task: SubtitleTask, percent: number) {
    task.progress = Math.max(0, Math.min(99, percent));
    if (Date.now() - lastProgress > 500) { lastProgress = Date.now(); sendSnapshot(); }
  }

  async function scan(paths: string[], recursive: boolean) {
    const files: SubtitleCandidate[] = [];
    const seen = new Set<string>();
    const errors: string[] = [];
    const outputs = new Set([...tasks.values()].flatMap(task => task.renders.map(render => render.path.toLowerCase())));
    let entries = 0;
    const folders: { path: string; expand: boolean }[] = [];
    async function add(path: string) {
      if (files.length >= 5000) throw new Error("本次扫描达到 5000 个视频上限，请缩小文件夹范围");
      const resolved = await localPath(path);
      if (seen.has(resolved.toLowerCase()) || outputs.has(resolved.toLowerCase())) return;
      if (!videoExtensions.has(extname(resolved).toLowerCase()) || /\.字幕版\.r\d+\./i.test(basename(resolved))) return;
      const file = await lstat(resolved);
      if (!file.isFile() || file.isSymbolicLink()) return;
      seen.add(resolved.toLowerCase());
      const existing = [...tasks.values()].find(task => visibleForAccount(task)
        && task.sourcePath.toLowerCase() === resolved.toLowerCase() && task.sourceRevision === fileRevision(file));
      files.push({ path: resolved, name: basename(resolved), size: file.size, existingId: existing?.id });
    }
    for (const path of paths) {
      const resolved = await localPath(path);
      const entry = await lstat(resolved);
      if (entry.isDirectory()) folders.push({ path: resolved, expand: recursive });
      else await add(resolved);
    }
    while (folders.length) {
      const folder = folders.pop()!;
      try {
        for await (const entry of await opendir(folder.path)) {
          if (++entries > 100000) throw new Error("扫描目录条目过多，请缩小范围");
          const path = join(folder.path, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory() && folder.expand) folders.push({ path, expand: true });
          else if (entry.isFile()) await add(path);
        }
      } catch (error) {
        if (files.length >= 5000 || entries > 100000) throw error;
        errors.push(`${folder.path}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const scanId = crypto.randomUUID();
    scans.set(scanId, { files, account: dependencies.account() });
    while (scans.size > 5) scans.delete(scans.keys().next().value!);
    dependencies.send({ type: "subtitleScanResult", scanId, files: files.slice(0, 100), total: files.length, offset: 0, errors: errors.slice(0, 20) });
    return { scanId, files: files.slice(0, 100), total: files.length, offset: 0, errors: errors.slice(0, 20) };
  }

  async function review(task: SubtitleTask, signal: AbortSignal) {
    task.review = { state: "completed", changed: 0, issues: [] };
    const revision = task.subtitleRevision;
    const original = structuredClone(task.segments);
    const reviewSignal = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    for (let offset = 0; offset < original.length;) {
      const segments: { index: number; text: string }[] = [];
      let characters = 0;
      for (let index = offset; index < Math.min(original.length, offset + 20); index++) {
        if (segments.length && characters + original[index].text.length > 12000) break;
        segments.push({ index, text: original[index].text });
        characters += original[index].text.length;
      }
      try {
        if (!dependencies.review) throw new Error("当前未绑定文本模型账户，已记录并继续合成");
        const response = await dependencies.review([
          { role: "system", content: subtitleReviewInstruction },
          { role: "user", content: JSON.stringify({ segments, contextBefore: original.slice(Math.max(0, offset - 2), offset).map(item => item.text.slice(0, 1000)),
            contextAfter: original.slice(offset + segments.length, offset + segments.length + 2).map(item => item.text.slice(0, 1000)) }) },
        ], reviewSignal);
        signal.throwIfAborted();
        const parsed = parseSubtitleReview(response);
        if (task.subtitleRevision !== revision) throw new Error("字幕版本已变化，未应用过期审查");
        const corrected = new Set<number>();
        for (const correction of parsed.corrections) {
          const current = original[correction.index];
          if (correction.index < offset || correction.index >= offset + segments.length || corrected.has(correction.index)
            || !current || current.text !== correction.original || !correction.text.trim() || /\n\s*\n|-->/g.test(correction.text))
            throw new Error("AI 返回了不匹配原文或无效的字幕修改");
          corrected.add(correction.index);
          serializeSrt([{ ...current, text: correction.text }]);
        }
        if (parsed.uncertain.some(issue => issue.index < offset || issue.index >= offset + segments.length)) throw new Error("AI 疑问记录的行编号越界");
        for (const correction of parsed.corrections) {
          if (correction.text === correction.original) continue;
          task.segments[correction.index].text = correction.text;
          task.review.changed++;
          task.review.issues.push({ index: correction.index, before: correction.original, after: correction.text, reason: correction.reason });
        }
        task.review.issues.push(...parsed.uncertain.map(issue => ({ index: issue.index, reason: issue.reason })));
        offset += segments.length;
      } catch (error) {
        signal.throwIfAborted();
        task.review.state = task.review.changed ? "partial" : "failed";
        task.review.error = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
        task.review.issues.push({ index: offset, reason: `本段及后续字幕未审查：${task.review.error}` });
        break;
      }
    }
    if (task.review.changed) task.subtitleRevision++;
    task.reviewedRevision = task.subtitleRevision;
    await writeAtomic(join(taskRoot, task.id, `subtitle${task.subtitleRevision}.srt`), serializeSrt(task.segments));
    await save(task);
  }

  async function run(task: SubtitleTask, renderOnly: boolean, signal: AbortSignal) {
    let temporary: string | undefined;
    try {
      signal.throwIfAborted();
      const source = await localPath(task.sourcePath);
      if (fileRevision(await lstat(source)) !== task.sourceRevision) throw new Error("源视频已变化，请重新扫描并创建任务");
      task.error = undefined;
      task.state = "probing"; task.progress = 0; await save(task);
      const tools = await getMediaStatus(true);
      if (!tools.tools.ffmpeg.path || !tools.tools.ffprobe.path || tools.tools.ffmpeg.error || tools.tools.ffprobe.error)
        throw new Error("本机 FFmpeg／ffprobe 不可用，请先在工具环境修复组件");
      const ffmpeg = createFfmpeg(dirname(source), { localFiles: true });
      ffmpeg.setFfmpegPath(tools.tools.ffmpeg.path);
      ffmpeg.setFfprobePath(tools.tools.ffprobe.path);
      const probe = (path: string) => new Promise<FfprobeData>((resolve, reject) => ffmpeg(path).ffprobe((error, data) => error ? reject(error) : resolve(data)));
      const media = await probe(source);
      signal.throwIfAborted();
      const stream = media.streams.find(item => item.codec_type === "video" && !item.disposition?.attached_pic);
      if (!stream && task.mode !== "transcribe") throw new Error("源文件没有有效视频流");
      const duration = Number(stream?.duration || media.format.duration);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法读取有效视频时长");
      if (task.mode !== "transcribe" && (stream?.color_transfer === "smpte2084" || stream?.color_transfer === "arib-std-b67"))
        throw new Error("当前自动字幕合成仅支持 SDR 视频，该 HDR 视频未转换以避免颜色失真");
      task.duration = duration; task.width = stream?.width; task.height = stream?.height;
      const hasAudio = media.streams.some(item => item.codec_type === "audio");
      if (!hasAudio && !renderOnly) throw new Error("视频没有音轨，无法进行语音识别");
      const preparation = renderOnly || task.segments.length ? undefined : await environment.prepare(task.modelChoice);
      const hardware = preparation?.hardware || (await environment.refresh()).hardware;
      if (!hardware) throw new Error("无法读取剩余磁盘空间");
      const outputDisk = hardware.disks.find(disk => source.toLowerCase().startsWith(`${disk.path.toLowerCase()}\\`));
      const sourceBytes = (await lstat(source)).size;
      const outputBudget = Math.max(sourceBytes * 3, duration * 2_000_000, 512 * 1024 * 1024);
      if (task.mode !== "transcribe" && (!outputDisk || outputDisk.free < outputBudget)) throw new Error("源视频所在磁盘空间不足，请释放空间后重新合成");
      if (preparation && (hardware.memoryFree < preparation.model.ramBytes + duration * 16000 * 8 + 1024 ** 3
        || hardware.storageFree < duration * 32000 + 1024 ** 3)) throw new Error("本视频解码需要的可用内存或缓存盘空间不足，请缩短视频或释放资源");
      const folders = join(environment.snapshot().settings.directory, "tasks");
      await mkdir(folders, { recursive: true });
      temporary = await mkdtemp(join(folders, "subtitle"));
      if (!renderOnly && !task.segments.length) {
        task.model = preparation!.model.id;
        task.state = "extracting"; await save(task);
        const audioPath = join(temporary, "audio.wav");
        await execute(ffmpeg(source).noVideo().audioCodec("pcm_s16le").audioFrequency(16000).audioChannels(1).output(audioPath).outputOptions("-n"),
          signal, percent => updateProgress(task, percent * 0.1));
        task.state = "transcribing"; await save(task);
        await transcribeWhisper({ pythonPath: preparation!.pythonPath, modelPath: preparation!.modelPath,
          audioPath, directory: temporary, language: task.language, device: preparation!.device, signal,
          onProgress: seconds => updateProgress(task, 10 + Math.min(60, seconds / duration * 60)) });
        signal.throwIfAborted();
        task.segments = parseSrt(await readFile(join(temporary, "audio.srt"), "utf8"));
        if (!task.segments.length) {
          task.state = "noSpeech"; task.progress = 100; task.review = { state: "skipped", changed: 0, issues: [] };
          await save(task); return;
        }
        task.subtitleRevision = 1;
        await writeAtomic(join(taskRoot, task.id, "original.srt"), serializeSrt(task.segments), { exclusive: true });
        await writeAtomic(join(taskRoot, task.id, "subtitle1.srt"), serializeSrt(task.segments), { exclusive: true });
        await save(task);
      }
      if (!renderOnly && task.review.state === "pending") {
        task.state = "reviewing"; task.progress = 70; await save(task);
        await review(task, signal);
      }
      if (task.mode === "transcribe") { task.state = "completed"; task.progress = 100; await save(task); return; }
      const revision = task.subtitleRevision;
      const subtitles = serializeSrt(task.segments);
      if (!subtitles || task.segments.some(segment => segment.end > duration + 0.5)) throw new Error("字幕时间轴为空或超出视频时长，请编辑后重新合成");
      const filters = await new Promise<Record<string, unknown>>((resolve, reject) => ffmpeg().availableFilters((error, data) => error ? reject(error) : resolve(data)));
      if (!filters.subtitles) throw new Error("FFmpeg 缺少 libass subtitles 滤镜，无法烧录字幕");
      const encoders = await new Promise<Record<string, unknown>>((resolve, reject) => ffmpeg().availableEncoders((error, data) => error ? reject(error) : resolve(data)));
      if (!encoders.libx264 || hasAudio && !encoders.aac) throw new Error("FFmpeg 缺少 libx264／AAC 编码器");
      task.state = "rendering"; task.progress = 75; await save(task);
      const token = crypto.randomUUID().replaceAll("-", "");
      const subtitleFile = `.subtitle${token}.srt`;
      const subtitlePath = join(dirname(source), subtitleFile);
      const videoTemporary = join(dirname(source), `.subtitle${token}.mp4`);
      let published = false;
      try {
        await writeAtomic(subtitlePath, subtitles, { exclusive: true });
        const command = ffmpeg(source).output(videoTemporary).videoCodec("libx264").format("mp4")
          .videoFilters([{ filter: "subtitles", options: { filename: subtitleFile, force_style: "Fontname=Microsoft YaHei,Fontsize=20,Outline=2,MarginV=20" } },
            { filter: "pad", options: "ceil(iw/2)*2:ceil(ih/2)*2" }])
          .outputOptions("-n", "-map", `0:${stream!.index}`, "-map", "0:a:0?", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-threads", "2");
        if (hasAudio) command.audioCodec("aac"); else command.noAudio();
        await execute(command, signal, percent => updateProgress(task, 75 + percent * 0.22));
        signal.throwIfAborted();
        const result = await probe(videoTemporary);
        if (!result.streams.some(item => item.codec_type === "video") || hasAudio && !result.streams.some(item => item.codec_type === "audio")
          || !Number.isFinite(Number(result.format.duration)) || Math.abs(Number(result.format.duration) - duration) > Math.max(1, duration * 0.01))
          throw new Error("合成结果的时长或音视频流不完整，未发布成片");
        task.state = "publishing"; task.progress = 98; await save(task);
        const base = `${basename(source)}.字幕版.r${revision}.${task.id.slice(0, 8)}.${token.slice(0, 6)}`;
        const output = join(dirname(source), `${base}.mp4`);
        const outputSrt = join(dirname(source), `${base}.srt`);
        // 持久化发布意图，重启时不会把已发布成片误认为需要再次编码。
        await writeAtomic(join(taskRoot, task.id, "publication.json"), JSON.stringify({ output, outputSrt, revision, id: token }));
        await publishFile(subtitlePath, outputSrt);
        await publishFile(videoTemporary, output);
        published = true;
        task.renders.push({ id: crypto.randomUUID(), revision, path: output, subtitlePath: outputSrt, at: Date.now() });
        task.state = "completed"; task.progress = 100;
        await save(task);
        await unlink(join(taskRoot, task.id, "publication.json"));
      } finally {
        for (const path of [subtitlePath, videoTemporary]) {
          await unlink(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw new Error(`${published ? "成片已保存；" : ""}本次临时文件清理失败：${path}`, { cause: error });
          });
        }
      }
    } catch (error) {
      task.state = signal.aborted ? "cancelled" : (error as { code?: string }).code === "WHISPER_SETUP_REQUIRED" ? "waitingEnvironment" : "failed";
      task.error = (error instanceof Error ? error.message : String(error)).slice(0, 6000);
      await save(task);
      void logError("subtitleTaskFailed", error, { source: "tray", taskId: task.id, cancelled: signal.aborted });
    } finally {
      if (temporary) {
        const directory = temporary;
        if (dirname(directory) !== join(environment.snapshot().settings.directory, "tasks")) throw new Error("字幕临时目录归属无效，未清理");
        await rm(directory, { recursive: true, force: true }).catch(error => {
          void logError("subtitleCleanupFailed", error, { source: "tray", taskId: task.id });
          dependencies.send({ type: "notice", message: `字幕缓存清理失败，保留目录：${directory}` });
        });
      }
    }
  }

  function pump() {
    if (pumping || paused) return;
    pumping = (async () => {
      while (pending.length && !paused) {
        const job = pending.shift()!;
        const task = tasks.get(job.id)!;
        if (!visibleForAccount(task)) { task.state = "interrupted"; task.error = "任务所属账户已切换，请切回原账户继续"; await save(task); continue; }
        if (task.state === "cancelled") continue;
        const controller = new AbortController();
        active = { id: task.id, controller };
        await dependencies.exclusive(() => run(task, job.renderOnly, controller.signal));
        active = undefined;
      }
    })().catch(error => { void logError("subtitleQueueFailed", error); dependencies.send({ type: "notice", message: error instanceof Error ? error.message : String(error) }); })
      .finally(() => { pumping = undefined; active = undefined; sendSnapshot(); });
  }

  async function createBatch(scanId: string, paths: string[], requestId: string, options?: { model?: SubtitleTask["modelChoice"]; language?: string }) {
    if (!paths.length || paths.length > subtitleBatchLimit) throw new Error(`每批请选择 1–${subtitleBatchLimit} 个视频`);
    const prior = requests.get(requestId);
    if (prior) { dependencies.send({ type: "subtitleAccepted", requestId, ids: prior }); return prior; }
    const scan = scans.get(scanId);
    if (!scan || scan.account !== dependencies.account() || paths.some(path => !scan.files.some(file => file.path === path))) throw new Error("选择的视频不属于本次扫描，请重新选择");
    const ids: string[] = [];
    for (const path of paths) {
      const source = await lstat(path);
      if (!source.isFile() || source.isSymbolicLink()) throw new Error("扫描后的视频文件类型已变化，请重新选择");
      const revision = fileRevision(source);
      const existing = [...tasks.values()].find(task => visibleForAccount(task) && task.sourcePath.toLowerCase() === path.toLowerCase()
        && task.sourceRevision === revision);
      if (existing) { ids.push(existing.id); continue; }
      const id = crypto.randomUUID();
      const task: SubtitleTask = { id, batchId: requestId, sourcePath: path, sourceRevision: revision, accountScope: dependencies.account(), mode: "video",
        modelChoice: options?.model ?? environment.snapshot().settings.model, createdAt: Date.now(), updatedAt: Date.now(), state: "queued", progress: 0,
        language: options?.language ?? environment.snapshot().settings.language, subtitleRevision: 0, segments: [], review: { state: "pending", changed: 0, issues: [] }, renders: [] };
      await mkdir(join(taskRoot, id));
      await save(task);
      tasks.set(id, task); ids.push(id); pending.push({ id, renderOnly: false });
      requests.set(requestId, [...ids]);
    }
    requests.set(requestId, ids);
    dependencies.send({ type: "subtitleAccepted", requestId, ids });
    sendSnapshot(); pump();
    return ids;
  }

  function start(scanId: string, paths: string[], requestId: string, options?: { model?: SubtitleTask["modelChoice"]; language?: string }) {
    const admitted = admissions.then(() => createBatch(scanId, paths, requestId, options)).finally(() => { sendSnapshot(); pump(); });
    admissions = admitted.then(() => {}, () => {});
    return admitted;
  }

  const api = {
    busy: () => !!active || !!pending.length || environment.busy(),
    snapshot: sendSnapshot,
    async initialize() {
      await mkdir(taskRoot, { recursive: true });
      await environment.initialize();
      for (const entry of await readdir(taskRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success) continue;
        try {
          const path = join(taskRoot, entry.name, "task.json");
          if ((await lstat(path)).size > 16 * 1024 * 1024) throw new Error("任务记录超过读取上限");
          const task = subtitleTaskSchema.parse(JSON.parse(await readFile(path, "utf8")));
          if (task.id !== entry.name) throw new Error("任务文件编号不匹配");
          tasks.set(task.id, task);
          requests.set(task.batchId, [...(requests.get(task.batchId) || []), task.id]);
          if (!terminalStates.has(task.state)) {
            task.state = "interrupted"; task.error = "上次处理已中断，已有字幕和成片保留，可继续处理";
            if (task.review.state === "pending" && task.segments.length) {
              task.review.state = "failed"; task.review.error = "上次审查结果未确认，不重复收费请求；继续时使用已保存字幕";
            }
            await save(task);
          }
          await recoverPublication(task);
        } catch (error) { void logError("subtitleTaskLoadFailed", error); dependencies.send({ type: "notice", message: `字幕任务 ${entry.name} 无法读取，原文件已保留` }); }
      }
      sendSnapshot();
    },
    async command(raw: unknown) {
      const command = subtitleCommand.parse(raw);
      if (command.type === "subtitleSnapshot") { page = command.page ?? page; sendSnapshot(); return; }
      if (command.type === "subtitleEnvironment") return environment.refresh(command.rescan);
      if (command.type === "subtitleSettings") {
        if (active || pending.length) throw new Error("请先完成或取消排队任务，再修改识别设置");
        return environment.settings(command.settings);
      }
      if (command.type === "subtitleInstall") {
        if (active || pending.length) throw new Error("请先暂停任务再准备识别环境");
        if (command.settings) await environment.settings(command.settings);
        await environment.install(command.model);
        for (const task of tasks.values()) {
          if (visibleForAccount(task) && task.state === "waitingEnvironment") {
            task.state = "queued"; task.error = undefined; await save(task);
            pending.push({ id: task.id, renderOnly: task.segments.length > 0 });
          }
        }
        pump();
        return;
      }
      if (command.type === "subtitleInstallCancel") { environment.cancel(); return; }
      if (command.type === "subtitleScan") return scan(command.paths, command.recursive);
      if (command.type === "subtitleScanPage") {
        const scan = scans.get(command.scanId);
        if (!scan || scan.account !== dependencies.account()) throw new Error("扫描记录已过期，请重新扫描");
        dependencies.send({ type: "subtitleScanResult", scanId: command.scanId, files: scan.files.slice(command.offset, command.offset + 100), total: scan.files.length, offset: command.offset, errors: [] });
        return;
      }
      if (command.type === "subtitleStart") return start(command.scanId, command.paths, command.requestId, command);
      if (command.type === "subtitlePause") {
        paused = command.paused;
        if (paused) active?.controller.abort(); else pump();
        sendSnapshot(); return;
      }
      const task = find(command.id);
      if (command.type === "subtitleDetail") { detail(task, command.offset); return; }
      if (command.type === "subtitleCancel") {
        if (active?.id === task.id) active.controller.abort();
        else { task.state = "cancelled"; await save(task); }
        return;
      }
      if (command.type === "subtitleSave") {
        if (!terminalStates.has(task.state)) throw new Error("任务执行中，请完成或取消后再编辑字幕");
        if (task.subtitleRevision !== command.revision) throw new Error("字幕已更新，请重新读取后保存");
        if (command.offset > task.segments.length || command.offset + command.segments.length > task.segments.length)
          throw new Error("字幕编辑范围无效");
        const next = structuredClone(task.segments);
        next.splice(command.offset, command.segments.length, ...command.segments);
        serializeSrt(next);
        if (task.duration && next.some(segment => segment.end > task.duration! + 0.5)) throw new Error("字幕时间超出视频时长，未保存");
        await writeAtomic(join(taskRoot, task.id, `subtitle${task.subtitleRevision + 1}.srt`), serializeSrt(next), { exclusive: true });
        task.segments = next; task.subtitleRevision++;
        await save(task); detail(task, command.offset); return;
      }
      if (command.type === "subtitleRender") {
        if (environment.busy()) throw new Error("正在安装识别环境，请安装完成后再处理字幕任务");
        if (active?.id === task.id || pending.some(item => item.id === task.id)) throw new Error("该任务已经在执行或排队");
        task.state = "queued"; task.error = undefined; await save(task);
        pending.push({ id: task.id, renderOnly: task.segments.length > 0 }); pump(); return;
      }
      if (command.type === "subtitleOpen") {
        dependencies.send({ type: "subtitleReveal", path: dirname(task.renders.at(-1)?.path || task.sourcePath) }); return;
      }
      if (command.type === "subtitlePreview") {
        const path = command.output ? task.renders.at(-1)?.path : task.sourcePath;
        if (!path) throw new Error("当前任务还没有成片");
        const previewDirectory = join(dataDirectory, "subtitlePreviews", task.id);
        await mkdir(previewDirectory, { recursive: true });
        const name = `${command.output ? `output${task.renders.length}` : "source"}${extname(path)}`;
        const target = join(previewDirectory, name);
        if (!await info(target)) {
          const hardware = (await environment.refresh()).hardware;
          const disk = hardware?.disks.find(item => target.toLowerCase().startsWith(`${item.path.toLowerCase()}\\`));
          if (!disk || disk.free < (await lstat(path)).size + 1024 ** 3) throw new Error("预览缓存盘空间不足，可从所在目录打开原视频");
          await copyFile(path, target, constants.COPYFILE_EXCL);
        }
        dependencies.send({ type: "subtitlePreviewReady", id: task.id, directory: previewDirectory, url: `https://subtitle${task.id.replaceAll("-", "")}.unionflow.app/${name}` });
      }
    },
    async acceptRemote(request: Extract<LocalHelperRequest, { action: "subtitleTranscribe" }>, sourcePath: string) {
      const existing = tasks.get(request.operationId);
      if (existing) {
        if (!visibleForAccount(existing) || existing.remote?.token !== request.token) throw new Error("画布字幕任务编号与已有记录冲突");
        return { status: "accepted", id: existing.id };
      }
      if (sourcePath !== join(taskRoot, request.operationId, request.fileName)) throw new Error("画布素材路径不属于本任务");
      const source = await lstat(sourcePath);
      const task: SubtitleTask = { mode: "transcribe", remote: { operationId: request.operationId, token: request.token, delivered: false },
        id: request.operationId, batchId: request.operationId, sourcePath, sourceRevision: fileRevision(source), accountScope: dependencies.account(),
        modelChoice: request.model, createdAt: Date.now(), updatedAt: Date.now(), state: "queued", progress: 0, language: request.language,
        subtitleRevision: 0, segments: [], review: { state: "pending", changed: 0, issues: [] }, renders: [] };
      await save(task); tasks.set(task.id, task); pending.push({ id: task.id, renderOnly: false }); sendSnapshot(); pump();
      return { status: "accepted", id: task.id };
    },
    remoteIds: () => [...tasks.values()].filter(task => visibleForAccount(task) && task.remote && !task.remote.delivered).map(task => task.id).slice(0, 100),
    async synchronize(report: (report: SubtitleReport) => Promise<unknown>) {
      if (synchronizing) return synchronizing;
      synchronizing = (async () => {
        for (const task of tasks.values()) {
          if (!visibleForAccount(task) || !task.remote || task.remote.delivered) continue;
          const terminal = terminalStates.has(task.state);
          try {
            const srt = task.state === "completed" ? serializeSrt(task.segments) : undefined;
            if (srt && Buffer.byteLength(srt) > 2 * 1024 * 1024) throw new Error("字幕结果超过 2 MiB，已保留在本机");
            await report({ operationId: task.id, token: task.remote.token, state: task.state as SubtitleReport["state"], model: task.model,
              progress: task.progress, error: task.error, srt, review: { state: task.review.state, changed: task.review.changed, issueCount: task.review.issues.length, error: task.review.error } });
            if (terminal) { task.remote.delivered = true; await save(task); }
          } catch (error) {
            if ([403, 409, 410].includes((error as { status?: number }).status || 0)) {
              if (!terminal) { if (active?.id === task.id) active.controller.abort(); else task.state = "cancelled"; }
              task.remote.delivered = true; await save(task);
            }
            // 回传失败保留本机结果，下轮仅回传，绝不重新识别。
          }
        }
      })().finally(() => { synchronizing = undefined; });
      return synchronizing;
    },
    async operation(operation: Extract<LocalComputerRequest, { action: "subtitleEnvironment" | "subtitleScan" | "subtitleStart" | "subtitleStatus" | "subtitleCancel" | "subtitleRender" }>): Promise<unknown> {
      if (operation.action === "subtitleEnvironment") return environment.refresh();
      if (operation.action === "subtitleScan") return scan(operation.paths, operation.recursive || false);
      if (operation.action === "subtitleStart") {
        const prior = requests.get(operation.requestId);
        if (prior) return { status: "queued", ids: prior, requestId: operation.requestId };
        const scanned = await scan(operation.paths, operation.recursive || false);
        const files = scans.get(scanned.scanId)!.files;
        if (!files.length || files.length > subtitleBatchLimit) throw new Error(`找到 ${files.length} 个视频，请在托盘选择每批 1–${subtitleBatchLimit} 个文件`);
        const ids = await start(scanned.scanId, files.map(file => file.path), operation.requestId, operation);
        return { status: "queued", ids, requestId: operation.requestId, message: "字幕任务已落盘，后台执行；关闭聊天不取消任务" };
      }
      if (operation.action === "subtitleStatus") return operation.id ? summary(find(operation.id))
        : { tasks: [...tasks.values()].filter(visibleForAccount).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20).map(summary) };
      await api.command({ type: operation.action, id: operation.id });
      return summary(find(operation.id));
    },
    async fromChat(paths: string[], recursive: boolean) {
      await scan(paths, recursive);
      const scanId = [...scans.keys()].at(-1)!;
      const files = scans.get(scanId)!.files;
      if (!files.length) throw new Error("指定位置没有找到视频");
      if (files.length > subtitleBatchLimit) throw new Error(`找到 ${files.length} 个视频，请在批量字幕页面选择本批最多 ${subtitleBatchLimit} 个文件`);
      return start(scanId, files.map(file => file.path), crypto.randomUUID());
    },
    async pause() { paused = true; active?.controller.abort(); environment.cancel(); await pumping; sendSnapshot(); },
    async shutdown() { paused = true; active?.controller.abort(); environment.cancel(); await admissions; await pumping; await environment.wait(); await writes; await synchronizing; },
  };
  return api;
}
