import { archiveSchema } from '@bplaylist/shared';
import { z } from 'zod';

interface Env {
  DB: D1Database;
  SYNC_TOKEN: string;
}

const uploadSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  archive: archiveSchema,
});

const maxBytes = 5 * 1024 * 1024;

async function authorized(request: Request, token: string): Promise<boolean> {
  if (!token) {
    return false;
  }

  const encoder = new TextEncoder();

  const supplied = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(request.headers.get('Authorization') ?? ''),
  );

  const expected = await crypto.subtle.digest('SHA-256', encoder.encode(`Bearer ${token}`));
  const a = new Uint8Array(supplied);
  const b = new Uint8Array(expected);
  let difference = 0;

  for (let i = 0; i < a.length; i++) {
    difference |= a[i]! ^ b[i]!;
  }

  return difference === 0;
}

async function readBody(request: Request) {
  if (Number(request.headers.get('Content-Length')) > maxBytes || !request.body) {
    throw new Error('文件超过 5 MB 或请求体为空');
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    size += value.length;

    if (size > maxBytes) {
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

  return uploadSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!(await authorized(request, env.SYNC_TOKEN))) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(request.url);

    if (url.pathname === '/playlists' && request.method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT id, title, revision, updated_at AS updatedAt FROM playlists ORDER BY updated_at DESC',
      ).all();

      return Response.json(results);
    }

    const match = /^\/playlists\/([^/]+)$/.exec(url.pathname);

    if (!match) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    const id = decodeURIComponent(match[1]!);

    if (request.method === 'GET') {
      const row = await env.DB.prepare('SELECT document, revision FROM playlists WHERE id = ?')
        .bind(id)
        .first<{ document: string; revision: number }>();

      return row
        ? Response.json({ archive: JSON.parse(row.document), revision: row.revision })
        : Response.json({ error: 'Not found' }, { status: 404 });
    }

    if (request.method !== 'PUT') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    return upload(request, env, id);
  },
};

async function upload(request: Request, env: Env, id: string): Promise<Response> {
  let input: z.infer<typeof uploadSchema>;

  try {
    input = await readBody(request);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Invalid archive' },
      { status: 400 },
    );
  }

  if (input.archive.playlist.id !== id) {
    return Response.json({ error: 'Playlist ID mismatch' }, { status: 400 });
  }

  const { playlist } = input.archive;
  const document = JSON.stringify(input.archive);
  const updatedAt = new Date().toISOString();

  // 条件更新在 D1 中原子执行，避免两台设备相互覆盖。
  const result =
    input.expectedRevision === 0
      ? await env.DB.prepare(
          'INSERT INTO playlists (id, title, document, revision, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(id) DO NOTHING',
        )
          .bind(id, playlist.title, document, updatedAt)
          .run()
      : await env.DB.prepare(
          'UPDATE playlists SET title = ?, document = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?',
        )
          .bind(playlist.title, document, updatedAt, id, input.expectedRevision)
          .run();

  if (result.meta.changes !== 1) {
    return Response.json({ error: 'Revision conflict' }, { status: 409 });
  }

  return Response.json({ revision: input.expectedRevision + 1 });
}
