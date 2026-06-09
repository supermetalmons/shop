import { DRIF_EFFECTS, DRIF_EFFECT_KEYS, getDrifCardByFigureId, type DrifCardConfig } from '../drifCards';
import { CARD_NFT_2_PACK_BASE_URL } from '../config/dropMediaDefaults';
import { isDropFamily, normalizeDropId, type FrontendDropConfig } from '../config/deployment';

const INTERACTIVE_CARD_PACK_PUNCH_VARIANT_COUNT = 3;
const INTERACTIVE_CARD_PACK_PUNCH_FRAME_COUNT = 3;
const INTERACTIVE_CARD_PACK_SEGMENT_1_1_FRAME_COUNT = 3;
const INTERACTIVE_CARD_PACK_SEGMENT_1_2_FRAME_COUNT = 3;
const INTERACTIVE_CARD_PACK_SEGMENT_AUTOPLAY_FRAME_COUNT = 10;
const PONCHO_DRIFELLA_PACK_BASE_URL = '/Poncho_Drifella/pack';
const CARD_NFT_2_CARD_FRONT_BASE_URL = 'https://assets.mons.link/drops/cardnft2/img';
const CARD_NFT_2_HOLO_BASE_URL = 'https://assets.mons.link/drops/cardnft2/holo';
const CARD_NFT_2_NEUTRAL_CARD_EFFECT = Object.freeze({
  id: 'card-nft-2-neutral',
  effectKey: DRIF_EFFECT_KEYS.lightingOnly,
  source: 'card_nft_2',
  setId: 'cardnft2',
  number: 'card',
  rarity: 'card',
  supertype: 'card',
  subtypes: 'card',
  trainerGallery: false,
});
const CARD_NFT_2_HOLO_EFFECT_BY_CARD_ID: Readonly<Partial<Record<number, keyof typeof DRIF_EFFECTS>>> = Object.freeze({
  1: 'swshp-SWSH179',
  2: 'swshp-SWSH179',
  3: 'pgo-24',
  4: 'swsh6-196',
  5: 'swsh6-196',
  6: 'swshp-SWSH179',
  7: 'pgo-24',
  8: 'pgo-24',
  9: 'swshp-SWSH179',
  10: 'pgo-24',
  11: 'swshp-SWSH179',
  12: 'pgo-24',
  13: 'swsh4-9',
  14: 'pgo-24',
  15: 'swshp-SWSH179',
  16: 'swshp-SWSH179',
  17: 'swshp-SWSH179',
  18: 'pgo-24',
  19: 'swsh4-9',
  20: 'swsh4-9',
  21: 'swsh4-9',
  22: 'swshp-SWSH179',
  23: 'swsh6-196',
  24: 'swsh4-9',
  25: 'swsh4-9',
  26: 'swsh4-9',
  27: 'swshp-SWSH179',
  28: 'swshp-SWSH179',
  29: 'swshp-SWSH179',
  30: 'pgo-24',
  31: 'pgo-24',
  32: 'swshp-SWSH179',
  33: 'swshp-SWSH179',
  34: 'swsh4-9',
  35: 'swsh6-196',
  36: 'swsh4-9',
  37: 'swsh4-9',
  38: 'swshp-SWSH179',
  39: 'swsh6-196',
  40: 'pgo-24',
  41: 'pgo-24',
  42: 'swshp-SWSH179',
  43: 'swsh6-196',
  44: 'swsh4-9',
  45: 'pgo-24',
  46: 'swsh4-9',
  47: 'swshp-SWSH179',
  48: 'swshp-SWSH179',
  49: 'pgo-24',
  50: 'swsh4-9',
  51: 'swsh6-196',
  52: 'pgo-24',
  53: 'swsh6-196',
  54: 'swsh6-196',
  55: 'swsh4-9',
  56: 'swsh6-196',
  57: 'swsh6-196',
  58: 'swsh6-196',
  59: 'swsh6-196',
  60: 'swsh6-196',
  61: 'swsh6-196',
  62: 'swshp-SWSH179',
  63: 'swsh6-196',
  64: 'pgo-24',
  65: 'pgo-24',
  66: 'swsh6-196',
  67: 'swsh4-9',
  68: 'swshp-SWSH179',
  69: 'swsh6-196',
  70: 'swsh4-9',
  71: 'swsh6-196',
  72: 'swsh4-9',
  73: 'pgo-24',
  74: 'swsh4-9',
  75: 'pgo-24',
  76: 'swshp-SWSH179',
  77: 'swsh4-9',
  78: 'swsh6-196',
  79: 'swsh4-9',
  80: 'pgo-24',
  81: 'swsh6-196',
  82: 'swshp-SWSH179',
  83: 'swsh4-9',
  84: 'swsh6-196',
  85: 'pgo-24',
  86: 'swsh4-9',
  87: 'pgo-24',
  88: 'swshp-SWSH179',
  89: 'swsh6-196',
  90: 'swsh4-9',
  91: 'swsh6-196',
  92: 'swshp-SWSH179',
  93: 'swshp-SWSH179',
  94: 'pgo-24',
  95: 'pgo-24',
  96: 'swsh4-9',
  97: 'pgo-24',
  98: 'swsh6-196',
  99: 'swsh4-9',
  100: 'pgo-24',
});

export type InteractiveCardPackRevealSequence = {
  packBaseUrl: string;
  initialFrameUrl: string;
  punchFrameUrlsByVariant: readonly (readonly string[])[];
  segment11FrameUrls: readonly string[];
  segment12FrameUrls: readonly string[];
  segmentAutoplayFrameUrls: readonly string[];
  segmentAutoplayOvertopFrameUrls: readonly string[];
  initialOvertopFrameUrl: string;
  punchFrameUrls: readonly string[];
  manualSequenceFrameUrls: readonly string[];
  sequenceFrameUrls: readonly string[];
  allPackFrameUrls: readonly string[];
  openingResidentFrameUrls: readonly string[];
  autoplayResidentFrameUrls: readonly string[];
  revealFrameSequence: {
    frames: string[];
    frameCount: number;
    clickMax: number;
    autoplayStart: number;
    mediaStart: number;
  };
};

function buildNumberedFrameUrls(baseUrl: string, frameCount: number) {
  return Array.from({ length: frameCount }, (_, index) => `${baseUrl}/${index + 1}.webp`);
}

function normalizePackBaseUrl(packBaseUrl: string) {
  return String(packBaseUrl || '').trim().replace(/\/+$/, '');
}

function normalizePositiveInteger(value: unknown) {
  const normalized = Math.floor(Number(value));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : undefined;
}

function normalizeInteractiveCardPackRevealIds(revealedIds: readonly unknown[] | undefined) {
  return (revealedIds || [])
    .map((revealedId) => normalizePositiveInteger(revealedId))
    .filter((revealedId): revealedId is number => Boolean(revealedId));
}

export function normalizeInteractiveCardPackMediaId(value: unknown): number | undefined {
  return normalizePositiveInteger(value);
}

export function buildInteractiveCardPackRevealSequence(packBaseUrlRaw: string): InteractiveCardPackRevealSequence {
  const packBaseUrl = normalizePackBaseUrl(packBaseUrlRaw);
  const initialFrameUrl = `${packBaseUrl}/initial.webp`;
  const punchSequenceBaseUrl = `${packBaseUrl}/recoverable_punches`;
  const sequenceBaseUrl = `${packBaseUrl}/final_sequence`;
  const punchFrameUrlsByVariant = Array.from({ length: INTERACTIVE_CARD_PACK_PUNCH_VARIANT_COUNT }, (_, index) =>
    buildNumberedFrameUrls(
      `${punchSequenceBaseUrl}/${index + 1}`,
      INTERACTIVE_CARD_PACK_PUNCH_FRAME_COUNT,
    ),
  );
  const segment11FrameUrls = buildNumberedFrameUrls(
    `${sequenceBaseUrl}/1`,
    INTERACTIVE_CARD_PACK_SEGMENT_1_1_FRAME_COUNT,
  );
  const segment12FrameUrls = buildNumberedFrameUrls(
    `${sequenceBaseUrl}/2`,
    INTERACTIVE_CARD_PACK_SEGMENT_1_2_FRAME_COUNT,
  );
  const segmentAutoplayFrameUrls = buildNumberedFrameUrls(
    `${sequenceBaseUrl}/autoplay`,
    INTERACTIVE_CARD_PACK_SEGMENT_AUTOPLAY_FRAME_COUNT,
  );
  const segmentAutoplayOvertopFrameUrls = buildNumberedFrameUrls(
    `${sequenceBaseUrl}/autoplay/overtop`,
    INTERACTIVE_CARD_PACK_SEGMENT_AUTOPLAY_FRAME_COUNT,
  );
  const initialOvertopFrameUrl = segment12FrameUrls[segment12FrameUrls.length - 1]!;
  const punchFrameUrls = punchFrameUrlsByVariant.flat();
  const manualSequenceFrameUrls = [...segment11FrameUrls, ...segment12FrameUrls];
  const sequenceFrameUrls = [...manualSequenceFrameUrls, ...segmentAutoplayFrameUrls];
  const allPackFrameUrls = [
    initialFrameUrl,
    ...punchFrameUrls,
    ...sequenceFrameUrls,
    ...segmentAutoplayOvertopFrameUrls,
  ];
  const openingResidentFrameUrls = [
    initialFrameUrl,
    ...punchFrameUrls,
    ...manualSequenceFrameUrls,
  ];
  const autoplayResidentFrameUrls = [
    ...segmentAutoplayFrameUrls,
    ...segmentAutoplayOvertopFrameUrls,
  ];
  return Object.freeze({
    packBaseUrl,
    initialFrameUrl,
    punchFrameUrlsByVariant,
    segment11FrameUrls,
    segment12FrameUrls,
    segmentAutoplayFrameUrls,
    segmentAutoplayOvertopFrameUrls,
    initialOvertopFrameUrl,
    punchFrameUrls,
    manualSequenceFrameUrls,
    sequenceFrameUrls,
    allPackFrameUrls,
    openingResidentFrameUrls,
    autoplayResidentFrameUrls,
    revealFrameSequence: {
      frames: [...sequenceFrameUrls],
      frameCount: sequenceFrameUrls.length,
      clickMax: manualSequenceFrameUrls.length,
      autoplayStart: manualSequenceFrameUrls.length + 1,
      mediaStart: sequenceFrameUrls.length,
    },
  });
}

export const PONCHO_DRIFELLA_PACK_REVEAL_SEQUENCE = buildInteractiveCardPackRevealSequence(PONCHO_DRIFELLA_PACK_BASE_URL);

export const INTERACTIVE_CARD_PACK_REVEAL_TIMING = Object.freeze({
  frameCount: PONCHO_DRIFELLA_PACK_REVEAL_SEQUENCE.revealFrameSequence.frameCount,
  clickMax: PONCHO_DRIFELLA_PACK_REVEAL_SEQUENCE.revealFrameSequence.clickMax,
  autoplayStart: PONCHO_DRIFELLA_PACK_REVEAL_SEQUENCE.revealFrameSequence.autoplayStart,
  mediaStart: PONCHO_DRIFELLA_PACK_REVEAL_SEQUENCE.revealFrameSequence.mediaStart,
});

const cardNft2RevealSequenceByDropAndPackMediaId = new Map<string, InteractiveCardPackRevealSequence>();

export function getInteractiveCardPackRevealSequenceForDropId(
  dropId?: string,
  packMediaId?: number,
): InteractiveCardPackRevealSequence {
  if (isDropFamily(dropId, 'card_nft_2')) {
    const normalizedPackMediaId = normalizeInteractiveCardPackMediaId(packMediaId) ?? 1;
    const cacheKey = `${normalizeDropId(dropId || 'card_nft_2')}:${normalizedPackMediaId}`;
    let sequence = cardNft2RevealSequenceByDropAndPackMediaId.get(cacheKey);
    if (!sequence) {
      sequence = buildInteractiveCardPackRevealSequence(`${CARD_NFT_2_PACK_BASE_URL}/${normalizedPackMediaId}`);
      cardNft2RevealSequenceByDropAndPackMediaId.set(cacheKey, sequence);
    }
    return sequence;
  }
  return PONCHO_DRIFELLA_PACK_REVEAL_SEQUENCE;
}

export function selectInteractiveCardPackRevealCardId(
  revealedIds: readonly number[] | undefined,
  random: () => number = Math.random,
): number | undefined {
  const normalizedIds = normalizeInteractiveCardPackRevealIds(revealedIds);
  if (!normalizedIds.length) return undefined;
  const randomValue = random();
  const index = Math.min(
    normalizedIds.length - 1,
    Math.max(0, Math.floor((Number.isFinite(randomValue) ? randomValue : 0) * normalizedIds.length)),
  );
  return normalizedIds[index];
}

export function selectInteractiveCardPackRevealCardIdForDrop(
  dropOrId: FrontendDropConfig | string | undefined,
  revealedIds: readonly number[] | undefined,
  random: () => number = Math.random,
): number | undefined {
  if (usesInteractiveCardPackStackReveal(dropOrId)) return undefined;
  return selectInteractiveCardPackRevealCardId(revealedIds, random);
}

export function getInteractiveCardPackRevealFigureIds(
  dropOrId: FrontendDropConfig | string | undefined,
  revealedIds: readonly number[] | undefined,
  selectedCardId?: number,
): number[] {
  const normalizedIds = normalizeInteractiveCardPackRevealIds(revealedIds);
  if (!normalizedIds.length) return [];
  if (usesInteractiveCardPackStackReveal(dropOrId)) return normalizedIds;
  const normalizedSelectedCardId = normalizePositiveInteger(selectedCardId);
  const revealCardId = normalizedSelectedCardId ?? (normalizedIds.length === 1 ? normalizedIds[0] : undefined);
  return revealCardId ? [revealCardId] : [];
}

const cardNft2CardByFigureId = new Map<number, DrifCardConfig>();

function getCardNft2CardByFigureId(figureId: number): DrifCardConfig | undefined {
  const normalizedFigureId = normalizePositiveInteger(figureId);
  if (!normalizedFigureId) return undefined;
  const cached = cardNft2CardByFigureId.get(normalizedFigureId);
  if (cached) return cached;
  const holoEffectId = CARD_NFT_2_HOLO_EFFECT_BY_CARD_ID[normalizedFigureId];
  const holoEffect = holoEffectId ? DRIF_EFFECTS[holoEffectId] : undefined;
  const imageSrc = `${CARD_NFT_2_CARD_FRONT_BASE_URL}/card_${normalizedFigureId}.webp`;
  const card: DrifCardConfig = holoEffect
    ? {
        imageSrc,
        foilSrc: `${CARD_NFT_2_HOLO_BASE_URL}/foil_${normalizedFigureId}.webp`,
        textureSrc: `${CARD_NFT_2_HOLO_BASE_URL}/mask_${normalizedFigureId}.webp`,
        effect: {
          ...holoEffect,
          number: String(normalizedFigureId),
        },
        glowType: holoEffect.typeClass ?? 'metal',
      }
    : {
        imageSrc,
        effect: {
          ...CARD_NFT_2_NEUTRAL_CARD_EFFECT,
          id: `card-nft-2-${normalizedFigureId}`,
          number: String(normalizedFigureId),
        },
        glowType: 'metal',
      };
  cardNft2CardByFigureId.set(normalizedFigureId, card);
  return card;
}

export function getInteractiveCardPackCardByFigureId(
  dropId: string | undefined,
  figureId: number,
): DrifCardConfig | undefined {
  if (isDropFamily(dropId, 'card_nft_2')) {
    return getCardNft2CardByFigureId(figureId);
  }
  return getDrifCardByFigureId(figureId);
}

export function getInteractiveCardPackCardsByFigureIds(
  dropId: string | undefined,
  figureIds: readonly number[] | undefined,
): DrifCardConfig[] {
  const cards: DrifCardConfig[] = [];
  normalizeInteractiveCardPackRevealIds(figureIds).forEach((normalizedFigureId) => {
    const card = getInteractiveCardPackCardByFigureId(dropId, normalizedFigureId);
    if (card) cards.push(card);
  });
  return cards;
}

export function usesInteractiveCardPackStackReveal(dropOrId?: FrontendDropConfig | string) {
  return isDropFamily(dropOrId, 'card_nft_2');
}
