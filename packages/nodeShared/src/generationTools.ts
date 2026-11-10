import { nodeTools, z } from "@toonflow/nodes-scaffold/nodeTools";

export function registerGenerationTools<Shape extends z.ZodRawShape>(options: {
  configDescription: string;
  promptDescription: string;
  configSchema: z.ZodObject<Shape>;
  updateDescription: string;
  loadModels(): Promise<void>;
  getConfig(): unknown;
  setPrompt(prompt: string): void;
  setConfig(args: z.output<z.ZodObject<Shape>>, signal?: AbortSignal): Promise<unknown>;
  generate: { name: string; description: string; execute(context: { source?: "ai" | "user" }): unknown | Promise<unknown> };
}) {
  const configSchema: z.ZodObject = options.configSchema;
  nodeTools.register({
    name: "getConfig",
    description: options.configDescription,
    parameters: z.strictObject({}),
    async execute(_args, { signal }) {
      signal?.throwIfAborted();
      await options.loadModels();
      signal?.throwIfAborted();
      return options.getConfig();
    },
  });
  nodeTools.register({
    name: "setPrompt",
    description: `${options.promptDescription}；可同时提供 setConfig 支持的配置字段，校验通过后一起更新。`,
    parameters: configSchema.safeExtend({ prompt: z.string() }),
    async execute({ prompt, ...config }, { signal }) {
      if (Object.keys(config).length) await options.setConfig(options.configSchema.parse(config), signal);
      signal?.throwIfAborted();
      options.setPrompt(z.string().parse(prompt));
      return { prompt };
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
