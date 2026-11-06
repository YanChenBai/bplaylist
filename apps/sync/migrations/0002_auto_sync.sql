ALTER TABLE playlists ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE playlists ADD COLUMN tombstones TEXT NOT NULL DEFAULT '[]';

CREATE TABLE sync_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL UNIQUE
);

INSERT INTO sync_changes (playlist_id, mutation_id)
SELECT id, 'migration:' || id FROM playlists;
