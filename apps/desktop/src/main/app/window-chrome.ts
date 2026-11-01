import { screen } from 'electron';
import type { BrowserWindow } from 'electron';

/** Owns window presentation independently of the video player and native fullscreen. */
export class WindowChrome {
  private immersive = false;
  private guestPointer = 0;

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  state() {
    const window = this.getWindow();
    const bounds = window?.getContentBounds();
    const cursor = screen.getCursorScreenPoint();

    const pointer =
      bounds &&
      !window?.isMinimized() &&
      cursor.x >= bounds.x &&
      cursor.x < bounds.x + bounds.width &&
      cursor.y >= bounds.y &&
      cursor.y < bounds.y + bounds.height
        ? { x: cursor.x - bounds.x, y: cursor.y - bounds.y }
        : null;

    return {
      immersive: this.immersive,
      maximized: this.getWindow()?.isMaximized() ?? false,
      guestPointer: this.guestPointer,
      pointer,
    };
  }

  noteGuestPointer() {
    this.guestPointer++;
  }

  setImmersive(value: boolean) {
    this.immersive = value;
  }

  control(action: 'minimize' | 'maximize' | 'close') {
    const window = this.getWindow();

    if (!window) {
      throw new Error('窗口已关闭');
    }

    if (action === 'minimize') {
      window.minimize();
    } else if (action === 'maximize') {
      if (window.isMaximized()) {
        window.unmaximize();
      } else {
        window.maximize();
      }
    } else {
      window.close();
    }
  }
}
