import { pathToFileURL } from 'node:url';

import { RPCHandler } from '@orpc/server/message-port';
import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainEvent, MessagePortMain } from 'electron';

/**
 * Owns renderer MessagePorts from trust validation through navigation and shutdown cleanup.
 */
export interface RpcConnections {
  /**
   * Closes all active renderer ports without unregistering the IPC listener.
   */
  closeAll(): void;

  /**
   * Unregisters the IPC listener and closes every active renderer port.
   */
  dispose(): void;
}

/**
 * Registers the renderer RPC bridge and closes ports whenever their trusted document changes.
 */
export function registerRpcConnections(
  router: ConstructorParameters<typeof RPCHandler>[0],
  getWindow: () => BrowserWindow | null,
  rendererUrl: string | undefined,
  rendererFile: string,
): RpcConnections {
  const ports = new Set<MessagePortMain>();
  const handler = new RPCHandler(router);
  const trustedRenderer = new URL(rendererUrl ?? pathToFileURL(rendererFile).href);

  const closeAll = () => {
    for (const port of ports) {
      port.close();
    }

    ports.clear();
  };

  const onConnect = (event: IpcMainEvent) => {
    const window = getWindow();

    if (!isTrustedRendererEvent(event, window, trustedRenderer) || event.ports.length !== 1) {
      for (const port of event.ports) {
        port.close();
      }

      return;
    }

    const port = event.ports[0];

    if (!port) {
      return;
    }

    ports.add(port);
    port.on('close', () => ports.delete(port));
    handler.upgrade(port);
    port.start();
  };

  ipcMain.on('start-orpc-server', onConnect);
  return {
    closeAll,
    dispose() {
      ipcMain.removeListener('start-orpc-server', onConnect);
      closeAll();
    },
  };
}

function isTrustedRendererEvent(
  event: IpcMainEvent,
  window: BrowserWindow | null,
  trustedRenderer: URL,
): boolean {
  const frame = event.senderFrame;

  if (
    !window ||
    !frame ||
    event.sender !== window.webContents ||
    frame !== event.sender.mainFrame
  ) {
    return false;
  }

  try {
    const frameUrl = new URL(frame.url);
    return (
      frameUrl.origin === trustedRenderer.origin && frameUrl.pathname === trustedRenderer.pathname
    );
  } catch {
    return false;
  }
}
