type VideoAudioModel = { audio?: boolean | "optional" | "native" };

export function getVideoAudioConfig(model: VideoAudioModel | undefined, enabled: boolean) {
  const mode = model?.audio === "optional" ? "optional" : model?.audio === "native" ? "native"
    : model?.audio === true ? "always" : model?.audio === false ? "silent" : "unknown";
  const generateAudio = mode === "optional" ? enabled : mode === "always" ? true : mode === "silent" ? false : null;
  const description = mode === "native" ? "模型原生合成声音，声音设计写在提示词中，没有独立声音开关；旧开关值不代表静音。具体音轨和音效须在生成后检查。"
    : mode === "optional" ? `声音开关已${enabled ? "开启" : "关闭"}。`
    : mode === "always" ? "模型固定生成声音，不支持关闭；具体音轨和音效须在生成后检查。"
    : mode === "silent" ? "模型声明不生成声音；需要音效时可在生成后添加已有音频。"
    : model ? "模型未声明声音能力，不能据开关值判断是否出声，不将其作为提示词冲突。"
    : "尚未选择或加载可用的视频模型，声音能力未知；不能据旧开关值判定静音或提示词冲突。";
  return { mode, canToggle: mode === "optional", generateAudio, description,
    requestGenerateAudio: generateAudio ?? undefined };
}
