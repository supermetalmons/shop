import { useLayoutEffect, useMemo, useRef, type HTMLAttributes } from 'react';
import { createMiNoteCardInput, VIEWER_TAP_MAX_DURATION_MS, VIEWER_TAP_MAX_MOVEMENT_PX } from '../lib/miNoteCardInput';

const VIEWER_CONTROLS = 'button, a, input, select, textarea, [role="button"], [contenteditable="true"], [data-viewer-dismiss-ignore]';

export function useViewerDismissInput({ enabled, onDismiss, resetKey, ignoreSelector }: {
  enabled: boolean;
  onDismiss?: () => void;
  resetKey?: string | number;
  ignoreSelector?: string;
}): HTMLAttributes<HTMLElement> {
  const stateRef = useRef({ enabled, onDismiss });
  const input = useMemo(() => createMiNoteCardInput(() => {
    const state = stateRef.current;
    if (state.enabled && document.visibilityState === 'visible') state.onDismiss?.();
  }, { maxTapDurationMs: VIEWER_TAP_MAX_DURATION_MS, maxTapMovementPx: VIEWER_TAP_MAX_MOVEMENT_PX }), []);

  useLayoutEffect(() => {
    stateRef.current = { enabled, onDismiss };
  }, [enabled, onDismiss]);

  useLayoutEffect(() => {
    input.cancel();
    if (!enabled) return;
    window.addEventListener('blur', input.cancel);
    document.addEventListener('visibilitychange', input.cancel);
    return () => {
      input.cancel();
      window.removeEventListener('blur', input.cancel);
      document.removeEventListener('visibilitychange', input.cancel);
    };
  }, [enabled, input, resetKey]);

  const ignored = (target: EventTarget) => target instanceof Element && Boolean(
    target.closest(ignoreSelector ? `${VIEWER_CONTROLS}, ${ignoreSelector}` : VIEWER_CONTROLS),
  );

  return {
    onPointerDownCapture(event) {
      if (stateRef.current.enabled && !ignored(event.target)) input.onPointerDown(event);
    },
    onPointerMoveCapture: input.onPointerMove,
    onPointerUpCapture(event) {
      if (ignored(event.target)) input.onPointerCancel(event);
      else input.onPointerUp(event);
    },
    onPointerCancelCapture: input.onPointerCancel,
    onLostPointerCaptureCapture: input.onLostPointerCapture,
    onPointerLeave: input.onPointerCancel,
    onClickCapture(event) {
      if (ignored(event.target)) return;
      event.stopPropagation();
      input.onClick(event);
    },
  };
}
