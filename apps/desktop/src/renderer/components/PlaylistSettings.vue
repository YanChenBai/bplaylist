<script setup lang="ts">
import ActionButton from '@bplaylist/ui/ui/ActionButton.vue';
import { Check, Settings2, Download, Upload, Pencil } from '@lucide/vue';
import { onClickOutside, usePreferredReducedMotion } from '@vueuse/core';
import { Motion } from 'motion-v';
import { nextTick, shallowRef, useTemplateRef } from 'vue';

import { rpc } from '../rpc.ts';
import { useWorkspace } from '../stores/workspace.ts';

const emit = defineEmits<{ rename: [] }>();
const workspace = useWorkspace();
const root = useTemplateRef<HTMLElement>('root');
const trigger = useTemplateRef<InstanceType<typeof ActionButton>>('trigger');
const menu = useTemplateRef<HTMLElement>('menu');
const open = shallowRef(false);
const reducedMotion = usePreferredReducedMotion();
onClickOutside(root, () => {
  open.value = false;
});

async function show(keyboard = false) {
  open.value = !open.value;

  if (open.value && keyboard) {
    await nextTick();
    menu.value?.querySelector<HTMLButtonElement>('button')?.focus();
  }
}

function close() {
  open.value = false;
  trigger.value?.$el.focus();
}

function rename() {
  close();
  emit('rename');
}

function importFile() {
  close();
  void workspace.perform(() => rpc.importFile());
}

function exportFile() {
  close();
  void workspace.perform(() => rpc.exportFile());
}

function keydown(event: KeyboardEvent) {
  if (event.key === 'Tab') {
    open.value = false;
    return;
  }

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();

    const buttons = [
      ...(menu.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
    ];

    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    buttons[(index + direction + buttons.length) % buttons.length]?.focus();
  }
}

async function toggleFullscreen() {
  await workspace.perform(() => rpc.fullscreen(!workspace.state?.autoFullscreen));
}
</script>

<template>
  <div ref="root" class="relative shrink-0" @keydown.esc.stop="close">
    <ActionButton
      ref="trigger"
      aria-label="播放列表设置"
      title="设置"
      aria-haspopup="menu"
      :aria-expanded="open"
      :active="open"
      class="p-1.5"
      @click="show()"
      @keydown.down.prevent="show(true)"
      ><Motion
        as="span"
        class="flex"
        :animate="{ rotate: open ? 45 : 0 }"
        :transition="{ duration: reducedMotion === 'reduce' ? 0 : 0.12 }"
        ><Settings2 :size="13" /></Motion
    ></ActionButton>
    <Transition
      enter-active-class="transition-[opacity,translate,scale] duration-120 ease-out motion-reduce:transition-none"
      enter-from-class="opacity-0 -translate-y-1 scale-98"
      leave-active-class="transition-[opacity,translate,scale] duration-80 ease-in motion-reduce:transition-none"
      leave-to-class="opacity-0 -translate-y-1 scale-98"
      ><div
        v-if="open"
        ref="menu"
        @keydown="keydown"
        role="menu"
        aria-label="播放列表设置"
        class="border-border bg-raised absolute top-full right-0 z-50 mt-2 w-52 origin-top-right rounded-md border p-1 shadow-xl"
      >
        <button
          type="button"
          role="menuitem"
          :disabled="workspace.busy"
          class="text-foreground hover:bg-foreground/5 focus:bg-foreground/8 flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[11px] outline-none disabled:opacity-40"
          @click="importFile"
        >
          <Download :size="13" />导入播放列表
        </button>
        <button
          type="button"
          role="menuitem"
          :disabled="workspace.busy"
          class="text-foreground hover:bg-foreground/5 focus:bg-foreground/8 flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[11px] outline-none disabled:opacity-40"
          @click="exportFile"
        >
          <Upload :size="13" />导出播放列表
        </button>
        <button
          type="button"
          role="menuitem"
          :disabled="workspace.busy"
          class="text-foreground hover:bg-foreground/5 focus:bg-foreground/8 flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[11px] outline-none disabled:opacity-40"
          @click="rename"
        >
          <Pencil :size="13" />重命名播放列表
        </button>
        <div role="separator" class="bg-border mx-2 my-1 h-px" />
        <button
          type="button"
          role="menuitemcheckbox"
          :aria-checked="workspace.state?.autoFullscreen ?? false"
          :disabled="workspace.busy"
          class="text-foreground hover:bg-foreground/5 focus:bg-foreground/8 flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left text-[11px] transition-colors duration-80 outline-none disabled:opacity-40"
          @click="toggleFullscreen"
        >
          <span>自动网页全屏</span
          ><Check
            :size="13"
            :class="workspace.state?.autoFullscreen ? 'opacity-100' : 'opacity-0'"
          />
        </button></div
    ></Transition>
  </div>
</template>
