export type MiNoteStickerEffectSettings = {
  mode: 'prism';
  width: number;
  outerness: number;
  softness: number;
  strength: number;
  scale: number;
  hue: number;
  variation: number;
  motion: number;
  shine: number;
};

export const MI_NOTE_STICKER_EFFECTS_STORAGE_KEY = 'mi-note-sticker-effects:prism-v1';

export const DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS: Readonly<MiNoteStickerEffectSettings> = {
  mode: 'prism',
  width: 0.055,
  outerness: 0.7,
  softness: 0.55,
  strength: 0.57,
  scale: 0.95,
  hue: 0,
  variation: 0.47,
  motion: 1.05,
  shine: 0,
};

export const MI_NOTE_STICKER_EFFECT_CONTROLS = [
  { key: 'width', label: 'Band width', min: 0.01, max: 0.055, step: 0.0025 },
  { key: 'outerness', label: 'Outerness', min: 0, max: 1, step: 0.01 },
  { key: 'softness', label: 'Blend', min: 0.2, max: 1, step: 0.01 },
  { key: 'strength', label: 'Strength', min: 0, max: 1, step: 0.01 },
  { key: 'scale', label: 'Scale', min: 0.5, max: 3, step: 0.05 },
  { key: 'hue', label: 'Hue', min: 0, max: 1, step: 0.01 },
  { key: 'variation', label: 'Variation', min: 0, max: 1, step: 0.01 },
  { key: 'motion', label: 'Motion', min: 0, max: 2, step: 0.05 },
  { key: 'shine', label: 'Shine', min: 0, max: 1, step: 0.01 },
] as const satisfies readonly {
  key: Exclude<keyof MiNoteStickerEffectSettings, 'mode'>;
  label: string;
  min: number;
  max: number;
  step: number;
}[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeMiNoteStickerEffectSettings(input: unknown): MiNoteStickerEffectSettings {
  const settings = { ...DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS };
  if (!isRecord(input)) return settings;
  for (const { key, min, max } of MI_NOTE_STICKER_EFFECT_CONTROLS) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value)) settings[key] = Math.min(max, Math.max(min, value));
  }
  return settings;
}

export function serializeMiNoteStickerEffect(settings: MiNoteStickerEffectSettings): string {
  return JSON.stringify({ version: 2, effect: normalizeMiNoteStickerEffectSettings(settings) }, null, 2);
}

export function parseMiNoteStickerEffect(json: string): MiNoteStickerEffectSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Enter valid sticker effect JSON.');
  }
  if (!isRecord(parsed)) throw new Error('Sticker effect JSON must be an object with version and effect fields.');
  if (parsed.version !== 1 && parsed.version !== 2) throw new Error('Sticker effect JSON must use version 1 or 2.');
  if (!isRecord(parsed.effect)) throw new Error('Sticker effect JSON must include an effect object.');
  if (parsed.effect.mode !== 'prism') throw new Error('Sticker effect JSON must use the prism mode.');
  for (const { key, label } of MI_NOTE_STICKER_EFFECT_CONTROLS) {
    if (!Object.hasOwn(parsed.effect, key)) continue;
    const value = parsed.effect[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  }
  const effect = parsed.effect;
  return normalizeMiNoteStickerEffectSettings(parsed.version === 1 && typeof effect.width === 'number'
    ? { ...effect, width: effect.width * 0.5 }
    : effect);
}
