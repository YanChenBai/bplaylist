declare namespace com.bplaylist.mobile {
  class FileCallback {
    constructor(implementation: { complete(value: string | null, error: string | null): void });
    complete(value: string | null, error: string | null): void;
  }

  class PlaylistFiles {
    static read(
      context: android.content.Context,
      uri: android.net.Uri,
      callback: FileCallback,
    ): void;
    static write(
      context: android.content.Context,
      uri: android.net.Uri,
      text: string,
      callback: FileCallback,
    ): void;
  }

  class MobileHost {
    static initialize(activity: android.app.Activity): string;
    static call(method: string, payload: string): string;
    static cloudConfig(): string;
    static saveCloudConfig(value: string): void;
    static setScript(source: string): void;
    static createBrowser(activity: android.app.Activity): android.webkit.WebView;
    static releaseBrowser(): void;
    static navigate(url: string): void;
    static back(): boolean;
    static command(method: string, payload: string): void;
    static snapshot(): string;
    static insets(): string;
    static animateLayout(view: android.view.ViewGroup): void;
    static connection(lan: boolean): string;
    static configureWindow(activity: android.app.Activity): void;
    static setImmersive(activity: android.app.Activity, enabled: boolean): void;
    static setTheme(light: boolean): void;
    static setWebZoom(zoom: number): void;
    static armFullscreen(): void;
  }
}

declare module '*?raw' {
  const value: string;

  export default value;
}

declare module '*.css';

declare module '*.vue' {
  import type { DefineComponent } from 'nativescript-vue';
  const component: DefineComponent;

  export default component;
}
