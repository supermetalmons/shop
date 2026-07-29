import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CLEAR_CARD_LIGHTING_PRESETS,
  DEFAULT_CLEAR_CARD_LIGHTING_PRESET_ID,
  parseClearCardLightingConfigJson,
  serializeClearCardLightingConfig,
  type ClearCardLightingConfig,
  type ClearCardLightingPresetId,
  type Vector3Config,
} from '../clearCardLighting';

type ClearCardLightingPanelProps = {
  config: ClearCardLightingConfig;
  presetId: ClearCardLightingPresetId | 'custom';
  unrestrictedMovement: boolean;
  onChange: (config: ClearCardLightingConfig) => void;
  onPresetChange: (presetId: ClearCardLightingPresetId) => void;
  onUnrestrictedMovementChange: (enabled: boolean) => void;
};

type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type RangeControlProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  unit?: string;
};

type ClipboardFeedback = {
  tone: 'success' | 'error';
  message: string;
};

const STAGE_OPTIONS: SelectOption[] = [
  { value: 'all', label: 'All stages' },
  { value: 'pack', label: 'Pack only' },
  { value: 'card', label: 'Card only' },
];

const TONE_MAPPING_OPTIONS: SelectOption[] = [
  { value: 'none', label: 'None' },
  { value: 'linear', label: 'Linear' },
  { value: 'reinhard', label: 'Reinhard' },
  { value: 'cineon', label: 'Cineon' },
  { value: 'aces', label: 'ACES filmic' },
  { value: 'agx', label: 'AgX' },
  { value: 'neutral', label: 'Neutral' },
];

const ENVIRONMENT_OPTIONS: SelectOption[] = [
  { value: 'sky', label: 'Spherical sky' },
  { value: 'room', label: 'Studio room' },
  { value: 'none', label: 'None' },
];

function cloneWithValue(
  source: ClearCardLightingConfig,
  path: string[],
  value: string | number | boolean,
): ClearCardLightingConfig {
  const next = JSON.parse(JSON.stringify(source)) as ClearCardLightingConfig;
  let cursor = next as unknown as Record<string, unknown>;
  for (let index = 0; index < path.length - 1; index += 1) {
    cursor = cursor[path[index]] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = value;
  return next;
}

function formatNumber(value: number, step: number) {
  const precision = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return value.toFixed(precision);
}

function RangeControl({
  label,
  value,
  min,
  max,
  step,
  onChange,
  unit = '',
}: RangeControlProps) {
  const numberFocusedRef = useRef(false);
  const [numberDraft, setNumberDraft] = useState(() => formatNumber(value, step));

  useEffect(() => {
    if (!numberFocusedRef.current) {
      setNumberDraft(formatNumber(value, step));
    }
  }, [step, value]);

  const clampValue = (nextValue: number) => {
    return Math.min(max, Math.max(min, nextValue));
  };

  const update = (nextValue: number) => {
    if (!Number.isFinite(nextValue)) return;
    onChange(clampValue(nextValue));
  };

  const commitDraft = () => {
    const nextValue = Number(numberDraft);
    const committedValue = Number.isFinite(nextValue) ? clampValue(nextValue) : value;
    setNumberDraft(formatNumber(committedValue, step));
    if (committedValue !== value) {
      onChange(committedValue);
    }
  };

  return (
    <label className="lighting-lab__range-row">
      <span className="lighting-lab__control-label">{label}</span>
      <input
        className="lighting-lab__range"
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => update(Number(event.currentTarget.value))}
      />
      <span className="lighting-lab__number-wrap">
        <input
          className="lighting-lab__number"
          type="number"
          value={numberDraft}
          min={min}
          max={max}
          step={step}
          onFocus={() => {
            numberFocusedRef.current = true;
          }}
          onChange={(event) => {
            const nextDraft = event.currentTarget.value;
            setNumberDraft(nextDraft);
            if (nextDraft.trim() === '' || nextDraft.endsWith('.') || nextDraft === '-') return;
            update(Number(nextDraft));
          }}
          onBlur={() => {
            numberFocusedRef.current = false;
            commitDraft();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
          }}
          aria-label={`${label} value`}
        />
        {unit ? <span>{unit}</span> : null}
      </span>
    </label>
  );
}

function ColorControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="lighting-lab__simple-row">
      <span className="lighting-lab__control-label">{label}</span>
      <span className="lighting-lab__color-wrap">
        <input
          className="lighting-lab__color"
          type="color"
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <span>{value.toUpperCase()}</span>
      </span>
    </label>
  );
}

function SelectControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="lighting-lab__simple-row">
      <span className="lighting-lab__control-label">{label}</span>
      <select
        className="lighting-lab__select"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ToggleControl({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="lighting-lab__toggle-row">
      <span className="lighting-lab__control-label">{label}</span>
      <input
        className="lighting-lab__toggle"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}

function ControlSection({
  title,
  children,
  open = false,
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="lighting-lab__section" open={open}>
      <summary>{title}</summary>
      <div className="lighting-lab__section-body">{children}</div>
    </details>
  );
}

function VectorControls({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Vector3Config;
  onChange: (axis: keyof Vector3Config, value: number) => void;
}) {
  return (
    <div className="lighting-lab__vector">
      <div className="lighting-lab__vector-title">{label}</div>
      {(['x', 'y', 'z'] as const).map((axis) => (
        <RangeControl
          key={axis}
          label={axis.toUpperCase()}
          value={value[axis]}
          min={-10}
          max={10}
          step={0.1}
          onChange={(nextValue) => onChange(axis, nextValue)}
        />
      ))}
    </div>
  );
}

export default function ClearCardLightingPanel({
  config,
  presetId,
  unrestrictedMovement,
  onChange,
  onPresetChange,
  onUnrestrictedMovementChange,
}: ClearCardLightingPanelProps) {
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const [importing, setImporting] = useState(false);
  const [clipboardFeedback, setClipboardFeedback] = useState<ClipboardFeedback | null>(null);
  const copiedTimeoutRef = useRef<number | null>(null);
  const feedbackTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current !== null) {
        window.clearTimeout(copiedTimeoutRef.current);
      }
      if (feedbackTimeoutRef.current !== null) {
        window.clearTimeout(feedbackTimeoutRef.current);
      }
    };
  }, []);

  const update = (path: string[], value: string | number | boolean) => {
    onChange(cloneWithValue(config, path, value));
  };

  const updateVector = (
    path: ['directional' | 'rim' | 'area' | 'point' | 'spot', 'position' | 'target'],
    axis: keyof Vector3Config,
    value: number,
  ) => {
    update([...path, axis], value);
  };

  const showClipboardFeedback = (feedback: ClipboardFeedback) => {
    setClipboardFeedback(feedback);
    if (feedbackTimeoutRef.current !== null) {
      window.clearTimeout(feedbackTimeoutRef.current);
    }
    feedbackTimeoutRef.current = window.setTimeout(() => {
      setClipboardFeedback(null);
      feedbackTimeoutRef.current = null;
    }, 3_200);
  };

  const copyConfig = () => {
    if (!navigator.clipboard?.writeText) {
      setCopied(false);
      showClipboardFeedback({
        tone: 'error',
        message: 'Clipboard writing is unavailable.',
      });
      return;
    }
    void navigator.clipboard
      .writeText(serializeClearCardLightingConfig(config))
      .then(() => {
        setCopied(true);
        showClipboardFeedback({
          tone: 'success',
          message: 'Configuration copied.',
        });
        if (copiedTimeoutRef.current !== null) {
          window.clearTimeout(copiedTimeoutRef.current);
        }
        copiedTimeoutRef.current = window.setTimeout(() => setCopied(false), 1_400);
      })
      .catch(() => {
        setCopied(false);
        showClipboardFeedback({
          tone: 'error',
          message: 'Clipboard access was denied.',
        });
      });
  };

  const importConfig = async () => {
    if (!navigator.clipboard?.readText) {
      showClipboardFeedback({
        tone: 'error',
        message: 'Clipboard reading is unavailable.',
      });
      return;
    }

    setImporting(true);
    try {
      const source = await navigator.clipboard.readText();
      if (!source.trim()) {
        throw new Error('Clipboard is empty.');
      }
      const importedConfig = parseClearCardLightingConfigJson(source);
      onChange(importedConfig);
      showClipboardFeedback({
        tone: 'success',
        message: 'Configuration imported.',
      });
    } catch (error) {
      showClipboardFeedback({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not import configuration.',
      });
    } finally {
      setImporting(false);
    }
  };

  const activePreset = CLEAR_CARD_LIGHTING_PRESETS.find(
    (preset) => preset.id === presetId,
  );

  return (
    <aside className={`lighting-lab${open ? ' lighting-lab--open' : ''}`} aria-label="Lighting lab">
      <button
        type="button"
        className="lighting-lab__header"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <span>
          <span className="lighting-lab__eyebrow">Lights</span>
        </span>
        <span className="lighting-lab__header-meta">
          {open ? 'Hide' : presetId === 'custom' ? 'Custom' : activePreset?.label}
        </span>
      </button>

      {open ? (
        <div className="lighting-lab__panel">
          <div className="lighting-lab__movement-block">
            <ToggleControl
              label="Unrestricted movement"
              checked={unrestrictedMovement}
              onChange={onUnrestrictedMovementChange}
            />
          </div>
          <div className="lighting-lab__preset-block">
            <SelectControl
              label="Setup"
              value={presetId}
              options={[
                ...CLEAR_CARD_LIGHTING_PRESETS.map((preset) => ({
                  value: preset.id,
                  label: preset.label,
                })),
                { value: 'custom', label: 'Custom', disabled: true },
              ]}
              onChange={(value) => {
                if (value !== 'custom') {
                  onPresetChange(value as ClearCardLightingPresetId);
                }
              }}
            />
            <p>
              {presetId === 'custom'
                ? 'Manual settings. Copy the JSON when you find a keeper.'
                : activePreset?.description}
            </p>
          </div>

          <ControlSection title="Renderer" open>
            <SelectControl
              label="Tone map"
              value={config.renderer.toneMapping}
              options={TONE_MAPPING_OPTIONS}
              onChange={(value) => update(['renderer', 'toneMapping'], value)}
            />
            <RangeControl
              label="Exposure"
              value={config.renderer.exposure}
              min={0.1}
              max={4}
              step={0.05}
              onChange={(value) => update(['renderer', 'exposure'], value)}
            />
          </ControlSection>

          <ControlSection title="Environment" open>
            <SelectControl
              label="Source"
              value={config.environment.mode}
              options={ENVIRONMENT_OPTIONS}
              onChange={(value) => update(['environment', 'mode'], value)}
            />
            <RangeControl
              label="Intensity"
              value={config.environment.intensity}
              min={0}
              max={5}
              step={0.05}
              onChange={(value) => update(['environment', 'intensity'], value)}
            />
            <RangeControl
              label="Rotation"
              value={config.environment.rotation}
              min={-180}
              max={180}
              step={1}
              unit="°"
              onChange={(value) => update(['environment', 'rotation'], value)}
            />

            {config.environment.mode === 'sky' ? (
              <>
                <SelectControl
                  label="Resolution"
                  value={String(config.environment.sky.resolution)}
                  options={[128, 256, 512, 1024].map((value) => ({
                    value: String(value),
                    label: `${value} × ${value / 2}`,
                  }))}
                  onChange={(value) =>
                    update(['environment', 'sky', 'resolution'], Number(value))
                  }
                />
                <div className="lighting-lab__subsection-title">Gradient</div>
                <ColorControl
                  label="Ground"
                  value={config.environment.sky.groundColor}
                  onChange={(value) => update(['environment', 'sky', 'groundColor'], value)}
                />
                <RangeControl
                  label="Ground power"
                  value={config.environment.sky.groundIntensity}
                  min={0}
                  max={8}
                  step={0.01}
                  onChange={(value) =>
                    update(['environment', 'sky', 'groundIntensity'], value)
                  }
                />
                <ColorControl
                  label="Horizon"
                  value={config.environment.sky.horizonColor}
                  onChange={(value) => update(['environment', 'sky', 'horizonColor'], value)}
                />
                <RangeControl
                  label="Horizon power"
                  value={config.environment.sky.horizonIntensity}
                  min={0}
                  max={8}
                  step={0.01}
                  onChange={(value) =>
                    update(['environment', 'sky', 'horizonIntensity'], value)
                  }
                />
                <ColorControl
                  label="Zenith"
                  value={config.environment.sky.zenithColor}
                  onChange={(value) => update(['environment', 'sky', 'zenithColor'], value)}
                />
                <RangeControl
                  label="Zenith power"
                  value={config.environment.sky.zenithIntensity}
                  min={0}
                  max={8}
                  step={0.01}
                  onChange={(value) =>
                    update(['environment', 'sky', 'zenithIntensity'], value)
                  }
                />
                <div className="lighting-lab__subsection-title">Spherical key</div>
                <ColorControl
                  label="Color"
                  value={config.environment.sky.keyColor}
                  onChange={(value) => update(['environment', 'sky', 'keyColor'], value)}
                />
                <RangeControl
                  label="Power"
                  value={config.environment.sky.keyIntensity}
                  min={0}
                  max={600}
                  step={1}
                  onChange={(value) =>
                    update(['environment', 'sky', 'keyIntensity'], value)
                  }
                />
                <RangeControl
                  label="Latitude"
                  value={config.environment.sky.keyLatitude}
                  min={-90}
                  max={90}
                  step={1}
                  unit="°"
                  onChange={(value) =>
                    update(['environment', 'sky', 'keyLatitude'], value)
                  }
                />
                <RangeControl
                  label="Longitude"
                  value={config.environment.sky.keyLongitude}
                  min={-180}
                  max={180}
                  step={1}
                  unit="°"
                  onChange={(value) =>
                    update(['environment', 'sky', 'keyLongitude'], value)
                  }
                />
                <RangeControl
                  label="Radius"
                  value={config.environment.sky.keyRadius}
                  min={2}
                  max={120}
                  step={1}
                  unit="°"
                  onChange={(value) => update(['environment', 'sky', 'keyRadius'], value)}
                />
                <RangeControl
                  label="Falloff"
                  value={config.environment.sky.keyFalloff}
                  min={0.1}
                  max={8}
                  step={0.1}
                  onChange={(value) => update(['environment', 'sky', 'keyFalloff'], value)}
                />
              </>
            ) : null}
          </ControlSection>

          <ControlSection title="Ambient light">
            <ToggleControl
              label="Enabled"
              checked={config.ambient.enabled}
              onChange={(value) => update(['ambient', 'enabled'], value)}
            />
            <SelectControl
              label="Stage"
              value={config.ambient.stage}
              options={STAGE_OPTIONS}
              onChange={(value) => update(['ambient', 'stage'], value)}
            />
            <ColorControl
              label="Color"
              value={config.ambient.color}
              onChange={(value) => update(['ambient', 'color'], value)}
            />
            <RangeControl
              label="Intensity"
              value={config.ambient.intensity}
              min={0}
              max={5}
              step={0.05}
              onChange={(value) => update(['ambient', 'intensity'], value)}
            />
          </ControlSection>

          <ControlSection title="Hemisphere light">
            <ToggleControl
              label="Enabled"
              checked={config.hemisphere.enabled}
              onChange={(value) => update(['hemisphere', 'enabled'], value)}
            />
            <SelectControl
              label="Stage"
              value={config.hemisphere.stage}
              options={STAGE_OPTIONS}
              onChange={(value) => update(['hemisphere', 'stage'], value)}
            />
            <ColorControl
              label="Sky"
              value={config.hemisphere.skyColor}
              onChange={(value) => update(['hemisphere', 'skyColor'], value)}
            />
            <ColorControl
              label="Ground"
              value={config.hemisphere.groundColor}
              onChange={(value) => update(['hemisphere', 'groundColor'], value)}
            />
            <RangeControl
              label="Intensity"
              value={config.hemisphere.intensity}
              min={0}
              max={5}
              step={0.05}
              onChange={(value) => update(['hemisphere', 'intensity'], value)}
            />
          </ControlSection>

          <ControlSection title="Directional key">
            <ToggleControl
              label="Enabled"
              checked={config.directional.enabled}
              onChange={(value) => update(['directional', 'enabled'], value)}
            />
            <SelectControl
              label="Stage"
              value={config.directional.stage}
              options={STAGE_OPTIONS}
              onChange={(value) => update(['directional', 'stage'], value)}
            />
            <ColorControl
              label="Color"
              value={config.directional.color}
              onChange={(value) => update(['directional', 'color'], value)}
            />
            <RangeControl
              label="Intensity"
              value={config.directional.intensity}
              min={0}
              max={10}
              step={0.05}
              onChange={(value) => update(['directional', 'intensity'], value)}
            />
            <VectorControls
              label="Position"
              value={config.directional.position}
              onChange={(axis, value) => updateVector(['directional', 'position'], axis, value)}
            />
            <VectorControls
              label="Target"
              value={config.directional.target}
              onChange={(axis, value) => updateVector(['directional', 'target'], axis, value)}
            />
          </ControlSection>

          <ControlSection title="Directional rim">
            <ToggleControl
              label="Enabled"
              checked={config.rim.enabled}
              onChange={(value) => update(['rim', 'enabled'], value)}
            />
            <SelectControl
              label="Stage"
              value={config.rim.stage}
              options={STAGE_OPTIONS}
              onChange={(value) => update(['rim', 'stage'], value)}
            />
            <ColorControl
              label="Color"
              value={config.rim.color}
              onChange={(value) => update(['rim', 'color'], value)}
            />
            <RangeControl
              label="Intensity"
              value={config.rim.intensity}
              min={0}
              max={10}
              step={0.05}
              onChange={(value) => update(['rim', 'intensity'], value)}
            />
            <VectorControls
              label="Position"
              value={config.rim.position}
              onChange={(axis, value) => updateVector(['rim', 'position'], axis, value)}
            />
            <VectorControls
              label="Target"
              value={config.rim.target}
              onChange={(axis, value) => updateVector(['rim', 'target'], axis, value)}
            />
          </ControlSection>

          <ControlSection title="Rectangular area light">
            <ToggleControl
              label="Enabled"
              checked={config.area.enabled}
              onChange={(value) => update(['area', 'enabled'], value)}
            />
            <SelectControl
              label="Stage"
              value={config.area.stage}
              options={STAGE_OPTIONS}
              onChange={(value) => update(['area', 'stage'], value)}
            />
            <ColorControl
              label="Color"
              value={config.area.color}
              onChange={(value) => update(['area', 'color'], value)}
            />
            <RangeControl
              label="Intensity"
              value={config.area.intensity}
              min={0}
              max={100}
              step={0.1}
              onChange={(value) => update(['area', 'intensity'], value)}
            />
            <RangeControl
              label="Width"
              value={config.area.width}
              min={0.1}
              max={20}
              step={0.1}
              onChange={(value) => update(['area', 'width'], value)}
            />
            <RangeControl
              label="Height"
              value={config.area.height}
              min={0.1}
              max={20}
              step={0.1}
              onChange={(value) => update(['area', 'height'], value)}
            />
            <VectorControls
              label="Position"
              value={config.area.position}
              onChange={(axis, value) => updateVector(['area', 'position'], axis, value)}
            />
            <VectorControls
              label="Target"
              value={config.area.target}
              onChange={(axis, value) => updateVector(['area', 'target'], axis, value)}
            />
          </ControlSection>

          <ControlSection title="Point light">
            <ToggleControl
              label="Enabled"
              checked={config.point.enabled}
              onChange={(value) => update(['point', 'enabled'], value)}
            />
            <SelectControl
              label="Stage"
              value={config.point.stage}
              options={STAGE_OPTIONS}
              onChange={(value) => update(['point', 'stage'], value)}
            />
            <ColorControl
              label="Color"
              value={config.point.color}
              onChange={(value) => update(['point', 'color'], value)}
            />
            <RangeControl
              label="Intensity"
              value={config.point.intensity}
              min={0}
              max={500}
              step={1}
              onChange={(value) => update(['point', 'intensity'], value)}
            />
            <RangeControl
              label="Distance"
              value={config.point.distance}
              min={0}
              max={50}
              step={0.5}
              onChange={(value) => update(['point', 'distance'], value)}
            />
            <RangeControl
              label="Decay"
              value={config.point.decay}
              min={0}
              max={4}
              step={0.1}
              onChange={(value) => update(['point', 'decay'], value)}
            />
            <VectorControls
              label="Position"
              value={config.point.position}
              onChange={(axis, value) => updateVector(['point', 'position'], axis, value)}
            />
          </ControlSection>

          <ControlSection title="Spot light">
            <ToggleControl
              label="Enabled"
              checked={config.spot.enabled}
              onChange={(value) => update(['spot', 'enabled'], value)}
            />
            <SelectControl
              label="Stage"
              value={config.spot.stage}
              options={STAGE_OPTIONS}
              onChange={(value) => update(['spot', 'stage'], value)}
            />
            <ColorControl
              label="Color"
              value={config.spot.color}
              onChange={(value) => update(['spot', 'color'], value)}
            />
            <RangeControl
              label="Intensity"
              value={config.spot.intensity}
              min={0}
              max={500}
              step={1}
              onChange={(value) => update(['spot', 'intensity'], value)}
            />
            <RangeControl
              label="Angle"
              value={config.spot.angle}
              min={1}
              max={90}
              step={1}
              unit="°"
              onChange={(value) => update(['spot', 'angle'], value)}
            />
            <RangeControl
              label="Penumbra"
              value={config.spot.penumbra}
              min={0}
              max={1}
              step={0.05}
              onChange={(value) => update(['spot', 'penumbra'], value)}
            />
            <RangeControl
              label="Distance"
              value={config.spot.distance}
              min={0}
              max={50}
              step={0.5}
              onChange={(value) => update(['spot', 'distance'], value)}
            />
            <RangeControl
              label="Decay"
              value={config.spot.decay}
              min={0}
              max={4}
              step={0.1}
              onChange={(value) => update(['spot', 'decay'], value)}
            />
            <VectorControls
              label="Position"
              value={config.spot.position}
              onChange={(axis, value) => updateVector(['spot', 'position'], axis, value)}
            />
            <VectorControls
              label="Target"
              value={config.spot.target}
              onChange={(axis, value) => updateVector(['spot', 'target'], axis, value)}
            />
          </ControlSection>

          <ControlSection title="Transmission backdrop">
            <ColorControl
              label="Card color"
              value={config.transmission.cardColor}
              onChange={(value) => update(['transmission', 'cardColor'], value)}
            />
            <RangeControl
              label="Card alpha"
              value={config.transmission.cardAlpha}
              min={0}
              max={1}
              step={0.01}
              onChange={(value) => update(['transmission', 'cardAlpha'], value)}
            />
            <ColorControl
              label="Pack color"
              value={config.transmission.packColor}
              onChange={(value) => update(['transmission', 'packColor'], value)}
            />
            <RangeControl
              label="Pack alpha"
              value={config.transmission.packAlpha}
              min={0}
              max={1}
              step={0.01}
              onChange={(value) => update(['transmission', 'packAlpha'], value)}
            />
          </ControlSection>

          <div className="lighting-lab__actions">
            <div
              className={`lighting-lab__clipboard-feedback${
                clipboardFeedback
                  ? ` lighting-lab__clipboard-feedback--${clipboardFeedback.tone}`
                  : ''
              }`}
              aria-live="polite"
            >
              {clipboardFeedback?.message ?? '\u00a0'}
            </div>
            <div className="lighting-lab__action-buttons">
              <button type="button" onClick={() => void importConfig()} disabled={importing}>
                {importing ? 'Importing…' : 'Import JSON'}
              </button>
              <button type="button" onClick={copyConfig}>
                {copied ? 'Copied' : 'Copy JSON'}
              </button>
              <button
                type="button"
                onClick={() => onPresetChange(DEFAULT_CLEAR_CARD_LIGHTING_PRESET_ID)}
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
