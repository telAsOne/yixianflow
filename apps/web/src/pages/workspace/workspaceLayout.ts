import type { ComputedRef, InjectionKey, Ref } from "vue";

export const workspaceLayoutKey: InjectionKey<{
  menuTarget: Ref<HTMLElement | undefined>;
  compact: ComputedRef<boolean>;
  inspectorAvailable: Ref<boolean>;
  inspectorVisible: Ref<boolean>;
  inspectorWidth: Ref<number>;
  inspectorMaxWidth: ComputedRef<number>;
}> = Symbol("workspaceLayout");
