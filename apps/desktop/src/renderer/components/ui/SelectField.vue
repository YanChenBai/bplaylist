<script setup lang="ts">
import { Check, ChevronDown } from '@lucide/vue';
import { onClickOutside, useEventListener } from '@vueuse/core';
import { cn } from 'cn';
import { computed, nextTick, ref, useId, useTemplateRef } from 'vue';

import { activeDialog } from '../../lib/interaction.ts';

const value = defineModel<string>({ default: '' });

const props = defineProps<{
  label: string;
  options: { value: string; label: string; disabled?: boolean }[];
  disabled?: boolean;
  borderless?: boolean;
  placeholder?: string;
}>();

const root = useTemplateRef<HTMLElement>('root');
const trigger = useTemplateRef<HTMLButtonElement>('trigger');
const menu = useTemplateRef<HTMLElement>('menu');
const menuStyle = ref({ left: '0px', top: '0px', width: '0px' });
const open = ref(false);
const focused = ref(0);
const id = useId();

const selected = computed(
  () =>
    props.options.find(option => option.value === value.value)?.label ??
    props.placeholder ??
    '请选择',
);

onClickOutside(
  root,
  () => {
    open.value = false;
  },
  { ignore: [menu] },
);

useEventListener(window, 'resize', () => {
  open.value = false;
});
useEventListener(
  window,
  'scroll',
  event => {
    if (open.value && !menu.value?.contains(event.target as Node)) {
      positionMenu();
    }
  },
  true,
);

function positionMenu() {
  const bounds = trigger.value!.getBoundingClientRect();
  const height = Math.min(256, props.options.length * 32 + 8);

  const top =
    bounds.bottom + height + 8 > innerHeight ? bounds.top - height - 4 : bounds.bottom + 4;

  menuStyle.value = {
    left: `${bounds.left}px`,
    top: `${Math.max(8, top)}px`,
    width: `${bounds.width}px`,
  };
}

async function show(keyboard = false) {
  if (props.disabled) {
    return;
  }

  open.value = !open.value;
  positionMenu();
  focused.value = Math.max(
    0,
    props.options.findIndex(option => option.value === value.value),
  );
  await nextTick();

  if (keyboard) {
    menu.value?.querySelector<HTMLElement>(`[data-option="${focused.value}"]`)?.focus();
  }
}

function choose(index: number) {
  const option = props.options[index];

  if (!option || option.disabled) {
    return;
  }

  value.value = option.value;
  open.value = false;
  trigger.value?.focus();
}

function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape' || event.key === 'Tab') {
    open.value = false;

    if (event.key === 'Escape') {
      trigger.value?.focus();
    }

    return;
  }

  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    return;
  }

  event.preventDefault();
  const length = props.options.length;

  if (!length) {
    return;
  }

  const delta = event.key === 'ArrowUp' ? -1 : 1;
  focused.value = (focused.value + delta + length) % length;

  if (event.key === 'Home') {
    focused.value = 0;
  }

  if (event.key === 'End') {
    focused.value = length - 1;
  }

  menu.value?.querySelector<HTMLElement>(`[data-option="${focused.value}"]`)?.focus();
}
</script>

<template>
  <div ref="root" class="relative min-w-0">
    <button
      ref="trigger"
      type="button"
      role="combobox"
      :aria-label="label"
      :aria-expanded="open"
      :aria-controls="id"
      aria-haspopup="listbox"
      :disabled="disabled"
      :class="
        cn(
          'border-border bg-surface text-foreground hover:bg-raised focus-visible:outline-dim flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-1 focus-visible:outline-offset-0 disabled:opacity-40',
          borderless &&
            'text-heading border-transparent bg-transparent px-0 py-1 text-sm hover:bg-transparent',
        )
      "
      @click="show()"
      @keydown.down.prevent="show(true)"
    >
      <span class="truncate">{{ selected }}</span
      ><ChevronDown :size="13" class="text-muted shrink-0" />
    </button>
    <Teleport :to="activeDialog ?? 'body'">
      <Transition
        enter-active-class="transition-[opacity,translate,scale] duration-120 ease-out motion-reduce:transition-none"
        enter-from-class="opacity-0 -translate-y-1 scale-98"
        enter-to-class="opacity-100 translate-y-0 scale-100"
        leave-active-class="transition-[opacity,translate,scale] duration-80 ease-in motion-reduce:transition-none"
        leave-from-class="opacity-100 translate-y-0 scale-100"
        leave-to-class="opacity-0 -translate-y-1 scale-98"
      >
        <div
          v-if="open"
          ref="menu"
          :style="menuStyle"
          :id="id"
          role="listbox"
          :aria-label="label"
          class="border-border bg-raised fixed z-50 max-h-64 origin-top overflow-auto rounded-md border p-1 shadow-xl"
          @keydown="keydown"
        >
          <button
            v-for="(option, index) in options"
            :key="option.value"
            type="button"
            role="option"
            :aria-selected="option.value === value"
            :disabled="option.disabled"
            :data-option="index"
            tabindex="-1"
            class="text-foreground flex w-full items-center justify-between gap-2 rounded px-2.5 py-2 text-left text-[11px] outline-none hover:bg-white/5 focus:bg-white/8 disabled:opacity-40"
            @click="choose(index)"
          >
            <span class="truncate">{{ option.label }}</span
            ><Check v-if="option.value === value" :size="12" class="text-accent shrink-0" />
          </button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
