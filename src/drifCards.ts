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

export const DRIF_EFFECT_KEYS = Object.freeze({
  vRegular: 'v-regular',
  trainerFullArt: 'trainer-full-art',
  amazingRare: 'amazing-rare',
  regularHolo: 'regular-holo',
  lightingOnly: 'lighting-only',
} as const);

export type DrifEffectKey = (typeof DRIF_EFFECT_KEYS)[keyof typeof DRIF_EFFECT_KEYS];

export type EffectConfig = {
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

export type DrifCardEffectAssets = {
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

export const DRIF_CARD_COUNT = 207;
export const DRIF_SHOWCASE_CARD_COUNT = 200;

const PONCHO_DRIFELLA_CDN_BASE_URL = 'https://cdn.lil.org/nft/poncho_drifella';
const PONCHO_DRIFELLA_FRONT_CDN_BASE_URL = `${PONCHO_DRIFELLA_CDN_BASE_URL}/fronts`;
const DEFAULT_DRIF_GLOW_TYPE: GlowType = 'metal';

export const DEFAULT_EFFECT_PREFERENCE_ASSIGNMENTS = Object.freeze({
  'https://cdn.lil.org/nft/poncho_drifella/fronts/1.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/8.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/37.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/2.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/3.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/4.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/5.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/6.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/207.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/7.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/9.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/10.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/11.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/12.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/13.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/14.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/15.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/16.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/17.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/18.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/19.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/20.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/21.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/22.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/23.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/24.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/25.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/26.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/27.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/28.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/29.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/30.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/31.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/32.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/33.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/34.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/35.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/36.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/38.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/39.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/40.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/41.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/42.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/43.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/44.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/45.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/46.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/47.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/48.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/49.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/50.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/51.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/52.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/53.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/54.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/55.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/56.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/57.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/58.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/59.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/60.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/61.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/62.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/63.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/64.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/65.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/66.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/67.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/68.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/69.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/70.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/71.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/72.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/73.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/74.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/75.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/76.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/77.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/78.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/79.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/80.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/81.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/82.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/83.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/84.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/85.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/86.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/87.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/88.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/89.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/90.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/91.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/92.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/93.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/94.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/95.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/96.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/97.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/98.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/99.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/100.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/101.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/102.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/103.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/104.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/105.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/106.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/107.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/108.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/109.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/110.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/111.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/112.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/113.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/114.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/115.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/116.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/117.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/118.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/119.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/120.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/121.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/122.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/123.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/124.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/125.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/126.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/127.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/128.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/129.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/130.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/131.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/132.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/133.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/134.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/135.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/136.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/137.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/138.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/139.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/140.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/141.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/142.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/143.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/144.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/145.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/146.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/147.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/148.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/149.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/150.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/151.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/152.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/153.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/154.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/155.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/156.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/157.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/158.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/159.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/160.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/161.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/162.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/163.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/164.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/165.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/166.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/167.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/168.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/169.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/170.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/171.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/172.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/173.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/174.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/175.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/176.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/177.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/178.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/179.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/180.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/181.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/182.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/183.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/184.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/185.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/186.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/187.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/188.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/189.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/190.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/191.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/192.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/193.webp': 'swsh6-196',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/194.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/195.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/196.webp': 'swshp-SWSH179',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/197.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/198.webp': 'swsh4-9',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/199.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/200.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/201.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/202.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/203.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/204.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/205.webp': 'pgo-24',
  'https://cdn.lil.org/nft/poncho_drifella/fronts/206.webp': 'pgo-24',
} satisfies Record<string, keyof typeof EFFECTS>);

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

function getDrifEffectPreferenceKey(assetId: number): keyof typeof DEFAULT_EFFECT_PREFERENCE_ASSIGNMENTS {
  return getDrifFrontAssetSrc(assetId) as keyof typeof DEFAULT_EFFECT_PREFERENCE_ASSIGNMENTS;
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

export const DRIF_CARDS: DrifCardConfig[] = Array.from({ length: DRIF_CARD_COUNT }, (_, index) => {
  const assetId = getDrifAssetId(index);
  const effectId = DEFAULT_EFFECT_PREFERENCE_ASSIGNMENTS[getDrifEffectPreferenceKey(assetId)];

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
