<script setup lang="ts">
import { X } from '@lucide/vue';
import { onUnmounted, useId, useTemplateRef } from 'vue';

import { activeDialog, animateDialog, dialogOrigin } from '../interaction.ts';
import ActionButton from './ActionButton.vue';

defineProps<{ title: string }>();
const emit = defineEmits<{ close: [] }>();
const dialog = useTemplateRef<HTMLDialogElement>('dialog');
const origin = dialogOrigin();
const titleId = useId();
let openedDialog: HTMLDialogElement | undefined;

const enter = (element: Element, done: () => void) => {
  openedDialog = element as HTMLDialogElement;
  animateDialog(element, done, origin);
};

onUnmounted(() => {
  if (activeDialog.value === openedDialog) {
    activeDialog.value = null;
  }

  openedDialog?.close();
});
const leave = (element: Element, done: () => void) => animateDialog(element, done, origin, true);
</script>

<template>
  <Transition appear :css="false" @enter="enter" @leave="leave">
    <dialog
      ref="dialog"
      :aria-labelledby="titleId"
      class="border-border bg-panel text-foreground m-auto max-h-[85vh] w-[520px] flex-col overflow-visible rounded-xl border p-0 shadow-2xl backdrop:bg-black/65 open:flex"
      @cancel.prevent="emit('close')"
      @click="
        event => {
          if (event.target === dialog) emit('close');
        }
      "
    >
      <header class="border-border flex shrink-0 items-center justify-between border-b px-5 py-4">
        <h2 :id="titleId" class="text-heading text-sm">{{ title }}</h2>
        <ActionButton aria-label="关闭对话框" @click="emit('close')"><X :size="15" /></ActionButton>
      </header>
      <div class="min-h-0 overflow-y-auto p-5" data-dialog-body><slot /></div>
      <footer
        v-if="$slots.footer"
        class="border-border bg-panel flex shrink-0 items-center justify-between gap-3 rounded-b-xl border-t px-5 py-3.5"
        data-dialog-footer
      >
        <slot name="footer" />
      </footer>
    </dialog>
  </Transition>
</template>
