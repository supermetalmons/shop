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

export const DRIF_CARD_COUNT = 207;
export const DRIF_SHOWCASE_CARD_COUNT = 12;

const DEFAULT_DRIF_GLOW_TYPE: GlowType = 'metal';

export const DEFAULT_EFFECT_PREFERENCE_ASSIGNMENTS = Object.freeze({
  '/assets/drifs/1.webp': 'swshp-SWSH179',
  '/assets/drifs/8.webp': 'swshp-SWSH179',
  '/assets/drifs/37.webp': 'swsh6-196',
  '/assets/drifs/2.webp': 'swshp-SWSH179',
  '/assets/drifs/3.webp': 'swshp-SWSH179',
  '/assets/drifs/4.webp': 'swshp-SWSH179',
  '/assets/drifs/5.webp': 'swsh4-9',
  '/assets/drifs/6.webp': 'pgo-24',
  '/assets/drifs/207.webp': 'swsh6-196',
  '/assets/drifs/7.webp': 'swsh6-196',
  '/assets/drifs/9.webp': 'pgo-24',
  '/assets/drifs/10.webp': 'swsh4-9',
  '/assets/drifs/11.webp': 'swsh6-196',
  '/assets/drifs/12.webp': 'swshp-SWSH179',
  '/assets/drifs/13.webp': 'pgo-24',
  '/assets/drifs/14.webp': 'swshp-SWSH179',
  '/assets/drifs/15.webp': 'swshp-SWSH179',
  '/assets/drifs/16.webp': 'pgo-24',
  '/assets/drifs/17.webp': 'swshp-SWSH179',
  '/assets/drifs/18.webp': 'swsh6-196',
  '/assets/drifs/19.webp': 'pgo-24',
  '/assets/drifs/20.webp': 'pgo-24',
  '/assets/drifs/21.webp': 'swshp-SWSH179',
  '/assets/drifs/22.webp': 'swsh4-9',
  '/assets/drifs/23.webp': 'swsh4-9',
  '/assets/drifs/24.webp': 'pgo-24',
  '/assets/drifs/25.webp': 'pgo-24',
  '/assets/drifs/26.webp': 'swsh4-9',
  '/assets/drifs/27.webp': 'pgo-24',
  '/assets/drifs/28.webp': 'swsh6-196',
  '/assets/drifs/29.webp': 'swsh4-9',
  '/assets/drifs/30.webp': 'swsh4-9',
  '/assets/drifs/31.webp': 'swshp-SWSH179',
  '/assets/drifs/32.webp': 'swshp-SWSH179',
  '/assets/drifs/33.webp': 'pgo-24',
  '/assets/drifs/34.webp': 'pgo-24',
  '/assets/drifs/35.webp': 'swsh6-196',
  '/assets/drifs/36.webp': 'swshp-SWSH179',
  '/assets/drifs/38.webp': 'swsh4-9',
  '/assets/drifs/39.webp': 'swshp-SWSH179',
  '/assets/drifs/40.webp': 'pgo-24',
  '/assets/drifs/41.webp': 'swsh4-9',
  '/assets/drifs/42.webp': 'swsh4-9',
  '/assets/drifs/43.webp': 'swsh6-196',
  '/assets/drifs/44.webp': 'swshp-SWSH179',
  '/assets/drifs/45.webp': 'swsh6-196',
  '/assets/drifs/46.webp': 'swshp-SWSH179',
  '/assets/drifs/47.webp': 'swshp-SWSH179',
  '/assets/drifs/48.webp': 'swshp-SWSH179',
  '/assets/drifs/49.webp': 'swsh6-196',
  '/assets/drifs/50.webp': 'swsh4-9',
  '/assets/drifs/51.webp': 'swshp-SWSH179',
  '/assets/drifs/52.webp': 'swsh6-196',
  '/assets/drifs/53.webp': 'swsh4-9',
  '/assets/drifs/54.webp': 'swsh4-9',
  '/assets/drifs/55.webp': 'swshp-SWSH179',
  '/assets/drifs/56.webp': 'swsh4-9',
  '/assets/drifs/57.webp': 'swsh4-9',
  '/assets/drifs/58.webp': 'swshp-SWSH179',
  '/assets/drifs/59.webp': 'swsh4-9',
  '/assets/drifs/60.webp': 'pgo-24',
  '/assets/drifs/61.webp': 'pgo-24',
  '/assets/drifs/62.webp': 'swshp-SWSH179',
  '/assets/drifs/63.webp': 'swsh4-9',
  '/assets/drifs/64.webp': 'swsh4-9',
  '/assets/drifs/65.webp': 'swsh6-196',
  '/assets/drifs/66.webp': 'swsh4-9',
  '/assets/drifs/67.webp': 'swsh4-9',
  '/assets/drifs/68.webp': 'swsh6-196',
  '/assets/drifs/69.webp': 'swshp-SWSH179',
  '/assets/drifs/70.webp': 'swshp-SWSH179',
  '/assets/drifs/71.webp': 'swsh4-9',
  '/assets/drifs/72.webp': 'pgo-24',
  '/assets/drifs/73.webp': 'swshp-SWSH179',
  '/assets/drifs/74.webp': 'swshp-SWSH179',
  '/assets/drifs/75.webp': 'pgo-24',
  '/assets/drifs/76.webp': 'pgo-24',
  '/assets/drifs/77.webp': 'swshp-SWSH179',
  '/assets/drifs/78.webp': 'swshp-SWSH179',
  '/assets/drifs/79.webp': 'swshp-SWSH179',
  '/assets/drifs/80.webp': 'swshp-SWSH179',
  '/assets/drifs/81.webp': 'swsh4-9',
  '/assets/drifs/82.webp': 'swsh6-196',
  '/assets/drifs/83.webp': 'swsh6-196',
  '/assets/drifs/84.webp': 'swsh6-196',
  '/assets/drifs/85.webp': 'swshp-SWSH179',
  '/assets/drifs/86.webp': 'swshp-SWSH179',
  '/assets/drifs/87.webp': 'swshp-SWSH179',
  '/assets/drifs/88.webp': 'pgo-24',
  '/assets/drifs/89.webp': 'pgo-24',
  '/assets/drifs/90.webp': 'swsh6-196',
  '/assets/drifs/91.webp': 'swshp-SWSH179',
  '/assets/drifs/92.webp': 'swshp-SWSH179',
  '/assets/drifs/93.webp': 'swshp-SWSH179',
  '/assets/drifs/94.webp': 'swsh6-196',
  '/assets/drifs/95.webp': 'swshp-SWSH179',
  '/assets/drifs/96.webp': 'swsh4-9',
  '/assets/drifs/97.webp': 'pgo-24',
  '/assets/drifs/98.webp': 'swsh4-9',
  '/assets/drifs/99.webp': 'swsh4-9',
  '/assets/drifs/100.webp': 'swsh6-196',
  '/assets/drifs/101.webp': 'swsh6-196',
  '/assets/drifs/102.webp': 'swshp-SWSH179',
  '/assets/drifs/103.webp': 'swshp-SWSH179',
  '/assets/drifs/104.webp': 'pgo-24',
  '/assets/drifs/105.webp': 'swsh4-9',
  '/assets/drifs/106.webp': 'pgo-24',
  '/assets/drifs/107.webp': 'swsh4-9',
  '/assets/drifs/108.webp': 'swshp-SWSH179',
  '/assets/drifs/109.webp': 'swsh4-9',
  '/assets/drifs/110.webp': 'swshp-SWSH179',
  '/assets/drifs/111.webp': 'swshp-SWSH179',
  '/assets/drifs/112.webp': 'swsh6-196',
  '/assets/drifs/113.webp': 'swshp-SWSH179',
  '/assets/drifs/114.webp': 'swsh6-196',
  '/assets/drifs/115.webp': 'swsh4-9',
  '/assets/drifs/116.webp': 'swshp-SWSH179',
  '/assets/drifs/117.webp': 'pgo-24',
  '/assets/drifs/118.webp': 'swsh6-196',
  '/assets/drifs/119.webp': 'swsh6-196',
  '/assets/drifs/120.webp': 'swshp-SWSH179',
  '/assets/drifs/121.webp': 'swshp-SWSH179',
  '/assets/drifs/122.webp': 'swsh4-9',
  '/assets/drifs/123.webp': 'swsh6-196',
  '/assets/drifs/124.webp': 'swsh6-196',
  '/assets/drifs/125.webp': 'swsh6-196',
  '/assets/drifs/126.webp': 'swshp-SWSH179',
  '/assets/drifs/127.webp': 'pgo-24',
  '/assets/drifs/128.webp': 'swshp-SWSH179',
  '/assets/drifs/129.webp': 'swsh4-9',
  '/assets/drifs/130.webp': 'swshp-SWSH179',
  '/assets/drifs/131.webp': 'swshp-SWSH179',
  '/assets/drifs/132.webp': 'swsh4-9',
  '/assets/drifs/133.webp': 'swsh4-9',
  '/assets/drifs/134.webp': 'swshp-SWSH179',
  '/assets/drifs/135.webp': 'swsh4-9',
  '/assets/drifs/136.webp': 'swshp-SWSH179',
  '/assets/drifs/137.webp': 'swshp-SWSH179',
  '/assets/drifs/138.webp': 'pgo-24',
  '/assets/drifs/139.webp': 'swsh4-9',
  '/assets/drifs/140.webp': 'swsh4-9',
  '/assets/drifs/141.webp': 'swsh4-9',
  '/assets/drifs/142.webp': 'swshp-SWSH179',
  '/assets/drifs/143.webp': 'swshp-SWSH179',
  '/assets/drifs/144.webp': 'swshp-SWSH179',
  '/assets/drifs/145.webp': 'swsh4-9',
  '/assets/drifs/146.webp': 'swshp-SWSH179',
  '/assets/drifs/147.webp': 'swshp-SWSH179',
  '/assets/drifs/148.webp': 'swshp-SWSH179',
  '/assets/drifs/149.webp': 'swsh4-9',
  '/assets/drifs/150.webp': 'pgo-24',
  '/assets/drifs/151.webp': 'swsh4-9',
  '/assets/drifs/152.webp': 'swsh4-9',
  '/assets/drifs/153.webp': 'swsh4-9',
  '/assets/drifs/154.webp': 'swsh4-9',
  '/assets/drifs/155.webp': 'swsh4-9',
  '/assets/drifs/156.webp': 'swsh4-9',
  '/assets/drifs/157.webp': 'swsh4-9',
  '/assets/drifs/158.webp': 'swshp-SWSH179',
  '/assets/drifs/159.webp': 'swshp-SWSH179',
  '/assets/drifs/160.webp': 'swsh6-196',
  '/assets/drifs/161.webp': 'swsh4-9',
  '/assets/drifs/162.webp': 'swshp-SWSH179',
  '/assets/drifs/163.webp': 'swsh4-9',
  '/assets/drifs/164.webp': 'swshp-SWSH179',
  '/assets/drifs/165.webp': 'pgo-24',
  '/assets/drifs/166.webp': 'swsh4-9',
  '/assets/drifs/167.webp': 'swshp-SWSH179',
  '/assets/drifs/168.webp': 'swsh6-196',
  '/assets/drifs/169.webp': 'swsh4-9',
  '/assets/drifs/170.webp': 'swshp-SWSH179',
  '/assets/drifs/171.webp': 'swsh4-9',
  '/assets/drifs/172.webp': 'swshp-SWSH179',
  '/assets/drifs/173.webp': 'swshp-SWSH179',
  '/assets/drifs/174.webp': 'swshp-SWSH179',
  '/assets/drifs/175.webp': 'swsh4-9',
  '/assets/drifs/176.webp': 'swsh6-196',
  '/assets/drifs/177.webp': 'swsh6-196',
  '/assets/drifs/178.webp': 'swsh6-196',
  '/assets/drifs/179.webp': 'swsh6-196',
  '/assets/drifs/180.webp': 'pgo-24',
  '/assets/drifs/181.webp': 'swsh4-9',
  '/assets/drifs/182.webp': 'swshp-SWSH179',
  '/assets/drifs/183.webp': 'swsh4-9',
  '/assets/drifs/184.webp': 'swsh4-9',
  '/assets/drifs/185.webp': 'pgo-24',
  '/assets/drifs/186.webp': 'swshp-SWSH179',
  '/assets/drifs/187.webp': 'swshp-SWSH179',
  '/assets/drifs/188.webp': 'swshp-SWSH179',
  '/assets/drifs/189.webp': 'swshp-SWSH179',
  '/assets/drifs/190.webp': 'swsh4-9',
  '/assets/drifs/191.webp': 'swsh6-196',
  '/assets/drifs/192.webp': 'swsh4-9',
  '/assets/drifs/193.webp': 'swsh6-196',
  '/assets/drifs/194.webp': 'swshp-SWSH179',
  '/assets/drifs/195.webp': 'swshp-SWSH179',
  '/assets/drifs/196.webp': 'swshp-SWSH179',
  '/assets/drifs/197.webp': 'swsh4-9',
  '/assets/drifs/198.webp': 'swsh4-9',
  '/assets/drifs/199.webp': 'pgo-24',
  '/assets/drifs/200.webp': 'pgo-24',
  '/assets/drifs/201.webp': 'pgo-24',
  '/assets/drifs/202.webp': 'pgo-24',
  '/assets/drifs/203.webp': 'pgo-24',
  '/assets/drifs/204.webp': 'pgo-24',
  '/assets/drifs/205.webp': 'pgo-24',
  '/assets/drifs/206.webp': 'pgo-24',
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
  return `/assets/drifs/${assetId}.webp` as keyof typeof DEFAULT_EFFECT_PREFERENCE_ASSIGNMENTS;
}

function getDrifAssetSrc(assetType: 'drifs' | 'foils' | 'textures', assetId: number) {
  return `/Poncho_Drifella/${assetType}/${assetId}.webp`;
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
