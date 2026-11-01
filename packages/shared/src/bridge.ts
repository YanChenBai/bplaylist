import { z } from 'zod';

import { nodeSchema } from './index.ts';

export const BRIDGE_PORT = 47821;

export const BRIDGE_ENDPOINT = `http://127.0.0.1:${BRIDGE_PORT}`;

export const bridgeConnectionSchema = z.object({
  endpoint: z
    .string()
    .url()
    .refine(value => {
      const url = new URL(value);
      return (
        url.protocol === 'http:' &&
        url.hostname === '127.0.0.1' &&
        url.pathname === '/' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }, '地址必须是 http://127.0.0.1:端口'),
  token: z.string().min(32).max(200),
});

export const appendNodesSchema = z.object({
  playlistId: z.string().min(1).max(100),
  nodes: z.array(nodeSchema).min(1).max(1000),
});

export const playlistOptionsSchema = z.array(
  z.object({ id: z.string(), title: z.string(), active: z.boolean() }),
);

export const groupOptionsSchema = z.array(z.object({ id: z.string(), title: z.string() }));

export const appendResultSchema = z.object({
  added: z.number().int().nonnegative(),
  playlistId: z.string(),
});

export type BridgeConnection = z.infer<typeof bridgeConnectionSchema>;
