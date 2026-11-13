import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { createClearCardViewerRuntime, type ClearCardViewerRuntime } from './clear-card-viewer/runtime';
import type { ClearCardThreeViewerHandle, ClearCardThreeViewerProps } from './clear-card-viewer/types';
export type {
  ViewerStatus,
  ClearCardModelLoadStatus,
  ClearCardDisplayStage,
  ClearCardThreeViewerHandle,
} from './clear-card-viewer/types';

const ClearCardThreeViewer = forwardRef<ClearCardThreeViewerHandle, ClearCardThreeViewerProps>(
  function ClearCardThreeViewer(props, ref) {
    const {
      ready, packModelUrl, unrestrictedMovement, axisLockedOrbit,
      interactionFrameRateMode = 'unrestricted', interactionEnabled = true,
      interactionBounds = 'canvas', pointerActivationEnabled = true,
      keyboardActivationEnabled = false, keyboardRotationEnabled = false,
      ariaLabel, onStatusChange,
    } = props;
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const runtimeRef = useRef<ClearCardViewerRuntime | null>(null);
    if (!runtimeRef.current) runtimeRef.current = createClearCardViewerRuntime(props);
    const runtime = runtimeRef.current;

    useEffect(() => {
      runtime.update(props);
    });
    useImperativeHandle(ref, () => ({
      reset: runtime.reset,
      hit: runtime.hit,
      isClientPointOnObject: runtime.isClientPointOnObject,
      retryCardModel: runtime.retryCardModel,
      captureSnapshot: runtime.captureSnapshot,
    }), [runtime]);
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      runtime.mount(canvas, { interactionFrameRateMode, onStatusChange, packModelUrl });
      return runtime.dispose;
    }, [runtime, interactionFrameRateMode, onStatusChange, packModelUrl]);

    return (
      <canvas
        ref={canvasRef}
        className={`clear-card-wip__canvas static-to-model__model${
          unrestrictedMovement || axisLockedOrbit
            ? ' clear-card-wip__canvas--unrestricted'
            : ''
        }`}
        role={keyboardActivationEnabled ? 'button' : 'img'}
        aria-label={
          ariaLabel || (axisLockedOrbit
            ? 'Interactive 3D clear card; drag sideways or vertically with one-axis perspective orbit'
            : unrestrictedMovement
              ? 'Interactive 3D clear card; drag to rotate'
              : 'Interactive 3D clear card unboxing')
        }
        aria-hidden={!ready}
        aria-disabled={
          keyboardActivationEnabled || keyboardRotationEnabled
            ? !ready || !interactionEnabled
            : undefined
        }
        aria-keyshortcuts={
          keyboardActivationEnabled
            ? 'Enter Space'
            : keyboardRotationEnabled
              ? 'ArrowLeft ArrowRight ArrowUp ArrowDown'
              : undefined
        }
        tabIndex={
          (keyboardActivationEnabled || keyboardRotationEnabled) && ready && interactionEnabled
            ? 0
            : undefined
        }
        onKeyDown={event => runtime.handleKeyDown(event, keyboardActivationEnabled, keyboardRotationEnabled)}
        onClick={event => runtime.handleSyntheticClick(event, keyboardActivationEnabled)}
        onPointerEnter={event => runtime.handlePointerMove(event, interactionBounds)}
        onPointerMove={event => runtime.handlePointerMove(event, interactionBounds)}
        onPointerDown={event => runtime.handlePointerDown(event, pointerActivationEnabled, interactionBounds)}
        onPointerUp={event => runtime.handlePointerUp(event, pointerActivationEnabled)}
        onPointerLeave={runtime.handlePointerLeave}
        onPointerCancel={runtime.handlePointerCancel}
        onLostPointerCapture={runtime.handleLostPointerCapture}
      />
    );
  },
);

export default ClearCardThreeViewer;
