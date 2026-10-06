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

export const DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS: Readonly<MiNoteStickerEffectSettings> = {
  mode: 'prism',
  width: 0.055,
  outerness: 0.13,
  softness: 1,
  strength: 0.66,
  scale: 1.5,
  hue: 0,
  variation: 0,
  motion: 0.9,
  shine: 0,
};

const EFFECT_RANGES = [
  { key: 'width', min: 0.01, max: 0.055 },
  { key: 'outerness', min: 0, max: 1 },
  { key: 'softness', min: 0.2, max: 1 },
  { key: 'strength', min: 0, max: 1 },
  { key: 'scale', min: 0.5, max: 3 },
  { key: 'hue', min: 0, max: 1 },
  { key: 'variation', min: 0, max: 1 },
  { key: 'motion', min: 0, max: 2 },
  { key: 'shine', min: 0, max: 1 },
] as const satisfies readonly {
  key: Exclude<keyof MiNoteStickerEffectSettings, 'mode'>;
  min: number;
  max: number;
}[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeMiNoteStickerEffectSettings(input: unknown): MiNoteStickerEffectSettings {
  const settings = { ...DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS };
  if (!isRecord(input)) return settings;
  for (const { key, min, max } of EFFECT_RANGES) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value)) settings[key] = Math.min(max, Math.max(min, value));
  }
  return settings;
}
