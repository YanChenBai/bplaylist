<script setup lang="ts">
import type { SyncPreferences } from '@bplaylist/shared/sync';
import ActionButton from '@bplaylist/ui/ui/ActionButton.vue';
import ModalDialog from '@bplaylist/ui/ui/ModalDialog.vue';
import TextField from '@bplaylist/ui/ui/TextField.vue';
import { RefreshCw } from '@lucide/vue';
import { useIntervalFn } from '@vueuse/core';
import { onMounted, ref, useId } from 'vue';
import { toast } from 'vue-sonner';

import { rpc } from '../rpc.ts';
import { useWorkspace } from '../stores/workspace.ts';

const emit = defineEmits<{ close: [] }>();
const formId = useId();
const workspace = useWorkspace();
const endpoint = ref('');
const token = ref('');
const settings = ref<Awaited<ReturnType<typeof rpc.remote.settings>>>();
const automatic = ref(true);
const intervalMinutes = ref<SyncPreferences['intervalMinutes']>(5);
const loading = ref(false);

const labels = {
  unconfigured: '尚未连接',
  idle: '已同步',
  syncing: '同步中',
  offline: '离线',
  error: '同步失败',
};

async function run(operation: () => Promise<void>) {
  loading.value = true;

  try {
    await operation();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

onMounted(() =>
  run(async () => {
    settings.value = await rpc.remote.settings();
    endpoint.value = settings.value.endpoint;
    automatic.value = settings.value.automatic;
    intervalMinutes.value = settings.value.intervalMinutes;
  }),
);

useIntervalFn(async () => {
  if (!loading.value) {
    try {
      settings.value = await rpc.remote.settings();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error), { id: 'sync-settings' });
    }
  }
}, 2000);

function configure() {
  return run(async () => {
    settings.value = await rpc.remote.configure({ endpoint: endpoint.value, token: token.value });
    token.value = '';
    toast.success('已连接云端');
  });
}

function preferences() {
  return run(async () => {
    settings.value = await rpc.remote.preferences({
      automatic: automatic.value,
      intervalMinutes: intervalMinutes.value,
    });
  });
}

function sync() {
  return run(async () => {
    const success = await workspace.perform(() => rpc.remote.sync(), '所有播放列表与进度已同步');

    if (success) {
      settings.value = await rpc.remote.settings();
    }
  });
}
</script>

<template>
  <ModalDialog title="云端同步" @close="emit('close')">
    <form :id="formId" class="grid gap-4" @submit.prevent="configure">
      <p class="text-muted text-[11px] leading-6">
        所有播放列表和进度在设备间同步。离线修改保存在本地，连接恢复后继续同步。
      </p>
      <TextField
        v-model="endpoint"
        label="Worker 地址"
        placeholder="https://bplaylist-sync.你的域名.workers.dev"
      />
      <TextField
        v-model="token"
        label="访问令牌（使用系统安全存储保存）"
        type="password"
        :placeholder="
          settings?.configured ? '已配置；重新连接时填写新令牌' : '与 Worker 的 SYNC_TOKEN 相同'
        "
      />
    </form>
    <section v-if="settings?.configured" class="border-border mt-6 grid gap-4 border-t pt-4">
      <label class="flex items-center justify-between gap-3">
        <span>自动同步</span>
        <input v-model="automatic" type="checkbox" :disabled="loading" @change="preferences" />
      </label>
      <label class="flex items-center justify-between gap-3">
        <span>同步间隔</span>
        <select
          v-model="intervalMinutes"
          class="bg-surface border-border rounded border px-2 py-1"
          :disabled="loading"
          @change="preferences"
        >
          <option :value="5">5 分钟</option>
          <option :value="15">15 分钟</option>
          <option :value="30">30 分钟</option>
        </select>
      </label>
      <p class="text-muted text-[11px] leading-6">
        列表编辑后等待 1 分钟批量同步，播放进度按所选间隔同步。关闭自动同步后，仍可随时手动同步。
      </p>
      <div class="text-muted text-[11px] leading-6" role="status" aria-live="polite">
        <p>
          {{
            settings.status.phase === 'idle' && !settings.status.lastSyncedAt
              ? '等待首次同步'
              : labels[settings.status.phase]
          }}
        </p>
        <p v-if="settings.status.lastSyncedAt">
          上次成功：{{ new Date(settings.status.lastSyncedAt).toLocaleString() }}
        </p>
        <p v-if="settings.status.error" class="text-accent">{{ settings.status.error }}</p>
      </div>
    </section>
    <template #footer>
      <ActionButton
        v-if="settings?.configured"
        :disabled="loading || workspace.busy || settings.status.phase === 'syncing'"
        @click="sync"
      >
        <RefreshCw :size="13" />立即同步 </ActionButton
      ><span v-else />
      <div class="flex items-center gap-2">
        <ActionButton @click="emit('close')">关闭</ActionButton>
        <button
          type="submit"
          :form="formId"
          :disabled="loading || !token"
          class="bg-accent text-surface rounded-md px-3 py-2 disabled:opacity-40"
        >
          保存并连接
        </button>
      </div>
    </template>
  </ModalDialog>
</template>
