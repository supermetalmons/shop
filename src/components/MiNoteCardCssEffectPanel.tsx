import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  MI_NOTE_CARD_CSS_BLEND_MODES,
  normalizeMiNoteCardCssEffectSettings,
  serializeMiNoteCardCssEffectSettings,
  type MiNoteCardCssEffectSettings,
} from '../lib/miNoteCardCssEffects';
import '../styles/mi-note-card-css-effect-panel.css';

type MiNoteCardCssEffectPanelProps = {
  settings: MiNoteCardCssEffectSettings;
  onChange: (settings: MiNoteCardCssEffectSettings) => void;
  onReset: () => void;
  holdPose: boolean;
  onHoldPoseChange: (hold: boolean) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type RangeControlProps = {
  label: string;
  name: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
};

function RangeControl({ label, name, value, min, max, step = 0.01, onChange }: RangeControlProps) {
  const id = useId();
  const focused = useRef(false);
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  const commit = () => {
    const parsed = draft.trim() === '' ? NaN : Number(draft);
    const next = Number.isFinite(parsed) ? clamp(parsed) : value;
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <div className="mi-css-panel__range-row">
      <label htmlFor={id} title={name}>{label}</label>
      <input
        id={id}
        className="mi-css-panel__range"
        type="range"
        aria-label={name}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(clamp(Number(event.currentTarget.value)))}
      />
      <span className="mi-css-panel__number-wrap">
        <input
          className="mi-css-panel__number"
          type="number"
          aria-label={`${name} value`}
          min={min}
          max={max}
          step={step}
          value={draft}
          onFocus={() => { focused.current = true; }}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setDraft(next);
            if (next.trim() === '' || next.endsWith('.') || next === '-') return;
            const parsed = Number(next);
            if (Number.isFinite(parsed)) onChange(clamp(parsed));
          }}
          onBlur={() => { focused.current = false; commit(); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      </span>
    </div>
  );
}

function BlendControl({ label, value, onChange }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="mi-css-panel__simple-row">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        {MI_NOTE_CARD_CSS_BLEND_MODES.map((mode) => <option value={mode} key={mode}>{mode}</option>)}
      </select>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mi-css-panel__section" aria-label={title}>
      <h3>{title}</h3>
      <div className="mi-css-panel__section-body">{children}</div>
    </section>
  );
}

const GLARE_FILTER_CONTROLS = [
  { key: 'strength', label: 'Strength', max: 1 },
  { key: 'brightness', label: 'Brightness', max: 3 },
  { key: 'contrast', label: 'Contrast', max: 5 },
] as const;

export default function MiNoteCardCssEffectPanel({
  settings, onChange, onReset, holdPose, onHoldPoseChange, open, onOpenChange,
}: MiNoteCardCssEffectPanelProps) {
  const panelId = useId();
  const copyRequest = useRef(0);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'fallback'>('idle');
  const [fallbackJson, setFallbackJson] = useState('');

  useEffect(() => {
    copyRequest.current += 1;
    setCopyState('idle');
    setFallbackJson('');
    return () => { copyRequest.current += 1; };
  }, [settings]);

  const update = (path: readonly (string | number)[], value: unknown) => {
    const next = JSON.parse(JSON.stringify(settings)) as MiNoteCardCssEffectSettings;
    let target = next as unknown as Record<string | number, unknown>;
    for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, unknown>;
    target[path[path.length - 1]] = value;
    onChange(normalizeMiNoteCardCssEffectSettings(next));
  };

  const copy = async () => {
    const request = ++copyRequest.current;
    const json = serializeMiNoteCardCssEffectSettings(settings);
    setCopyState('copying');
    setFallbackJson('');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(json);
      if (request === copyRequest.current) setCopyState('copied');
    } catch {
      if (request === copyRequest.current) {
        setFallbackJson(json);
        setCopyState('fallback');
      }
    }
  };

  const glareFilterControls = GLARE_FILTER_CONTROLS.map((control) => (
    <RangeControl
      key={control.key}
      label={control.label}
      name={`Glare ${control.key}`}
      value={settings.glare[control.key]}
      min={0}
      max={control.max}
      onChange={(value) => update(['glare', control.key], value)}
    />
  ));

  return (
    <aside className={`mi-css-panel${open ? ' mi-css-panel--open' : ''}`} aria-label="MI card effect tuning">
      <button className="mi-css-panel__header" type="button" aria-expanded={open} aria-controls={panelId} onClick={() => onOpenChange(!open)}>
        <span>CSS effect</span>{' '}<span>{open ? 'Hide' : 'Tune'}</span>
      </button>
      {open && (
        <div className="mi-css-panel__panel" id={panelId}>
          <div className="mi-css-panel__scroll">
            {copyState === 'fallback' && (
              <div className="mi-css-panel__manual-copy">
                <textarea aria-label="Effect settings JSON" readOnly autoFocus value={fallbackJson} onFocus={(event) => event.currentTarget.select()} />
              </div>
            )}
            <label className="mi-css-panel__hold">
              <span>Hold last pose</span>
              <input type="checkbox" checked={holdPose} onChange={(event) => onHoldPoseChange(event.currentTarget.checked)} />
            </label>
            <Section title="Glare">
              {glareFilterControls}
              <RangeControl label="Size" name="Glare size" value={settings.glare.size} min={0.25} max={3} onChange={(value) => update(['glare', 'size'], value)} />
              <BlendControl label="Glare blend" value={settings.glare.blendMode} onChange={(value) => update(['glare', 'blendMode'], value)} />
            </Section>
          </div>
          <div className="mi-css-panel__actions">
            <div className="mi-css-panel__feedback" aria-live="polite">
              {copyState === 'copied' ? 'Settings copied.' : copyState === 'fallback' ? 'Clipboard unavailable. Copy the selected JSON.' : '\u00a0'}
            </div>
            <div className="mi-css-panel__buttons">
              <button type="button" disabled={copyState === 'copying'} onClick={() => void copy()}>{copyState === 'copying' ? 'Copying…' : copyState === 'copied' ? 'Copied' : 'Copy JSON'}</button>
              <button type="button" onClick={() => { copyRequest.current += 1; setCopyState('idle'); setFallbackJson(''); onReset(); }}>Reset</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
