import { z } from 'zod';

const id = z.string().min(1).max(100);
const seconds = z.number().finite().nonnegative();

export function isBilibiliUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com')) &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
}

export function videoUrl(value: string, page?: number): string {
  let input = value.trim();

  if (/^BV[\da-z]+$/i.test(input)) {
    input = `https://www.bilibili.com/video/${input}`;
  }

  const url = new URL(input);

  if (
    !isBilibiliUrl(url.href) ||
    !/^\/(video\/(BV[\da-z]+|av\d+)|bangumi\/play\/(ep|ss)\d+)/i.test(url.pathname)
  ) {
    throw new Error('请输入 B 站视频或番剧链接（也支持 BV 号）');
  }

  const part = page ?? Number(url.searchParams.get('p') || 1);

  if (!Number.isInteger(part) || part < 1) {
    throw new Error('分 P 必须是正整数');
  }

  url.search = '';
  url.hash = '';
  url.searchParams.set('p', String(part));
  return url.href;
}

const sourceUrlSchema = z
  .string()
  .max(2048)
  .refine(isBilibiliUrl, '必须是 HTTPS B 站链接')
  .transform(value => videoUrl(value));

export const videoPartSchema = z.object({
  title: z.string().max(300),
  url: sourceUrlSchema,
});

export const itemSchema = z
  .object({
    id,
    parentId: id.nullable(),
    kind: z.literal('video'),
    alias: z.string().trim().max(300).default(''),
    partTitle: z.string().trim().max(300).default(''),
    title: z.string().trim().min(1).max(300),
    url: sourceUrlSchema,
    continuation: z.array(videoPartSchema).min(1).max(10000).optional(),
    start: seconds.default(0),
    end: seconds.nullable().default(null),
  })
  .refine(
    value => value.continuation || value.end === null || value.end > value.start,
    '结束时间必须大于开始时间',
  )
  .refine(value => {
    const sources = [value.url, ...(value.continuation ?? []).map(part => part.url)].map(
      playbackIdentity,
    );

    return new Set(sources).size === sources.length;
  }, '跨分集范围不能包含重复分集');

export const groupSchema = z.object({
  id,
  parentId: id.nullable(),
  kind: z.literal('group'),
  title: z.string().trim().min(1).max(300),
});

export const nodeSchema = z.union([itemSchema, groupSchema]);

export type PlaylistNode = z.infer<typeof nodeSchema>;

export type VideoItem = z.infer<typeof itemSchema>;

export function playbackSegments(item: VideoItem) {
  const urls = [item.url, ...(item.continuation ?? []).map(part => part.url)];
  return urls.map((url, index) => ({
    url,
    start: index === 0 ? item.start : 0,
    end: index === urls.length - 1 ? item.end : null,
  }));
}

export function displayTitle(node: PlaylistNode): string {
  if (node.kind === 'group') {
    return node.title;
  }

  return node.alias || [node.title, node.partTitle].filter(Boolean).join(' · ');
}

export const progressSchema = z.object({
  segmentIndex: z.number().int().nonnegative().optional(),
  position: seconds,
  duration: seconds,
  completed: z.boolean(),
  updatedAt: z.string().datetime(),
});

function validParents(nodes: Map<string, PlaylistNode>): boolean {
  for (const node of nodes.values()) {
    const seen = new Set([node.id]);
    let parentId = node.parentId;

    while (parentId !== null) {
      const parent = nodes.get(parentId);

      if (!parent || parent.kind !== 'group' || seen.has(parentId) || seen.size > 32) {
        return false;
      }

      seen.add(parentId);
      parentId = parent.parentId;
    }
  }

  return true;
}

export const playlistSchema = z
  .object({
    version: z.literal(1),
    id,
    title: z.string().trim().min(1).max(200),
    nodes: z.array(nodeSchema).max(10000),
    activeItemId: id.nullable(),
    progress: z.record(z.string(), progressSchema),
    updatedAt: z.string().datetime(),
  })
  .superRefine((value, context) => {
    const nodes = new Map(value.nodes.map(node => [node.id, node]));

    if (nodes.size !== value.nodes.length) {
      context.addIssue({ code: 'custom', message: '条目 ID 重复' });
    }

    if (!validParents(nodes)) {
      context.addIssue({ code: 'custom', message: '分组不存在、嵌套过深或包含循环' });
    }

    if (value.activeItemId && nodes.get(value.activeItemId)?.kind !== 'video') {
      context.addIssue({ code: 'custom', message: '当前播放条目不存在' });
    }

    for (const key of Object.keys(value.progress)) {
      if (nodes.get(key)?.kind !== 'video') {
        context.addIssue({ code: 'custom', message: '进度引用了不存在的视频' });
      }
    }
  });

export type Playlist = z.infer<typeof playlistSchema>;

export const archiveSchema = z.object({
  format: z.literal('bplaylist'),
  version: z.literal(1),
  playlist: playlistSchema,
});

export function createPlaylist(title = '我的播放列表'): Playlist {
  return {
    version: 1,
    id: crypto.randomUUID(),
    title,
    nodes: [],
    activeItemId: null,
    progress: {},
    updatedAt: new Date().toISOString(),
  };
}

export function flattenPlaylist(
  nodes: PlaylistNode[],
  parentId: string | null = null,
): VideoItem[] {
  return nodes
    .filter(node => node.parentId === parentId)
    .flatMap(node => (node.kind === 'video' ? [node] : flattenPlaylist(nodes, node.id)));
}

export type DropPosition = 'before' | 'after' | 'inside';

export function canMovePlaylistNode(nodes: PlaylistNode[], id: string, targetId: string): boolean {
  const indexed = new Map(nodes.map(node => [node.id, node]));
  let target = indexed.get(targetId);

  while (target) {
    if (target.id === id) {
      return false;
    }

    target = target.parentId ? indexed.get(target.parentId) : undefined;
  }

  return indexed.has(id) && indexed.has(targetId);
}

export function movePlaylistNode(
  nodes: PlaylistNode[],
  id: string,
  targetId: string,
  position: DropPosition,
): PlaylistNode[] {
  const item = nodes.find(node => node.id === id);
  const target = nodes.find(node => node.id === targetId);

  if (!item || !target || !canMovePlaylistNode(nodes, id, targetId)) {
    throw new Error('不能把分组拖入自身或子分组');
  }

  if (position === 'inside' && target.kind !== 'group') {
    throw new Error('只有分组可以容纳视频');
  }

  const result = nodes.filter(node => node.id !== id);
  const moved = { ...item, parentId: position === 'inside' ? target.id : target.parentId };
  const index = result.findIndex(node => node.id === targetId);

  if (position === 'inside') {
    result.push(moved);
  } else {
    result.splice(index + Number(position === 'after'), 0, moved);
  }

  return result;
}

export function playbackIdentity(value: string): string {
  const url = new URL(value);
  return `${url.pathname.replace(/\/$/, '')}?p=${url.searchParams.get('p') || '1'}`;
}

export function formatTime(value: number): string {
  const seconds = Math.floor(Math.max(0, value));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function parseTime(value: string): number {
  if (!/^(\d+:){0,2}\d+(\.\d+)?$/.test(value.trim())) {
    throw new Error('时间格式应为秒数、mm:ss 或 hh:mm:ss');
  }

  return value
    .trim()
    .split(':')
    .reduce((sum, part) => sum * 60 + Number(part), 0);
}

export function parseVideoLink(value: string): { url: string; start: number | null } {
  const url = videoUrl(value);
  let original: URL;

  try {
    original = new URL(value.trim());
  } catch {
    return { url, start: null };
  }

  const timestamp = original.searchParams.get('t') ?? original.searchParams.get('start_progress');

  if (!timestamp) {
    return { url, start: null };
  }

  const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(timestamp.trim());

  const start = units
    ? Number(units[1] || 0) * 3600 + Number(units[2] || 0) * 60 + Number(units[3] || 0)
    : parseTime(timestamp);

  return { url, start: original.searchParams.has('start_progress') ? start / 1000 : start };
}

const partSchema = z.object({ title: z.string(), url: z.string() });

export const snapshotSchema = z.object({
  url: z.string(),
  title: z.string(),
  partTitle: z.string().default(''),
  available: z.boolean(),
  position: seconds,
  duration: seconds,
  paused: z.boolean(),
  ended: z.boolean(),
  webFullscreen: z.boolean(),
  parts: z.array(partSchema),
});

export type PlayerSnapshot = z.infer<typeof snapshotSchema>;

export const emptySnapshot: PlayerSnapshot = {
  url: '',
  title: '',
  partTitle: '',
  available: false,
  position: 0,
  duration: 0,
  paused: true,
  ended: false,
  webFullscreen: false,
  parts: [],
};

export interface PlaybackState {
  playingPlaylistId: string;
  playingItemId: string | null;
  revision: number;
  playlist: Playlist;
  snapshot: PlayerSnapshot;
  running: boolean;
  autoFullscreen: boolean;
  error: string | null;
}

export const remoteConfigSchema = z.object({
  endpoint: z
    .string()
    .url()
    .refine(value => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
      );
    }, '远程地址必须使用 HTTPS'),
  token: z.string().min(1).max(500),
});
