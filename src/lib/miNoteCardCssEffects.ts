import type { CSSProperties } from 'react';

export const MI_NOTE_CARD_CSS_BLEND_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge',
  'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue',
  'saturation', 'color', 'luminosity',
] as const;

type MiNoteCssBlendMode = typeof MI_NOTE_CARD_CSS_BLEND_MODES[number];
type MiNoteCssColor = { h: number; s: number; l: number };
type MiNoteCssGlareStop = { color: MiNoteCssColor; alpha: number; position: number };
type MiNoteCssLayer = {
  strength: number;
  brightness: number;
  contrast: number;
  saturation: number;
  blendMode: MiNoteCssBlendMode;
};

export type MiNoteCardCssEffectSettings = {
  glare: MiNoteCssLayer & {
    size: number;
    offsetX: number;
    offsetY: number;
    stops: [MiNoteCssGlareStop, MiNoteCssGlareStop, MiNoteCssGlareStop];
  };
  shine: MiNoteCssLayer;
  secondary: MiNoteCssLayer;
  pattern: {
    grainEnabled: boolean;
    grainSize: number;
    rainbowSpacing: number;
    stripeAngle: number;
    rainbowColors: [MiNoteCssColor, MiNoteCssColor, MiNoteCssColor, MiNoteCssColor, MiNoteCssColor, MiNoteCssColor];
    blendModes: [MiNoteCssBlendMode, MiNoteCssBlendMode, MiNoteCssBlendMode];
  };
};

export const DEFAULT_MI_NOTE_CARD_CSS_EFFECT_SETTINGS: MiNoteCardCssEffectSettings = {
  glare: {
    strength: 0.5,
    brightness: 0.9,
    contrast: 1.75,
    saturation: 1,
    size: 1,
    offsetX: 0,
    offsetY: 0,
    blendMode: 'hard-light',
    stops: [
      { color: { h: 0, s: 0, l: 100 }, alpha: 1, position: 0 },
      { color: { h: 210, s: 3, l: 54 }, alpha: 0.33, position: 45 },
      { color: { h: 0, s: 0, l: 20 }, alpha: 0.9, position: 130 },
    ],
  },
  shine: { strength: 1, brightness: 0.8, contrast: 2.95, saturation: 0.65, blendMode: 'color-dodge' },
  secondary: { strength: 0.99, brightness: 1, contrast: 2.5, saturation: 1.75, blendMode: 'soft-light' },
  pattern: {
    grainEnabled: true,
    grainSize: 500,
    rainbowSpacing: 5,
    stripeAngle: 133,
    rainbowColors: [
      { h: 2, s: 100, l: 73 },
      { h: 53, s: 100, l: 69 },
      { h: 93, s: 100, l: 69 },
      { h: 176, s: 100, l: 76 },
      { h: 228, s: 100, l: 74 },
      { h: 283, s: 100, l: 73 },
    ],
    blendModes: ['screen', 'hue', 'hard-light'],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function blendMode(value: unknown, fallback: MiNoteCssBlendMode): MiNoteCssBlendMode {
  return MI_NOTE_CARD_CSS_BLEND_MODES.includes(value as MiNoteCssBlendMode) ? value as MiNoteCssBlendMode : fallback;
}

function normalizeColor(input: unknown, fallback: MiNoteCssColor): MiNoteCssColor {
  const value = record(input);
  return {
    h: bounded(value.h, fallback.h, 0, 360),
    s: bounded(value.s, fallback.s, 0, 100),
    l: bounded(value.l, fallback.l, 0, 100),
  };
}

function normalizeLayer(input: unknown, fallback: MiNoteCssLayer): MiNoteCssLayer {
  const value = record(input);
  return {
    strength: bounded(value.strength, fallback.strength, 0, 1),
    brightness: bounded(value.brightness, fallback.brightness, 0, 3),
    contrast: bounded(value.contrast, fallback.contrast, 0, 5),
    saturation: bounded(value.saturation, fallback.saturation, 0, 3),
    blendMode: blendMode(value.blendMode, fallback.blendMode),
  };
}

export function normalizeMiNoteCardCssEffectSettings(input: unknown): MiNoteCardCssEffectSettings {
  const settings = record(input);
  const glare = record(settings.glare);
  const pattern = record(settings.pattern);
  const defaults = DEFAULT_MI_NOTE_CARD_CSS_EFFECT_SETTINGS;
  const stops = Array.isArray(glare.stops) ? glare.stops : [];
  const colors = Array.isArray(pattern.rainbowColors) ? pattern.rainbowColors : [];
  const modes = Array.isArray(pattern.blendModes) ? pattern.blendModes : [];
  let previousPosition = 0;
  return {
    glare: {
      ...normalizeLayer(glare, defaults.glare),
      size: bounded(glare.size, defaults.glare.size, 0.25, 3),
      offsetX: bounded(glare.offsetX, defaults.glare.offsetX, -100, 100),
      offsetY: bounded(glare.offsetY, defaults.glare.offsetY, -100, 100),
      stops: defaults.glare.stops.map((fallback, index) => {
        const stop = record(stops[index]);
        const position = Math.max(previousPosition, bounded(stop.position, fallback.position, 0, 200));
        previousPosition = position;
        return {
          color: normalizeColor(stop.color, fallback.color),
          alpha: bounded(stop.alpha, fallback.alpha, 0, 1),
          position,
        };
      }) as MiNoteCardCssEffectSettings['glare']['stops'],
    },
    shine: normalizeLayer(settings.shine, defaults.shine),
    secondary: normalizeLayer(settings.secondary, defaults.secondary),
    pattern: {
      grainEnabled: typeof pattern.grainEnabled === 'boolean' ? pattern.grainEnabled : defaults.pattern.grainEnabled,
      grainSize: bounded(pattern.grainSize, defaults.pattern.grainSize, 100, 1000),
      rainbowSpacing: bounded(pattern.rainbowSpacing, defaults.pattern.rainbowSpacing, 1, 15),
      stripeAngle: bounded(pattern.stripeAngle, defaults.pattern.stripeAngle, 0, 360),
      rainbowColors: defaults.pattern.rainbowColors.map((fallback, index) => normalizeColor(colors[index], fallback)) as MiNoteCardCssEffectSettings['pattern']['rainbowColors'],
      blendModes: defaults.pattern.blendModes.map((fallback, index) => blendMode(modes[index], fallback)) as MiNoteCardCssEffectSettings['pattern']['blendModes'],
    },
  };
}

export function miNoteCardCssEffectStyle(settings: MiNoteCardCssEffectSettings): CSSProperties {
  const { glare, shine, secondary, pattern } = normalizeMiNoteCardCssEffectSettings(settings);
  const style: Record<string, string | number> = {
    '--mi-note-css-glare-size': glare.size,
    '--mi-note-css-glare-offset-x': `${glare.offsetX}%`,
    '--mi-note-css-glare-offset-y': `${glare.offsetY}%`,
    ...(!pattern.grainEnabled ? { '--mi-note-css-grain': 'none' } : {}),
    '--mi-note-css-grain-size': `${pattern.grainSize}px`,
    '--mi-note-css-rainbow-spacing': `${pattern.rainbowSpacing}%`,
    '--mi-note-css-stripe-angle': `${pattern.stripeAngle}deg`,
  };
  for (const [name, layer] of Object.entries({ glare, shine, secondary })) {
    style[`--mi-note-css-${name}-strength`] = layer.strength;
    style[`--mi-note-css-${name}-brightness`] = layer.brightness;
    style[`--mi-note-css-${name}-contrast`] = layer.contrast;
    style[`--mi-note-css-${name}-saturation`] = layer.saturation;
    style[`--mi-note-css-${name}-blend-mode`] = layer.blendMode;
  }
  glare.stops.forEach(({ color, alpha, position }, index) => {
    style[`--mi-note-css-glare-color-${index + 1}`] = `hsla(${color.h}, ${color.s}%, ${color.l}%, ${alpha})`;
    style[`--mi-note-css-glare-stop-${index + 1}`] = `${position}%`;
  });
  pattern.rainbowColors.forEach((color, index) => {
    style[`--mi-note-css-rainbow-${index + 1}`] = `hsl(${color.h}, ${color.s}%, ${color.l}%)`;
  });
  pattern.blendModes.forEach((mode, index) => { style[`--mi-note-css-pattern-blend-${index + 1}`] = mode; });
  return style as CSSProperties;
}

export function serializeMiNoteCardCssEffectSettings(settings: MiNoteCardCssEffectSettings): string {
  return JSON.stringify({
    version: 1,
    effect: 'MI_NOTE_CARDS_DEFAULT',
    renderer: 'css',
    settings: normalizeMiNoteCardCssEffectSettings(settings),
  }, null, 2);
}

export function parseMiNoteCardCssEffectSettingsJson(source: string): MiNoteCardCssEffectSettings | null {
  try {
    const value: unknown = JSON.parse(source);
    if (!isRecord(value) || value.version !== 1 || value.effect !== 'MI_NOTE_CARDS_DEFAULT' || value.renderer !== 'css' || !isRecord(value.settings)) return null;
    return normalizeMiNoteCardCssEffectSettings(value.settings);
  } catch {
    return null;
  }
}
