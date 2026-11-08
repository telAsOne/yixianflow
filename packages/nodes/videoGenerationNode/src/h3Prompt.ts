import type { NodeInputValue, NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import { referenceKey } from "@toonflow/node-shared/useNodeReferences";
import type { ZealmanVoice } from "./zealmanOptions";

export type H3Subject = { id: number; name: string; references: string[]; speaker?: number; referenceNotes?: Record<string, string> };
export type H3PromptState = {
  subjects: H3Subject[];
  audioBindings: Record<string, { subject: number; speaker: number; description: string }>;
  voices: string[];
  attachments: { id: string; name: string; dataType: "IMAGE" | "VIDEO" | "AUDIO"; value: NodeMediaValue; source?: string; sourceHandle?: string }[];
  editorMode: "tags" | "code";
};
export type H3Reference = { id: string; name: string; value: string; category: string; avatar?: string; previewUrl?: string; input?: NodeInputValue; voice?: ZealmanVoice; action?: boolean; hideValue?: boolean };
export function h3ReferenceGroup(item: H3Reference) {
  const remote = item.input?.dataType === "IMAGE" && /^https?:\/\//i.test(item.input.value?.url ?? "");
  return `${item.category}:${item.id.startsWith("voice:") ? "voice" : remote ? "url" : "input"}`;
}
export const h3Sections = [
  ["subject_definitions", "主体定义"], ["summary", "摘要"], ["retention_analysis", "保留分析"],
  ["detailed_description", "详细描述"], ["overall_soundscape", "环境音"], ["non_diegetic_music", "非剧情配乐"],
] as const;
export const h3Languages = [{ value: "Chinese", label: "中文" }, { value: "English", label: "英文" }, { value: "Japanese", label: "日文" }, { value: "Korean", label: "韩文" }];
const h3TaskNames: Record<string, string> = { "keyframe completion": "首尾帧补全", "reference generation": "参考生成", "video editing": "视频编辑", "video continuation": "视频续写", "audio reuse": "音频复用", "audio reference": "音频参考" };
const h3VoiceoverBindingPattern = /<Subject\s+\d+>(?:\s*(?:and|和|、)\s*<Subject\s+\d+>)*\s*\(S\d+(?:,\s*S\d+)*\)[^<>\n]*(?:voice[ -]?over|(?:inner|internal) monologue|旁白|内心独白|思维配音|闭口配音)[^<>\n]*<d>/gi;
const h3CameraTagPattern = /\{\{CameraPreset [^\s{}]+\}\}/g;
export const h3CameraTagLike = /\{\{\s*CameraPreset\b/i;
export const h3DetailPattern = /(?:^|\n)[ \t]*detailed_description[ \t]*:[\s\S]*?(?=\n[ \t]*(?:overall_soundscape|non_diegetic_music)[ \t]*:|$)/;
const h3TokenPattern = new RegExp(`<d>\\[[^\\]\\n]+\\]\\s*[\\s\\S]*?<\\/d>|\\{\\{CameraPreset [^\\s{}]+\\}\\}|<(?:Missing )?(?:Picture|Video|Audio|Subject)\\s+\\d+>|\\[Shot\\s+\\d+\\]|\\(S\\d+(?:,\\s*S\\d+)*\\)|<\\/?(?:scenetrans|cutoff)>|\\[(?:${Object.keys(h3TaskNames).join("|")})(?:\\s+\\+\\s+(?:${Object.keys(h3TaskNames).join("|")}))*\\]|^[ \\t]*(?:${h3Sections.map(item => item[0]).join("|")})[ \\t]*:`, "gim");

export function h3PromptTokens(prompt: string) {
  return [...prompt.matchAll(h3TokenPattern)].map(match => {
    const value = match[0].trimStart();
    let category: string;
    let name: string;
    const media = /^<(Missing )?(Picture|Video|Audio|Subject)\s+(\d+)>$/i.exec(value);
    if (media) {
      category = media[1] ? "missing" : media[2].toLowerCase();
      name = `${media[1] ? "已移除的" : ""}${({ picture: "图", video: "视", audio: "音", subject: "主体" } as Record<string, string>)[media[2].toLowerCase()]}${Number(media[3])}`;
    } else if (/^<d>/i.test(value)) {
      const dialogue = /^<d>\[([^\]]+)\]\s*([\s\S]*?)<\/d>$/i.exec(value)!;
      category = "dialogue";
      name = `${h3Languages.find(item => item.value.toLowerCase() === dialogue[1].toLowerCase())?.label ?? dialogue[1]}对白：${dialogue[2].trim()}`;
    } else if (/^\{\{CameraPreset /i.test(value)) {
      category = "camera";
      name = "运镜";
    } else if (/^\[Shot\s/i.test(value)) {
      category = "shot";
      name = `镜头${Number(value.match(/\d+/)![0])}`;
    } else if (/^\(S/i.test(value)) {
      const speakers = value.match(/\d+/g)!;
      category = "speaker";
      name = speakers.length > 1 ? `齐声${speakers.join(",")}` : `说话人${speakers[0]}`;
    } else if (value.startsWith("<")) {
      category = "transition";
      name = /scenetrans/i.test(value) ? "场景过渡" : "对白截断";
    } else if (value.startsWith("[")) {
      category = "task";
      name = value.slice(1, -1).split(/\s+\+\s+/).map(task => h3TaskNames[task.toLowerCase()]).join("+");
    } else {
      category = "section";
      name = h3Sections.find(([key]) => key === value.slice(0, -1).trim().toLowerCase())![1];
    }
    return { index: match.index + match[0].length - value.length, value, category, name };
  });
}
export type H3CameraPreset = { id: string; name: string };
export function h3CameraTag(id: string) { return `{{CameraPreset ${id}}}`; }
export function h3CameraInsertRange(prompt: string, selection?: { anchor: number; focus: number }) {
  const detail = h3DetailPattern.exec(prompt);
  const start = selection && Math.min(selection.anchor, selection.focus);
  const end = selection && Math.max(selection.anchor, selection.focus);
  if (start === undefined || end === undefined || (detail && (start < detail.index || end > detail.index + detail[0].length))) {
    const at = detail ? detail.index + detail[0].trimEnd().length : prompt.length;
    return { start: at, end: at };
  }
  // 光标落在对白或其他标签内部时移到标签之后，选区也不覆盖已有标签。
  const inside = h3PromptTokens(prompt).find(token => token.index < end && token.index + token.value.length > start);
  const at = inside && inside.index + inside.value.length;
  return at === undefined ? { start, end } : { start: at, end: at };
}

export function h3References(inputs: NodeInputValue[], state: H3PromptState, voices?: ZealmanVoice[], previews: { id: string; avatar?: string; previewUrl?: string }[] = []) {
  const counts: Record<string, number> = {};
  const previewById = new Map(previews.map(item => [item.id, item]));
  const references: H3Reference[] = inputs.flatMap((input, index) => {
    const kind = String(input.dataType);
    const tag = ({ IMAGE: "Picture", VIDEO: "Video", AUDIO: "Audio", STRING: "Text" } as Record<string, string>)[kind];
    if (!tag || input.value === undefined || input.value === null || input.value === "") return [];
    const number = counts[tag] = (counts[tag] ?? 0) + 1;
    const id = referenceKey(input);
    const preview = previewById.get(id);
    return [{ id, name: `${({ Picture: "图", Video: "视", Audio: "音", Text: "文本" } as Record<string, string>)[tag]}${number}`,
      value: tag === "Text" ? `参考 ${index + 1}` : `<${tag} ${number}>`, category: tag.toLowerCase(), input,
      avatar: preview?.avatar, previewUrl: preview?.previewUrl }];
  });
  const byVoice = new Map(voices?.map(voice => [voice.path, voice]));
  for (const path of voices ? state.voices : []) {
    const number = counts.Audio = (counts.Audio ?? 0) + 1;
    const voice = byVoice.get(path);
    references.push({ id: `voice:${path}`, name: `音${number} · ${voice?.label ?? path.split("/").at(-1)}`, value: `<Audio ${number}>`, category: "audio", voice });
  }
  return references;
}

function addDefinitions(prompt: string, definitions: string[]) {
  if (!definitions.length) return prompt;
  const heading = /^\s*subject_definitions\s*:\s*\n?/im.exec(prompt);
  if (!heading) return `subject_definitions:\n${definitions.join("\n")}\n\n${prompt}`;
  const at = heading.index + heading[0].length;
  return `${prompt.slice(0, at)}${definitions.join("\n")}\n${prompt.slice(at)}`;
}

export function h3GenerationPrompt(prompt: string, references: H3Reference[], state: H3PromptState, updateBindings = false) {
  const inputs = references.filter(item => item.input);
  let text = prompt.replace(/\{\{ref\s+(\d+)\}\}/g, (tag, index: string) => inputs[Number(index) - 1]?.value ?? tag);
  const definitions: string[] = [];
  const byId = new Map(references.map(item => [item.id, item]));
  for (const subject of state.subjects) {
    const sources = subject.references.flatMap(id => byId.has(id) ? [byId.get(id)!.value] : []);
    if (!sources.length) continue;
    const generated = new RegExp(`(<Subject ${subject.id}> is the )[^\\n]*? in <(?:Missing )?(?:Picture|Video) \\d+>(?: and <(?:Missing )?(?:Picture|Video) \\d+>)*`, "g");
    if (updateBindings) text = text.replace(generated, () => `<Subject ${subject.id}> is the ${subject.name} in ${sources.join(" and ")}`);
    if (!new RegExp(`<Subject\\s+${subject.id}>\\s+(?:is|是)`, "i").test(text)) definitions.push(`<Subject ${subject.id}> is the ${subject.name} in ${sources.join(" and ")}.`);
    for (const [id, note] of Object.entries(subject.referenceNotes ?? {})) {
      const reference = byId.get(id);
      if (reference && subject.references.includes(id) && !text.includes(`${reference.value}：${note}`)) definitions.push(`${reference.value}：${note}`);
    }
  }
  for (const [id, binding] of Object.entries(state.audioBindings)) {
    const audio = byId.get(id);
    if (!audio || audio.category !== "audio" || !state.subjects.some(subject => subject.id === binding.subject)) continue;
    const line = `${audio.value} is the voice-timbre reference for <Subject ${binding.subject}> (S${binding.speaker}).${binding.description.trim() ? ` ${binding.description.trim()}` : ""}`;
    const existing = new RegExp(`${audio.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is the voice-timbre reference for[^\\n]*`, "i");
    if (existing.test(text)) { if (updateBindings) text = text.replace(existing, () => line); }
    else definitions.push(line);
  }
  return addDefinitions(text, definitions);
}

export function h3SectionText(prompt: string, key: string) {
  const section = new RegExp(`(?:^|\\n)[ \\t]*${key}[ \\t]*:[ \\t]*([\\s\\S]*?)(?=\\n[ \\t]*(?:${h3Sections.map(item => item[0]).join("|")})[ \\t]*:|$)`, "i").exec(prompt);
  return section?.[1]?.trim() ?? "";
}

export function h3PromptSubjects(prompt: string, references: H3Reference[]) {
  const byTag = new Map(references.map(item => [item.value, item.id]));
  return [...(h3SectionText(prompt, "subject_definitions") || prompt).matchAll(/^\s*<Subject (\d+)> is (?:the )?([^\n]+?)(?: in | from )(<(?:Picture|Video) \d+>[^\n]*)/gm)].map(match => ({
    id: Number(match[1]), name: match[2].trim(),
    references: [...match[3].matchAll(/<(?:Picture|Video) \d+>/g)].flatMap(token => byTag.has(token[0]) ? [byTag.get(token[0])!] : []),
  })).filter(subject => subject.references.length);
}

export function reconcileH3References(prompt: string, references: H3Reference[], state: H3PromptState, previous: { id: string; value: string }[] = []) {
  const byId = new Map(references.map(item => [item.id, item]));
  const replacements = new Map(previous.filter(item => /^<(Picture|Video|Audio) /.test(item.value)).map(item => [item.value, byId.get(item.id)?.value ?? item.value.replace("<", "<Missing ")]));
  let text = prompt.replace(/<(Picture|Video|Audio)\s+\d+>/g, value => replacements.get(value) ?? value);
  const removedSubjects = new Set<number>();
  for (const subject of state.subjects) {
    const retained = subject.references.filter(id => ["picture", "video"].includes(byId.get(id)?.category ?? ""));
    if (retained.length !== subject.references.length) subject.references = retained;
    if (!retained.length) removedSubjects.add(subject.id);
  }
  if (removedSubjects.size) {
    state.subjects = state.subjects.filter(subject => !removedSubjects.has(subject.id));
    text = text.replace(/<Subject\s+(\d+)>/g, (token, id: string) => removedSubjects.has(Number(id)) ? `<Missing Subject ${id}>` : token);
  }
  const subjects = new Set(state.subjects.map(subject => subject.id));
  for (const [id, binding] of Object.entries(state.audioBindings)) {
    if (byId.get(id)?.category !== "audio" || !subjects.has(binding.subject)) delete state.audioBindings[id];
  }
  // ACT: 只更新应用生成的素材定义；正文与台词保留失效标记，避免编号复用后误指向另一人物。
  return h3GenerationPrompt(text, references, state, true);
}

export function h3PromptIssues(prompt: string, references: H3Reference[], duration: number, cameraPresets?: H3CameraPreset[]) {
  const issues: string[] = [];
  const cameraTags: string[] = prompt.match(h3CameraTagPattern) ?? [];
  if (h3CameraTagLike.test(prompt.replace(h3CameraTagPattern, ""))) issues.push("运镜标签格式无效，请删除后从运镜库重新插入");
  // ACT: 运镜库未读取成功时只查格式与位置，不因读取失败拦截生成，ID 有效性交给平台判断。
  for (const tag of cameraTags) if (cameraPresets && !cameraPresets.some(preset => h3CameraTag(preset.id) === tag)) issues.push(`${tag} 不在运镜库中，请删除后重新选择`);
  if ([...prompt.matchAll(/<d>[\s\S]*?<\/d>/g)].some(match => h3CameraTagLike.test(match[0]))) issues.push("运镜标签不能放在对白内");
  if (/<Missing (Picture|Video|Audio|Subject)\s+\d+>/.test(prompt)) issues.push("提示词中有已移除的素材或主体，请删除失效标签或重新插入引用");
  const available = new Set(references.map(item => item.value));
  for (const match of prompt.matchAll(/<(Picture|Video|Audio)\s+(\d+)>/g)) {
    if (!available.has(`<${match[1]} ${Number(match[2])}>`)) issues.push(`${match[0]} 没有对应素材`);
  }
  const definitions = h3SectionText(prompt, "subject_definitions") || prompt;
  const defined = new Set([...definitions.matchAll(/<Subject\s+(\d+)>\s+(?:is|是)/g)].map(match => Number(match[1])));
  for (const match of prompt.matchAll(/<Subject\s+(\d+)>/g)) if (!defined.has(Number(match[1]))) issues.push(`${match[0]} 尚未定义`);
  const detail = h3SectionText(prompt, "detailed_description");
  if ((detail || prompt).match(h3VoiceoverBindingPattern)) issues.push("旁白和内心独白必须使用独立声源，不能绑定人物标签");
  const boundSpeakers = new Set([...prompt.matchAll(/<Subject\s+\d+>\s*\((S\d+(?:,\s*S\d+)*)\)/g)].flatMap(match => match[1].match(/S\d+/g)!));
  if ([...(detail || prompt).matchAll(/(?:narrator|inner (?:male |female )?voice)\s*\((S\d+)\)/gi)].some(match => boundSpeakers.has(match[1]))) issues.push("旁白和内心独白不能复用已绑定人物的声音编号");
  if (detail && (prompt.match(/<d>/g)?.length ?? 0) !== (detail.match(/<d>/g)?.length ?? 0)) issues.push("完整对白须放在详细描述 detailed_description 段内");
  if (detail && cameraTags.length !== (detail.match(h3CameraTagPattern)?.length ?? 0)) issues.push("运镜标签须放在详细描述 detailed_description 段内");
  const shots = [...detail.matchAll(/\[Shot\s+(\d+)\]/g)];
  if (shots.some((match, index) => Number(match[1]) !== index + 1)) issues.push("镜头编号须从 Shot 1 开始连续递增");
  let previous = 0;
  for (const match of detail.matchAll(/At\s+(\d{2}):(\d{2})\.(\d{3})/g)) {
    const time = Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 1000;
    if (time <= previous || time >= duration) issues.push("镜头切点须递增且小于视频时长");
    previous = time;
  }
  const description = detail.replace(/<d>[\s\S]*?<\/d>/g, "");
  const words = description.match(/[a-z]+(?:['-][a-z]+)*/gi)?.length ?? 0;
  // ACT: 沿用 U06 的 28% 汉字占比，中文正文不按英文词数提醒。
  const chinese = (description.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0) / description.replace(/\s/g, "").length >= 0.28;
  if (detail && !chinese && words && (words < 350 || words > 500)) issues.push(`分镜正文约 ${words} 个英文词，建议 350～500 词（对白密集时可适当调整）`);
  return [...new Set(issues)];
}

export function h3Skeleton(prompt: string, references: H3Reference[], state: H3PromptState, duration: number) {
  const definitions = h3SectionText(h3GenerationPrompt("", references, state), "subject_definitions");
  const count = duration < 5 ? 1 : duration <= 6 ? 2 : duration <= 10 ? 3 : Math.min(5, Math.floor(duration / 3));
  const shots = Array.from({ length: Math.max(1, count) }, (_, index) => `[Shot ${index + 1}]${index ? ` At ${new Date(Math.floor(duration * index / count * 1000)).toISOString().slice(14, 23)},` : ""} …`);
  const hasSections = h3Sections.some(([key]) => h3SectionText(prompt, key));
  return h3Sections.map(([key]) => `${key}:\n${h3SectionText(prompt, key) || ({
    subject_definitions: definitions || references.filter(item => item.category !== "text").map(item => `${item.value} is the … reference.`).join("\n"),
    summary: `[reference generation] Create a ${duration}-second video. ${hasSections ? "" : prompt.trim()}`,
    retention_analysis: state.subjects.map(subject => `<Subject ${subject.id}> (appears in [Shot 1]): fully_preserved - …`).join("\n"),
    detailed_description: `The target video is in a … style.\n${shots.join("\n")}`,
    overall_soundscape: "…", non_diegetic_music: "N/A",
  } as Record<string, string>)[key]}`).join("\n\n");
}
