import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPonchoDrifellaRevealPlayerViewState,
  canCommitPonchoDrifellaVisualTarget,
  canEnterPonchoDrifellaAutoplay,
  getPonchoDrifellaAdvanceDecision,
  getPonchoDrifellaRevealVisualTarget,
  getPonchoDrifellaTimedAdvanceResult,
} from '../src/lib/ponchoDrifellaReveal.ts';

const DUMMY_PUNCH_FRAMES = ['/Poncho_Drifella/pack/recoverable_punches/1/1.webp'];

test('advance decisions preserve the reveal click flow', () => {
  assert.equal(
    getPonchoDrifellaAdvanceDecision({
      phase: 'ready',
      stage: 'idle',
      advanceLocked: false,
      cardReady: false,
      openingFramesReady: false,
      autoplayEntryReady: false,
    }),
    'start-punch',
  );

  assert.equal(
    getPonchoDrifellaAdvanceDecision({
      phase: 'ready',
      stage: 'idle',
      advanceLocked: false,
      cardReady: true,
      openingFramesReady: true,
      autoplayEntryReady: false,
    }),
    'start-segment-1-1',
  );

  assert.equal(
    getPonchoDrifellaAdvanceDecision({
      phase: 'ready',
      stage: 'idle',
      advanceLocked: false,
      cardReady: true,
      openingFramesReady: true,
      autoplayEntryReady: true,
    }),
    'start-segment-1-1',
  );

  assert.equal(
    getPonchoDrifellaAdvanceDecision({
      phase: 'ready',
      stage: 'idle',
      advanceLocked: false,
      cardReady: true,
      openingFramesReady: false,
      autoplayEntryReady: true,
    }),
    'start-punch',
  );

  assert.equal(
    getPonchoDrifellaAdvanceDecision({
      phase: 'ready',
      stage: 'segment_1_1_hold',
      advanceLocked: false,
      cardReady: true,
      openingFramesReady: true,
      autoplayEntryReady: false,
    }),
    'start-segment-1-2',
  );

  assert.equal(
    getPonchoDrifellaAdvanceDecision({
      phase: 'ready',
      stage: 'segment_1_2_hold',
      advanceLocked: false,
      cardReady: true,
      openingFramesReady: true,
      autoplayEntryReady: false,
    }),
    'queue-autoplay',
  );

  assert.equal(
    getPonchoDrifellaAdvanceDecision({
      phase: 'ready',
      stage: 'segment_1_2_hold',
      advanceLocked: false,
      cardReady: true,
      openingFramesReady: true,
      autoplayEntryReady: true,
    }),
    'start-autoplay',
  );
});

test('timed stage progression preserves the current choreography', () => {
  assert.deepEqual(
    getPonchoDrifellaTimedAdvanceResult({
      stage: 'punch',
      stageFrameIndex: 0,
      activePunchFrameCount: 3,
    }),
    { stage: 'punch', stageFrameIndex: 1 },
  );

  assert.deepEqual(
    getPonchoDrifellaTimedAdvanceResult({
      stage: 'segment_1_1',
      stageFrameIndex: 2,
      activePunchFrameCount: 1,
    }),
    { stage: 'segment_1_1_hold', stageFrameIndex: 2 },
  );

  assert.deepEqual(
    getPonchoDrifellaTimedAdvanceResult({
      stage: 'segment_1_2',
      stageFrameIndex: 2,
      activePunchFrameCount: 1,
    }),
    { stage: 'segment_1_2_hold', stageFrameIndex: 2 },
  );

  assert.deepEqual(
    getPonchoDrifellaTimedAdvanceResult({
      stage: 'autoplay',
      stageFrameIndex: 9,
      activePunchFrameCount: 1,
    }),
    { stage: 'revealed', stageFrameIndex: 9 },
  );
});

test('autoplay entry waits for reveal result, hidden card, and full autoplay assets', () => {
  assert.equal(
    canEnterPonchoDrifellaAutoplay({
      cardReady: true,
      cardAssetsReady: true,
      cardImageReady: false,
      autoplayFramesReady: true,
    }),
    false,
  );

  assert.equal(
    canEnterPonchoDrifellaAutoplay({
      cardReady: true,
      cardAssetsReady: false,
      cardImageReady: true,
      autoplayFramesReady: true,
    }),
    false,
  );

  assert.equal(
    canEnterPonchoDrifellaAutoplay({
      cardReady: true,
      cardAssetsReady: true,
      cardImageReady: true,
      autoplayFramesReady: false,
    }),
    false,
  );

  assert.equal(
    canEnterPonchoDrifellaAutoplay({
      cardReady: true,
      cardAssetsReady: true,
      cardImageReady: true,
      autoplayFramesReady: true,
    }),
    true,
  );
});

test('segment_1_2 seeds the initial overtop from 3.webp before autoplay', () => {
  const target = getPonchoDrifellaRevealVisualTarget('segment_1_2', 2, DUMMY_PUNCH_FRAMES);
  assert.equal(target.boxFrameSrc, '/Poncho_Drifella/pack/final_sequences/1/2/3.webp');
  assert.equal(target.foregroundFrameSrc, '/Poncho_Drifella/pack/final_sequences/1/2/3.webp');
  assert.equal(target.stageVisible, true);
  assert.equal(target.cardVisible, false);
});

test('autoplay visuals never commit when back or overtop is missing', () => {
  const target = getPonchoDrifellaRevealVisualTarget('autoplay', 0, DUMMY_PUNCH_FRAMES);

  assert.equal(
    canCommitPonchoDrifellaVisualTarget(target, new Set([target.boxFrameSrc])),
    false,
  );

  assert.equal(
    canCommitPonchoDrifellaVisualTarget(target, new Set([target.foregroundFrameSrc!])),
    false,
  );

  assert.equal(
    canCommitPonchoDrifellaVisualTarget(target, new Set([target.boxFrameSrc, target.foregroundFrameSrc!])),
    true,
  );
});

test('fail-open keeps the last safe manual composition instead of exposing the card', () => {
  const lastSafeManualVisual = getPonchoDrifellaRevealVisualTarget('segment_1_2_hold', 2, DUMMY_PUNCH_FRAMES);
  const viewState = buildPonchoDrifellaRevealPlayerViewState({
    phase: 'ready',
    boxLabel: 'box',
    hasRevealAttempted: true,
    stage: 'revealed',
    autoplayQueued: false,
    cardReady: true,
    cardAssetsReady: true,
    cardImageReady: false,
    autoplayFramesReady: false,
    cardInteractionUnlocked: false,
    revealFailedOpen: true,
    lastCommittedVisual: lastSafeManualVisual,
  });

  assert.equal(viewState.revealComplete, true);
  assert.equal(viewState.stageVisible, true);
  assert.equal(viewState.cardVisible, false);
  assert.equal(viewState.packDiscarded, false);
  assert.equal(viewState.cardInteractive, false);
});
