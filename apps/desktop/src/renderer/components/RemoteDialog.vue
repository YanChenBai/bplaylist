<script setup lang="ts">
import { Cloud, Download, RefreshCw, Upload } from '@lucide/vue';
import { onMounted, ref, useId } from 'vue';
import { toast } from 'vue-sonner';

import { rpc } from '../rpc.ts';
import { useWorkspace } from '../stores/workspace.ts';
import ActionButton from './ui/ActionButton.vue';
import ModalDialog from './ui/ModalDialog.vue';
import TextField from './ui/TextField.vue';

const formId = useId();
const emit = defineEmits<{ close: [] }>();
const workspace = useWorkspace();
const api = { rpc };
const endpoint = ref('');
const token = ref('');
const configured = ref(false);
const records = ref<{ id: string; title: string; revision: number; updatedAt: string }[]>([]);
const downloaded = ref<string | null>(null);
const loading = ref(false);

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
    const settings = await rpc.remote.settings();
    endpoint.value = settings.endpoint;
    configured.value = settings.configured;

    if (settings.configured) {
      records.value = await rpc.remote.list();
    }
  }),
);

function configure() {
  return run(async () => {
    await rpc.remote.configure({ endpoint: endpoint.value, token: token.value });
    token.value = '';
    configured.value = true;
    records.value = await rpc.remote.list();
    toast.success('已连接云端');
  });
}

function upload() {
  return run(async () => {
    await rpc.remote.push();
    records.value = await rpc.remote.list();
    toast.success('播放列表与进度已上传');
  });
}

function download(id: string) {
  if (downloaded.value !== id) {
    downloaded.value = id;
    return;
  }

  return run(async () => {
    const result = await workspace.perform(() => rpc.remote.pull(id), '已下载列表与进度');

    if (result) {
      emit('close');
    }
  });
}
</script>

<template>
  <ModalDialog title="Cloudflare D1 · 远程导入导出" @close="emit('close')">
    <form :id="formId" class="grid gap-4" @submit.prevent="configure">
      <p class="text-muted text-[11px] leading-6">
        列表、分组、视频时间和列表进度一起同步。云端有新版本时会提示冲突，上传不会静默覆盖。
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
        :placeholder="configured ? '已配置；重新连接时填写新令牌' : '与 Worker 的 SYNC_TOKEN 相同'"
      />
    </form>
    <section v-if="configured" class="border-border mt-6 border-t pt-4">
      <div class="mb-3 flex items-center justify-between">
        <span class="text-muted flex items-center gap-2"><Cloud :size="14" /> 云端播放列表</span
        ><ActionButton
          aria-label="刷新云端列表"
          :disabled="loading"
          @click="
            run(async () => {
              records = await api.rpc.remote.list();
            })
          "
          ><RefreshCw :size="13"
        /></ActionButton>
      </div>
      <p v-if="!records.length" class="text-dim py-4 text-center">云端还没有播放列表</p>
      <div
        v-for="record in records"
        :key="record.id"
        class="border-border mb-2 rounded-md border p-3"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="truncate">{{ record.title }}</span
          ><ActionButton :disabled="loading" @click="download(record.id)"
            ><Download :size="13" />{{
              downloaded === record.id ? '确认下载' : '下载'
            }}</ActionButton
          >
        </div>
        <p class="text-dim mt-1 text-[10px]">
          v{{ record.revision }} · {{ new Date(record.updatedAt).toLocaleString() }}
        </p>
        <p v-if="downloaded === record.id" class="text-accent mt-2 text-[11px]">
          将切换到云端列表，并替换同 ID 的本地列表及进度。需要时请先导出本地备份。
        </p>
      </div>
    </section>
    <template #footer
      ><ActionButton
        v-if="configured"
        :disabled="loading || workspace.busy"
        class="text-[11px]"
        @click="upload"
        ><Upload :size="13" />上传当前列表</ActionButton
      ><span v-else />
      <div class="flex items-center gap-2">
        <ActionButton @click="emit('close')">关闭</ActionButton
        ><button
          type="submit"
          :form="formId"
          :disabled="loading || !token"
          class="bg-accent text-surface rounded-md px-3 py-2 disabled:opacity-40"
        >
          保存并连接
        </button>
      </div></template
    >
  </ModalDialog>
</template>
