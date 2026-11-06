import { z } from 'zod';

import { nodeSchema, playlistSchema, progressSchema } from './index.ts';
import type { Playlist } from './index.ts';

const id = z.string().min(1).max(100);

export const syncPreferencesSchema = z.object({
  automatic: z.boolean().default(true),
  intervalMinutes: z.union([z.literal(5), z.literal(15), z.literal(30)]).default(5),
});

export type SyncPreferences = z.infer<typeof syncPreferencesSchema>;

// 字段补丁相对于上次确认的版本生成，避免离线设备提交旧字段覆盖其他设备。
const nodeFields = z.enum([
  'parentId',
  'title',
  'alias',
  'partTitle',
  'url',
  'continuation',
  'start',
  'end',
]);

export const playlistPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  deleted: z.boolean().optional(),
  nodes: z
    .array(
      z
        .object({ id, value: nodeSchema, fields: z.array(nodeFields).max(15) })
        .refine(update => update.id === update.value.id, '条目 ID 不匹配'),
    )
    .max(10000),
  removed: z.array(id).max(10000),
  order: z.array(id).max(10000).optional(),
  progress: z.record(z.string(), progressSchema.nullable()),
  activeItemId: id.nullable().optional(),
});

export type PlaylistPatch = z.infer<typeof playlistPatchSchema>;

export const syncDocumentSchema = z.object({
  id,
  playlist: playlistSchema.nullable(),
  tombstones: z.array(id),
  revision: z.number().int().nonnegative(),
});

export type SyncDocument = z.infer<typeof syncDocumentSchema>;

export const syncMutationSchema = z.object({ mutationId: id, id, patch: playlistPatchSchema });

export type SyncMutation = z.infer<typeof syncMutationSchema>;

export const syncPageSchema = z.object({
  cursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  documents: z.array(syncDocumentSchema),
});

function equal(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function playlistPatch(base: Playlist | null, current: Playlist | null): PlaylistPatch {
  const patch: PlaylistPatch = { nodes: [], removed: [], progress: {} };

  if (!current) {
    return { ...patch, deleted: true };
  }

  if (base?.title !== current.title) {
    patch.title = current.title;
  }

  const before = new Map(base?.nodes.map(node => [node.id, node]) ?? []);

  for (const node of current.nodes) {
    const previous = before.get(node.id);

    const fields = [...new Set([...Object.keys(previous ?? {}), ...Object.keys(node)])].filter(
      key =>
        key !== 'id' &&
        key !== 'kind' &&
        !equal(previous?.[key as keyof typeof previous], node[key as keyof typeof node]),
    ) as z.infer<typeof nodeFields>[];

    // 时间范围与跨集来源是一组约束，并发修改时必须一起提交。
    const playbackFields = ['url', 'start', 'end', 'continuation'] as const;

    if (
      node.kind === 'video' &&
      fields.some(field => (playbackFields as readonly string[]).includes(field))
    ) {
      for (const field of playbackFields) {
        if (!fields.includes(field)) {
          fields.push(field);
        }
      }
    }

    if (fields.length) {
      patch.nodes.push({ id: node.id, value: node, fields });
    }
  }

  patch.removed = [...before.keys()].filter(id => !current.nodes.some(node => node.id === id));
  const order = current.nodes.map(node => node.id);

  if (
    !equal(
      base?.nodes.map(node => node.id),
      order,
    )
  ) {
    patch.order = order;
  }

  for (const key of new Set([
    ...Object.keys(base?.progress ?? {}),
    ...Object.keys(current.progress),
  ])) {
    if (!equal(base?.progress[key], current.progress[key])) {
      patch.progress[key] = current.progress[key] ?? null;
    }
  }

  if (base?.activeItemId !== current.activeItemId) {
    patch.activeItemId = current.activeItemId;
  }

  return patch;
}

export function hasPlaylistPatch(patch: PlaylistPatch): boolean {
  return (
    patch.deleted === true ||
    patch.title !== undefined ||
    patch.nodes.length > 0 ||
    patch.removed.length > 0 ||
    patch.order !== undefined ||
    Object.keys(patch.progress).length > 0 ||
    patch.activeItemId !== undefined
  );
}

export function applyPlaylistPatch(
  document: SyncDocument,
  patch: PlaylistPatch,
  updatedAt: string,
): SyncDocument {
  if (patch.deleted || (document.revision > 0 && !document.playlist)) {
    return { ...document, playlist: null };
  }

  const playlist: Playlist = JSON.parse(
    JSON.stringify(
      document.playlist ?? {
        version: 1,
        id: document.id,
        title: patch.title ?? '我的播放列表',
        nodes: [],
        activeItemId: null,
        progress: {},
        updatedAt,
      },
    ),
  );

  const tombstones = new Set([...document.tombstones, ...patch.removed]);
  const nodes = new Map(playlist.nodes.map(node => [node.id, node]));

  for (const update of patch.nodes) {
    if (tombstones.has(update.id)) {
      continue;
    }

    const previous = nodes.get(update.id);
    const value: Record<string, unknown> = previous ? { ...previous } : { ...update.value };

    for (const field of update.fields) {
      if (Object.hasOwn(update.value, field)) {
        value[field] = update.value[field as keyof typeof update.value];
      } else if (field === 'continuation') {
        delete value[field];
      }
    }

    const parsed = nodeSchema.safeParse(value);

    if (!parsed.success) {
      throw new Error('并发修改产生了无效条目，请检查片段时间范围');
    }

    nodes.set(update.id, parsed.data);
  }

  // 删除分组同时删除其后代；离线设备不能重新带回已删除的节点。
  let changed = true;

  while (changed) {
    changed = false;

    for (const node of nodes.values()) {
      if (node.parentId && tombstones.has(node.parentId) && !tombstones.has(node.id)) {
        tombstones.add(node.id);
        changed = true;
      }
    }
  }

  for (const key of tombstones) {
    nodes.delete(key);
  }

  // 并发移动形成环或引用已不存在的分组时，将条目放回根层。
  for (const node of nodes.values()) {
    const seen = new Set([node.id]);
    let parentId = node.parentId;

    while (parentId) {
      const parent = nodes.get(parentId);

      if (!parent || parent.kind !== 'group' || seen.has(parentId) || seen.size >= 32) {
        node.parentId = null;
        break;
      }

      seen.add(parentId);
      parentId = parent.parentId;
    }
  }

  const order = [...new Set([...(patch.order ?? []), ...nodes.keys()])];
  playlist.nodes = order.flatMap(id => (nodes.has(id) ? [nodes.get(id)!] : []));
  playlist.title = patch.title ?? playlist.title;

  for (const [id, progress] of Object.entries(patch.progress)) {
    const previous = playlist.progress[id];
    const previousSession = previous?.sessionStartedAt ?? previous?.updatedAt ?? '';
    const nextSession = progress?.sessionStartedAt ?? progress?.updatedAt ?? '';

    if (!progress) {
      delete playlist.progress[id];
    } else if (
      !previous ||
      nextSession > previousSession ||
      (nextSession === previousSession && progress.updatedAt >= previous.updatedAt)
    ) {
      playlist.progress[id] = progress;
    }
  }

  playlist.progress = Object.fromEntries(
    Object.entries(playlist.progress).filter(([id]) => nodes.get(id)?.kind === 'video'),
  );
  playlist.activeItemId =
    patch.activeItemId === undefined ? playlist.activeItemId : patch.activeItemId;

  if (nodes.get(playlist.activeItemId ?? '')?.kind !== 'video') {
    playlist.activeItemId = null;
  }

  playlist.updatedAt = updatedAt;
  return { ...document, playlist: playlistSchema.parse(playlist), tombstones: [...tombstones] };
}
