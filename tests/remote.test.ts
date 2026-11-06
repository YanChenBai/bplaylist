import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import type { PlaybackController } from '../apps/desktop/src/main/player/controller.ts';
import { RemoteLibrary } from '../apps/desktop/src/main/remote.ts';
import { openLibrary } from '../apps/desktop/src/main/storage/database.ts';

const storage = vi.hoisted(() => ({
  isAsyncEncryptionAvailable: vi.fn(),
  encryptStringAsync: vi.fn(),
  decryptStringAsync: vi.fn(),
}));

vi.mock('../apps/desktop/node_modules/electron/index.js', () => ({ safeStorage: storage }));

describe('云同步异步安全存储', () => {
  let library: ReturnType<typeof openLibrary>;
  let remote: RemoteLibrary;

  beforeEach(() => {
    vi.resetAllMocks();
    library = openLibrary(':memory:');
    library.setSetting('syncPreferences', JSON.stringify({ automatic: false }));
    storage.isAsyncEncryptionAvailable.mockResolvedValue(true);
    storage.encryptStringAsync.mockResolvedValue(Buffer.from('encrypted'));
    storage.decryptStringAsync.mockResolvedValue({ result: 'test-token', shouldReEncrypt: false });
    remote = new RemoteLibrary(library, {
      persist: vi.fn(),
      applySync: vi.fn(),
    } as unknown as PlaybackController);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        if (init.method === 'POST') {
          const mutation = JSON.parse(init.body as string);
          return Response.json({
            id: mutation.id,
            playlist: library.get(mutation.id),
            tombstones: [],
            revision: 1,
          });
        }

        return Response.json({ cursor: 0, hasMore: false, documents: [] });
      }),
    );
  });

  afterEach(() => {
    remote.dispose();
    library.close();
    vi.unstubAllGlobals();
  });

  it('异步保存、读取令牌，并保持手动同步可用', async () => {
    const result = await remote.configure({
      endpoint: 'https://sync.example.com/',
      token: 'test-token',
    });

    expect(result.configured).toBe(true);
    expect(result.endpoint).toBe('https://sync.example.com');
    expect(storage.encryptStringAsync).toHaveBeenCalledWith('test-token');
    expect(storage.decryptStringAsync).toHaveBeenCalledWith(Buffer.from('encrypted'));
    await remote.sync();
    expect(fetch).toHaveBeenCalledWith(
      'https://sync.example.com/sync?cursor=0',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
  });

  it('兼容已有密文，并按异步接口要求更新加密密钥', async () => {
    library.setSetting('remoteEndpoint', 'https://sync.example.com');
    library.setSetting('remoteToken', Buffer.from('legacy-encrypted').toString('base64'));
    storage.decryptStringAsync.mockResolvedValue({ result: 'test-token', shouldReEncrypt: true });
    await remote.start();
    expect(storage.decryptStringAsync).toHaveBeenCalledWith(Buffer.from('legacy-encrypted'));
    expect(library.getSetting('remoteToken')).toBe(Buffer.from('encrypted').toString('base64'));
    await remote.sync();
  });

  it('较早启动的解密迟到时，不会覆盖新配置的同步客户端', async () => {
    library.setSetting('remoteEndpoint', 'https://old.example.com');
    library.setSetting('remoteToken', Buffer.from('old').toString('base64'));
    let finish!: (value: { result: string; shouldReEncrypt: boolean }) => void;
    storage.decryptStringAsync.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const first = remote.start();
    await remote.configure({ endpoint: 'https://new.example.com', token: 'test-token' });
    finish({ result: 'old-token', shouldReEncrypt: false });
    await first;
    await remote.sync();
    expect(fetch).toHaveBeenCalledWith(
      'https://new.example.com/sync?cursor=0',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
  });

  it('销毁后的解密结果不会启动同步或写回密文', async () => {
    library.setSetting('remoteEndpoint', 'https://sync.example.com');
    library.setSetting('remoteToken', Buffer.from('old').toString('base64'));
    let finish!: (value: { result: string; shouldReEncrypt: boolean }) => void;
    storage.decryptStringAsync.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const starting = remote.start();
    remote.dispose();
    finish({ result: 'old-token', shouldReEncrypt: true });
    await starting;
    expect(storage.encryptStringAsync).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
