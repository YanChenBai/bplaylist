import type { D1Database } from '@cloudflare/workers-types';

import { applyPlaylistPatch, syncMutationSchema } from '../../../packages/shared/src/sync.ts';
import type { SyncDocument } from '../../../packages/shared/src/sync.ts';

interface Row {
  id: string;
  document: string;
  revision: number;
  deleted: number;
  tombstones: string;
}

function decode(row: Row): SyncDocument {
  return {
    id: row.id,
    playlist: row.deleted ? null : JSON.parse(row.document).playlist,
    revision: row.revision,
    tombstones: JSON.parse(row.tombstones),
  };
}

export async function syncRequest(request: Request, db: D1Database): Promise<Response> {
  if (request.method === 'GET') {
    const cursor = Number(new URL(request.url).searchParams.get('cursor') ?? 0);

    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      return Response.json({ error: 'Invalid cursor' }, { status: 400 });
    }

    const { results } = await db
      .prepare(
        'SELECT sequence, playlist_id FROM sync_changes WHERE sequence > ? ORDER BY sequence LIMIT 101',
      )
      .bind(cursor)
      .all<{ sequence: number; playlist_id: string }>();

    const page = results.slice(0, 100);
    const documents: SyncDocument[] = [];

    for (const id of new Set(page.map(row => row.playlist_id))) {
      const row = await db.prepare('SELECT * FROM playlists WHERE id = ?').bind(id).first<Row>();

      if (row) {
        documents.push(decode(row));
      }
    }

    return Response.json({
      cursor: page.at(-1)?.sequence ?? cursor,
      hasMore: results.length > 100,
      documents,
    });
  }

  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  let mutation;

  try {
    // 流式限制请求大小，不能仅信任 Content-Length。
    const reader = request.body?.getReader();

    if (!reader) {
      throw new Error('请求体为空');
    }

    const chunks: Uint8Array[] = [];
    let size = 0;

    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      size += value.length;

      if (size > 5 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('文件超过 5 MB');
      }

      chunks.push(value);
    }

    const bytes = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    mutation = syncMutationSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Invalid mutation' },
      { status: 400 },
    );
  }

  const { id, mutationId, patch } = mutation;

  for (let attempt = 0; attempt < 8; attempt++) {
    const applied = await db
      .prepare('SELECT playlist_id FROM sync_changes WHERE mutation_id = ?')
      .bind(mutationId)
      .first<{ playlist_id: string }>();

    const row = await db.prepare('SELECT * FROM playlists WHERE id = ?').bind(id).first<Row>();

    if (applied) {
      if (applied.playlist_id !== id) {
        return Response.json({ error: 'Mutation ID mismatch' }, { status: 400 });
      }

      return Response.json(decode(row!));
    }

    let next: SyncDocument;

    try {
      next = applyPlaylistPatch(
        row ? decode(row) : { id, playlist: null, revision: 0, tombstones: [] },
        patch,
        new Date().toISOString(),
      );
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : 'Invalid merge' },
        { status: 400 },
      );
    }

    const revision = (row?.revision ?? 0) + 1;
    const document = JSON.stringify({ format: 'bplaylist', version: 1, playlist: next.playlist });
    const updatedAt = new Date().toISOString();

    const write = row
      ? db
          .prepare(
            'UPDATE playlists SET title = ?, document = ?, revision = ?, updated_at = ?, deleted = ?, tombstones = ? WHERE id = ? AND revision = ?',
          )
          .bind(
            next.playlist?.title ?? '',
            document,
            revision,
            updatedAt,
            Number(!next.playlist),
            JSON.stringify(next.tombstones),
            id,
            row.revision,
          )
      : db
          .prepare(
            'INSERT INTO playlists (id, title, document, revision, updated_at, deleted, tombstones) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
          )
          .bind(
            id,
            next.playlist?.title ?? '',
            document,
            revision,
            updatedAt,
            Number(!next.playlist),
            JSON.stringify(next.tombstones),
          );

    try {
      const results = await db.batch([
        write,
        db
          .prepare(
            'INSERT INTO sync_changes (playlist_id, mutation_id) SELECT ?, ? WHERE changes() = 1',
          )
          .bind(id, mutationId),
      ]);

      if (results[0]!.meta.changes === 1) {
        return Response.json({ ...next, revision });
      }
    } catch (error) {
      // 同一请求重试的唯一键竞争会回滚整个批次，下一轮读取已确认结果。
      if (!String(error).includes('UNIQUE constraint failed')) {
        throw error;
      }
    }
  }

  return Response.json({ error: '同步竞争，请稍后重试' }, { status: 409 });
}
