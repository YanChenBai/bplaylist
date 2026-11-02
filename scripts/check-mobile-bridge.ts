import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';

import type { BridgeClient } from '../packages/bridge/src/index.ts';
import { bridgeConnectionSchema } from '../packages/shared/src/bridge.ts';
import { archiveSchema, itemSchema } from '../packages/shared/src/index.ts';

const build = spawnSync(
  'cargo',
  ['build', '--locked', '--manifest-path', 'crates/mobile-core/Cargo.toml', '--bin', 'bridge-host'],
  { stdio: 'inherit' },
);

assert.equal(build.status, 0);

const directory = await mkdtemp(join(tmpdir(), 'bplaylist-bridge-'));

const executable = resolve(
  'crates/mobile-core/target/debug',
  process.platform === 'win32' ? 'bridge-host.exe' : 'bridge-host',
);

const child = spawn(executable, [join(directory, 'library.sqlite')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

const lines = createInterface({ input: child.stdout });
const iterator = lines[Symbol.asyncIterator]();

async function read() {
  const next = await iterator.next();
  assert.equal(next.done, false, '原生服务意外退出');
  const result = JSON.parse(next.value!) as { ok: boolean; data: unknown; error?: string };
  assert.equal(result.ok, true, result.error);
  return result.data;
}

async function invoke(method: string, input: unknown = null) {
  child.stdin.write(`${JSON.stringify({ method, input })}\n`);
  return read();
}

try {
  await read();
  const server = (await read()) as { token: string };

  const connection = bridgeConnectionSchema.parse({
    endpoint: 'http://127.0.0.1:47822',
    token: server.token,
  });

  const api = createORPCClient<BridgeClient>(
    new RPCLink({
      url: `${connection.endpoint}/rpc`,
      headers: {
        authorization: `Bearer ${connection.token}`,
        origin: 'chrome-extension://bplaylist',
      },
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) }),
    }),
  );

  const lists = await api.list();
  assert.equal(lists.length, 1);
  const id = lists[0]!.id;
  const group = { id: 'group', kind: 'group' as const, parentId: null, title: '活动' };

  const item = itemSchema.parse({
    id: 'video',
    kind: 'video',
    parentId: 'group',
    title: '测试视频',
    url: 'https://www.bilibili.com/video/BV1XSMpzdEWD/?p=1',
    start: 1080,
    end: 2160,
    continuation: [{ title: 'P2', url: 'https://www.bilibili.com/video/BV1XSMpzdEWD/?p=2' }],
  });

  const input = { playlistId: id, nodes: [group, item] };
  assert.equal((await api.append(input)).added, 2);
  assert.equal((await api.append(input)).added, 0);
  assert.deepEqual(await api.groups(id), [{ id: 'group', title: '活动' }]);

  await invoke('play', 'video');
  await invoke('command');
  await invoke('snapshot', {
    available: true,
    url: item.url,
    position: 1200,
    duration: 2400,
    paused: false,
    ended: false,
  });
  const current = archiveSchema.parse(await invoke('export'));
  assert.equal(current.playlist.progress.video!.position, 1200);
  await invoke('create', '浏览其他列表');
  const state = (await invoke('state')) as { playingPlaylistId: string };
  assert.equal(state.playingPlaylistId, id);

  const response = await fetch(`${connection.endpoint}/rpc/list`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 401);
  assert.equal(
    bridgeConnectionSchema.safeParse({ endpoint: 'http://192.168.1.20:47821', token: server.token })
      .success,
    true,
  );
  process.stdout.write(
    'Android HTTP 协议兼容检查通过：插件客户端、追加与重试、分组、进度、浏览列表、鉴权。\n',
  );
} finally {
  lines.close();
  child.stdin.end();
  child.kill();
  await new Promise<void>(resolveExit => {
    if (child.exitCode !== null) {
      resolveExit();
    } else {
      child.once('exit', () => resolveExit());
    }
  });
  await rm(directory, { recursive: true, force: true });
}
