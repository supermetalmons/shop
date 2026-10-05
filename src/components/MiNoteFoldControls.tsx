import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  MI_NOTE_STAR_FOLD_MAX,
  MI_NOTE_STAR_FOLD_MIN,
  MI_NOTE_STAR_FOLD_STEP,
  MI_NOTE_STAR_ROTATION_MAX,
  MI_NOTE_STAR_ROTATION_MIN,
  MI_NOTE_STAR_ROTATION_STEP,
  serializeMiNoteStarFolds,
  type MiNoteStarFoldPositions,
  type MiNoteStarRotationOffsets,
} from '../lib/miNoteStarFolds';

type MiNoteFoldControlsProps = {
  foldPosition: number;
  foldPositions: MiNoteStarFoldPositions;
  rotationOffsetDegrees: number;
  rotationOffsetsDegrees: MiNoteStarRotationOffsets;
  storageError: boolean;
  disabled: boolean;
  onChange: (value: number) => void;
  onRotationChange: (value: number) => void;
};

type CopyState = 'idle' | 'copying' | 'copied' | 'manual';

export default function MiNoteFoldControls({
  foldPosition,
  foldPositions,
  rotationOffsetDegrees,
  rotationOffsetsDegrees,
  storageError,
  disabled,
  onChange,
  onRotationChange,
}: MiNoteFoldControlsProps) {
  const rangeId = useId();
  const rotationId = useId();
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [showStorageError, setShowStorageError] = useState(storageError);
  const json = useMemo(
    () => serializeMiNoteStarFolds(foldPositions, rotationOffsetsDegrees),
    [foldPositions, rotationOffsetsDegrees],
  );
  const rotationLabel = `${rotationOffsetDegrees > 0 ? '+' : ''}${rotationOffsetDegrees.toFixed(1)}°`;
  const latestJsonRef = useRef(json);
  const mountedRef = useRef(false);
  const copyPendingRef = useRef(false);
  const copyTimerRef = useRef<number | null>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const manualCopyRef = useRef<HTMLTextAreaElement>(null);
  const manualWasOpenRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  useLayoutEffect(() => {
    latestJsonRef.current = json;
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    setCopyState((previous) => previous === 'copied' ? 'idle' : previous);
  }, [json]);

  useEffect(() => {
    setShowStorageError(storageError);
    if (!storageError) return;
    const timer = window.setTimeout(() => setShowStorageError(false), 4000);
    return () => window.clearTimeout(timer);
  }, [storageError, foldPositions, rotationOffsetsDegrees]);

  useLayoutEffect(() => {
    if (copyState === 'manual') {
      manualCopyRef.current?.focus();
      manualCopyRef.current?.select();
    } else if (manualWasOpenRef.current) {
      copyButtonRef.current?.focus();
    }
    manualWasOpenRef.current = copyState === 'manual';
  }, [copyState]);

  const copyJson = async () => {
    if (copyPendingRef.current) return;
    copyPendingRef.current = true;
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    setCopyState('copying');
    try {
      await navigator.clipboard.writeText(json);
      if (!mountedRef.current) return;
      if (latestJsonRef.current !== json) {
        setCopyState('idle');
        return;
      }
      setCopyState('copied');
      copyTimerRef.current = window.setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      if (mountedRef.current) setCopyState('manual');
    } finally {
      copyPendingRef.current = false;
    }
  };

  return (
    <div className="mi-note-wip__fold-controls">
      <div className="mi-note-wip__fold-row">
        <label htmlFor={rangeId}>Horizontal position</label>
        <input
          id={rangeId}
          type="range"
          min={MI_NOTE_STAR_FOLD_MIN * 100}
          max={MI_NOTE_STAR_FOLD_MAX * 100}
          step={MI_NOTE_STAR_FOLD_STEP * 100}
          value={foldPosition * 100}
          disabled={disabled}
          aria-valuetext={`${(foldPosition * 100).toFixed(1)}%`}
          onChange={(event) => { if (!disabled) onChange(Number(event.target.value) / 100); }}
        />
        <output htmlFor={rangeId}>{(foldPosition * 100).toFixed(1)}%</output>
        <button
          ref={copyButtonRef}
          type="button"
          className="mi-note-wip__copy-folds"
          disabled={copyState === 'copying'}
          onClick={() => void copyJson()}
        >
          {copyState === 'copying' ? 'Copying…' : copyState === 'copied' ? 'Copied' : 'Copy JSON'}
        </button>
      </div>
      <div className="mi-note-wip__fold-row">
        <label htmlFor={rotationId}>Rotation</label>
        <input
          id={rotationId}
          type="range"
          min={MI_NOTE_STAR_ROTATION_MIN}
          max={MI_NOTE_STAR_ROTATION_MAX}
          step={MI_NOTE_STAR_ROTATION_STEP}
          value={rotationOffsetDegrees}
          disabled={disabled}
          aria-valuetext={rotationOffsetDegrees === 0 ? '0.0°, original rotation' : `${rotationLabel} from original rotation`}
          title="0° is the original rotation; positive values rotate clockwise"
          onChange={(event) => { if (!disabled) onRotationChange(Number(event.target.value)); }}
        />
        <output htmlFor={rotationId}>{rotationLabel}</output>
      </div>
      {disabled && <div className="mi-note-wip__fold-reference">Blush is the fixed reference.</div>}
      <div className="mi-note-wip__fold-feedback" role="status">
        {showStorageError ? 'Not saved locally' : copyState === 'copied' ? 'Copied to clipboard' : ''}
      </div>
      {copyState === 'manual' && (
        <div className="mi-note-wip__fold-export" role="group" aria-label="Copy star tuning JSON manually">
          <div className="mi-note-wip__fold-export-heading">
            <span>Select and copy JSON</span>
            <button
              type="button"
              className="mi-note-wip__copy-folds"
              onClick={() => setCopyState('idle')}
              aria-label="Close JSON export"
            >
              Close
            </button>
          </div>
          <textarea
            ref={manualCopyRef}
            aria-label="Star tuning JSON"
            readOnly
            value={json}
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      )}
    </div>
  );
}
