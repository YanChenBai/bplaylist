import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { createBridgeRouter } from '@bplaylist/bridge';
import type { BridgeService } from '@bplaylist/bridge';
import { BRIDGE_PORT } from '@bplaylist/shared/bridge';
import { RPCHandler } from '@orpc/server/node';

import type { Library } from '../storage/database.ts';

export class BrowserServer {
  private server?: Server;
  private token: string;
  private error: string | null = null;
  private port = 0;

  constructor(
    private readonly library: Library,
    private readonly service: BridgeService,
  ) {
    this.token = library.getSetting('browserToken') ?? randomBytes(32).toString('hex');
    library.setSetting('browserToken', this.token);
  }

  settings() {
    return {
      endpoint: `http://127.0.0.1:${this.port || BRIDGE_PORT}`,
      token: this.token,
      connected: Boolean(this.server?.listening),
      error: this.error,
    };
  }

  async start(port = BRIDGE_PORT) {
    if (this.server?.listening) {
      return this.settings();
    }

    this.port = port;
    const handler = new RPCHandler(createBridgeRouter(this.service));

    const server = createServer(async (request, response) => {
      const status = accessStatus(request, this.port, this.token);

      if (status !== 200) {
        response.writeHead(status).end();
        return;
      }

      response.setHeader('Cache-Control', 'no-store');

      try {
        if (!(await readBody(request, response))) {
          return;
        }

        const { matched } = await handler.handle(request, response, { prefix: '/rpc' });

        if (!matched) {
          response.writeHead(404).end();
        }
      } catch {
        if (!response.headersSent) {
          response.writeHead(500);
        }

        response.end();
      }
    });

    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          const address = server.address();
          this.port = typeof address === 'object' && address ? address.port : port;
          this.error = null;
          resolve();
        });
      });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }

    return this.settings();
  }

  resetToken() {
    this.token = randomBytes(32).toString('hex');
    this.library.setSetting('browserToken', this.token);
    return this.settings();
  }

  async close() {
    const server = this.server;
    this.server = undefined;

    if (!server) {
      return;
    }

    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

function accessStatus(request: IncomingMessage, port: number, secret: string) {
  const origin = request.headers.origin;

  if (
    request.headers.host !== `127.0.0.1:${port}` ||
    (origin && !/^(chrome-extension|moz-extension):\/\/[a-zA-Z0-9-]+$/.test(origin))
  ) {
    return 403;
  }

  const token = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
  const expected = Buffer.from(secret);

  if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
    return 401;
  }

  return request.method === 'POST' ? 200 : 405;
}

async function readBody(request: IncomingMessage, response: ServerResponse) {
  if (Number(request.headers['content-length'] ?? 0) > 1024 * 1024) {
    response.writeHead(413, { connection: 'close' }).end();
    return false;
  }

  if (
    request.headers['content-type'] &&
    !request.headers['content-type'].startsWith('application/json')
  ) {
    response.writeHead(415).end();
    return false;
  }

  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;

    if (size > 1024 * 1024) {
      response.writeHead(413, { connection: 'close' }).end();
      request.resume();
      return false;
    }

    chunks.push(buffer);
  }

  try {
    const body: unknown = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    Object.assign(request, { body });
    return true;
  } catch {
    response.writeHead(400).end();
    return false;
  }
}
