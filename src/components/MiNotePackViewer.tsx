import { useEffect, useRef } from 'react';
import { DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS } from '../lib/miNoteStickerEffects';
import { createMiNotePackViewerRuntime, type MiNotePackViewerRuntime } from '../mi-note-pack-viewer/runtime';
import type { MiNotePackViewerProps } from '../mi-note-pack-viewer/types';
export type { MiNotePackControls } from '../mi-note-pack-viewer/types';

export default function MiNotePackViewer(props: MiNotePackViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const currentProps = useRef(props);
  currentProps.current = props;
  const runtimeRef = useRef<MiNotePackViewerRuntime | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const runtime = createMiNotePackViewerRuntime(host, props, () => currentProps.current);
    runtimeRef.current = runtime;
    return () => {
      runtimeRef.current = null;
      runtime?.dispose();
    };
  }, [props.color, props.star, props.controlsRef]);

  useEffect(() => {
    runtimeRef.current?.updateCards(props.cards, props.cardEffect);
    runtimeRef.current?.invalidate();
  }, [props.cards, props.cardEffect]);
  useEffect(() => runtimeRef.current?.invalidate(), [props.state, props.foldPosition, props.rotationOffsetDegrees, props.verticalPosition, props.sizeScale, props.inspectSticker, props.previewVisible, props.interactionEnabled, props.activationEnabled, props.onFrameRendered]);
  useEffect(() => {
    runtimeRef.current?.updateEffectSettings(props.effectSettings ?? DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS);
    runtimeRef.current?.invalidate();
  }, [props.effectSettings]);

  return <div ref={hostRef} className="mi-note-pack__renderer" tabIndex={0} role="group" aria-label="Interactive Mi Note Cards folder" />;
}
