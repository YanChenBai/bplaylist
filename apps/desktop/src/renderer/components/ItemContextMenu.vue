<script setup lang="ts">
import { Pencil, Trash2 } from '@lucide/vue';
import { onClickOutside, useWindowSize } from '@vueuse/core';
import { computed, nextTick, onMounted, useTemplateRef } from 'vue';

import { captureActivation } from '../lib/interaction.ts';

const props = defineProps<{ x: number; y: number }>();
const emit = defineEmits<{ edit: []; remove: []; close: [] }>();
const root = useTemplateRef<HTMLElement>('root');
const { width, height } = useWindowSize();

const position = computed(() => ({
  left: `${Math.max(8, Math.min(props.x, width.value - 176))}px`,
  top: `${Math.max(8, Math.min(props.y, height.value - 88))}px`,
}));

onClickOutside(root, () => emit('close'));
onMounted(async () => {
  await nextTick();
  root.value?.focus();
});

function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape' || event.key === 'Tab') {
    emit('close');
    return;
  }

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const buttons = [...(root.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + 1) % buttons.length]?.focus();
  }
}
</script>

<template>
  <Teleport to="body"
    ><Transition
      appear
      enter-active-class="transition-[opacity,translate,scale] duration-100 ease-out motion-reduce:transition-none"
      enter-from-class="opacity-0 scale-95"
      leave-active-class="transition-[opacity,translate,scale] duration-80 ease-in motion-reduce:transition-none"
      leave-to-class="opacity-0 scale-95"
      ><div
        ref="root"
        role="menu"
        tabindex="-1"
        aria-label="条目操作"
        :style="position"
        class="border-border bg-raised fixed z-50 w-42 origin-top-left rounded-md border p-1 shadow-xl outline-none"
        @keydown="keydown"
        @click.capture="captureActivation"
        @contextmenu.prevent
      >
        <button
          type="button"
          role="menuitem"
          class="text-foreground flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[11px] outline-none hover:bg-white/5 focus:bg-white/8"
          @click="emit('edit')"
        >
          <Pencil :size="13" />编辑</button
        ><button
          type="button"
          role="menuitem"
          class="text-foreground flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[11px] outline-none hover:bg-white/5 focus:bg-white/8"
          @click="emit('remove')"
        >
          <Trash2 :size="13" />删除
        </button>
      </div></Transition
    ></Teleport
  >
</template>
