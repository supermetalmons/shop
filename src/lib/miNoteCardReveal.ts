export const MI_NOTE_OPEN_TAPS = 4;
export const MI_NOTE_DEMO_CARD_IDS = [1302, 1325, 1327] as const;

export type MiNoteDemoCardId = (typeof MI_NOTE_DEMO_CARD_IDS)[number];

export const MI_NOTE_PACK_VARIANTS = [
  { id: 'cobalt-blue', name: 'Cobalt Blue', color: '#3559B7' },
  { id: 'marigold', name: 'Marigold', color: '#E7A62C' },
  { id: 'emerald', name: 'Emerald', color: '#20866C' },
] as const;

export type MiNotePackVariant = (typeof MI_NOTE_PACK_VARIANTS)[number];

export type MiNotePack = {
  readonly variant: MiNotePackVariant;
  readonly cardIds: readonly [MiNoteDemoCardId, MiNoteDemoCardId];
};

export type MiNoteFolderPose = 0 | 1 | 2;
export type MiNoteRevealStage = 'sealed' | 'seal-peeling' | 'unsealed' | 'interactive';

export type MiNoteRevealState = {
  readonly stage: MiNoteRevealStage;
  readonly ready: boolean;
  readonly taps: number;
  readonly folderPose: MiNoteFolderPose;
  readonly selectedCard: 0 | 1 | null;
  readonly cardStage: 'pocket' | 'lifting' | 'inspecting' | 'returning';
};

export type MiNoteRevealEvent =
  | { type: 'activate'; leaf?: 0 | 2 }
  | { type: 'seal-finished' }
  | { type: 'ready'; ready: boolean }
  | { type: 'folder-pose'; pose: MiNoteFolderPose }
  | { type: 'select-card'; index: 0 | 1 }
  | { type: 'card-lifted' }
  | { type: 'return-card' }
  | { type: 'card-returned' };

function sampleIndex(count: number, random: () => number): number {
  const value = random();
  return Number.isFinite(value) ? Math.max(0, Math.min(count - 1, Math.floor(value * count))) : 0;
}

export function sampleMiNotePack(random: () => number = Math.random): MiNotePack {
  const variant = MI_NOTE_PACK_VARIANTS[sampleIndex(MI_NOTE_PACK_VARIANTS.length, random)];
  const firstCardIndex = sampleIndex(MI_NOTE_DEMO_CARD_IDS.length, random);
  const secondCardCandidate = sampleIndex(MI_NOTE_DEMO_CARD_IDS.length - 1, random);
  const secondCardIndex = secondCardCandidate >= firstCardIndex ? secondCardCandidate + 1 : secondCardCandidate;
  return { variant, cardIds: [MI_NOTE_DEMO_CARD_IDS[firstCardIndex], MI_NOTE_DEMO_CARD_IDS[secondCardIndex]] };
}

export function createMiNoteRevealState(): MiNoteRevealState {
  return { stage: 'sealed', ready: false, taps: 0, folderPose: 0, selectedCard: null, cardStage: 'pocket' };
}

function unlockWhenReady(state: MiNoteRevealState): MiNoteRevealState {
  return state.stage === 'unsealed' && state.ready
    ? { ...state, stage: 'interactive' }
    : state;
}

export function reduceMiNoteReveal(state: MiNoteRevealState, event: MiNoteRevealEvent): MiNoteRevealState {
  switch (event.type) {
    case 'activate':
      if (state.stage === 'sealed') {
        const taps = state.taps + 1;
        return { ...state, taps, stage: taps === MI_NOTE_OPEN_TAPS ? 'seal-peeling' : 'sealed' };
      }
      if (state.stage !== 'interactive' || state.selectedCard !== null) return state;
      return { ...state, folderPose: state.folderPose === 1 ? event.leaf ?? 0 : 1 };
    case 'seal-finished':
      return state.stage === 'seal-peeling' ? unlockWhenReady({ ...state, stage: 'unsealed' }) : state;
    case 'ready':
      if (state.ready === event.ready) return state;
      return unlockWhenReady({ ...state, ready: event.ready });
    case 'folder-pose':
      if (
        state.folderPose === event.pose ||
        state.selectedCard !== null ||
        (state.stage !== 'interactive' && (state.stage !== 'sealed' || event.pose === 1))
      ) return state;
      return { ...state, folderPose: event.pose };
    case 'select-card':
      if (state.stage !== 'interactive' || !state.ready || state.folderPose !== 1 || state.selectedCard !== null) {
        return state;
      }
      return { ...state, selectedCard: event.index, cardStage: 'lifting' };
    case 'card-lifted':
      return state.cardStage === 'lifting' ? { ...state, cardStage: 'inspecting' } : state;
    case 'return-card':
      return state.cardStage === 'inspecting' ? { ...state, cardStage: 'returning' } : state;
    case 'card-returned':
      return state.cardStage === 'returning' ? { ...state, selectedCard: null, cardStage: 'pocket' } : state;
  }
}
