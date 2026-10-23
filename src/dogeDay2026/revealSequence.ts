import { DOGE_DAY_2026_STARTER_PACK_BASE_URL } from './starterConfig';

const INTERACTIVE_CARD_PACK_PUNCH_VARIANT_COUNT = 3;
const INTERACTIVE_CARD_PACK_PUNCH_FRAME_COUNT = 3;
const INTERACTIVE_CARD_PACK_SEGMENT_1_1_FRAME_COUNT = 3;
const INTERACTIVE_CARD_PACK_SEGMENT_1_2_FRAME_COUNT = 3;
const INTERACTIVE_CARD_PACK_SEGMENT_AUTOPLAY_FRAME_COUNT = 10;
export type DogeDay2026RevealSequence = {
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

function buildDogeDay2026RevealSequence(packBaseUrlRaw: string): DogeDay2026RevealSequence {
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

export const DOGE_DAY_2026_PACK_REVEAL_SEQUENCE = buildDogeDay2026RevealSequence(DOGE_DAY_2026_STARTER_PACK_BASE_URL);
