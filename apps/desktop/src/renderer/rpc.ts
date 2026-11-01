import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/message-port';
import type { RouterClient } from '@orpc/server';

import type { AppRouter } from '../main/router.ts';

const { port1, port2 } = new MessageChannel();
window.postMessage('start-orpc-client', '*', [port2]);
port1.start();

export const rpc: RouterClient<AppRouter> = createORPCClient(new RPCLink({ port: port1 }));
