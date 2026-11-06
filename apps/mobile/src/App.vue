<script setup lang="ts">
import type { Playlist, VideoItem } from '@bplaylist/shared';
import { Application, Screen, action, prompt } from '@nativescript/core';
import type { EventData, View } from '@nativescript/core';
import { computed, nextTick, onUnmounted, shallowRef, watch } from 'nativescript-vue';

import IconButton from './components/IconButton.vue';
import ImmersiveControls from './components/ImmersiveControls.vue';
import ItemEditor from './components/ItemEditor.vue';
import PlaylistRow from './components/PlaylistRow.vue';
import { nativeHost } from './host.ts';
import { animate, enter } from './motion.ts';
import { draftVideo, useWorkspace } from './workspace.ts';

const workspace = useWorkspace();
const { playlist, theme, collapsed, immersive, snapshot, rows, error, search } = workspace;
const editor = shallowRef<VideoItem | null>(null);
const width = shallowRef(Screen.mainScreen.widthDIPs);
const height = shallowRef(Screen.mainScreen.heightDIPs);
const insets = shallowRef({ left: 0, top: 0, right: 0, bottom: 0 });
const sidebarVisible = shallowRef(true);
let shellView: View | undefined;
let sidebarView: View | undefined;
let sidebarTransition = 0;
const landscape = computed(() => width.value >= height.value);
const sidebarWidth = computed(() => Math.min(width.value >= 1000 ? 380 : 320, width.value * 0.43));

const columns = computed(() =>
  landscape.value && sidebarVisible.value ? `*,${sidebarWidth.value}` : '*',
);

const layoutRows = computed(() => (!landscape.value && sidebarVisible.value ? '*,*' : '*'));
const foreground = computed(() => (theme.value === 'dark' ? '#c4c4c4' : '#383838'));
let timer: ReturnType<typeof setInterval> | undefined;

function layout(event: EventData) {
  const view = event.object as View;
  const size = view.getActualSize();

  if (size.width > 0 && size.height > 0 && size.width >= size.height !== landscape.value) {
    nativeHost().animateLayout(shellView?.android ?? view.android);
  }

  if (size.width > 0) {
    width.value = size.width;
  }

  if (size.height > 0) {
    height.value = size.height;
  }
}

function loaded() {
  workspace.start();

  if (timer) {
    clearInterval(timer);
  }

  timer = setInterval(() => {
    workspace.refresh();
    insets.value = { left: 0, top: 0, right: 0, bottom: 0, ...JSON.parse(nativeHost().insets()) };
  }, 800);
}

watch(theme, async value => {
  await nextTick();
  nativeHost().setTheme(value === 'light');
});
watch(collapsed, async hidden => {
  const transition = ++sidebarTransition;

  if (hidden) {
    await animate(sidebarView, {
      opacity: 0,
      translate: { x: landscape.value ? 24 : 0, y: landscape.value ? 0 : 16 },
      duration: 120,
    });

    if (transition !== sidebarTransition) {
      return;
    }

    if (shellView) {
      nativeHost().animateLayout(shellView.android);
    }

    sidebarVisible.value = false;
  } else {
    if (shellView) {
      nativeHost().animateLayout(shellView.android);
    }

    sidebarVisible.value = true;
    await nextTick();

    if (sidebarView) {
      enter(sidebarView, 8);
    }
  }
});

watch(
  immersive,
  () => {
    if (shellView) {
      nativeHost().animateLayout(shellView.android);
    }
  },
  { flush: 'sync' },
);

function activateRow(node: Playlist['nodes'][number]) {
  if (node.kind === 'group' && sidebarView) {
    nativeHost().animateLayout(sidebarView.android);
  }

  workspace.activate(node);
}

function shellLoaded(event: EventData) {
  shellView = event.object as View;
}

function sidebarLoaded(event: EventData) {
  sidebarView = event.object as View;
  enter(sidebarView, 8);
}

onUnmounted(() => {
  workspace.stop();

  if (timer) {
    clearInterval(timer);
  }
});

async function addItem(parentId: string | null = null) {
  if (snapshot.value.available) {
    const draft = draftVideo(snapshot.value.url);
    draft.parentId = parentId;
    draft.title = snapshot.value.title;
    draft.partTitle = snapshot.value.partTitle;
    editor.value = draft;
    return;
  }

  const result = await prompt({
    title: '添加视频链接 / BV 号',
    okButtonText: '添加',
    cancelButtonText: '取消',
  });

  if (result.result) {
    try {
      editor.value = { ...draftVideo(result.text), parentId };
    } catch {
      error.value = '请输入有效的 B 站视频链接';
    }
  }
}

function saveItem(item: VideoItem) {
  if (!playlist.value) {
    return;
  }

  const document = JSON.parse(JSON.stringify(playlist.value)) as Playlist;
  const index = document.nodes.findIndex(node => node.id === item.id);

  if (index < 0) {
    document.nodes.push(item);
  } else {
    document.nodes[index] = item;
  }

  workspace.save(document);
  editor.value = null;
}

async function navigation() {
  const choice = await action({
    title: '网页导航',
    actions: ['打开网址', '后退', '刷新', '显示系统栏'],
    cancelButtonText: '取消',
  });

  if (choice === '后退') {
    nativeHost().back();
  }

  if (choice === '刷新') {
    nativeHost().navigate(snapshot.value.url || 'https://www.bilibili.com');
  }

  if (choice === '显示系统栏') {
    nativeHost().setImmersive(Application.android.foregroundActivity, false);
  }

  if (choice === '打开网址') {
    const result = await prompt({
      title: 'B 站网址',
      defaultText: snapshot.value.url || 'https://www.bilibili.com',
      okButtonText: '打开',
      cancelButtonText: '取消',
    });

    if (result.result && /^https:\/\/([\w-]+\.)?bilibili\.com(\/|$)/i.test(result.text)) {
      nativeHost().navigate(result.text);
    }
  }
}

function listLoaded(event: EventData) {
  const list = (event.object as View).android as android.widget.ListView | undefined;
  list?.setDividerHeight(0);
  list?.setSelector(
    new android.graphics.drawable.ColorDrawable(android.graphics.Color.TRANSPARENT),
  );
}

function editItem(value: VideoItem) {
  editor.value = value;
}
</script>

<template>
  <Page
    actionBarHidden="true"
    androidOverflowEdge="dont-apply"
    :statusBarStyle="theme === 'dark' ? 'light' : 'dark'"
    androidStatusBarBackground="#00000000"
    backgroundSpanUnderStatusBar="true"
    :backgroundColor="theme === 'dark' ? '#0e0e0e' : '#fafafa'"
    @layoutChanged="layout"
    @loaded="loaded"
  >
    <GridLayout
      rows="auto,*"
      androidOverflowEdge="dont-apply"
      @loaded="shellLoaded"
      class="bg-surface text-foreground font-mono text-xs"
      :class="theme === 'light' ? 'light' : ''"
      :color="foreground"
    >
      <GridLayout
        v-if="!immersive"
        row="0"
        columns="auto,*,auto,auto,auto"
        class="bg-surface border-border min-h-[42] border-b"
        :paddingTop="insets.top"
        :paddingLeft="Math.max(12, insets.left)"
        :paddingRight="Math.max(8, insets.right)"
      >
        <IconButton name="back" accessibilityLabel="后退" @tap="nativeHost().back()" />
        <Label
          col="1"
          :text="snapshot.title || 'bilibili.com'"
          class="text-muted px-3 text-[length:11]"
          verticalAlignment="center"
          @tap="navigation"
        />
        <IconButton
          col="2"
          name="expand"
          accessibilityLabel="沉浸模式"
          @tap="workspace.toggleImmersive"
        />
        <IconButton
          col="3"
          :name="theme === 'dark' ? 'sun' : 'moon'"
          accessibilityLabel="切换主题"
          @tap="
            workspace.perform('setting', {
              key: 'theme',
              value: theme === 'dark' ? 'light' : 'dark',
            })
          "
        />
        <IconButton
          col="4"
          name="panel"
          accessibilityLabel="切换播放列表侧栏"
          @tap="collapsed = !collapsed"
        />
      </GridLayout>
      <GridLayout
        row="1"
        :columns="columns"
        :rows="layoutRows"
        :paddingBottom="immersive ? 0 : insets.bottom"
      >
        <BilibiliView row="0" col="0" />
        <GridLayout
          v-if="sidebarVisible"
          :col="landscape ? 1 : 0"
          :row="landscape ? 0 : 1"
          rows="auto,auto,auto,*,auto"
          class="bg-panel border-border border-l"
          @loaded="sidebarLoaded"
          :paddingRight="landscape ? insets.right : 0"
          :paddingTop="immersive ? insets.top : 0"
        >
          <GridLayout row="0" columns="*,auto,auto" class="border-border border-b px-2.5 py-0.5">
            <StackLayout
              orientation="horizontal"
              verticalAlignment="center"
              @tap="workspace.selectPlaylist"
            >
              <Label
                :text="playlist?.title || '播放列表'"
                class="text-heading text-sm"
                :maxWidth="landscape ? sidebarWidth - 125 : width - 140"
                textWrap="false"
                verticalAlignment="center"
              />
              <Image
                src="res://ic_chevron"
                rotate="90"
                class="ml-1.5 h-3.5 w-3.5"
                verticalAlignment="center"
              />
            </StackLayout>
            <IconButton
              col="1"
              name="settings"
              accessibilityLabel="播放列表设置"
              @tap="workspace.settings"
            />
            <IconButton
              col="2"
              name="plus"
              accessibilityLabel="新建播放列表"
              @tap="workspace.createPlaylist"
            />
          </GridLayout>
          <GridLayout row="1" columns="*,auto,auto,auto,auto" class="px-2.5 py-1">
            <Label text="播放顺序" class="text-dim text-[length:11]" verticalAlignment="center" />
            <IconButton
              col="1"
              name="previous"
              small
              accessibilityLabel="上一项"
              @tap="workspace.perform('previous')"
            />
            <IconButton
              col="2"
              name="next"
              small
              accessibilityLabel="下一项"
              @tap="workspace.perform('next')"
            />
            <IconButton
              col="3"
              name="folder"
              small
              accessibilityLabel="添加分组"
              @tap="workspace.addGroup"
            />
            <IconButton col="4" name="plus" small accessibilityLabel="添加视频" @tap="addItem()" />
          </GridLayout>
          <TextField
            row="2"
            v-model="search"
            hint="搜索标题、别名、分集、链接…"
            accessibilityLabel="搜索播放列表"
            class="text-foreground mx-3 mb-2 text-[length:12]"
          />
          <ListView
            row="3"
            :items="rows"
            separatorColor="transparent"
            class="bg-transparent"
            @loaded="listLoaded"
          >
            <template #default="{ item }">
              <PlaylistRow
                :item="item"
                @activate="activateRow"
                @add="addItem"
                @menu="node => workspace.itemMenu(node, editItem)"
              />
            </template>
          </ListView>
          <Label
            v-if="!rows.length"
            row="3"
            :text="search.trim() ? '没有匹配的条目' : '添加视频，开始你的播放列表'"
            class="text-dim m-4 text-[length:11]"
            horizontalAlignment="center"
            verticalAlignment="center"
          />
          <Label
            v-if="error || snapshot.audioOffsetError"
            row="4"
            :text="error || snapshot.audioOffsetError"
            class="bg-border text-foreground p-2.5"
            textWrap="true"
            @tap="error = ''"
          />
        </GridLayout>
      </GridLayout>
      <ImmersiveControls
        v-if="immersive"
        row="1"
        horizontalAlignment="right"
        verticalAlignment="top"
        :marginTop="Math.max(6, insets.top)"
        :marginRight="Math.max(8, insets.right) + (landscape && sidebarVisible ? sidebarWidth : 0)"
        @exit="workspace.toggleImmersive"
        @toggleSidebar="collapsed = !collapsed"
      />
      <ItemEditor
        v-if="editor && playlist"
        row="0"
        rowSpan="2"
        :item="editor"
        :playlist="playlist"
        :snapshot="snapshot"
        :theme="theme"
        :marginTop="insets.top"
        :marginBottom="insets.bottom"
        :marginLeft="Math.max(16, insets.left)"
        :marginRight="Math.max(16, insets.right)"
        @save="saveItem"
        @close="editor = null"
      />
    </GridLayout>
  </Page>
</template>
