import type { PlaylistNode } from './index.ts';

export function searchPlaylist(nodes: PlaylistNode[], query: string): Set<string> | undefined {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);

  if (!terms.length) {
    return undefined;
  }

  const indexed = new Map(nodes.map(node => [node.id, node]));
  const visible = new Set<string>();

  for (const node of nodes) {
    const ancestors: string[] = [];
    let parentId = node.parentId;

    while (parentId && !ancestors.includes(parentId)) {
      const parent = indexed.get(parentId);

      if (!parent) {
        break;
      }

      ancestors.push(parentId);
      parentId = parent.parentId;
    }

    const fields = [node.title, ...ancestors.map(id => indexed.get(id)!.title)];

    if (node.kind === 'video') {
      fields.push(
        node.alias,
        node.partTitle,
        node.url,
        ...(node.continuation ?? []).flatMap(part => [part.title, part.url]),
      );
    }

    const text = fields.join(' ').toLocaleLowerCase();

    if (terms.every(term => text.includes(term))) {
      visible.add(node.id);
      ancestors.forEach(id => visible.add(id));
    }
  }

  return visible;
}
