import { DatabaseSync } from 'node:sqlite';

import { createPlaylist, playlistSchema } from '@bplaylist/shared';
import type { Playlist } from '@bplaylist/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';

import { playlists, settings } from './schema.ts';

export function openLibrary(path: string) {
  const sqlite = new DatabaseSync(path);
  sqlite.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY NOT NULL, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);`);
  const db = drizzle({ client: sqlite });

  const library = {
    list(): Playlist[] {
      return db
        .select()
        .from(playlists)
        .all()
        .map(row => playlistSchema.parse(JSON.parse(row.document)));
    },
    get(id: string): Playlist | undefined {
      const row = db.select().from(playlists).where(eq(playlists.id, id)).get();
      return row ? playlistSchema.parse(JSON.parse(row.document)) : undefined;
    },
    save(playlist: Playlist) {
      const value = playlistSchema.parse(playlist);
      db.insert(playlists)
        .values({ id: value.id, document: JSON.stringify(value) })
        .onConflictDoUpdate({ target: playlists.id, set: { document: JSON.stringify(value) } })
        .run();
    },
    remove(id: string) {
      db.delete(playlists).where(eq(playlists.id, id)).run();
    },
    getSetting(key: string): string | null {
      return db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
    },
    setSetting(key: string, value: string) {
      db.insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
        .run();
    },
    close: () => sqlite.close(),
  };

  if (library.list().length === 0) {
    library.save(createPlaylist());
  }

  return library;
}

export type Library = ReturnType<typeof openLibrary>;
