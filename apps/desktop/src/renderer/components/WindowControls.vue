<script setup lang="ts">
import { Copy, Minus, Square, X } from '@lucide/vue';
import { toast } from 'vue-sonner';

import { rpc } from '../rpc.ts';

defineProps<{ maximized: boolean }>();

function control(action: 'minimize' | 'maximize' | 'close') {
  void rpc.windowControl(action).catch(error => {
    toast.error(error instanceof Error ? error.message : '窗口操作失败');
  });
}
</script>

<template>
  <div
    data-window-controls
    class="text-muted flex h-[39px] shrink-0 self-start pt-px [-webkit-app-region:no-drag]"
  >
    <button
      type="button"
      aria-label="最小化窗口"
      title="最小化"
      class="hover:bg-raised flex h-[39px] w-[46px] items-center justify-center transition-colors duration-80"
      @click="control('minimize')"
    >
      <Minus :size="14" :stroke-width="1" />
    </button>
    <button
      type="button"
      :aria-label="maximized ? '还原窗口' : '最大化窗口'"
      :title="maximized ? '还原' : '最大化'"
      class="hover:bg-raised flex h-[39px] w-[46px] items-center justify-center transition-colors duration-80"
      @click="control('maximize')"
    >
      <Copy v-if="maximized" :size="12" :stroke-width="1" /><Square
        v-else
        :size="12"
        :stroke-width="1"
      />
    </button>
    <button
      type="button"
      aria-label="关闭窗口"
      title="关闭"
      class="flex h-[39px] w-[46px] items-center justify-center transition-colors duration-80 hover:bg-[#c42b1c] hover:text-[#f0f0f0]"
      @click="control('close')"
    >
      <X :size="16" :stroke-width="1" />
    </button>
  </div>
</template>
