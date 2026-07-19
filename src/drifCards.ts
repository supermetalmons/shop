import { PONCHO_DRIFELLA_CDN_BASE_URL } from './config/dropMediaDefaults.ts';

type GlowType =
  | 'water'
  | 'fire'
  | 'grass'
  | 'lightning'
  | 'psychic'
  | 'fighting'
  | 'darkness'
  | 'metal'
  | 'dragon'
  | 'fairy';

export const DRIF_EFFECT_KEYS = Object.freeze({
  vRegular: 'v-regular',
  trainerFullArt: 'trainer-full-art',
  amazingRare: 'amazing-rare',
  regularHolo: 'regular-holo',
  lightingOnly: 'lighting-only',
} as const);

type DrifEffectKey = (typeof DRIF_EFFECT_KEYS)[keyof typeof DRIF_EFFECT_KEYS];

type EffectConfig = {
  id: string;
  effectKey: DrifEffectKey;
  source: string;
  setId: string;
  number: string;
  rarity: string;
  supertype: string;
  subtypes: string;
  trainerGallery: boolean;
  typeClass?: GlowType;
};

type DrifCardEffectAssets = {
  foilSrc: string;
  textureSrc: string;
};

type DrifCardWithoutEffectAssets = {
  foilSrc?: undefined;
  textureSrc?: undefined;
};

export type DrifCardConfig = {
  imageSrc: string;
  effect: EffectConfig;
  glowType?: GlowType;
} & (DrifCardEffectAssets | DrifCardWithoutEffectAssets);

const EFFECTS: Record<string, EffectConfig> = {
  'swshp-SWSH179': {
    id: 'swshp-SWSH179',
    effectKey: DRIF_EFFECT_KEYS.vRegular,
    source: 'swsh',
    setId: 'swshp',
    number: 'swsh179',
    rarity: 'rare holo v',
    supertype: 'pokémon',
    subtypes: 'basic v single strike',
    trainerGallery: false,
    typeClass: 'fire',
  },
  'swsh6-196': {
    id: 'swsh6-196',
    effectKey: DRIF_EFFECT_KEYS.trainerFullArt,
    source: 'swsh',
    setId: 'swsh6',
    number: '196',
    rarity: 'rare ultra',
    supertype: 'trainer',
    subtypes: 'supporter',
    trainerGallery: false,
  },
  'swsh4-9': {
    id: 'swsh4-9',
    effectKey: DRIF_EFFECT_KEYS.amazingRare,
    source: 'swsh',
    setId: 'swsh4',
    number: '9',
    rarity: 'amazing rare',
    supertype: 'pokémon',
    subtypes: 'basic',
    trainerGallery: false,
    typeClass: 'grass',
  },
  'pgo-24': {
    id: 'pgo-24',
    effectKey: DRIF_EFFECT_KEYS.regularHolo,
    source: 'swsh',
    setId: 'pgo',
    number: '24',
    rarity: 'rare holo',
    supertype: 'pokémon',
    subtypes: 'basic',
    trainerGallery: false,
    typeClass: 'water',
  },
};

export const DRIF_EFFECTS = EFFECTS;

const DRIF_CARD_COUNT = 207;
const DRIF_SHOWCASE_CARD_COUNT = 200;

const PONCHO_DRIFELLA_FRONT_CDN_BASE_URL = `${PONCHO_DRIFELLA_CDN_BASE_URL}/fronts`;
const DEFAULT_DRIF_GLOW_TYPE: GlowType = 'metal';

const DEFAULT_EFFECT_PREFERENCE_ASSIGNMENTS: Readonly<Record<number, keyof typeof EFFECTS>> = Object.freeze({
  1: 'swshp-SWSH179',
  2: 'swshp-SWSH179',
  3: 'swshp-SWSH179',
  4: 'swshp-SWSH179',
  5: 'swsh4-9',
  6: 'pgo-24',
  7: 'swsh6-196',
  8: 'swshp-SWSH179',
  9: 'pgo-24',
  10: 'swsh4-9',
  11: 'swsh6-196',
  12: 'swshp-SWSH179',
  13: 'pgo-24',
  14: 'swshp-SWSH179',
  15: 'swshp-SWSH179',
  16: 'pgo-24',
  17: 'swshp-SWSH179',
  18: 'swsh6-196',
  19: 'pgo-24',
  20: 'pgo-24',
  21: 'swshp-SWSH179',
  22: 'swsh4-9',
  23: 'swsh4-9',
  24: 'pgo-24',
  25: 'pgo-24',
  26: 'swsh4-9',
  27: 'pgo-24',
  28: 'swsh6-196',
  29: 'swsh4-9',
  30: 'swsh4-9',
  31: 'swshp-SWSH179',
  32: 'swshp-SWSH179',
  33: 'pgo-24',
  34: 'pgo-24',
  35: 'swsh6-196',
  36: 'swshp-SWSH179',
  37: 'swsh6-196',
  38: 'swsh4-9',
  39: 'swshp-SWSH179',
  40: 'pgo-24',
  41: 'swsh4-9',
  42: 'swsh4-9',
  43: 'swsh6-196',
  44: 'swshp-SWSH179',
  45: 'swsh6-196',
  46: 'swshp-SWSH179',
  47: 'swshp-SWSH179',
  48: 'swshp-SWSH179',
  49: 'swsh6-196',
  50: 'swsh4-9',
  51: 'swshp-SWSH179',
  52: 'swsh6-196',
  53: 'swsh4-9',
  54: 'swsh4-9',
  55: 'swshp-SWSH179',
  56: 'swsh4-9',
  57: 'swsh4-9',
  58: 'swshp-SWSH179',
  59: 'swsh4-9',
  60: 'pgo-24',
  61: 'pgo-24',
  62: 'swshp-SWSH179',
  63: 'swsh4-9',
  64: 'swsh4-9',
  65: 'swsh6-196',
  66: 'swsh4-9',
  67: 'swsh4-9',
  68: 'swsh6-196',
  69: 'swshp-SWSH179',
  70: 'swshp-SWSH179',
  71: 'swsh4-9',
  72: 'pgo-24',
  73: 'swshp-SWSH179',
  74: 'swshp-SWSH179',
  75: 'pgo-24',
  76: 'pgo-24',
  77: 'swshp-SWSH179',
  78: 'swshp-SWSH179',
  79: 'swshp-SWSH179',
  80: 'swshp-SWSH179',
  81: 'swsh4-9',
  82: 'swsh6-196',
  83: 'swsh6-196',
  84: 'swsh6-196',
  85: 'swshp-SWSH179',
  86: 'swshp-SWSH179',
  87: 'swshp-SWSH179',
  88: 'pgo-24',
  89: 'pgo-24',
  90: 'swsh6-196',
  91: 'swshp-SWSH179',
  92: 'swshp-SWSH179',
  93: 'swshp-SWSH179',
  94: 'swsh6-196',
  95: 'swshp-SWSH179',
  96: 'swsh4-9',
  97: 'pgo-24',
  98: 'swsh4-9',
  99: 'swsh4-9',
  100: 'swsh6-196',
  101: 'swsh6-196',
  102: 'swshp-SWSH179',
  103: 'swshp-SWSH179',
  104: 'pgo-24',
  105: 'swsh4-9',
  106: 'pgo-24',
  107: 'swsh4-9',
  108: 'swshp-SWSH179',
  109: 'swsh4-9',
  110: 'swshp-SWSH179',
  111: 'swshp-SWSH179',
  112: 'swsh6-196',
  113: 'swshp-SWSH179',
  114: 'swsh6-196',
  115: 'swsh4-9',
  116: 'swshp-SWSH179',
  117: 'pgo-24',
  118: 'swsh6-196',
  119: 'swsh6-196',
  120: 'swshp-SWSH179',
  121: 'swshp-SWSH179',
  122: 'swsh4-9',
  123: 'swsh6-196',
  124: 'swsh6-196',
  125: 'swsh6-196',
  126: 'swshp-SWSH179',
  127: 'pgo-24',
  128: 'swshp-SWSH179',
  129: 'swsh4-9',
  130: 'swshp-SWSH179',
  131: 'swshp-SWSH179',
  132: 'swsh4-9',
  133: 'swsh4-9',
  134: 'swshp-SWSH179',
  135: 'swsh4-9',
  136: 'swshp-SWSH179',
  137: 'swshp-SWSH179',
  138: 'pgo-24',
  139: 'swsh4-9',
  140: 'swsh4-9',
  141: 'swsh4-9',
  142: 'swshp-SWSH179',
  143: 'swshp-SWSH179',
  144: 'swshp-SWSH179',
  145: 'swsh4-9',
  146: 'swshp-SWSH179',
  147: 'swshp-SWSH179',
  148: 'swshp-SWSH179',
  149: 'swsh4-9',
  150: 'pgo-24',
  151: 'swsh4-9',
  152: 'swsh4-9',
  153: 'swsh4-9',
  154: 'swsh4-9',
  155: 'swsh4-9',
  156: 'swsh4-9',
  157: 'swsh4-9',
  158: 'swshp-SWSH179',
  159: 'swshp-SWSH179',
  160: 'swsh6-196',
  161: 'swsh4-9',
  162: 'swshp-SWSH179',
  163: 'swsh4-9',
  164: 'swshp-SWSH179',
  165: 'pgo-24',
  166: 'swsh4-9',
  167: 'swshp-SWSH179',
  168: 'swsh6-196',
  169: 'swsh4-9',
  170: 'swshp-SWSH179',
  171: 'swsh4-9',
  172: 'swshp-SWSH179',
  173: 'swshp-SWSH179',
  174: 'swshp-SWSH179',
  175: 'swsh4-9',
  176: 'swsh6-196',
  177: 'swsh6-196',
  178: 'swsh6-196',
  179: 'swsh6-196',
  180: 'pgo-24',
  181: 'swsh4-9',
  182: 'swshp-SWSH179',
  183: 'swsh4-9',
  184: 'swsh4-9',
  185: 'pgo-24',
  186: 'swshp-SWSH179',
  187: 'swshp-SWSH179',
  188: 'swshp-SWSH179',
  189: 'swshp-SWSH179',
  190: 'swsh4-9',
  191: 'swsh6-196',
  192: 'swsh4-9',
  193: 'swsh6-196',
  194: 'swshp-SWSH179',
  195: 'swshp-SWSH179',
  196: 'swshp-SWSH179',
  197: 'swsh4-9',
  198: 'swsh4-9',
  199: 'pgo-24',
  200: 'pgo-24',
  201: 'pgo-24',
  202: 'pgo-24',
  203: 'pgo-24',
  204: 'pgo-24',
  205: 'pgo-24',
  206: 'pgo-24',
  207: 'swsh6-196',
});

const DRIF_GLOW_TYPES_BY_ASSET_ID: Readonly<Partial<Record<number, GlowType>>> = Object.freeze({
  1: 'metal',
  2: 'dragon',
  3: 'metal',
  4: 'fairy',
  5: 'metal',
  6: 'lightning',
  7: 'water',
  8: 'psychic',
  9: 'dragon',
  10: 'darkness',
  11: 'fairy',
  207: 'fire',
});

function getDrifAssetId(index: number) {
  return index + 1;
}

function getDrifFrontAssetSrc(assetId: number) {
  return `${PONCHO_DRIFELLA_FRONT_CDN_BASE_URL}/${assetId}.webp`;
}

function getDrifAssetSrc(assetType: 'drifs' | 'foils' | 'textures', assetId: number) {
  if (assetType === 'drifs') return getDrifFrontAssetSrc(assetId);
  return `${PONCHO_DRIFELLA_CDN_BASE_URL}/${assetType}/${assetId}.webp`;
}

function normalizeDrifCardAssetSrc(assetSrc: string | undefined) {
  return String(assetSrc || '').trim();
}

export function drifCardIdentityKey(card: DrifCardConfig): string {
  return JSON.stringify([
    card.effect.id,
    normalizeDrifCardAssetSrc(card.imageSrc),
    normalizeDrifCardAssetSrc(card.foilSrc),
    normalizeDrifCardAssetSrc(card.textureSrc),
  ]);
}

export function getDrifCardAssetSources(card: DrifCardConfig | undefined): string[] {
  if (!card) return [];
  return Array.from(
    new Set(
      [card.imageSrc, card.textureSrc, card.foilSrc]
        .map((assetSrc) => normalizeDrifCardAssetSrc(assetSrc))
        .filter((assetSrc) => assetSrc.length > 0),
    ),
  );
}

const DRIF_CARDS: DrifCardConfig[] = Array.from({ length: DRIF_CARD_COUNT }, (_, index) => {
  const assetId = getDrifAssetId(index);
  const effectId = DEFAULT_EFFECT_PREFERENCE_ASSIGNMENTS[assetId];

  if (!effectId) {
    throw new Error(`Missing default effect preference assignment for drif asset ${assetId}`);
  }

  return {
    imageSrc: getDrifAssetSrc('drifs', assetId),
    foilSrc: getDrifAssetSrc('foils', assetId),
    textureSrc: getDrifAssetSrc('textures', assetId),
    effect: EFFECTS[effectId],
    glowType: DRIF_GLOW_TYPES_BY_ASSET_ID[assetId] ?? DEFAULT_DRIF_GLOW_TYPE,
  };
});

export const DRIF_SHOWCASE_CARDS: DrifCardConfig[] = DRIF_CARDS.slice(0, DRIF_SHOWCASE_CARD_COUNT);

export function getDrifCardByFigureId(figureId: number): DrifCardConfig | undefined {
  const normalizedFigureId = Math.floor(Number(figureId));
  if (!Number.isFinite(normalizedFigureId) || normalizedFigureId < 1 || normalizedFigureId > DRIF_CARDS.length) {
    return undefined;
  }
  return DRIF_CARDS[normalizedFigureId - 1];
}
