import { EventEmitter } from 'node:events';

import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { PlaybackController } from '../apps/desktop/src/main/player/controller.ts';
import { openLibrary } from '../apps/desktop/src/main/storage/database.ts';
import { createPlaylist, emptySnapshot, videoUrl } from '../packages/shared/src/index.ts';
import type { PlayerSnapshot } from '../packages/shared/src/index.ts';

vi.mock('../apps/desktop/src/main/player/scripts/install.ts?inject', () => ({ default: 'read' }));
vi.mock('../apps/desktop/src/main/player/scripts/command.ts?inject', () => ({
  default: 'command',
}));

class Guest extends EventEmitter {
  snapshot: PlayerSnapshot = {
    ...emptySnapshot,
    available: true,
    duration: 100,
    url: videoUrl('BV1GJ411x7h7'),
  };
  commands: { action: string; position?: number }[] = [];
  fullscreenReady = true;
  isDestroyed = () => false;
  isLoadingMainFrame = () => false;
  getURL = () => this.snapshot.url;

  async loadURL(url: string) {
    this.snapshot = { ...this.snapshot, url, position: 0, ended: false };
  }

  async executeJavaScript(script: string) {
    if (script.endsWith('\nread')) {
      return { ...this.snapshot };
    }

    const input = JSON.parse(script.slice(script.indexOf('=') + 1, script.indexOf(';')));
    this.commands.push(input);

    if (input.action === 'seek') {
      this.snapshot.position = input.position;
      this.snapshot.ended = false;
    }

    if (input.action === 'play') {
      this.snapshot.paused = false;
    }

    if (input.action === 'pause') {
      this.snapshot.paused = true;
    }

    if (input.action === 'fullscreen') {
      if (!this.fullscreenReady) {
        return false;
      }

      this.snapshot.webFullscreen = true;
      return true;
    }
  }
}

describe('主进程顺序播放', () => {
  let library: ReturnType<typeof openLibrary>;
  let player: PlaybackController;
  let guest: Guest;

  beforeEach(async () => {
    vi.useFakeTimers();
    library = openLibrary(':memory:');
    player = new PlaybackController(library);
    guest = new Guest();
    player.attach(guest as unknown as WebContents);
    const document = createPlaylist();
    document.nodes = [
      {
        id: 'a',
        parentId: null,
        kind: 'video',
        alias: '',
        partTitle: '',
        title: '片段 A',
        url: videoUrl('BV1GJ411x7h7'),
        start: 10,
        end: 20,
      },
      { id: 'g', parentId: null, kind: 'group', title: '分组' },
      {
        id: 'b',
        parentId: 'g',
        kind: 'video',
        alias: '',
        partTitle: '',
        title: '片段 B',
        url: videoUrl('BV1GJ411x7h7'),
        start: 30,
        end: 40,
      },
    ];
    await player.replace(document);
  });

  afterEach(() => {
    player.dispose();
    library.close();
    vi.useRealTimers();
  });

  it('后台同步保留当前播放位置和条目，同时更新列表结构', async () => {
    await player.play('a');
    await vi.advanceTimersByTimeAsync(600);
    guest.snapshot.position = 15;
    await vi.advanceTimersByTimeAsync(500);
    player.persist();
    const incoming = structuredClone(player.playlist);
    incoming.title = '云端改名';
    incoming.activeItemId = 'b';
    incoming.progress.a = {
      position: 19,
      duration: 100,
      completed: false,
      updatedAt: new Date().toISOString(),
    };
    const commands = guest.commands.length;
    player.applySync(incoming.id, incoming);
    expect(player.playlist.title).toBe('云端改名');
    expect(player.playlist.activeItemId).toBe('a');
    expect(player.playlist.progress.a!.position).toBe(15);
    expect(player.running).toBe(true);
    expect(guest.commands).toHaveLength(commands);
  });

  it('云端删除正在播放的条目会暂停并保留有效列表', async () => {
    await player.play('a');
    await vi.advanceTimersByTimeAsync(600);
    const incoming = structuredClone(player.playlist);
    incoming.nodes = incoming.nodes.filter(node => node.id !== 'a');
    incoming.activeItemId = null;
    delete incoming.progress.a;
    player.applySync(incoming.id, incoming);
    expect(player.running).toBe(false);
    expect(guest.commands.at(-1)?.action).toBe('pause');
    player.applySync(incoming.id, null);
    expect(library.get(incoming.id)).toBeUndefined();
    expect(library.get(player.selectedPlaylist.id)).toBeDefined();
  });

  it('浏览和编辑其他列表不暂停原视频，原列表继续自动播放', async () => {
    const originalId = player.playlist.id;
    const target = createPlaylist('另一个列表');
    library.save(target);
    await player.play('a');
    await vi.advanceTimersByTimeAsync(600);
    const pauses = guest.commands.filter(command => command.action === 'pause').length;
    player.select(target.id);
    expect(player.state().playlist.id).toBe(target.id);
    expect(player.state().playingPlaylistId).toBe(originalId);
    expect(player.running).toBe(true);
    const edited = structuredClone(player.state().playlist);
    edited.title = '只修改浏览中的列表';
    await player.editSelected(edited, player.state().revision);
    expect(library.list().find(item => item.id === target.id)?.title).toBe(edited.title);
    expect(guest.commands.filter(command => command.action === 'pause')).toHaveLength(pauses);
    guest.snapshot.position = 20;
    await vi.advanceTimersByTimeAsync(1100);
    expect(player.playlist.id).toBe(originalId);
    expect(player.playlist.activeItemId).toBe('b');
    expect(player.playlist.progress.a.completed).toBe(true);
    expect(player.state().playlist.id).toBe(target.id);
    expect(player.running).toBe(true);
  });

  it('只有点击浏览列表的有效条目才切换播放，保留原列表进度', async () => {
    const originalId = player.playlist.id;
    const target = createPlaylist('待播放');
    const source = player.playlist.nodes[0]!;

    if (source.kind !== 'video') {
      throw new Error('fixture');
    }

    target.nodes = [{ ...source, id: 'c', url: videoUrl('BV1GJ411x7h7', 2), start: 5, end: 8 }];
    library.save(target);
    await player.play('a');
    await vi.advanceTimersByTimeAsync(600);
    guest.snapshot.position = 15;
    await vi.advanceTimersByTimeAsync(500);
    player.select(target.id);
    await expect(player.playSelected('missing')).rejects.toThrow('找不到播放条目');
    expect(player.playlist.id).toBe(originalId);
    expect(guest.snapshot.paused).toBe(false);
    await player.playSelected('c');
    await vi.advanceTimersByTimeAsync(600);
    expect(player.playlist.id).toBe(target.id);
    expect(player.playlist.activeItemId).toBe('c');
    expect(guest.snapshot.position).toBe(5);
    expect(library.list().find(item => item.id === originalId)?.progress.a.position).toBe(15);
  });

  it('重启后分别恢复浏览列表和播放列表的身份', async () => {
    const originalId = player.playlist.id;
    const target = createPlaylist('浏览中');
    library.save(target);
    await player.play('a');
    await vi.advanceTimersByTimeAsync(600);
    player.select(target.id);
    player.dispose();
    player = new PlaybackController(library);
    player.attach(guest as unknown as WebContents);
    expect(player.playlist.id).toBe(originalId);
    expect(player.state().playlist.id).toBe(target.id);
  });

  it('网页全屏每次进入只触发一次，手动退出后不反复恢复', async () => {
    await player.play('a');
    await vi.advanceTimersByTimeAsync(1100);
    expect(guest.snapshot.webFullscreen).toBe(true);
    guest.snapshot.webFullscreen = false;
    await vi.advanceTimersByTimeAsync(6000);
    expect(guest.snapshot.webFullscreen).toBe(false);
    expect(guest.commands.filter(command => command.action === 'fullscreen')).toHaveLength(1);

    await player.play('b');
    await vi.advanceTimersByTimeAsync(1100);
    expect(guest.snapshot.webFullscreen).toBe(true);
    guest.snapshot.webFullscreen = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(guest.snapshot.webFullscreen).toBe(false);
    guest.emit('did-start-navigation', {}, guest.getURL(), true, true);
    await vi.advanceTimersByTimeAsync(500);
    expect(guest.snapshot.webFullscreen).toBe(false);
    guest.emit(
      'did-start-navigation',
      {},
      `${guest.getURL()}&fullscreen_change=1#player`,
      true,
      true,
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(guest.snapshot.webFullscreen).toBe(false);
    guest.emit('did-start-navigation', {}, videoUrl('BV1GJ411x7h7', 2), true, true);
    await guest.loadURL(videoUrl('BV1GJ411x7h7', 2));
    await vi.advanceTimersByTimeAsync(500);
    expect(guest.snapshot.webFullscreen).toBe(true);
  });

  it('视频先就绪、网页全屏按钮后出现时，等待按钮后只触发一次', async () => {
    guest.fullscreenReady = false;
    await player.play('a');
    await vi.advanceTimersByTimeAsync(3000);
    expect(guest.snapshot.webFullscreen).toBe(false);
    guest.fullscreenReady = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(guest.snapshot.webFullscreen).toBe(true);
    guest.snapshot.webFullscreen = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(guest.snapshot.webFullscreen).toBe(false);
  });

  it('片段结束后只推进一次，同一视频的下一片段从起点播放', async () => {
    await player.play('a');
    await vi.advanceTimersByTimeAsync(600);
    expect(guest.snapshot.position).toBe(10);
    guest.snapshot.position = 20.2;
    await vi.advanceTimersByTimeAsync(500);
    expect(player.playlist.activeItemId).toBe('b');
    expect(player.playlist.progress.a?.completed).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(guest.snapshot.position).toBe(30);
    await vi.advanceTimersByTimeAsync(500);
    expect(player.playlist.activeItemId).toBe('b');
    expect(guest.snapshot.webFullscreen).toBe(true);
  });

  it('最后一项完成后停止，保留完成进度', async () => {
    await player.play('b');
    await vi.advanceTimersByTimeAsync(600);
    guest.snapshot.position = 40;
    await vi.advanceTimersByTimeAsync(500);
    expect(player.running).toBe(false);
    expect(player.playlist.progress.b?.completed).toBe(true);
    expect(guest.snapshot.paused).toBe(true);
  });

  it('从已保存的视频时间恢复并在重新播放时清除完成标记', async () => {
    player.playlist.progress.a = {
      position: 17,
      duration: 100,
      completed: false,
      updatedAt: new Date().toISOString(),
    };
    await player.play('a');
    await vi.advanceTimersByTimeAsync(600);
    expect(guest.snapshot.position).toBe(17);
    player.playlist.progress.a!.completed = true;
    await player.play('a');
    await vi.advanceTimersByTimeAsync(500);
    expect(guest.snapshot.position).toBe(10);
    expect(player.playlist.progress.a?.completed).toBe(false);
  });

  it('编辑时不覆盖主进程的新进度', async () => {
    await player.play('a');
    await vi.advanceTimersByTimeAsync(600);
    const stale = structuredClone(player.playlist);
    guest.snapshot.position = 16;
    await vi.advanceTimersByTimeAsync(500);
    stale.title = '新名称';
    await player.edit(stale);
    expect(player.playlist.progress.a?.position).toBe(16);
    expect(player.playlist.title).toBe('新名称');
  });

  it('主动暂停会取消等待播放的条目', async () => {
    await player.play('a');
    await player.control({ action: 'pause' });
    await vi.advanceTimersByTimeAsync(1500);
    expect(player.running).toBe(false);
    expect(guest.commands.filter(command => command.action === 'play')).toHaveLength(0);
  });

  it('重启后页面初始时间不能覆盖已保存的恢复时间', async () => {
    player.playlist.activeItemId = 'a';
    player.playlist.progress.a = {
      position: 17,
      duration: 100,
      completed: false,
      updatedAt: new Date().toISOString(),
    };
    await vi.advanceTimersByTimeAsync(600);
    expect(player.playlist.progress.a.position).toBe(17);
    await player.play('a');
    await vi.advanceTimersByTimeAsync(500);
    expect(guest.snapshot.position).toBe(17);
  });

  it('播放中调整条目所属分组不会暂停或重置进度', async () => {
    await player.play('a');
    await vi.advanceTimersByTimeAsync(600);
    guest.snapshot.position = 16;
    await vi.advanceTimersByTimeAsync(500);
    const document = structuredClone(player.playlist);
    document.nodes.find(node => node.id === 'a')!.parentId = 'g';
    await player.edit(document);
    expect(player.running).toBe(true);
    expect(guest.snapshot.paused).toBe(false);
    expect(player.playlist.progress.a?.position).toBe(16);
  });

  it('跨三个分 P 的同一条目仅在末集结束后推进，后续分集从零开始', async () => {
    const document = structuredClone(player.playlist);
    Object.assign(document.nodes[0]!, {
      start: 80,
      end: 36,
      continuation: [
        { title: 'P2', url: videoUrl('BV1GJ411x7h7', 2) },
        { title: 'P3', url: videoUrl('BV1GJ411x7h7', 3) },
      ],
    });
    await player.edit(document);
    await player.play('a');
    await vi.advanceTimersByTimeAsync(600);
    expect(guest.snapshot.position).toBe(80);
    guest.snapshot.position = 99;
    await vi.advanceTimersByTimeAsync(500);
    expect(guest.getURL()).toBe(videoUrl('BV1GJ411x7h7'));
    guest.snapshot.ended = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(guest.getURL()).toBe(videoUrl('BV1GJ411x7h7', 2));
    expect(guest.snapshot.position).toBe(0);
    expect(player.playlist.activeItemId).toBe('a');
    expect(player.playlist.progress.a?.completed).toBe(false);
    guest.snapshot.ended = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(guest.getURL()).toBe(videoUrl('BV1GJ411x7h7', 3));
    guest.snapshot.position = 36;
    await vi.advanceTimersByTimeAsync(500);
    expect(player.playlist.activeItemId).toBe('b');
    expect(player.playlist.progress.a).toMatchObject({
      completed: true,
      segmentIndex: 2,
      position: 36,
    });
  });

  it('跨番剧分集进度持久化后恢复末集，不把首集起点用于末集', async () => {
    const document = structuredClone(player.playlist);
    Object.assign(document.nodes[0]!, {
      url: videoUrl('https://www.bilibili.com/bangumi/play/ep100'),
      start: 80,
      end: 36,
      continuation: [
        { title: '第二集', url: videoUrl('https://www.bilibili.com/bangumi/play/ep101') },
      ],
    });
    await player.edit(document);
    await player.play('a');
    await vi.advanceTimersByTimeAsync(600);
    guest.snapshot.ended = true;
    await vi.advanceTimersByTimeAsync(1000);
    guest.snapshot.position = 12;
    await vi.advanceTimersByTimeAsync(500);
    player.dispose();
    player = new PlaybackController(library);
    player.attach(guest as unknown as WebContents);
    await player.play('a');
    await vi.advanceTimersByTimeAsync(600);
    expect(guest.getURL()).toContain('ep101');
    expect(guest.snapshot.position).toBe(12);
    expect(player.playlist.progress.a?.segmentIndex).toBe(1);
    await player.play('a', false);
    await vi.advanceTimersByTimeAsync(600);
    expect(guest.getURL()).toContain('ep100');
    expect(guest.snapshot.position).toBe(80);
  });
});
