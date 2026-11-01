import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vite-plus/test';

import { openLibrary } from '../apps/desktop/src/main/storage/database.ts';
import { videoUrl } from '../packages/shared/src/index.ts';

it('SQLite 重开后恢复播放列表、当前视频和播放时间', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bplaylist-db-'));
  const path = join(directory, 'library.sqlite');
  let library = openLibrary(path);

  try {
    const document = library.list()[0]!;
    document.nodes.push({
      id: 'video',
      kind: 'video',
      alias: '',
      partTitle: '',
      parentId: null,
      title: '视频',
      url: videoUrl('BV1GJ411x7h7'),
      start: 5,
      end: 50,
    });
    document.activeItemId = 'video';
    document.progress.video = {
      position: 17,
      duration: 60,
      completed: false,
      updatedAt: document.updatedAt,
    };
    library.save(document);
    library.setSetting('activePlaylist', document.id);
    library.close();
    library = openLibrary(path);
    expect(library.list()[0]).toEqual(document);
    expect(library.getSetting('activePlaylist')).toBe(document.id);
  } finally {
    library.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
