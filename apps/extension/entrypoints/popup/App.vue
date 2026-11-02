<script setup lang="ts">
import {
  BRIDGE_ENDPOINT,
  bridgeConnectionSchema,
  playlistOptionsSchema,
} from '@bplaylist/shared/bridge';
import ThemeToaster from '@bplaylist/ui/ThemeToaster.vue';
import ActionButton from '@bplaylist/ui/ui/ActionButton.vue';
import TextField from '@bplaylist/ui/ui/TextField.vue';
import { Sun, Moon } from '@lucide/vue';
import { onMounted, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import { browser } from 'wxt/browser';

import { request } from '../../lib/messages.ts';
import { useExtensionTheme } from '../../lib/theme.ts';

const theme = useExtensionTheme();
watch(
  theme,
  value => {
    document.documentElement.dataset.theme = value;
  },
  { immediate: true },
);
const endpoint = ref(BRIDGE_ENDPOINT);
const token = ref('');
const connectionInfo = ref('');
const status = ref('未连接');
const busy = ref(false);
onMounted(async () => {
  const parsed = bridgeConnectionSchema.safeParse(
    (await browser.storage.local.get('connection')).connection,
  );

  if (parsed.success) {
    endpoint.value = parsed.data.endpoint;
    token.value = parsed.data.token;
    await test();
  }
});

async function test() {
  busy.value = true;

  try {
    const source: unknown = connectionInfo.value.trim()
      ? JSON.parse(connectionInfo.value)
      : { endpoint: endpoint.value, token: token.value };

    const connection = bridgeConnectionSchema.parse(source);
    const host = new URL(connection.endpoint);

    if (host.hostname !== '127.0.0.1') {
      const granted = await browser.permissions.request({ origins: [`${host.origin}/*`] });

      if (!granted) {
        throw new Error('需要允许插件连接此设备地址');
      }
    }

    const playlists = await request({ action: 'connect', connection }, playlistOptionsSchema);
    endpoint.value = connection.endpoint;
    token.value = connection.token;
    connectionInfo.value = '';
    status.value = `已连接 · ${playlists.length} 个播放列表`;
    toast.success('连接成功');
  } catch (error) {
    status.value = '未连接';
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <main :data-theme="theme" class="bg-panel text-foreground w-[340px] p-5 text-xs">
    <header class="mb-5 flex items-center justify-between">
      <h1 class="text-heading text-sm">BPlaylist</h1>
      <ActionButton
        :aria-label="theme === 'dark' ? '切换白色主题' : '切换黑色主题'"
        @click="theme = theme === 'dark' ? 'light' : 'dark'"
        ><Sun v-if="theme === 'dark'" :size="15" /><Moon v-else :size="15"
      /></ActionButton>
    </header>
    <p class="text-muted mb-4 leading-6">
      桌面端或安卓端 → 连接浏览器插件，复制连接信息并粘贴。连接手机时需处于同一局域网。
    </p>
    <form class="grid gap-4" @submit.prevent="test">
      <TextField
        v-model="connectionInfo"
        type="password"
        label="粘贴连接信息"
        placeholder='{"endpoint": "…", "token": "…"}'
        autocomplete="off"
      />
      <details>
        <summary class="text-muted cursor-pointer">手动连接</summary>
        <div class="mt-3 grid gap-3">
          <TextField v-model="endpoint" label="本地服务地址" /><TextField
            v-model="token"
            type="password"
            label="访问密钥"
            autocomplete="off"
          />
        </div>
      </details>
      <p class="text-dim" role="status">{{ status }}</p>
      <button
        type="submit"
        :disabled="busy"
        class="bg-accent text-surface rounded-md px-4 py-2 disabled:opacity-40"
      >
        {{ busy ? '正在连接…' : '保存并连接' }}
      </button>
    </form>
    <ThemeToaster />
  </main>
</template>
