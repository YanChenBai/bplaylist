<script setup lang="ts">
import ActionButton from '@bplaylist/ui/ui/ActionButton.vue';
import ModalDialog from '@bplaylist/ui/ui/ModalDialog.vue';
import { onMounted, ref } from 'vue';
import { toast } from 'vue-sonner';

import { rpc } from '../rpc.ts';

defineEmits<{ close: [] }>();
const settings = ref<Awaited<ReturnType<typeof rpc.browserSettings>>>();
onMounted(async () => {
  try {
    settings.value = await rpc.browserSettings();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
});

async function reset() {
  try {
    settings.value = await rpc.resetBrowserToken();
    toast.success('连接密钥已更新，请在插件中重新连接');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

async function copy() {
  if (!settings.value) {
    return;
  }

  try {
    await navigator.clipboard.writeText(
      JSON.stringify({ endpoint: settings.value.endpoint, token: settings.value.token }),
    );
    toast.success('连接信息已复制');
  } catch {
    toast.error('复制失败，请检查剪贴板权限');
  }
}
</script>
<template>
  <ModalDialog title="连接浏览器插件" @close="$emit('close')">
    <div v-if="settings" class="grid gap-4">
      <p class="text-muted leading-6">
        在浏览器安装 BPlaylist 插件后，点击插件图标，粘贴下方连接信息即可。请保持桌面端运行。
      </p>
      <p :class="settings.connected ? 'text-heading' : 'text-muted'">
        {{ settings.connected ? '本地服务已启动' : '本地服务未启动' }} · {{ settings.endpoint }}
      </p>
      <p v-if="settings.error" class="text-muted break-all">{{ settings.error }}</p>
      <p class="text-dim text-[11px]">
        连接信息包含访问密钥，只提供给自己的浏览器。重置后原有连接会失效。
      </p>
    </div>
    <template #footer>
      <ActionButton @click="reset">重置密钥</ActionButton>
      <ActionButton
        :disabled="!settings?.connected"
        class="bg-accent text-surface hover:bg-heading hover:text-surface"
        @click="copy"
        >复制连接信息</ActionButton
      >
    </template>
  </ModalDialog>
</template>
