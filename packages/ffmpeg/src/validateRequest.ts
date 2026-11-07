import { open } from "@toonflow/file";
import { dirname, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { BrowserFfmpegRequest, FfmpegCall } from "./browserTypes";

const inputMethods = new Set(["input", "addInput", "mergeAdd"]);
const inputFormatMethods = new Set(["inputFormat", "withInputFormat", "fromFormat"]);
const outputMethods = new Set(["output", "addOutput", "save", "saveToFile", "concat", "concatenate", "mergeToFile"]);
const screenshotMethods = new Set(["screenshots", "screenshot", "takeScreenshots", "thumbnail", "thumbnails"]);
const filters = new Set("scale crop pad fps format aformat setsar setdar setpts asetpts trim atrim concat overlay amix amerge asplit split aresample volume atempo hflip vflip transpose rotate fade afade xfade acrossfade color anull null eq hue unsharp reverse areverse drawbox drawgrid subtitles ass movie amovie".split(" "));
const fileFilters = new Set(["subtitles", "ass", "movie", "amovie"]);
const filterMethods = new Set("withAudioFilter withAudioFilters audioFilter audioFilters withVideoFilter withVideoFilters videoFilter videoFilters filterGraph complexFilter".split(" "));
const switches = new Set("y n an vn sn dn shortest copyts start_at_zero count_frames count_packets show_streams show_format show_frames show_packets show_error show_programs show_chapters hide_banner nostats".split(" "));
const valueOptions = new Set("c codec vcodec acodec b ab vb r ar ac crf preset profile level pix_fmt sample_fmt t ss to frames vframes aframes s aspect threads q qscale vtag atag movflags fflags map map_metadata map_chapters metadata disposition maxrate minrate bufsize filter_threads filter_complex_threads analyzeduration probesize read_intervals select_streams show_entries of print_format loglevel v vsync fps_mode f safe".split(" "));

function invalid(message: string): never { throw Object.assign(new Error(message), { status: 403 }); }

export async function validateFfmpegRequest(request: BrowserFfmpegRequest, resolvePath: (path: string) => Promise<string>, allowRawOptions: boolean,
  transfer?: { mapPath: (path: string) => string; isLocalPath?: (path: string) => boolean }) {
  const workingDirectory = request.options.cwd ? await resolvePath(request.options.cwd) : request.directory;
  const inputs: string[] = [];
  const files = new Set<string>();
  const outputs = new Set<string>();
  const folders = new Set<string>();
  const manifests = new Map<string, string>();
  const concatFiles = new Set<string>();
  if (request.options.source) {
    const path = await resolvePath(request.options.source);
    inputs.push(path);
    files.add(path);
    if (transfer) request.options.source = transfer.mapPath(path);
  }
  if (transfer && request.options.cwd) request.options.cwd = transfer.mapPath(workingDirectory);

  async function validateFormat(format: string, input?: string) {
    if (input && transfer?.isLocalPath?.(input)) return;
    if (/^(hls|dash|sdp|lavfi)$/i.test(format) || /^concat$/i.test(format) && !input) invalid("不允许通过媒体清单间接访问文件");
    if (!/^concat$/i.test(format) || !input || concatFiles.has(input)) return;
    const handle = await open(input, "r");
    const stream = handle.createReadStream({ encoding: "utf8", autoClose: false });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const content: string[] = [];
    stream.on("error", error => lines.emit("error", error));
    try {
      for await (const line of lines) {
        if (/^[ \t]*(?:#.*)?$/.test(line) || /^[ \t]*ffconcat[ \t]+version[ \t]+1\.0[ \t]*$/.test(line)
          || /^[ \t]*(?:duration|inpoint|outpoint)[ \t]+[^\s\x00-\x1f]+[ \t]*$/.test(line)) { content.push(line); continue; }
        // ACT: 只开放拼接所需指令；按 FFmpeg 的单引号和反斜杠规则解析文件名，拒绝 option 等间接配置。
        const token = /^[ \t]*file[ \t]+((?:[^\\'\s\x00-\x1f]|\\[^\r\n]|'[^'\r\n]*')+)[ \t]*$/.exec(line)?.[1];
        if (!token) invalid("concat 清单仅支持 file、duration、inpoint、outpoint 和 ffconcat version 1.0");
        const path = token.replace(/\\(.)|'([^']*)'/g, (_match, escaped: string | undefined, quoted: string | undefined) => escaped ?? quoted!);
        if (!path || /[\x00-\x1f]/.test(path) || /^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) {
          invalid("FFmpeg 文件路径无效，不能使用协议或设备路径");
        }
        const source = await resolvePath(transfer?.isLocalPath?.(path) ? path : resolve(dirname(input), path));
        files.add(source);
        const local = (transfer?.isLocalPath?.(source) ? source : relative(dirname(input), source)).replaceAll("\\", "/").replaceAll("'", "'\\''");
        content.push(`file '${local}'`);
      }
      concatFiles.add(input);
      manifests.set(input, content.join("\n"));
    } finally {
      lines.close();
      stream.destroy();
      await handle.close();
    }
  }

  async function fileFilterPath(value: unknown) {
    if (typeof value === "string" && transfer?.isLocalPath?.(value)) return;
    if (typeof value !== "string" || !value || /[\\:'";,\[\]\x00-\x1f]/.test(value) || value.startsWith("/") || value.split("/").includes("..")) {
      invalid("FFmpeg 文件路径无效，不能使用协议或设备路径");
    }
    const path = await resolvePath(resolve(workingDirectory, value));
    files.add(path);
  }

  async function validateFilter(value: unknown): Promise<void> {
    if (Array.isArray(value)) { for (const item of value) await validateFilter(item); return; }
    if (typeof value === "string") {
      if (/[\\'"\x00-\x1f]/.test(value)) invalid("滤镜不在允许范围内，请使用结构化参数与工作区相对路径");
      for (const part of value.split(/[,;]/)) {
        const name = /^(?:\s*\[[\w:.]+\])*\s*(\w+)(?:@\w+)?(?:=|\[|\s*$)/.exec(part)?.[1];
        if (!name || !filters.has(name)) invalid("滤镜不在允许范围内，请使用结构化参数与工作区相对路径");
        if (fileFilters.has(name)) invalid("滤镜不在允许范围内，请使用结构化参数与工作区相对路径");
      }
      return;
    }
    if (!value || typeof value !== "object") invalid("滤镜不在允许范围内，请使用结构化参数与工作区相对路径");
    const item = value as { filter?: unknown; options?: unknown; inputs?: unknown; outputs?: unknown };
    if (typeof item.filter !== "string" || !filters.has(item.filter)) invalid("滤镜不在允许范围内，请使用结构化参数与工作区相对路径");
    for (const labels of [item.inputs, item.outputs]) {
      if (labels !== undefined && (Array.isArray(labels) ? labels : [labels]).some(label => typeof label !== "string" || !/^\[?[\w:.]+\]?$/.test(label))) invalid("滤镜不在允许范围内，请使用结构化参数与工作区相对路径");
    }
    if (fileFilters.has(item.filter)) {
      if (!item.options || typeof item.options !== "object" || Array.isArray(item.options)) invalid("滤镜不在允许范围内，请使用结构化参数与工作区相对路径");
      const options = item.options as Record<string, unknown>;
      const allowed = new Set(["filename", "f", "fontsdir", "original_size", "alpha", "charenc", "stream_index", "si", "wrap_unicode", "loop", "seek_point", "s", "streams"]);
      if (Object.keys(options).some(key => !allowed.has(key))) invalid("滤镜不在允许范围内，请使用结构化参数与工作区相对路径");
      if (options.filename === undefined && options.f === undefined) invalid("滤镜不在允许范围内，请使用结构化参数与工作区相对路径");
      for (const name of ["filename", "f", "fontsdir"]) if (options[name] !== undefined) await fileFilterPath(options[name]);
    }
    const values = item.options && typeof item.options === "object" ? Object.entries(item.options) : [["", item.options]];
    for (const [key, value] of values) {
      if (/[\\:'";,\[\]\x00-\x1f]/.test(String(key))) invalid("滤镜不在允许范围内，请使用结构化参数与工作区相对路径");
      if (value !== undefined && typeof value !== "number" && (typeof value !== "string" || /[\\'";,\[\]\x00-\x1f]/.test(value))) invalid("滤镜不在允许范围内，请使用结构化参数与工作区相对路径");
      if (fileFilters.has(item.filter) && typeof value === "string" && value.includes(":") && !transfer?.isLocalPath?.(value)) invalid("滤镜不在允许范围内，请使用结构化参数与工作区相对路径");
    }
  }

  async function validateOptions(args: unknown[], input?: string) {
    const values = args.flatMap(value => Array.isArray(value) ? value : [value]).flatMap(value => {
      if (typeof value !== "string") invalid("原始参数不在允许范围内，请使用专用方法");
      const combined = /^(-\S+)\s+([\s\S]+)$/.exec(value);
      return combined ? [combined[1], combined[2]] : [value];
    });
    for (let index = 0; index < values.length; index++) {
      const option = values[index];
      const name = /^-([a-z_]+)(?::[\w:]+)?$/i.exec(option)?.[1];
      if (!name) invalid("原始参数不在允许范围内，请使用专用方法");
      if (switches.has(name)) continue;
      if (!["vf", "af", "filter_complex", "protocol_whitelist"].includes(name) && !valueOptions.has(name)) invalid("原始参数不在允许范围内，请使用专用方法");
      const value = values[++index];
      if (value === undefined) invalid("原始参数不在允许范围内，请使用专用方法");
      if (name === "protocol_whitelist" && value !== "file,pipe") invalid("只能使用本地文件协议");
      if (["vf", "af", "filter_complex"].includes(name)) await validateFilter(value);
      if (name === "safe") {
        if (!input || !/^[01]$/.test(value)) invalid("原始参数不在允许范围内，请使用专用方法");
        await validateFormat("concat", input);
      }
      if (name === "f") await validateFormat(value, input);
    }
  }

  for (const call of [...request.calls, request.operation]) {
    if (inputMethods.has(call.method) || outputMethods.has(call.method)) {
      if (typeof call.args[0] !== "string") invalid("浏览器 FFmpeg 输入、输出必须使用工作区文件路径");
      const path = await resolvePath(call.args[0]);
      if (inputMethods.has(call.method)) { inputs.push(path); files.add(path); }
      else outputs.add(path);
      if (transfer) call.args[0] = transfer.mapPath(path);
    }
    if (/options?$/i.test(call.method)) {
      if (!allowRawOptions) invalid("配对设备不能使用 FFmpeg 原始参数或滤镜");
      await validateOptions(call.args, /input/i.test(call.method) ? inputs.at(-1) : undefined);
    }
    if (filterMethods.has(call.method)) {
      if (!allowRawOptions) invalid("配对设备不能使用 FFmpeg 原始参数或滤镜");
      await validateFilter(call.args[0]);
      if (call.args.length > 1 && !/^(filterGraph|complexFilter)$/.test(call.method)) {
        for (const value of call.args.slice(1)) await validateFilter(value);
      } else if (call.args[1] !== undefined && (Array.isArray(call.args[1]) ? call.args[1] : [call.args[1]]).some((value: unknown) => typeof value !== "string" || !/^\[?[\w:.]+\]?$/.test(value))) invalid("滤镜不在允许范围内，请使用结构化参数与工作区相对路径");
    }
    if (/format/i.test(call.method) && typeof call.args[0] === "string") {
      await validateFormat(call.args[0], inputFormatMethods.has(call.method) ? inputs.at(-1) : undefined);
    }
    if (screenshotMethods.has(call.method)) {
      const options = call.args[0];
      let folder = typeof call.args[1] === "string" ? call.args[1] : workingDirectory;
      if (options && typeof options === "object" && !Array.isArray(options)) {
        const settings = options as { folder?: string; filename?: string };
        folder = settings.folder ?? folder;
        if (settings.filename) await resolvePath(resolve(workingDirectory, folder, settings.filename));
      }
      const path = await resolvePath(folder);
      folders.add(path);
      if (transfer) {
        call.args[0] = { ...(typeof options === "number" ? { count: options } : options as object), folder: transfer.mapPath(path) };
        call.args = call.args.slice(0, 1);
      }
    }
    if (call.method === "ffprobe") {
      const args = call.args.map((value, index) => call.undefinedArgs?.includes(index) ? undefined : value);
      let config: { index?: unknown; options?: unknown; json?: unknown };
      if (args.length <= 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) config = args[0];
      else if (args.length <= 1 && Array.isArray(args[0])) config = { options: args[0] };
      else if (args.length <= 2) config = { index: args[0], options: args[1] };
      else invalid("原始参数不在允许范围内，请使用专用方法");
      if (Object.keys(config).some(key => !["index", "options", "json"].includes(key))
        || config.index !== undefined && (typeof config.index !== "number" || !Number.isInteger(config.index) || config.index < 0)
        || config.json !== undefined && typeof config.json !== "boolean"
        || config.options !== undefined && !Array.isArray(config.options)) invalid("原始参数不在允许范围内，请使用专用方法");
      const options = config.options as unknown[] | undefined;
      if (!allowRawOptions && options?.length) invalid("配对设备不能使用 FFmpeg 原始参数或滤镜");
      if (options) await validateOptions(options, inputs[typeof config.index === "number" ? config.index : inputs.length - 1]);
      call.args = [{ ...Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined)), options: ["-protocol_whitelist", "file,pipe", ...(options ?? [])] }];
      delete call.undefinedArgs;
    }
  }
  // ACT: 工作区只解析显式参数；本地助手按当前 Windows 用户权限访问本机文件。
  const protocol: FfmpegCall = { method: "inputOptions", args: ["-protocol_whitelist", "file,pipe"] };
  if (!transfer) request.calls = [...(request.options.source ? [protocol] : []), ...request.calls.flatMap(call => inputMethods.has(call.method) ? [call, protocol] : [call])];
  return { files, outputs, folders, manifests };
}
