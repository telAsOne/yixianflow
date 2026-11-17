import { nodeTools, z } from "@toonflow/nodes-scaffold/nodeTools";

export function registerGenerationTools<Shape extends z.ZodRawShape>(options: {
  configDescription: string;
  promptDescription: string;
  configSchema: z.ZodObject<Shape>;
  updateDescription: string;
  loadModels(): Promise<void>;
  getConfig(): unknown;
  getPrompt(): string;
  setPrompt(prompt: string): void;
  setConfig(args: z.output<z.ZodObject<Shape>>, signal?: AbortSignal): Promise<unknown>;
  generate: { name: string; description: string; execute(context: { source?: "ai" | "user" }): unknown | Promise<unknown> };
}) {
  const configSchema: z.ZodObject = options.configSchema;
  nodeTools.register({
    name: "getPrompt",
    description: "读取此生成节点当前完整提示词；仅在需要正文时调用，不查询模型清单、不启动生成。",
    parameters: z.strictObject({}),
    execute: () => ({ prompt: options.getPrompt() }),
  });
  nodeTools.register({
    name: "getConfig",
    description: `${options.configDescription}；includeModels=false省略模型清单，只读取当前配置与能力。`,
    parameters: z.strictObject({ includeModels: z.boolean().optional() }),
    async execute({ includeModels }, { signal }) {
      signal?.throwIfAborted();
      await options.loadModels();
      signal?.throwIfAborted();
      const config = await options.getConfig();
      if (includeModels === false && config && typeof config === "object") {
        const current = { ...config } as Record<string, unknown>;
        delete current.models;
        return current;
      }
      return config;
    },
  });
  nodeTools.register({
    name: "setPrompt",
    description: `${options.promptDescription}；可同时提供 setConfig 支持的配置字段，校验通过后一起更新。默认返回精简写入回执，returnPrompt=true 才回传全文；需要读取正文使用 getPrompt。`,
    parameters: configSchema.safeExtend({ prompt: z.string(), returnPrompt: z.boolean().optional() }),
    async execute({ prompt, returnPrompt, ...config }, { signal }) {
      if (Object.keys(config).length) await options.setConfig(options.configSchema.parse(config), signal);
      signal?.throwIfAborted();
      const text = z.string().parse(prompt);
      options.setPrompt(text);
      return { updated: true, promptCharacters: text.length, ...(returnPrompt ? { prompt: text } : {}) };
    },
  });
  nodeTools.register({
    name: "setConfig",
    description: options.updateDescription,
    parameters: options.configSchema,
    execute(args, { signal }) { return options.setConfig(args, signal); },
  });
  let starting = false;
  nodeTools.register({
    name: options.generate.name,
    description: `${options.generate.description}；args 可省略字段并传 {} 沿用节点设置，也可一次传入 prompt 和 setConfig 支持的配置字段，校验后使用这些参数生成。`,
    parameters: configSchema.safeExtend({ prompt: z.string().refine(value => !!value.trim(), "请输入生成提示词").optional() }),
    async execute({ prompt, ...config }, { signal, source }) {
      if (starting) throw new Error("此节点正在准备生成，请先查询 getGenerationStatus，不要重复启动");
      starting = true;
      try {
        if (prompt !== undefined || Object.keys(config).length) await options.setConfig(options.configSchema.parse(config), signal);
        signal?.throwIfAborted();
        if (prompt !== undefined) options.setPrompt(z.string().parse(prompt));
        return await options.generate.execute({ source });
      } finally { starting = false; }
    },
  });
}
