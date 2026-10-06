import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS,
  MI_NOTE_STICKER_EFFECT_CONTROLS,
  parseMiNoteStickerEffect,
  serializeMiNoteStickerEffect,
  type MiNoteStickerEffectSettings,
} from '../lib/miNoteStickerEffects';
import '../styles/mi-note-sticker-effects.css';

type MiNoteStickerEffectControlsProps = {
  settings: MiNoteStickerEffectSettings;
  onChange: (settings: MiNoteStickerEffectSettings) => void;
  storageError: boolean;
  inspectSticker?: boolean;
  onInspectChange?: (inspect: boolean) => void;
};

type JsonEditor = 'import' | 'export' | null;

function formatValue(key: keyof MiNoteStickerEffectSettings, value: number) {
  if (key === 'hue') return `${Math.round(value * 360)}°`;
  if (key === 'scale' || key === 'motion') return `${value.toFixed(2)}×`;
  return `${Number((value * 100).toFixed(key === 'width' ? 2 : 1))}%`;
}

export default function MiNoteStickerEffectControls({ settings, onChange, storageError, inspectSticker = false, onInspectChange }: MiNoteStickerEffectControlsProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState<JsonEditor>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [copying, setCopying] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const importRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const copyRequestRef = useRef(0);
  const returnFocusRef = useRef<JsonEditor>(null);
  const json = serializeMiNoteStickerEffect(settings);

  useLayoutEffect(() => {
    copyRequestRef.current += 1;
    setCopying(false);
    setStatus('');
  }, [json]);

  useEffect(() => () => { copyRequestRef.current += 1; }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const page = root?.closest<HTMLElement>('.mi-note-wip-page');
    if (!open || !root || !page || typeof ResizeObserver === 'undefined') return;
    const updateHeight = () => page.style.setProperty('--mi-note-sticker-controls-height', `${Math.ceil(root.getBoundingClientRect().height)}px`);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(root);
    return () => {
      observer.disconnect();
      page.style.removeProperty('--mi-note-sticker-controls-height');
    };
  }, [open]);

  useLayoutEffect(() => {
    if (editor) {
      textareaRef.current?.focus({ preventScroll: true });
      if (editor === 'export') textareaRef.current?.select();
    } else if (returnFocusRef.current) {
      (returnFocusRef.current === 'import' ? importRef.current : copyRef.current)?.focus({ preventScroll: true });
      returnFocusRef.current = null;
    }
  }, [editor]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || rootRef.current?.closest('[inert]')) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      copyRequestRef.current += 1;
      setCopying(false);
      if (editor) {
        setEditor(null);
        setError('');
      } else {
        setOpen(false);
        toggleRef.current?.focus({ preventScroll: true });
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, editor]);

  const changeSettings = (next: MiNoteStickerEffectSettings) => {
    setError('');
    setStatus('');
    onChange(next);
  };

  const closeEditor = () => {
    setEditor(null);
    setError('');
  };

  const copyJson = async () => {
    const request = ++copyRequestRef.current;
    setCopying(true);
    setStatus('');
    try {
      await navigator.clipboard.writeText(json);
      if (copyRequestRef.current !== request) return;
      setStatus('Finish JSON copied.');
    } catch {
      if (copyRequestRef.current !== request) return;
      returnFocusRef.current = 'export';
      setEditor('export');
      setStatus('Select and copy the JSON below.');
    } finally {
      if (copyRequestRef.current === request) setCopying(false);
    }
  };

  const importJson = () => {
    try {
      const next = parseMiNoteStickerEffect(draft);
      changeSettings(next);
      setEditor(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to read this finish JSON.');
    }
  };

  return (
    <div className="mi-note-sticker-effects" ref={rootRef}>
      <button
        ref={toggleRef}
        type="button"
        className="mi-note-sticker-effects__toggle"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => {
          copyRequestRef.current += 1;
          setCopying(false);
          setOpen(!open);
          setEditor(null);
          setError('');
          setStatus('');
          returnFocusRef.current = null;
        }}
      >
        <span className="mi-note-sticker-effects__swatch" aria-hidden="true" />
        Sticker finish
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <section id={`${id}-panel`} className="mi-note-sticker-effects__panel" aria-label="Sticker finish controls">
          {editor ? (
            <div className="mi-note-sticker-effects__editor">
              <div className="mi-note-sticker-effects__heading">
                <label htmlFor={`${id}-json`}>{editor === 'import' ? 'Import finish JSON' : 'Copy finish JSON'}</label>
                <button type="button" onClick={closeEditor} aria-label="Close finish JSON editor">Back</button>
              </div>
              <textarea
                id={`${id}-json`}
                ref={textareaRef}
                aria-label="Sticker finish JSON"
                aria-invalid={Boolean(error) || undefined}
                aria-describedby={error ? `${id}-error` : undefined}
                readOnly={editor === 'export'}
                spellCheck={false}
                value={editor === 'export' ? json : draft}
                placeholder={editor === 'import' ? 'Paste a saved finish JSON…' : undefined}
                onChange={(event) => { setDraft(event.target.value); setError(''); }}
                onFocus={(event) => { if (editor === 'export') event.currentTarget.select(); }}
              />
              {error && <p id={`${id}-error`} className="mi-note-sticker-effects__error" role="alert">{error}</p>}
              {editor === 'import' && <button type="button" disabled={!draft.trim()} onClick={importJson}>Apply finish</button>}
            </div>
          ) : (
            <>
              <div className="mi-note-sticker-effects__heading">
                <h2 className="mi-note-sticker-effects__title">Prismatic foil</h2>
                {onInspectChange && (
                  <button
                    type="button"
                    className="mi-note-sticker-effects__inspect"
                    aria-pressed={inspectSticker}
                    onClick={() => onInspectChange(!inspectSticker)}
                  >Close-up</button>
                )}
              </div>
              <p id={`${id}-band-hint`} className="mi-note-sticker-effects__band-hint">Outerness moves the band outside the artwork. Blend softens the join.</p>
              <div className="mi-note-sticker-effects__sliders">
                {MI_NOTE_STICKER_EFFECT_CONTROLS.map(({ key, label, min, max, step }) => (
                  <div className="mi-note-sticker-effects__slider" key={key}>
                    <label htmlFor={`${id}-${key}`}>{label}</label>
                    <input
                      id={`${id}-${key}`}
                      type="range"
                      min={min}
                      max={max}
                      step={step}
                      value={settings[key]}
                      aria-valuetext={formatValue(key, settings[key])}
                      aria-describedby={key === 'outerness' || key === 'softness' ? `${id}-band-hint` : undefined}
                      onChange={(event) => changeSettings({ ...settings, [key]: Number(event.target.value) })}
                    />
                    <output htmlFor={`${id}-${key}`}>{formatValue(key, settings[key])}</output>
                  </div>
                ))}
              </div>
              <p className="mi-note-sticker-effects__hint">Rotate the pack to compare. Applies to every star.</p>
              <div className="mi-note-sticker-effects__actions">
                <button type="button" onClick={() => changeSettings({ ...DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS })}>Reset defaults</button>
                <button ref={copyRef} type="button" aria-label="Copy sticker finish JSON" disabled={copying} onClick={() => void copyJson()}>{copying ? 'Copying…' : 'Copy JSON'}</button>
                <button
                  ref={importRef}
                  type="button"
                  aria-label="Import sticker finish JSON"
                  onClick={() => {
                    copyRequestRef.current += 1;
                    setCopying(false);
                    setStatus('');
                    setError('');
                    setDraft('');
                    returnFocusRef.current = 'import';
                    setEditor('import');
                  }}
                >Import JSON</button>
              </div>
            </>
          )}
          <div className="mi-note-sticker-effects__status" role="status" aria-label="Sticker finish status">{status || (storageError ? 'Not saved locally. Copy JSON to keep this finish.' : 'Saved on this device.')}</div>
        </section>
      )}
    </div>
  );
}
