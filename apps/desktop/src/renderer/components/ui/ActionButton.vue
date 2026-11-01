<script setup lang="ts">
import { cn } from 'cn';
import type { HTMLAttributes } from 'vue';

defineProps<{ class?: HTMLAttributes['class']; active?: boolean }>();
</script>

<template>
  <button
    type="button"
    :class="
      cn(
        'text-muted hover:bg-raised hover:text-heading inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-transparent px-2.5 py-1.5 transition-[color,background-color,border-color,scale] duration-100 ease-out active:scale-95 disabled:opacity-35 disabled:active:scale-100 motion-reduce:scale-100',
        active && 'border-border bg-raised text-heading',
        $props.class,
      )
    "
  >
    <slot />
  </button>
</template>
