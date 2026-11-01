import type { PlaylistNode } from '@bplaylist/shared';
import { appendNodesSchema } from '@bplaylist/shared/bridge';
import { os, ORPCError } from '@orpc/server';
import type { RouterClient } from '@orpc/server';
import { z } from 'zod';

export interface BridgeService {
  list(): { id: string; title: string; active: boolean }[];
  groups(id: string): { id: string; title: string }[];
  append(id: string, nodes: PlaylistNode[]): Promise<{ added: number; playlistId: string }>;
}

const procedure = os.use(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error instanceof ORPCError) {
      throw error;
    }

    throw new ORPCError('BAD_REQUEST', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

export function createBridgeRouter(service: BridgeService) {
  return {
    list: procedure.handler(() => service.list()),
    groups: procedure
      .input(z.string().min(1).max(100))
      .handler(({ input }) => service.groups(input)),
    append: procedure
      .input(appendNodesSchema)
      .handler(({ input }) => service.append(input.playlistId, input.nodes)),
  };
}

export type BridgeClient = RouterClient<ReturnType<typeof createBridgeRouter>>;
