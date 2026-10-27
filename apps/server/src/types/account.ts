import { z } from "zod";

export const userSchema = z.object({ id: z.number().int().positive(), username: z.string(), display_name: z.string() });
export const uploadLimitsSchema = z.object({
  imageMaxBytes: z.number().int().positive().max(20 * 1024 * 1024),
  audioMaxBytes: z.number().int().positive().max(64 * 1024 * 1024),
  videoMaxBytes: z.number().int().positive().max(512 * 1024 * 1024),
  requestTotalMaxBytes: z.number().int().positive(), maxReferencesPerRequest: z.number().int().positive(),
});
export const defaultUploadLimits = { imageMaxBytes: 20 * 1024 * 1024, audioMaxBytes: 64 * 1024 * 1024,
  videoMaxBytes: 100 * 1024 * 1024, requestTotalMaxBytes: 300 * 1024 * 1024, maxReferencesPerRequest: 12 };
export type UploadLimits = z.infer<typeof uploadLimitsSchema>;

export const modelSchema = z.object({
  id: z.string().min(1).max(200), label: z.string().min(1).max(200),
  contextWindow: z.number().int().positive().optional(), maxOutputTokens: z.number().int().positive().optional(), think: z.boolean().optional(),
  mode: z.array(z.union([z.enum(["text", "singleImage", "multiReference", "startEndRequired", "endFrameOptional", "startFrameOptional"]),
    z.array(z.string().regex(/^(image|video|audio)Reference:\d+$/))])).optional(),
  imageSizes: z.array(z.string().min(1)).optional(), imageRatios: z.array(z.string().min(1)).optional(),
  videoRatios: z.array(z.string().min(1)).optional(), minReferenceImages: z.number().int().nonnegative().optional(),
  supportsSeed: z.boolean().optional(), audio: z.union([z.boolean(), z.literal("optional")]).optional(),
  defaultDuration: z.number().positive().optional(), defaultResolution: z.string().optional(),
  durationResolutionMap: z.array(z.object({ duration: z.array(z.number().int().min(1).max(3600)), resolution: z.array(z.string()) })).optional(),
});
const createCategorySchema = (itemSchema: z.ZodType<z.infer<typeof modelSchema>>) => z.object({ enabled: z.boolean(), defaultModel: z.string().optional(),
  models: z.array(itemSchema).max(2000), requestBodyLimitMiB: z.number().int().positive().optional(),
}).superRefine((category, context) => {
  if (new Set(category.models.map(model => model.id)).size !== category.models.length)
    context.addIssue({ code: "custom", message: "平台模型 ID 重复" });
  if (category.enabled && !category.models.some(model => model.id === category.defaultModel))
    context.addIssue({ code: "custom", message: "平台默认模型不存在" });
});
const textAndImageCategorySchema = createCategorySchema(modelSchema.extend({
  audio: modelSchema.shape.audio.nullable().transform(value => value ?? undefined),
}));
const videoCategorySchema = createCategorySchema(modelSchema.required({ audio: true }));
export const platformConfigSchema = z.object({ revision: z.string().min(1), min_client_version: z.string(),
  categories: z.object({ text: textAndImageCategorySchema, image: textAndImageCategorySchema, video: videoCategorySchema }), limits: uploadLimitsSchema });
export const accountInfoSchema = z.object({ user: userSchema, balance: z.object({ quota: z.number(), display: z.string() }),
  storage: z.object({ used_bytes: z.number().nonnegative(), quota_bytes: z.number().nonnegative() }),
  topup_url: z.url({ protocol: /^https$/ }).refine(value => { const url = new URL(value); return !url.username && !url.password; }),
});
export type AccountInfo = z.infer<typeof accountInfoSchema>;
export type AccountView = { authenticated: boolean; loginStatus: "idle" | "waiting" | "cancelled" | "failed" | "expired";
  message?: string; account?: AccountInfo; configError?: string; limits: UploadLimits; revision?: string };
