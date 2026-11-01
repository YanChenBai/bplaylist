import type { BrowserWindow } from 'electron';

/** Owns window presentation independently of the video player and native fullscreen. */
export class WindowChrome {
  private immersive = false;
  private guestPointer = 0;

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  state() {
    return {
      immersive: this.immersive,
      maximized: this.getWindow()?.isMaximized() ?? false,
      guestPointer: this.guestPointer,
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
