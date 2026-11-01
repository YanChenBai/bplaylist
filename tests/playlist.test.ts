import { describe, expect, it } from 'vite-plus/test';

import {
  archiveSchema,
  createPlaylist,
  flattenPlaylist,
  movePlaylistNode,
  canMovePlaylistNode,
  displayTitle,
  parseVideoLink,
  itemSchema,
  parseTime,
  playlistSchema,
  videoUrl,
} from '../packages/shared/src/index.ts';
import type { PlaylistNode, VideoItem } from '../packages/shared/src/index.ts';

const video = (id: string, parentId: string | null = null): VideoItem => ({
  id,
  parentId,
  kind: 'video',
  alias: '',
  partTitle: '',
  title: id,
  url: videoUrl('BV1GJ411x7h7'),
  start: 0,
  end: null,
});

describe('播放列表与交换格式', () => {
  it('拖拽支持同级重排、进入分组和移出分组，并拒绝循环', () => {
    const nodes: PlaylistNode[] = [
      video('a'),
      { id: 'g', parentId: null, kind: 'group', title: '分组' },
      video('b', 'g'),
      video('c'),
    ];

    const reordered = movePlaylistNode(nodes, 'c', 'a', 'before');
    expect(flattenPlaylist(reordered).map(node => node.id)).toEqual(['c', 'a', 'b']);
    const grouped = movePlaylistNode(nodes, 'c', 'g', 'inside');
    expect(grouped.find(node => node.id === 'c')?.parentId).toBe('g');
    expect(flattenPlaylist(grouped).map(node => node.id)).toEqual(['a', 'b', 'c']);
    const ungrouped = movePlaylistNode(grouped, 'b', 'g', 'after');
    expect(ungrouped.find(node => node.id === 'b')?.parentId).toBeNull();
    expect(canMovePlaylistNode(grouped, 'g', 'b')).toBe(false);
    expect(() => movePlaylistNode(grouped, 'g', 'b', 'before')).toThrow();
    expect(nodes.find(node => node.id === 'c')?.parentId).toBeNull();
  });
  it('递归进入分组，播完分组后回到外部后继项', () => {
    const nodes: PlaylistNode[] = [
      video('first'),
      { id: 'group', parentId: null, kind: 'group', title: '分组' },
      video('inside-1', 'group'),
      { id: 'nested', parentId: 'group', kind: 'group', title: '嵌套' },
      video('inside-2', 'nested'),
      video('last'),
    ];

    expect(flattenPlaylist(nodes).map(item => item.id)).toEqual([
      'first',
      'inside-1',
      'inside-2',
      'last',
    ]);
  });

  it.each([
    [{ id: 'g', parentId: 'g', kind: 'group', title: '循环' }],
    [video('a', 'missing')],
    [video('a'), video('a')],
    [video('a'), video('b', 'a')],
  ])('拒绝无效分组结构 %j', (...nodes) => {
    expect(playlistSchema.safeParse({ ...createPlaylist(), nodes }).success).toBe(false);
  });

  it('导出导入保留当前条目、片段、分 P 和每项进度', () => {
    const playlist = createPlaylist('教程');
    playlist.nodes = [{ ...video('p2'), url: videoUrl('BV1GJ411x7h7', 2), start: 10, end: 40 }];
    playlist.activeItemId = 'p2';
    playlist.progress.p2 = {
      position: 23,
      duration: 100,
      completed: false,
      updatedAt: playlist.updatedAt,
    };
    const archive = { format: 'bplaylist', version: 1, playlist };
    const serialized = JSON.parse(JSON.stringify(archive));
    expect(archiveSchema.parse(serialized)).toEqual(archive);
    expect(archiveSchema.safeParse({ ...archive, version: 2 }).success).toBe(false);
  });

  it('校验片段边界与视频地址', () => {
    expect(itemSchema.safeParse({ ...video('a'), start: 20, end: 10 }).success).toBe(false);
    expect(() => videoUrl('https://bilibili.com.evil.test/video/BV123')).toThrow();
    expect(() => videoUrl('https://www.bilibili.com/video/BV123?p=-1')).toThrow();
    expect(videoUrl('https://www.bilibili.com/video/BV123?p=2&tracking=remove')).toBe(
      'https://www.bilibili.com/video/BV123?p=2',
    );
    expect(videoUrl('https://www.bilibili.com/bangumi/play/ep123')).toContain('/ep123');
    expect(videoUrl('https://www.bilibili.com/bangumi/play/ep6613853')).toBe(
      'https://www.bilibili.com/bangumi/play/ep6613853?p=1',
    );
    expect(parseTime('1:02:03')).toBe(3723);
    expect(() => parseTime('无效时间')).toThrow();
  });

  it('跨分集允许末集时间小于首集起点，交换格式保留范围与分集进度', () => {
    const item = itemSchema.parse({
      ...video('range'),
      start: 1080,
      end: 360,
      continuation: [{ title: 'P2', url: videoUrl('BV1GJ411x7h7', 2) }],
    });

    const playlist = createPlaylist();
    playlist.nodes = [item];
    playlist.progress.range = {
      segmentIndex: 1,
      position: 120,
      duration: 1000,
      completed: false,
      updatedAt: playlist.updatedAt,
    };
    const serialized = JSON.parse(JSON.stringify({ format: 'bplaylist', version: 1, playlist }));
    expect(archiveSchema.parse(serialized).playlist).toEqual(playlist);
    expect(
      itemSchema.safeParse({ ...item, continuation: [{ title: '重复首集', url: item.url }] })
        .success,
    ).toBe(false);
    expect(itemSchema.safeParse({ ...item, continuation: [] }).success).toBe(false);
  });

  it('别名优先，仍然保留原视频标题与分集名', () => {
    const item = itemSchema.parse({
      ...video('alias'),
      title: '课程标题',
      partTitle: '第 2 集 · 基础',
    });

    expect(displayTitle(item)).toBe('课程标题 · 第 2 集 · 基础');
    expect(displayTitle({ ...item, alias: '今晚看这段' })).toBe('今晚看这段');
    expect(item.title).toBe('课程标题');
  });

  it('从分享链接提取分 P、分集与空降时间并清理追踪参数', () => {
    expect(
      parseVideoLink(
        'https://www.bilibili.com/video/BV1XSMpzdEWD/?share_source=copy_web&vd_source=tracking&t=1266&spm_id_from=333.1369.0.0',
      ),
    ).toEqual({ url: 'https://www.bilibili.com/video/BV1XSMpzdEWD/?p=1', start: 1266 });
    expect(parseVideoLink('https://www.bilibili.com/video/BV123?p=3&t=1:30')).toEqual({
      url: 'https://www.bilibili.com/video/BV123?p=3',
      start: 90,
    });
    expect(parseVideoLink('https://www.bilibili.com/bangumi/play/ep6613853?t=90')).toEqual({
      url: 'https://www.bilibili.com/bangumi/play/ep6613853?p=1',
      start: 90,
    });
    expect(parseVideoLink('BV1XSMpzdEWD').start).toBeNull();
  });
});
