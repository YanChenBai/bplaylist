import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { unstable_dev } from 'wrangler';

import type { Playlist } from '../packages/shared/src/index.ts';
import { playlistPatch, syncDocumentSchema, syncPageSchema } from '../packages/shared/src/sync.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const persistence = await mkdtemp(join(tmpdir(), 'bplaylist-d1-'));
const template = process.argv.includes('--template');
const cwd = template ? join(persistence, 'template') : join(root, 'apps/sync');

if (template) {
  await cp(join(root, 'templates/cloudflare'), cwd, {
    recursive: true,
    filter: path => !path.includes('node_modules'),
  });
}

process.chdir(cwd);
const token = 'local-integration-test';
const run = promisify(execFile);
let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined;
type WorkerResponse = Awaited<ReturnType<Awaited<ReturnType<typeof unstable_dev>>['fetch']>>;

try {
  await run(
    process.execPath,
    [
      join(root, 'node_modules/wrangler/bin/wrangler.js'),
      'd1',
      'migrations',
      'apply',
      'DB',
      '--local',
      '--persist-to',
      persistence,
    ],
    { cwd, env: { ...process.env, CI: 'true' }, timeout: 30000 },
  );
  worker = await unstable_dev(join(cwd, template ? 'worker.js' : 'src/index.ts'), {
    config: join(cwd, 'wrangler.jsonc'),
    local: true,
    persistTo: persistence,
    vars: { SYNC_TOKEN: token },
    logLevel: 'error',
    experimental: {
      disableExperimentalWarning: true,
      watch: false,
      showInteractiveDevSession: false,
    },
  });

  const playlist: Playlist = {
    version: 1,
    id: 'd1-smoke',
    title: '远程播放列表',
    nodes: [],
    activeItemId: null,
    progress: {},
    updatedAt: new Date().toISOString(),
  };

  const archive = { format: 'bplaylist', version: 1, playlist };
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await worker.fetch('/playlists')).status, 401);

  const upload = await worker.fetch('/playlists/d1-smoke', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ expectedRevision: 0, archive }),
  });

  assert.equal(upload.status, 200, await upload.text());
  const result = await worker.fetch('/playlists/d1-smoke', { headers });
  assert.deepEqual(await result.json(), { archive, revision: 1 });

  const conflict = await worker.fetch('/playlists/d1-smoke', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ expectedRevision: 0, archive }),
  });

  assert.equal(conflict.status, 409);

  const list = (await (await worker.fetch('/playlists', { headers })).json()) as {
    title: string;
  }[];

  assert.equal(list[0]!.title, playlist.title);

  const page = syncPageSchema.parse(
    await (await worker.fetch('/sync?cursor=0', { headers })).json(),
  );

  assert.equal(page.documents[0]!.id, playlist.id);
  assert.ok(page.cursor > 0);

  const mutation = {
    id: playlist.id,
    mutationId: crypto.randomUUID(),
    patch: playlistPatch(playlist, { ...playlist, title: '增量更新' }),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const response: WorkerResponse = await worker.fetch('/sync', {
      method: 'POST',
      headers,
      body: JSON.stringify(mutation),
    });

    assert.equal(response.status, 200, await response.clone().text());
    const document = syncDocumentSchema.parse(await response.json());
    assert.equal(document.revision, 2);
    assert.equal(document.playlist!.title, '增量更新');
  }

  const changes = syncPageSchema.parse(
    await (await worker.fetch(`/sync?cursor=${page.cursor}`, { headers })).json(),
  );

  assert.equal(changes.documents.length, 1);
  assert.equal(changes.documents[0]!.revision, 2);

  const deletion = await worker.fetch('/sync', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: playlist.id,
      mutationId: crypto.randomUUID(),
      patch: playlistPatch(playlist, null),
    }),
  });

  assert.equal(deletion.status, 200);
  assert.equal(syncDocumentSchema.parse(await deletion.json()).playlist, null);
  assert.equal((await worker.fetch(`/playlists/${playlist.id}`, { headers })).status, 404);
  process.stdout.write(
    'Local workerd + D1 smoke passed: migrations, authentication, legacy compatibility, incremental feed, idempotent mutation, deletion.\n',
  );
} finally {
  await worker?.stop();
  process.chdir(root);
  await rm(persistence, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(
    () => {},
  );
}
