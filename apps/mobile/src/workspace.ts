import type { Playlist, PlaylistNode, VideoItem } from '@bplaylist/shared';
import {
  emptySnapshot,
  archiveSchema,
  flattenPlaylist,
  formatTime,
  parseTime,
  parseVideoLink,
} from '@bplaylist/shared';
import { action, alert, confirm, prompt, Application } from '@nativescript/core';
import { computed, ref, shallowRef } from 'nativescript-vue';

import { cloud } from './cloud.ts';
import { openPlaylistFile, savePlaylistFile } from './files.ts';
import { call, connection, initialize, nativeHost } from './host.ts';
import type { MobileState } from './host.ts';

export function useWorkspace() {
  const state = shallowRef<MobileState | null>(null);
  const error = shallowRef('');
  const collapsed = shallowRef(false);
  const immersive = shallowRef(false);
  const collapsedGroups = ref(new Set<string>());
  const snapshot = shallowRef({ ...emptySnapshot });
  const playlist = computed(() => state.value?.playlist);
  const theme = computed(() => state.value?.theme ?? 'dark');

  function refresh() {
    try {
      const next = call('state');

      if (
        !state.value ||
        next.revision !== state.value.revision ||
        next.playlist.id !== state.value.playlist.id ||
        next.theme !== state.value.theme ||
        next.autoFullscreen !== state.value.autoFullscreen
      ) {
        state.value = next;
      }

      snapshot.value = { ...emptySnapshot, ...JSON.parse(nativeHost().snapshot()) };
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  function perform(method: string, input: unknown = null) {
    try {
      call(method, input);
      refresh();
    } catch (cause) {
      void alert({
        title: '操作失败',
        message: cause instanceof Error ? cause.message : String(cause),
        okButtonText: '知道了',
      });
    }
  }

  const rows = computed(() => {
    const result: {
      node: PlaylistNode;
      depth: number;
      number: number;
      title: string;
      detail: string;
      active: boolean;
      collapsed: boolean;
    }[] = [];

    const document = playlist.value;

    if (!document) {
      return result;
    }

    const order = new Map(
      flattenPlaylist(document.nodes).map((node, index) => [node.id, index + 1]),
    );

    function visit(parentId: string | null, depth: number) {
      for (const node of document!.nodes.filter(node => node.parentId === parentId)) {
        const group = node.kind === 'group';
        result.push({
          node,
          depth,
          number: order.get(node.id) ?? 0,
          title: group ? node.title : node.alias || node.title,
          detail: describeNode(node, document!),
          active:
            state.value?.playingPlaylistId === document!.id &&
            state.value.playingItemId === node.id,
          collapsed: collapsedGroups.value.has(node.id),
        });

        if (group && !collapsedGroups.value.has(node.id)) {
          visit(node.id, depth + 1);
        }
      }
    }

    visit(null, 0);
    return result;
  });

  function activate(node: PlaylistNode) {
    if (node.kind === 'group') {
      const groups = new Set(collapsedGroups.value);

      if (groups.has(node.id)) {
        groups.delete(node.id);
      } else {
        groups.add(node.id);
      }

      collapsedGroups.value = groups;
    } else {
      perform('play', node.id);
    }
  }

  async function selectPlaylist() {
    const lists = state.value?.playlists ?? [];

    const picked = await action({
      title: '播放列表',
      cancelButtonText: '取消',
      actions: lists.map((list, index) => `${index + 1}. ${list.title}`),
    });

    const index = Number.parseInt(picked) - 1;

    if (lists[index]) {
      perform('select', lists[index].id);
    }
  }

  async function createPlaylist() {
    const result = await prompt({
      title: '新建播放列表',
      defaultText: '',
      okButtonText: '创建',
      cancelButtonText: '取消',
    });

    if (result.result && result.text.trim()) {
      perform('create', result.text.trim());
    }
  }

  function save(document: Playlist) {
    perform('save', document);
  }

  async function addGroup() {
    const result = await prompt({
      title: '添加分组',
      okButtonText: '添加',
      cancelButtonText: '取消',
    });

    if (!result.result || !result.text.trim() || !playlist.value) {
      return;
    }

    const document = JSON.parse(JSON.stringify(playlist.value)) as Playlist;
    document.nodes.push({
      id: java.util.UUID.randomUUID().toString(),
      kind: 'group',
      parentId: null,
      title: result.text.trim(),
    });
    save(document);
  }

  async function showConnection() {
    try {
      const result = connection();

      const picked = await action({
        title: '连接浏览器插件',
        message: '电脑与手机连接同一局域网，选择地址复制连接信息。',
        cancelButtonText: '取消',
        actions: result.endpoints,
      });

      if (result.endpoints.includes(picked)) {
        setClipboard(JSON.stringify({ endpoint: picked, token: result.token }));
        await alert({
          title: '已复制连接信息',
          message: '粘贴到浏览器插件的连接设置。服务在应用进程运行时可用。',
          okButtonText: '知道了',
        });
      }
    } catch (cause) {
      await alert(String(cause));
    }
  }

  async function settings() {
    const fullscreenLabel = `${state.value?.autoFullscreen ? '关闭' : '开启'}自动网页全屏`;

    const choices: Record<string, () => unknown> = {
      连接浏览器插件: showConnection,
      网页缩放: chooseWebZoom,
      切换黑白主题: () =>
        perform('setting', { key: 'theme', value: theme.value === 'dark' ? 'light' : 'dark' }),
      [fullscreenLabel]: () =>
        perform('setting', { key: 'autoFullscreen', value: String(!state.value?.autoFullscreen) }),
      重命名播放列表: renamePlaylist,
      导入播放列表: importPlaylist,
      导出播放列表: exportPlaylist,
      云端导入导出: () =>
        playlist.value && cloud(playlist.value.id, archive => perform('import', archive)),
      删除播放列表: deletePlaylist,
    };

    const choice = await action({
      title: '播放列表设置',
      cancelButtonText: '取消',
      actions: Object.keys(choices),
    });

    await choices[choice]?.();
  }

  async function chooseWebZoom() {
    const choices = ['85%', '100%', '115%', '125%', '150%'];

    const choice = await action({
      title: '网页缩放',
      message: '按播放器区域自动适配，额外调整页面内容大小。',
      cancelButtonText: '取消',
      actions: choices,
    });

    if (choices.includes(choice)) {
      nativeHost().setWebZoom(Number.parseInt(choice) / 100);
    }
  }

  async function renamePlaylist() {
    if (!playlist.value) {
      return;
    }

    const result = await prompt({
      title: '重命名播放列表',
      defaultText: playlist.value.title,
      okButtonText: '保存',
      cancelButtonText: '取消',
    });

    if (result.result && result.text.trim()) {
      save({ ...playlist.value, title: result.text.trim() });
    }
  }

  async function exportPlaylist() {
    try {
      const archive = archiveSchema.parse(call('export'));

      const saved = await savePlaylistFile(
        archive.playlist.title,
        JSON.stringify(archive, null, 2),
      );

      if (saved) {
        await alert({
          title: '导出成功',
          message: '播放列表及进度已保存为 JSON 文件，可直接导入 PC 端。',
          okButtonText: '知道了',
        });
      }
    } catch (cause) {
      await alert({
        title: '导出失败',
        message: cause instanceof Error ? cause.message : String(cause),
        okButtonText: '知道了',
      });
    }
  }

  async function importPlaylist() {
    try {
      const text = await openPlaylistFile();

      if (text === null) {
        return;
      }

      const parsed = archiveSchema.safeParse(JSON.parse(text.replace(/^\uFEFF/, '')));

      if (!parsed.success) {
        throw new Error('文件不是有效的 BPlaylist 播放列表，请选择 PC 或安卓端导出的 JSON 文件。');
      }

      call('import', parsed.data);
      refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      await alert({
        title: '导入失败',
        message: cause instanceof SyntaxError ? '播放列表文件不是有效的 JSON。' : message,
        okButtonText: '知道了',
      });
    }
  }

  async function deletePlaylist() {
    if (!playlist.value) {
      return;
    }

    const confirmed = await confirm({
      title: '删除播放列表？',
      message: '条目和本地进度也会被删除。',
      okButtonText: '删除',
      cancelButtonText: '取消',
    });

    if (confirmed) {
      perform('remove', playlist.value.id);
    }
  }

  async function itemMenu(node: PlaylistNode, edit: (item: VideoItem) => void) {
    const choices =
      node.kind === 'video' ? ['编辑', '上移', '下移', '删除'] : ['重命名', '上移', '下移', '删除'];

    const choice = await action({ title: node.title, cancelButtonText: '取消', actions: choices });

    if (choice === '编辑' && node.kind === 'video') {
      edit(node);
      return;
    }

    if (!playlist.value || choice === '取消') {
      return;
    }

    const document = JSON.parse(JSON.stringify(playlist.value)) as Playlist;

    if (choice === '重命名') {
      const result = await prompt({
        title: '重命名分组',
        defaultText: node.title,
        okButtonText: '保存',
        cancelButtonText: '取消',
      });

      if (!result.result) {
        return;
      }

      document.nodes.find(item => item.id === node.id)!.title = result.text.trim();
    }

    if (choice === '上移' || choice === '下移') {
      reorderNode(document, node, choice === '上移' ? -1 : 1);
    }

    if (choice === '删除') {
      if (
        !(await confirm({
          title: '删除条目？',
          message: node.kind === 'group' ? '分组中的条目也会被删除。' : node.title,
          okButtonText: '删除',
          cancelButtonText: '取消',
        }))
      ) {
        return;
      }

      removeNode(document, node.id);
    }

    save(document);
  }

  function toggleImmersive() {
    immersive.value = !immersive.value;

    if (immersive.value) {
      collapsed.value = true;
    }

    nativeHost().setImmersive(
      Application.android.foregroundActivity || Application.android.startActivity,
      immersive.value,
    );
  }

  return {
    state,
    error,
    collapsed,
    immersive,
    playlist,
    theme,
    snapshot,
    rows,
    refresh,
    perform,
    activate,
    selectPlaylist,
    createPlaylist,
    addGroup,
    settings,
    itemMenu,
    save,
    toggleImmersive,
    start() {
      try {
        state.value = initialize();
      } catch (cause) {
        error.value = String(cause);
      }
    },
  };
}

export function draftVideo(url: string): VideoItem {
  const parsed = parseVideoLink(url);
  return {
    id: java.util.UUID.randomUUID().toString(),
    kind: 'video',
    parentId: null,
    alias: '',
    title: '未命名视频',
    partTitle: '',
    url: parsed.url,
    start: parsed.start ?? 0,
    end: null,
  };
}

export function readTime(text: string, optional = false) {
  return optional && !text.trim() ? null : parseTime(text || '0');
}

function setClipboard(value: string) {
  const context = Application.android.context;

  const manager = context.getSystemService(
    android.content.Context.CLIPBOARD_SERVICE,
  ) as android.content.ClipboardManager;

  manager.setPrimaryClip(android.content.ClipData.newPlainText('BPlaylist', value));
}

function describeNode(node: PlaylistNode, document: Playlist): string {
  if (node.kind === 'group') {
    return `${document.nodes.filter(child => child.parentId === node.id).length} 项`;
  }

  const progress = document.progress[node.id];

  const range =
    node.start || node.end
      ? `${formatTime(node.start)} — ${node.end === null ? '结尾' : formatTime(node.end)}`
      : '';

  const position = progress
    ? `${progress.completed ? '已完成' : '已播'} ${formatTime(progress.position)}`
    : '';

  const continuation = node.continuation?.at(-1);

  if (continuation) {
    const first = node.partTitle.split(' · ')[0] || '起始集';
    const last = continuation.title.split(' · ')[0] || '结束集';
    return [
      `${first} ${formatTime(node.start)} → ${last} ${node.end === null ? '结尾' : formatTime(node.end)}`,
      position,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  return [node.partTitle, range, position].filter(Boolean).join(' · ');
}

function reorderNode(document: Playlist, node: PlaylistNode, direction: number) {
  const siblings = document.nodes.filter(item => item.parentId === node.parentId);
  const index = siblings.findIndex(item => item.id === node.id);
  const target = siblings[index + direction];

  if (!target) {
    return;
  }

  const from = document.nodes.findIndex(item => item.id === node.id);
  const to = document.nodes.findIndex(item => item.id === target.id);
  [document.nodes[from], document.nodes[to]] = [document.nodes[to], document.nodes[from]];
}

function removeNode(document: Playlist, id: string) {
  const removed = new Set([id]);

  for (let changed = true; changed;) {
    changed = false;

    for (const item of document.nodes) {
      if (item.parentId && removed.has(item.parentId) && !removed.has(item.id)) {
        removed.add(item.id);
        changed = true;
      }
    }
  }

  document.nodes = document.nodes.filter(item => !removed.has(item.id));
}
