import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { unstable_dev } from 'wrangler';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cwd = join(root, 'apps/sync');
process.chdir(cwd);

const persistence = await mkdtemp(join(tmpdir(), 'bplaylist-d1-'));
const token = 'local-integration-test';
const run = promisify(execFile);
let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined;

try {
  await run(
    process.execPath,
    [
      join(cwd, 'node_modules/wrangler/bin/wrangler.js'),
      'd1',
      'migrations',
      'apply',
      'bplaylist',
      '--local',
      '--persist-to',
      persistence,
    ],
    { cwd, env: { ...process.env, CI: 'true' }, timeout: 30000 },
  );
  worker = await unstable_dev(join(cwd, 'src/index.ts'), {
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

  const playlist = {
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
  process.stdout.write(
    'Local workerd + D1 smoke passed: migration, authentication, upload, download, list, conflict.\n',
  );
} finally {
  await worker?.stop();
  await rm(persistence, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(
    () => {},
  );
}
