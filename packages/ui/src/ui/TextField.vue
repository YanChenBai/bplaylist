<script setup lang="ts">
import { cn } from 'cn';

const value = defineModel<string>({ default: '' });
defineProps<{
  label?: string;
  ariaLabel?: string;
  placeholder?: string;
  type?: string;
  compact?: boolean;
}>();
</script>

<template>
  <label class="group/field text-muted grid gap-2 text-xs">
    <span v-if="label">{{ label }}</span>
    <span class="relative block min-w-0">
      <span
        v-if="$slots.leading"
        class="text-dim group-focus-within/field:text-muted pointer-events-none absolute inset-y-0 left-2.5 flex items-center transition-colors"
        aria-hidden="true"
      >
        <slot name="leading" />
      </span>
      <input
        v-model="value"
        :type="type ?? 'text'"
        :placeholder="placeholder"
        :aria-label="ariaLabel ?? label ?? placeholder"
        :class="
          cn(
            'text-foreground placeholder:text-dim focus:ring-accent/10 w-full min-w-0 rounded-md border transition-[border-color,background-color,box-shadow] duration-150 focus:outline-none',
            compact
              ? 'border-border/50 bg-raised/30 hover:border-dim/40 hover:bg-raised/50 focus:border-dim/60 focus:bg-raised/60 h-7 px-2 text-[11px] focus:ring-1'
              : 'border-border bg-surface hover:border-dim/60 focus:border-dim focus:bg-panel px-3 py-2.5 focus:ring-2',
            $slots.leading && 'pl-7',
          )
        "
      />
    </span>
  </label>
</template>
