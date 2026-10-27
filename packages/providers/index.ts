/// <reference path="./types.d.ts" />

import yixian from "./src/language/yixian";
import yixianVideo from "./src/media/yixianVideo";


export type Provider = ProviderDefinition;
export type VideoTaskContext = ProviderVideoTask;
export type VideoTaskState = ProviderVideoTaskState;
export type ImageTaskContext = ProviderImageTask;
export type ProviderTools = ProviderContext["tool"];
export type AudioConvertOptions = Parameters<ProviderTools["audio"]["convert"]>[1];
export type { FfmpegFactory, FfmpegCommand } from "@toonflow/ffmpeg/types";

export const languageProviders = [yixian] as const;
export const mediaProviders: readonly Provider[] = [yixianVideo];
