<script setup lang="ts">
import type { View, TouchGestureEventData } from '@nativescript/core';

import { animate } from '../motion.ts';

defineProps<{ name: string; accessibilityLabel?: string; small?: boolean }>();
const emit = defineEmits<{ tap: [] }>();

function touch(event: TouchGestureEventData) {
  const pressed = event.action === 'down';
  void animate(event.object as View, {
    opacity: pressed ? 0.6 : 1,
    scale: { x: pressed ? 0.9 : 1, y: pressed ? 0.9 : 1 },
    duration: pressed ? 70 : 120,
  });
}
</script>

<template>
  <GridLayout
    :accessibilityLabel="accessibilityLabel"
    accessibilityRole="button"
    class="m-0 rounded-md bg-transparent p-0"
    :class="small ? 'h-[34] w-[34]' : 'h-[42] w-[42]'"
    @tap="emit('tap')"
    @touch="touch"
  >
    <Image
      :src="`res://ic_${name}`"
      class="h-[18] w-[18]"
      stretch="aspectFit"
      :isUserInteractionEnabled="false"
    />
  </GridLayout>
</template>
