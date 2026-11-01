import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isBilibiliUrl } from '@bplaylist/shared';
import { app, BrowserWindow, dialog } from 'electron';
import type { WebContents } from 'electron';

import { BrowserServer } from './app/browser-server.ts';
import { createBrowserService } from './app/browser-service.ts';
import { registerRpcConnections } from './app/rpc-server.ts';
import { WindowChrome } from './app/window-chrome.ts';
import { PlaybackController } from './player/controller.ts';
import { RemoteLibrary } from './remote.ts';
import { createRouter } from './router.ts';
import { openLibrary } from './storage/database.ts';

app.setName('BPlaylist');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (process.env.BPLAYLIST_USER_DATA) {
  const path = resolve(process.env.BPLAYLIST_USER_DATA);
  mkdirSync(path, { recursive: true });
  app.setPath('userData', path);
}

let mainWindow: BrowserWindow | null = null;
let dispose: (() => void) | undefined;

async function start() {
  await app.whenReady();
  mkdirSync(app.getPath('userData'), { recursive: true });
  const library = openLibrary(join(app.getPath('userData'), 'bplaylist.sqlite'));
  const player = new PlaybackController(library);
  const remote = new RemoteLibrary(library);
  const browser = new BrowserServer(library, createBrowserService(library, player));
  await browser.start(
    process.env.BPLAYLIST_BRIDGE_PORT ? Number(process.env.BPLAYLIST_BRIDGE_PORT) : undefined,
  );
  const base = fileURLToPath(new URL('.', import.meta.url));
  const rendererFile = join(base, '../renderer/index.html');
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  const chrome = new WindowChrome(() => mainWindow);

  const rpc = registerRpcConnections(
    createRouter(library, player, remote, () => mainWindow, chrome, browser),
    () => mainWindow,
    rendererUrl,
    rendererFile,
  );

  async function createWindow() {
    const window = new BrowserWindow({
      title: 'BPlaylist',
      width: 1152,
      height: 648,
      icon: app.isPackaged
        ? join(process.resourcesPath, 'icon.png')
        : join(base, '../../build/icon.png'),
      backgroundColor: '#0e0e0e',
      autoHideMenuBar: true,
      frame: false,
      webPreferences: {
        preload: join(base, '../preload/index.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: true,
      },
    });

    window.setAspectRatio(16 / 9);
    mainWindow = window;
    chrome.setImmersive(false);

    const registerShortcuts = (contents: WebContents) => {
      contents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || input.isAutoRepeat || window.isFullScreen()) {
          return;
        }

        if (input.key === 'F11' || (input.key === 'Escape' && chrome.state().immersive)) {
          event.preventDefault();
          chrome.setImmersive(!chrome.state().immersive);
        }
      });
    };

    registerShortcuts(window.webContents);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', (event, preferences, params) => {
      if (!isBilibiliUrl(params.src)) {
        event.preventDefault();
        return;
      }

      delete preferences.preload;
      preferences.nodeIntegration = false;
      preferences.contextIsolation = true;
      preferences.sandbox = true;
    });
    window.webContents.on('did-attach-webview', (_event, guest) => {
      registerShortcuts(guest);
      guest.on('before-mouse-event', (_event, mouse) => {
        if (mouse.type === 'mouseMove' || mouse.type === 'mouseDown') {
          chrome.noteGuestPointer();
        }
      });
      guest.setWindowOpenHandler(details => {
        if (isBilibiliUrl(details.url)) {
          void guest.loadURL(details.url).catch(error => console.error('B 站页面打开失败', error));
        }

        return { action: 'deny' };
      });
      guest.on('will-navigate', (event, url) => {
        if (!isBilibiliUrl(url)) {
          event.preventDefault();
        }
      });
      guest.on('will-redirect', (event, url) => {
        if (!isBilibiliUrl(url)) {
          event.preventDefault();
        }
      });
      player.attach(guest);
    });
    window.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
      if (mainFrame) {
        rpc.closeAll();
      }
    });
    window.on('closed', () => {
      rpc.closeAll();
      mainWindow = null;
    });

    if (rendererUrl) {
      await window.loadURL(rendererUrl);
    } else {
      await window.loadFile(rendererFile);
    }
  }

  dispose = () => {
    void browser.close();
    rpc.dispose();
    player.dispose();
    library.close();
  };

  app.on('activate', () => {
    if (!mainWindow) {
      void createWindow();
    }
  });
  await createWindow();
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
app.on('before-quit', () => {
  dispose?.();
  dispose = undefined;
});
void start().catch(error => {
  console.error(error);
  dialog.showErrorBox('BPlaylist 启动失败', error instanceof Error ? error.message : String(error));
  app.quit();
});
