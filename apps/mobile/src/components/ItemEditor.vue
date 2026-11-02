<script setup lang="ts">
import type { Playlist, VideoItem, PlayerSnapshot } from '@bplaylist/shared';
import { itemSchema, parseVideoLink, formatTime } from '@bplaylist/shared';
import { action, alert } from '@nativescript/core';
import type { View, EventData } from '@nativescript/core';
import { computed, reactive, shallowRef, watch } from 'nativescript-vue';

import { animate, enter } from '../motion.ts';
import { readTime } from '../workspace.ts';

const props = defineProps<{
  item: VideoItem;
  playlist: Playlist;
  snapshot: PlayerSnapshot;
  theme: string;
}>();

const emit = defineEmits<{ save: [item: VideoItem]; close: [] }>();
let editorView: View | undefined;

function loaded(event: EventData) {
  editorView = event.object as View;
  enter(editorView, 12);
}

async function close() {
  await animate(editorView, { opacity: 0, translate: { x: 0, y: 8 }, duration: 110 });
  emit('close');
}

const draft = reactive(JSON.parse(JSON.stringify(props.item)) as VideoItem);
const link = shallowRef(draft.url);
const start = shallowRef(formatTime(draft.start));
const end = shallowRef(draft.end === null ? '' : formatTime(draft.end));
const crossParts = shallowRef(Boolean(draft.continuation));
const firstPart = shallowRef(draft.url);
const lastPart = shallowRef(draft.continuation?.at(-1)?.url ?? '');

const parts = computed(() => {
  const current = props.snapshot.parts;

  if (current.some(part => part.url === firstPart.value)) {
    return current;
  }

  return [{ url: draft.url, title: draft.partTitle || '当前分集' }, ...(draft.continuation ?? [])];
});

watch(link, value => {
  try {
    firstPart.value = parseVideoLink(value).url;
  } catch {
    /* 输入完成后再校验。 */
  }
});

const groupLabel = computed(
  () => props.playlist.nodes.find(node => node.id === draft.parentId)?.title ?? '列表顶层',
);

const firstLabel = computed(
  () =>
    parts.value.find(part => part.url === firstPart.value)?.title ?? draft.partTitle ?? '开始分集',
);

const lastLabel = computed(
  () => parts.value.find(part => part.url === lastPart.value)?.title ?? '选择结束分集',
);

async function readVideo() {
  try {
    const parsed = parseVideoLink(link.value);
    draft.url = parsed.url;
    firstPart.value = parsed.url;

    if (parsed.start !== null) {
      start.value = formatTime(parsed.start);
    }

    if (!props.snapshot.available) {
      throw new Error('请先在左侧打开并播放该视频');
    }

    const current = new URL(props.snapshot.url);
    const requested = new URL(parsed.url);

    if (current.pathname.replace(/\/$/, '') !== requested.pathname.replace(/\/$/, '')) {
      throw new Error('请先打开该视频，再读取分集信息');
    }

    draft.title = props.snapshot.title;
    draft.partTitle =
      parts.value.find(part => part.url === draft.url)?.title || props.snapshot.partTitle;
  } catch (cause) {
    await alert(String(cause));
  }
}

async function choosePart(last: boolean) {
  const result = await action({
    title: last ? '结束分集' : '开始分集',
    cancelButtonText: '取消',
    actions: parts.value.map((part, index) => `${index + 1}. ${part.title}`),
  });

  const part = parts.value[Number.parseInt(result) - 1];

  if (!part) {
    return;
  }

  if (last) {
    lastPart.value = part.url;
  } else {
    firstPart.value = part.url;
    draft.partTitle = part.title;
  }
}

async function chooseGroup() {
  const groups = props.playlist.nodes.filter(node => node.kind === 'group');

  const result = await action({
    title: '所属分组',
    cancelButtonText: '取消',
    actions: ['列表顶层', ...groups.map((group, index) => `${index + 1}. ${group.title}`)],
  });

  if (result === '列表顶层') {
    draft.parentId = null;
  } else {
    const group = groups[Number.parseInt(result) - 1];

    if (group) {
      draft.parentId = group.id;
    }
  }
}

async function save() {
  try {
    const item = {
      ...draft,
      url: parseVideoLink(firstPart.value || link.value).url,
      start: readTime(start.value)!,
      end: readTime(end.value, true),
    };

    delete item.continuation;

    if (crossParts.value) {
      const first = parts.value.findIndex(part => part.url === firstPart.value);
      const last = parts.value.findIndex(part => part.url === lastPart.value);

      if (first < 0 || last <= first) {
        throw new Error('结束分集必须在开始分集之后');
      }

      item.continuation = parts.value.slice(first + 1, last + 1);
    }

    emit('save', itemSchema.parse(item));
  } catch (cause) {
    await alert({
      title: '无法保存',
      message: cause instanceof Error ? cause.message : String(cause),
      okButtonText: '知道了',
    });
  }
}
</script>

<template>
  <GridLayout
    rows="auto,*,auto"
    class="bg-panel border-border text-foreground mx-6 my-3 max-w-[700] rounded-xl border font-mono"
    :class="theme === 'light' ? 'light' : ''"
    @loaded="loaded"
  >
    <GridLayout row="0" columns="*,auto" class="border-border border-b px-4 py-1.5">
      <Label text="编辑播放条目" class="text-heading text-[length:15]" />
      <Button
        col="1"
        text="×"
        class="text-muted m-0 h-[42] min-h-0 w-[42] min-w-0 rounded-md border-0 bg-transparent p-0 text-[length:21]"
        accessibilityLabel="关闭编辑器"
        @tap="close"
      />
    </GridLayout>
    <ScrollView row="1">
      <StackLayout class="px-5 pt-3 pb-5">
        <Label text="视频链接 / BV 号" class="text-muted mt-3 mb-1.5 text-xs" />
        <GridLayout columns="*,auto">
          <TextField
            v-model="link"
            hint="https://www.bilibili.com/video/…"
            class="text-foreground bg-surface border-border placeholder:text-dim m-0 min-h-[42] rounded-[7] border px-3 py-2.5 text-xs"
            autocorrect="false"
          />
          <Button
            col="1"
            text="读取"
            class="bg-accent text-panel m-0 ml-2.5 h-[42] min-h-0 min-w-0 rounded-md border-0 px-[18] py-0 text-xs normal-case"
            @tap="readVideo"
          />
        </GridLayout>
        <Label text="别名" class="text-muted mt-3 mb-1.5 text-xs" /><TextField
          v-model="draft.alias"
          hint="留空使用视频标题"
          class="text-foreground bg-surface border-border placeholder:text-dim m-0 min-h-[42] rounded-[7] border px-3 py-2.5 text-xs"
        />
        <Label text="视频标题" class="text-muted mt-3 mb-1.5 text-xs" /><TextField
          v-model="draft.title"
          class="text-foreground bg-surface border-border placeholder:text-dim m-0 min-h-[42] rounded-[7] border px-3 py-2.5 text-xs"
        />
        <Label
          :text="crossParts ? '开始分 P / 分集' : '分 P / 分集'"
          class="text-muted mt-3 mb-1.5 text-xs"
        />
        <Button
          v-if="parts.length"
          :text="firstLabel || '选择分集'"
          class="bg-surface text-foreground border-border m-0 h-[42] min-h-0 min-w-0 rounded-[7] border px-3 py-0 text-left text-xs normal-case"
          @tap="choosePart(false)"
        />
        <TextField
          v-else
          v-model="draft.partTitle"
          class="text-foreground bg-surface border-border placeholder:text-dim m-0 min-h-[42] rounded-[7] border px-3 py-2.5 text-xs"
          hint="分集名称"
        />
        <GridLayout columns="*,auto" class="mt-2.5">
          <Label text="跨分 P / 分集播放" class="text-muted mt-3 mb-1.5 text-xs" />
          <Switch col="1" v-model="crossParts" />
        </GridLayout>
        <Button
          v-if="crossParts"
          :text="lastLabel"
          class="bg-surface text-foreground border-border m-0 h-[42] min-h-0 min-w-0 rounded-[7] border px-3 py-0 text-left text-xs normal-case"
          @tap="choosePart(true)"
        />
        <GridLayout columns="*,16,*">
          <StackLayout col="0"
            ><Label text="开始时间" class="text-muted mt-3 mb-1.5 text-xs" /><TextField
              v-model="start"
              class="text-foreground bg-surface border-border placeholder:text-dim m-0 min-h-[42] rounded-[7] border px-3 py-2.5 text-xs"
              hint="18:00"
          /></StackLayout>
          <StackLayout col="2"
            ><Label
              text="结束时间（留空至结尾）"
              class="text-muted mt-3 mb-1.5 text-xs" /><TextField
              v-model="end"
              class="text-foreground bg-surface border-border placeholder:text-dim m-0 min-h-[42] rounded-[7] border px-3 py-2.5 text-xs"
              hint="36:00"
          /></StackLayout>
        </GridLayout>
        <Button
          text="以当前播放时间作为起点"
          class="text-muted m-0 h-10 min-h-0 min-w-0 border-0 bg-transparent px-2.5 py-0 text-xs normal-case"
          @tap="start = formatTime(snapshot.position)"
        />
        <Label text="所属分组" class="text-muted mt-3 mb-1.5 text-xs" /><Button
          :text="groupLabel"
          class="bg-surface text-foreground border-border m-0 h-[42] min-h-0 min-w-0 rounded-[7] border px-3 py-0 text-left text-xs normal-case"
          @tap="chooseGroup"
        />
      </StackLayout>
    </ScrollView>
    <GridLayout row="2" columns="*,auto,auto" class="border-border border-t px-4 py-3">
      <Button
        text="读取当前视频"
        class="text-muted m-0 h-10 min-h-0 min-w-0 border-0 bg-transparent px-2.5 py-0 text-xs normal-case"
        horizontalAlignment="left"
        @tap="
          link = snapshot.url;
          readVideo();
        "
      />
      <Button
        col="1"
        text="取消"
        class="text-muted m-0 h-10 min-h-0 min-w-0 border-0 bg-transparent px-2.5 py-0 text-xs normal-case"
        @tap="close"
      />
      <Button
        col="2"
        text="保存"
        class="bg-accent text-panel m-0 ml-2.5 h-[42] min-h-0 min-w-0 rounded-md border-0 px-[18] py-0 text-xs normal-case"
        @tap="save"
      />
    </GridLayout>
  </GridLayout>
</template>
