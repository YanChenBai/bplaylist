<script setup lang="ts">
const value = defineModel<string>({ default: '' });
defineProps<{ label: string; placeholder?: string; type?: string }>();
</script>

<template>
  <label class="text-muted grid gap-2 text-xs">
    {{ label }}
    <input
      v-model="value"
      :type="type ?? 'text'"
      :placeholder="placeholder"
      class="border-border bg-surface text-foreground placeholder:text-dim hover:border-dim/60 focus:border-dim focus:bg-panel focus:ring-accent/10 w-full rounded-md border px-3 py-2.5 transition-[border-color,background-color,box-shadow] duration-100 ease-out focus:ring-2 focus:outline-none"
    />
  </label>
</template>
