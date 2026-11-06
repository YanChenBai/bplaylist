import type { Playlist, PlayerSnapshot } from '@bplaylist/shared';
import audioOffsetScript from '@bplaylist/shared/audio-offset.js?raw';
import { Application, ContentView } from '@nativescript/core';

import playerScript from './player.js?raw';

const injectedPlayerScript = `${audioOffsetScript}\n${playerScript}`;

export interface MobileState {
  playlist: Playlist;
  playlists: { id: string; title: string; active: boolean }[];
  playingPlaylistId: string | null;
  playingItemId: string | null;
  segmentIndex: number;
  revision: number;
  snapshot: Partial<PlayerSnapshot>;
  theme: 'light' | 'dark';
  autoFullscreen: boolean;
}

function unwrap<T>(raw: string): T {
  const result = JSON.parse(raw) as { ok: boolean; data: T; error?: string };

  if (!result.ok) {
    throw new Error(result.error || '原生调用失败');
  }

  return result.data;
}

export function nativeHost() {
  return com.bplaylist.mobile.MobileHost;
}

export function call<T = MobileState>(method: string, input: unknown = null): T {
  return unwrap<T>(nativeHost().call(method, JSON.stringify(input)));
}

export function initialize() {
  const state = unwrap<MobileState>(
    nativeHost().initialize(
      Application.android.foregroundActivity || Application.android.startActivity,
    ),
  );

  nativeHost().setScript(injectedPlayerScript);
  return state;
}

export function connection() {
  return unwrap<{ connected: boolean; token: string; endpoints: string[] }>(
    nativeHost().connection(true),
  );
}

export class BilibiliView extends ContentView {
  createNativeView() {
    const activity = Application.android.foregroundActivity || Application.android.startActivity;
    nativeHost().initialize(activity);
    nativeHost().setScript(injectedPlayerScript);
    return nativeHost().createBrowser(activity);
  }

  disposeNativeView() {
    nativeHost().releaseBrowser();
    super.disposeNativeView();
  }
}
