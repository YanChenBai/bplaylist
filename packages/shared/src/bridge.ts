import { z } from 'zod';

import { nodeSchema } from './index.ts';

export const BRIDGE_PORT = 47821;

export const BRIDGE_ENDPOINT = `http://127.0.0.1:${BRIDGE_PORT}`;

export function isBridgeEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname;

    return (
      url.protocol === 'http:' &&
      isPrivateHost(host) &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isPrivateHost(host: string): boolean {
  if (host === '127.0.0.1') {
    return true;
  }

  const octets = host.split('.').map(Number);

  if (
    octets.length !== 4 ||
    !octets.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    return false;
  }

  if (octets[0] === 10) {
    return true;
  }

  if (octets[0] === 192) {
    return octets[1] === 168;
  }

  return octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31;
}

export const bridgeConnectionSchema = z.object({
  endpoint: z.string().url().refine(isBridgeEndpoint, '地址必须是 HTTP 本机或局域网 IP 地址'),
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
