import { getDrifCardByFigureId, type DrifCardConfig } from '../drifCards';
import { CARD_NFT_2_PACK_BASE_URL } from '../config/dropMediaDefaults';
import { isDropFamily, normalizeDropId } from '../config/deployment';

const INTERACTIVE_CARD_PACK_PUNCH_VARIANT_COUNT = 3;
const INTERACTIVE_CARD_PACK_PUNCH_FRAME_COUNT = 3;
const INTERACTIVE_CARD_PACK_SEGMENT_1_1_FRAME_COUNT = 3;
const INTERACTIVE_CARD_PACK_SEGMENT_1_2_FRAME_COUNT = 3;
const INTERACTIVE_CARD_PACK_SEGMENT_AUTOPLAY_FRAME_COUNT = 10;
const PONCHO_DRIFELLA_PACK_BASE_URL = '/Poncho_Drifella/pack';
const CARD_NFT_2_CARD_FRONT_BASE_URL = 'https://assets.mons.link/drops/cardnft2/img';
const CARD_NFT_2_NEUTRAL_CARD_EFFECT_ASSET_URL = '/card_nft_2/back.webp';
const CARD_NFT_2_NEUTRAL_CARD_EFFECT = Object.freeze({
  id: 'card-nft-2-neutral',
  effectKey: 'regular-holo',
  source: 'card_nft_2',
  setId: 'cardnft2',
  number: 'card',
  rarity: 'rare holo',
  supertype: 'card',
  subtypes: 'card',
  trainerGallery: false,
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
  const normalizedIds = (revealedIds || [])
    .map((revealedId) => normalizePositiveInteger(revealedId))
    .filter((revealedId): revealedId is number => Boolean(revealedId));
  if (!normalizedIds.length) return undefined;
  const randomValue = random();
  const index = Math.min(
    normalizedIds.length - 1,
    Math.max(0, Math.floor((Number.isFinite(randomValue) ? randomValue : 0) * normalizedIds.length)),
  );
  return normalizedIds[index];
}

const cardNft2CardByFigureId = new Map<number, DrifCardConfig>();

function getCardNft2CardByFigureId(figureId: number): DrifCardConfig | undefined {
  const normalizedFigureId = normalizePositiveInteger(figureId);
  if (!normalizedFigureId) return undefined;
  const cached = cardNft2CardByFigureId.get(normalizedFigureId);
  if (cached) return cached;
  const card: DrifCardConfig = {
    imageSrc: `${CARD_NFT_2_CARD_FRONT_BASE_URL}/card_${normalizedFigureId}.webp`,
    foilSrc: CARD_NFT_2_NEUTRAL_CARD_EFFECT_ASSET_URL,
    textureSrc: CARD_NFT_2_NEUTRAL_CARD_EFFECT_ASSET_URL,
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
