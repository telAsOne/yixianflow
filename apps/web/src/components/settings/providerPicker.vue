<template>
  <div class="providerPicker">
    <aside class="providerSidebar" aria-label="选择厂商">
      <button v-for="item in providers" :key="item.id" class="providerItem" type="button" :disabled="disabled"
        :aria-pressed="selectedProvider === item.id" @click="selectedProvider = item.id">
        <img v-if="item.icon" class="providerLogo" :src="item.icon" alt="" />
        <modelIcon v-else :model="item.id" :size="18" />
        <span>{{ item.label }}</span>
      </button>
    </aside>
    <el-scrollbar class="providerDetails">
      <section v-if="activeProvider" :key="selectedProvider" class="providerContent" :aria-label="activeProvider.label">
        <div class="providerHeader">
          <h3>{{ activeProvider.label }}</h3>
          <el-tag v-if="activeProvider.version" size="small" type="info" effect="plain">v{{ activeProvider.version }}</el-tag>
        </div>
        <slot />
      </section>
    </el-scrollbar>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { modelIcon } from "@toonflow/model-icons";

const props = defineProps<{ providers: readonly { id: string; label: string; icon?: string; version?: string }[]; disabled?: boolean }>();
const selectedProvider = defineModel<string>({ required: true });
const activeProvider = computed(() => props.providers.find(provider => provider.id === selectedProvider.value));
</script>

<style lang="scss" scoped src="./providerList.scss"></style>
