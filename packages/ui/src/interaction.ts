import { shallowRef } from 'vue';
import type { InjectionKey } from 'vue';

export const uiRootKey: InjectionKey<HTMLElement> = Symbol('bplaylist-ui-root');

export const activeDialog = shallowRef<HTMLDialogElement | null>(null);

let activation = { x: 0, y: 0, time: 0 };

export function captureActivation(event: MouseEvent) {
  const target =
    event.target instanceof Element ? event.target.closest('button, [role="button"]') : null;

  if (!target) {
    return;
  }

  const bounds = target.getBoundingClientRect();
  activation = {
    x: event.detail ? event.clientX : bounds.x + bounds.width / 2,
    y: event.detail ? event.clientY : bounds.y + bounds.height / 2,
    time: performance.now(),
  };
}

export function dialogOrigin() {
  return performance.now() - activation.time < 1500 && activation.time > 0
    ? { x: activation.x, y: activation.y }
    : { x: innerWidth / 2, y: innerHeight / 2 };
}

export function animateDialog(
  element: Element,
  done: () => void,
  origin: { x: number; y: number },
  leaving = false,
) {
  const dialog = element as HTMLDialogElement;

  if (!leaving) {
    dialog.showModal();
    activeDialog.value = dialog;
  }

  const bounds = dialog.getBoundingClientRect();
  const x = origin.x - (bounds.x + bounds.width / 2);
  const y = origin.y - (bounds.y + bounds.height / 2);
  const small = { opacity: 0, transform: `translate(${x}px, ${y}px) scale(0.16)` };
  const full = { opacity: 1, transform: 'translate(0px, 0px) scale(1)' };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const duration = leaving ? 110 : 160;

  const animation = dialog.animate(leaving ? [full, small] : [small, full], {
    duration: reduced ? 0 : duration,
    easing: leaving ? 'cubic-bezier(0.4, 0, 1, 1)' : 'cubic-bezier(0.16, 1, 0.3, 1)',
  });

  void animation.finished.then(() => {
    if (leaving) {
      if (activeDialog.value === dialog) {
        activeDialog.value = null;
      }

      dialog.close();
    }

    done();
  }, done);
}
