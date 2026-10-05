import { CARD_NFT_2_MAX_CARD_ID } from '../../shared/cardNft2AssetCore.ts';

export const MI_NOTE_PACK_DISCARD_DELAY_MS = 420;
export const MI_NOTE_PACK_DISCARD_DURATION_MS = 380;

export const MI_NOTE_PACK_VARIANTS = [
  { id: 'cobalt-blue', name: 'Cobalt Blue', color: '#3559B7' },
  { id: 'marigold', name: 'Marigold', color: '#E7A62C' },
  { id: 'emerald', name: 'Emerald', color: '#20866C' },
] as const;

export type MiNotePackVariant = (typeof MI_NOTE_PACK_VARIANTS)[number];

export type MiNotePack = {
  readonly variant: MiNotePackVariant;
  readonly cardIds: readonly [number, number];
};

export type MiNoteRevealStage =
  | 'sealed'
  | 'seal-falling'
  | 'unsealed'
  | 'opening'
  | 'pack-falling'
  | 'revealed';

export type MiNoteRevealState = {
  readonly stage: MiNoteRevealStage;
  readonly ready: boolean;
  readonly openRequested: boolean;
};

export type MiNoteRevealEvent =
  | { type: 'activate' }
  | { type: 'seal-finished' }
  | { type: 'ready'; ready: boolean }
  | { type: 'opened' }
  | { type: 'discarded' };

function sampleIndex(count: number, random: () => number): number {
  const value = random();
  return Number.isFinite(value) ? Math.max(0, Math.min(count - 1, Math.floor(value * count))) : 0;
}

export function sampleMiNotePack(random: () => number = Math.random): MiNotePack {
  const variant = MI_NOTE_PACK_VARIANTS[sampleIndex(MI_NOTE_PACK_VARIANTS.length, random)];
  const firstCardId = sampleIndex(CARD_NFT_2_MAX_CARD_ID, random) + 1;
  const secondCardCandidate = sampleIndex(CARD_NFT_2_MAX_CARD_ID - 1, random) + 1;
  const secondCardId = secondCardCandidate >= firstCardId ? secondCardCandidate + 1 : secondCardCandidate;
  return { variant, cardIds: [firstCardId, secondCardId] };
}

export function createMiNoteRevealState(): MiNoteRevealState {
  return { stage: 'sealed', ready: false, openRequested: false };
}

function openWhenReady(state: MiNoteRevealState): MiNoteRevealState {
  return state.stage === 'unsealed' && state.ready && state.openRequested
    ? { ...state, stage: 'opening' }
    : state;
}

export function reduceMiNoteReveal(state: MiNoteRevealState, event: MiNoteRevealEvent): MiNoteRevealState {
  switch (event.type) {
    case 'activate':
      if (state.stage === 'sealed') return { ...state, stage: 'seal-falling' };
      if (state.openRequested || (state.stage !== 'seal-falling' && state.stage !== 'unsealed')) return state;
      return openWhenReady({ ...state, openRequested: true });
    case 'seal-finished':
      return state.stage === 'seal-falling' ? openWhenReady({ ...state, stage: 'unsealed' }) : state;
    case 'ready':
      if (
        state.ready === event.ready ||
        state.stage === 'opening' ||
        state.stage === 'pack-falling' ||
        state.stage === 'revealed'
      ) return state;
      return openWhenReady({ ...state, ready: event.ready });
    case 'opened':
      return state.stage === 'opening' ? { ...state, stage: 'pack-falling' } : state;
    case 'discarded':
      return state.stage === 'pack-falling' ? { ...state, stage: 'revealed' } : state;
  }
}
