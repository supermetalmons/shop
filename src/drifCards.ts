export type GlowType =
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

export type EffectConfig = {
  id: string;
  effectKey: string;
  source: string;
  setId: string;
  number: string;
  rarity: string;
  supertype: string;
  subtypes: string;
  trainerGallery: boolean;
  typeClass?: GlowType;
};

export type DrifCardConfig = {
  imageSrc: string;
  foilSrc: string;
  textureSrc: string;
  effect: EffectConfig;
  glowType?: GlowType;
};

const EFFECTS: Record<string, EffectConfig> = {
  'swshp-SWSH179': {
    id: 'swshp-SWSH179',
    effectKey: 'v-regular',
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
    effectKey: 'trainer-full-art',
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
    effectKey: 'amazing-rare',
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
    effectKey: 'regular-holo',
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

const DRIF_EFFECT_IDS = [
  'swsh6-196',
  'swshp-SWSH179',
  'swshp-SWSH179',
  'swshp-SWSH179',
  'swshp-SWSH179',
  'swsh4-9',
  'pgo-24',
  'swsh6-196',
  'swshp-SWSH179',
  'pgo-24',
  'swsh4-9',
  'swsh6-196',
] as const;

const DRIF_GLOW_TYPES = [
  'fire',
  'metal',
  'dragon',
  'metal',
  'fairy',
  'metal',
  'lightning',
  'water',
  'psychic',
  'dragon',
  'darkness',
  'fairy',
] as const;

export const DRIF_CARDS: DrifCardConfig[] = DRIF_EFFECT_IDS.map((effectId, index) => ({
  imageSrc: `/Poncho_Drifella/drifs/${index}.webp`,
  foilSrc: `/Poncho_Drifella/foils/${index}.webp`,
  textureSrc: `/Poncho_Drifella/textures/${index}.webp`,
  effect: EFFECTS[effectId],
  glowType: DRIF_GLOW_TYPES[index],
}));
