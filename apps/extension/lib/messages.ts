import { appendNodesSchema, bridgeConnectionSchema } from '@bplaylist/shared/bridge';
import { browser } from 'wxt/browser';
import { z } from 'zod';

export const messageSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('groups'), playlistId: z.string() }),
  z.object({ action: z.literal('append'), input: appendNodesSchema }),
  z.object({ action: z.literal('capture') }),
  z.object({ action: z.literal('resolve'), url: z.string().max(2048) }),
  z.object({ action: z.literal('connect'), connection: bridgeConnectionSchema }),
]);

const replySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export async function request<T extends z.ZodType>(
  message: z.infer<typeof messageSchema>,
  schema: T,
): Promise<z.infer<T>> {
  const reply = replySchema.parse(await browser.runtime.sendMessage(message));

  if (!reply.ok) {
    throw new Error(reply.error);
  }

  return schema.parse(reply.data);
}
