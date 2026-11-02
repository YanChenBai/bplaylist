import { AnimationCurve, Application } from '@nativescript/core';
import type { View } from '@nativescript/core';

export function motionEnabled() {
  const context = Application.android.context;
  return (
    android.provider.Settings.Global.getFloat(
      context.getContentResolver(),
      'animator_duration_scale',
      1,
    ) > 0
  );
}

export async function animate(
  view: View | undefined,
  options: {
    opacity?: number;
    translate?: { x: number; y: number };
    scale?: { x: number; y: number };
    rotate?: number;
    duration: number;
  },
) {
  if (!view) {
    return;
  }

  try {
    await view.animate({
      ...options,
      duration: motionEnabled() ? options.duration : 0,
      curve: AnimationCurve.easeOut,
    });
  } catch {
    /* 新动画或视图卸载可以取消旧动画。 */
  }
}

export function enter(view: View, offset = 10) {
  view.opacity = 0;
  view.translateY = offset;
  void animate(view, { opacity: 1, translate: { x: 0, y: 0 }, duration: 180 });
}
