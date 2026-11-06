import { describe, expect, it } from 'vite-plus/test';

import { itemSchema } from '../packages/shared/src/index.ts';
import { searchPlaylist } from '../packages/shared/src/search.ts';

const nodes = [
  { id: 'group', kind: 'group' as const, title: 'Rust 教程', parentId: null },
  itemSchema.parse({
    id: 'video',
    kind: 'video',
    title: '所有权',
    alias: '复习',
    partTitle: 'P2 借用',
    parentId: 'group',
    url: 'https://www.bilibili.com/video/BV1GJ411x7h7',
  }),
  { id: 'other', kind: 'group' as const, title: '其他', parentId: null },
];

describe('播放列表搜索', () => {
  it('匹配别名、分集、链接和祖先分组，保留祖先层级', () => {
    for (const query of ['复习', '借用', 'BV1GJ411x7h7', 'rust 所有权']) {
      expect(searchPlaylist(nodes, query)).toEqual(new Set(['video', 'group']));
    }
  });

  it('搜索分组显示其后代，空搜索恢复全部内容', () => {
    expect(searchPlaylist(nodes, 'rust')).toEqual(new Set(['group', 'video']));
    expect(searchPlaylist(nodes, '   ')).toBeUndefined();
    expect(searchPlaylist(nodes, '不存在')).toEqual(new Set());
  });
});
