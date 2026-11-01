import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const playlists = sqliteTable('playlists', {
  id: text('id').primaryKey(),
  document: text('document').notNull(),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
