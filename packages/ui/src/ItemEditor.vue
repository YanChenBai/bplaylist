<script setup lang="ts">
import {
  itemSchema,
  parseTime,
  parseVideoLink,
  formatTime,
  videoUrl,
  playbackIdentity,
} from '@bplaylist/shared';
import type { PlaylistNode, PlayerSnapshot } from '@bplaylist/shared';
import type { VideoMetadata } from '@bplaylist/shared/bilibili';
import { computed, ref, watch, useId } from 'vue';
import { toast } from 'vue-sonner';

import ActionButton from './ui/ActionButton.vue';
import ModalDialog from './ui/ModalDialog.vue';
import SelectField from './ui/SelectField.vue';
import TextField from './ui/TextField.vue';

const props = defineProps<{
  node?: PlaylistNode;
  parentId?: string;
  kind: 'video' | 'group';
  snapshot?: PlayerSnapshot;
  prefill?: boolean;
  groups: { id: string; title: string }[];
  busy?: boolean;
  resolveVideo: (url: string) => Promise<VideoMetadata>;
  saveNodes: (nodes: PlaylistNode[]) => Promise<boolean>;
  captureVideo?: () => Promise<PlayerSnapshot>;
}>();

const emit = defineEmits<{ close: [] }>();
const formId = useId();
const draftId = props.node?.id ?? crypto.randomUUID();
const partIds = new Map<string, string>();
const initial = props.prefill ? props.snapshot : undefined;
const title = ref(props.node?.title ?? initial?.title ?? '');
const alias = ref(props.node?.kind === 'video' ? props.node.alias : '');

const partTitle = ref(
  props.node?.kind === 'video' ? props.node.partTitle : (initial?.partTitle ?? ''),
);

const resolving = ref(false);
const url = ref(props.node?.kind === 'video' ? props.node.url : (initial?.url ?? ''));
const continuation = ref(props.node?.kind === 'video' ? (props.node.continuation ?? []) : []);
const acrossParts = ref(continuation.value.length > 0);
const endPartUrl = ref(continuation.value.at(-1)?.url ?? '');
const resolvedParts = ref<{ title: string; url: string }[]>([]);

const start = ref(
  props.node?.kind === 'video' ? String(props.node.start) : formatTime(initial?.position ?? 0),
);

const end = ref(
  props.node?.kind === 'video' && props.node.end !== null ? String(props.node.end) : '',
);

const parentId = ref(props.node?.parentId ?? props.parentId ?? '');

const audioOffsetMs = ref(
  String(props.node?.kind === 'video' ? (props.node.audioOffsetMs ?? 0) : 0),
);

function readAudioOffset() {
  const value = Number(audioOffsetMs.value);

  if (!Number.isInteger(value) || Math.abs(value) > 10000) {
    throw new Error('声音偏移请输入 -10000 到 10000 之间的整数毫秒');
  }

  return value;
}

const parts = computed(() => {
  if (resolvedParts.value.some(part => sameSource(part.url, url.value))) {
    return resolvedParts.value;
  }

  const snapshot = props.snapshot;

  if (snapshot?.parts.some(part => sameSource(part.url, url.value))) {
    return snapshot.parts;
  }

  if (props.node?.kind === 'video' && props.node.continuation) {
    return [
      { title: props.node.partTitle || '开始分集', url: props.node.url },
      ...props.node.continuation,
    ];
  }

  return [];
});

const startPartIndex = computed(() =>
  parts.value.findIndex(part => sameSource(part.url, url.value)),
);

const endPartOptions = computed(() =>
  parts.value.slice(startPartIndex.value + 1).map(part => ({ value: part.url, label: part.title })),
);

function sameSource(left: string, right: string) {
  try {
    return playbackIdentity(left) === playbackIdentity(videoUrl(right));
  } catch {
    return false;
  }
}

watch(
  () => props.groups,
  groups => {
    if (parentId.value && !groups.some(group => group.id === parentId.value)) {
      parentId.value = '';
    }
  },
);

watch(url, value => {
  try {
    const parsed = parseVideoLink(value);

    if (parsed.start !== null) {
      start.value = formatTime(parsed.start);
    }
  } catch {
    // 输入过程可能尚不是完整链接，保存时再报告格式错误。
  }
});

function selectPart(value: string) {
  const part = parts.value.find(part => part.url === value);

  if (part) {
    url.value = part.url;
    partTitle.value = part.title;
  }
}

async function capture() {
  resolving.value = true;

  try {
    const snapshot = props.captureVideo ? await props.captureVideo() : props.snapshot;

    if (!snapshot?.available) {
      throw new Error('请先打开一个可以播放的视频');
    }

    title.value = snapshot.title;
    resolvedParts.value = snapshot.parts;
    partTitle.value = snapshot.partTitle;
    url.value = snapshot.url;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    resolving.value = false;
  }
}

async function resolveMetadata() {
  resolving.value = true;

  try {
    const metadata = await props.resolveVideo(url.value);
    title.value = metadata.title;
    partTitle.value = metadata.partTitle;
    url.value = metadata.url;
    resolvedParts.value = metadata.parts;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '读取视频信息失败');
  } finally {
    resolving.value = false;
  }
}

async function save() {
  try {
    updateContinuation();

    const common = {
      id: draftId,
      parentId: parentId.value || null,
      title: title.value.trim(),
    };

    const node: PlaylistNode =
      props.kind === 'group'
        ? { ...common, kind: 'group' }
        : itemSchema.parse({
            ...common,
            kind: 'video',
            alias: alias.value,
            partTitle: partTitle.value,
            url: videoUrl(url.value),
            ...(acrossParts.value ? { continuation: continuation.value } : {}),
            start: parseTime(start.value || '0'),
            end: end.value.trim() ? parseTime(end.value) : null,
            audioOffsetMs: readAudioOffset(),
          });

    if (!node.title) {
      throw new Error('请输入名称');
    }

    const saved = await props.saveNodes([node]);

    if (saved) {
      emit('close');
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

function updateContinuation() {
  if (props.kind !== 'video' || !acrossParts.value) {
    return;
  }

  const endIndex = parts.value.findIndex(part => sameSource(part.url, endPartUrl.value));

  if (startPartIndex.value < 0 || endIndex <= startPartIndex.value) {
    throw new Error('请选择位于开始分集之后的结束分集；可先从链接读取分集信息');
  }

  continuation.value = parts.value.slice(startPartIndex.value + 1, endIndex + 1);
}

async function addParts() {
  let offset: number;

  try {
    offset = readAudioOffset();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
    return;
  }

  const nodes: PlaylistNode[] = [];
  const groupId = draftId;
  nodes.push({
    id: groupId,
    parentId: parentId.value || null,
    kind: 'group',
    title: title.value.trim() || props.snapshot?.title || '视频分集',
  });

  for (const part of parts.value) {
    if (!partIds.has(part.url)) {
      partIds.set(part.url, crypto.randomUUID());
    }

    nodes.push({
      id: partIds.get(part.url)!,
      parentId: groupId,
      kind: 'video',
      alias: '',
      title: title.value || props.snapshot?.title || part.title,
      partTitle: part.title,
      url: videoUrl(part.url),
      start: 0,
      end: null,
      audioOffsetMs: offset,
    });
  }

  const saved = await props.saveNodes(nodes);

  if (saved) {
    emit('close');
  }
}
</script>

<template>
  <ModalDialog
    :title="`${node ? '编辑' : '添加'}${kind === 'group' ? '分组' : '视频'}`"
    @close="emit('close')"
  >
    <form :id="formId" class="grid gap-5" @submit.prevent="save">
      <slot name="destination" />
      <TextField v-if="kind === 'group'" v-model="title" label="名称" placeholder="分组名称" />
      <template v-if="kind === 'video'">
        <TextField
          v-model="alias"
          label="别名（可选）"
          placeholder="留空时显示视频标题与分集名称"
        />
        <div class="flex items-end gap-2">
          <TextField
            v-model="url"
            label="视频链接 / BV 号"
            placeholder="https://www.bilibili.com/video/BV…?p=2"
            class="min-w-0 flex-1"
          />
          <button
            type="button"
            aria-label="从链接读取视频 / 分集信息"
            title="从链接读取视频 / 分集信息"
            :aria-busy="resolving"
            :disabled="resolving || !url.trim()"
            class="bg-accent text-surface hover:bg-heading h-[38px] w-[88px] shrink-0 rounded-md px-3 text-xs transition-colors duration-100 disabled:opacity-40"
            @click="resolveMetadata"
          >
            {{ resolving ? '读取中…' : '读取' }}
          </button>
        </div>
        <TextField v-model="title" label="视频标题" placeholder="原始视频或剧集标题" />
        <TextField
          v-if="!acrossParts"
          v-model="partTitle"
          label="分 P / 分集名称"
          placeholder="例如 P2 · 安装，或 第 3 话"
        />
        <div v-if="parts.length" class="text-muted grid gap-2">
          <span>{{ acrossParts ? '开始分 P / 分集' : '当前视频的分 P / 分集' }}</span
          ><SelectField
            :label="acrossParts ? '开始分 P / 分集' : '当前视频的分 P / 分集'"
            placeholder="选择分 P 或分集"
            :model-value="parts[startPartIndex]?.url ?? ''"
            :options="parts.map(part => ({ value: part.url, label: part.title }))"
            @update:model-value="selectPart"
          />
        </div>
        <label class="text-muted flex items-center gap-2 text-xs">
          <input v-model="acrossParts" type="checkbox" class="accent-accent h-3.5 w-3.5" />
          跨分 P / 分集播放
        </label>
        <div v-if="acrossParts" class="grid gap-2">
          <SelectField
            v-model="endPartUrl"
            label="结束分 P / 分集"
            placeholder="选择结束分 P / 分集"
            :options="endPartOptions"
          />
          <p class="text-dim text-[10px] leading-5">
            从开始分集的指定时间播放，中间分集完整播放，直到结束分集的指定时间。
          </p>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <TextField v-model="start" label="开始时间" placeholder="00:00 或秒数" /><TextField
            v-model="end"
            label="结束时间（留空播到结尾）"
            placeholder="mm:ss"
          />
        </div>
        <ActionButton
          v-if="props.snapshot?.available"
          class="justify-start py-0 text-[11px]"
          @click="start = String(Math.floor(props.snapshot!.position))"
          >以当前播放时间作为起点</ActionButton
        >
        <div class="grid gap-2">
          <div class="flex items-end gap-2">
            <TextField
              v-model="audioOffsetMs"
              label="声音偏移（毫秒）"
              placeholder="0"
              class="min-w-0 flex-1"
            />
            <ActionButton class="mb-1 shrink-0" @click="audioOffsetMs = '0'">重置</ActionButton>
          </div>
          <p class="text-dim text-[10px] leading-5">
            正值让声音延后，负值让声音提前；0 不调整。范围 ±10000 ms，跨分集使用同一偏移。
          </p>
        </div>
      </template>
      <div class="text-muted grid gap-2">
        <span>所属分组</span
        ><SelectField
          v-model="parentId"
          label="所属分组"
          :options="[
            { value: '', label: '列表顶层' },
            ...props.groups.map(group => ({ value: group.id, label: group.title })),
          ]"
        />
      </div>
    </form>
    <template #footer>
      <div class="flex min-w-0 items-center gap-1">
        <ActionButton
          v-if="kind === 'video'"
          :disabled="props.busy || resolving"
          class="px-2 text-[11px]"
          @click="capture"
          >读取当前视频</ActionButton
        >
        <ActionButton
          v-if="kind === 'video' && !node && parts.length > 1"
          :disabled="props.busy || resolving"
          class="px-2 text-[11px]"
          :title="`全部 ${parts.length} 集作为分组加入`"
          @click="addParts"
          >全部分集</ActionButton
        >
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <ActionButton @click="emit('close')">取消</ActionButton
        ><button
          type="submit"
          :form="formId"
          :disabled="props.busy || resolving"
          class="bg-accent text-surface rounded-md px-4 py-2 disabled:opacity-40"
        >
          保存
        </button>
      </div>
    </template>
  </ModalDialog>
</template>
