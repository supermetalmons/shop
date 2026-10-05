import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_NFT_2_MAX_CARD_ID } from '../shared/cardNft2AssetCore.ts';
import {
  MI_NOTE_OPEN_TAPS,
  MI_NOTE_PACK_VARIANTS,
  createMiNoteRevealState,
  reduceMiNoteReveal,
  sampleMiNotePack,
  type MiNoteRevealEvent,
  type MiNoteRevealState,
} from '../src/lib/miNoteCardReveal.ts';

function runEvents(events: readonly MiNoteRevealEvent[]): MiNoteRevealState {
  return events.reduce(reduceMiNoteReveal, createMiNoteRevealState());
}

test('mi note packs have only the three requested source colors', () => {
  assert.deepEqual(MI_NOTE_PACK_VARIANTS, [
    { id: 'cobalt-blue', name: 'Cobalt Blue', color: '#3559B7' },
    { id: 'marigold', name: 'Marigold', color: '#E7A62C' },
    { id: 'emerald', name: 'Emerald', color: '#20866C' },
  ]);
  for (const [index, value] of [0, 0.5, 0.999999].entries()) {
    assert.equal(sampleMiNotePack(() => value).variant, MI_NOTE_PACK_VARIANTS[index]);
  }
});

test('mi note sampling always produces two distinct valid cards with exactly three draws', () => {
  for (const value of [0, 0.1, 0.5, 0.999999, 1, -1, NaN, Infinity]) {
    let calls = 0;
    const pack = sampleMiNotePack(() => {
      calls += 1;
      return value;
    });
    assert.equal(calls, 3);
    assert.notEqual(pack.cardIds[0], pack.cardIds[1]);
    for (const cardId of pack.cardIds) {
      assert.ok(Number.isInteger(cardId));
      assert.ok(cardId >= 1 && cardId <= CARD_NFT_2_MAX_CARD_ID);
    }
  }
});

test('mi note second-card sampling skips the selected first card without excluding either endpoint', () => {
  for (const [values, expected] of [
    [[0, 0, 0], [1, 2]],
    [[0, 0, 0.999999], [1, CARD_NFT_2_MAX_CARD_ID]],
    [[0, 0.999999, 0], [CARD_NFT_2_MAX_CARD_ID, 1]],
    [[0, 0.999999, 0.999999], [CARD_NFT_2_MAX_CARD_ID, CARD_NFT_2_MAX_CARD_ID - 1]],
  ] as const) {
    let index = 0;
    assert.deepEqual(sampleMiNotePack(() => values[index++]).cardIds, expected);
  }
});

const openingTaps: readonly MiNoteRevealEvent[] = Array.from({ length: 4 }, () => ({ type: 'activate' }));
const openEvents: readonly MiNoteRevealEvent[] = [
  ...openingTaps,
  { type: 'seal-finished' },
  { type: 'ready', ready: true },
];

test('mi note initial opening requires exactly four taps and removes the seal once', () => {
  assert.equal(MI_NOTE_OPEN_TAPS, 4);
  let state = reduceMiNoteReveal(createMiNoteRevealState(), { type: 'ready', ready: true });
  for (let tap = 1; tap <= 3; tap += 1) {
    state = reduceMiNoteReveal(state, { type: 'activate' });
    assert.equal(state.stage, 'sealed');
    assert.equal(state.taps, tap);
    assert.equal(state.folderPose, 0);
  }
  state = reduceMiNoteReveal(state, { type: 'activate' });
  assert.equal(state.stage, 'seal-falling');
  assert.equal(state.taps, 4);
  assert.equal(reduceMiNoteReveal(state, { type: 'activate' }), state);
  state = reduceMiNoteReveal(state, { type: 'seal-finished' });
  assert.equal(state.stage, 'interactive');
  assert.equal(state.folderPose, 1);
  assert.equal(reduceMiNoteReveal(state, { type: 'seal-finished' }), state);
});

test('mi note queued opening waits for seal clearance and readiness in either completion order', () => {
  const completions: MiNoteRevealEvent[] = [{ type: 'seal-finished' }, { type: 'ready', ready: true }];
  for (const order of [completions, [...completions].reverse()]) {
    let state = runEvents(openingTaps);
    state = reduceMiNoteReveal(state, order[0]);
    assert.notEqual(state.stage, 'interactive');
    assert.equal(state.folderPose, 0);
    assert.equal(reduceMiNoteReveal(state, { type: 'activate' }), state);
    assert.equal(reduceMiNoteReveal(state, { type: 'folder-pose', pose: 1 }), state);
    state = reduceMiNoteReveal(state, order[1]);
    assert.equal(state.stage, 'interactive');
    assert.equal(state.folderPose, 1);
  }
});

test('mi note opening stays queued during a preload error and resumes on retry readiness', () => {
  let state = runEvents([
    { type: 'ready', ready: true },
    ...openingTaps,
    { type: 'ready', ready: false },
    { type: 'seal-finished' },
  ]);
  assert.equal(state.stage, 'unsealed');
  assert.equal(state.taps, 4);
  assert.equal(reduceMiNoteReveal(state, { type: 'activate' }), state);
  state = reduceMiNoteReveal(state, { type: 'ready', ready: true });
  assert.equal(state.stage, 'interactive');
  assert.equal(state.folderPose, 1);
});

test('mi note sealed rotation changes only closed poses and preserves tap progress', () => {
  let state = runEvents([{ type: 'activate' }, { type: 'activate' }]);
  assert.equal(reduceMiNoteReveal(state, { type: 'folder-pose', pose: 1 }), state);
  for (const pose of [2, 0] as const) {
    state = reduceMiNoteReveal(state, { type: 'folder-pose', pose });
    assert.equal(state.stage, 'sealed');
    assert.equal(state.folderPose, pose);
    assert.equal(state.taps, 2);
  }
});

test('mi note folder can close toward either leaf and reopen without restoring the seal', () => {
  let state = runEvents(openEvents);
  for (const leaf of [0, 2, 0, 2] as const) {
    state = reduceMiNoteReveal(state, { type: 'activate', leaf });
    assert.equal(state.folderPose, leaf);
    assert.equal(state.stage, 'interactive');
    assert.equal(state.taps, 4);
    state = reduceMiNoteReveal(state, { type: 'activate' });
    assert.equal(state.folderPose, 1);
    assert.equal(state.stage, 'interactive');
  }
  state = reduceMiNoteReveal(state, { type: 'activate' });
  assert.equal(state.folderPose, 0);
  state = reduceMiNoteReveal(state, { type: 'folder-pose', pose: 2 });
  assert.equal(state.folderPose, 2);
  state = reduceMiNoteReveal(state, { type: 'folder-pose', pose: 1 });
  assert.equal(state.folderPose, 1);
});

test('mi note selection requires visible ready cards and locks the folder until return finishes', () => {
  for (const state of [
    createMiNoteRevealState(),
    runEvents(openingTaps),
    runEvents([...openingTaps, { type: 'seal-finished' }]),
    runEvents([...openEvents, { type: 'folder-pose', pose: 0 }]),
    runEvents([...openEvents, { type: 'folder-pose', pose: 2 }]),
    runEvents([...openEvents, { type: 'ready', ready: false }]),
  ]) {
    assert.equal(reduceMiNoteReveal(state, { type: 'select-card', index: 0 }), state);
  }
  for (const index of [0, 1] as const) {
    let state = reduceMiNoteReveal(runEvents(openEvents), { type: 'select-card', index });
    assert.equal(state.selectedCard, index);
    assert.equal(state.cardStage, 'lifting');
    assert.equal(reduceMiNoteReveal(state, { type: 'return-card' }), state);
    assert.equal(reduceMiNoteReveal(state, { type: 'card-returned' }), state);
    for (const transition of [null, 'card-lifted', 'return-card'] as const) {
      if (transition) state = reduceMiNoteReveal(state, { type: transition });
      for (const event of [
        { type: 'activate' },
        { type: 'folder-pose', pose: 0 },
        { type: 'select-card', index: 0 },
        { type: 'select-card', index: 1 },
      ] as const) {
        assert.equal(reduceMiNoteReveal(state, event), state);
      }
      assert.equal(state.folderPose, 1);
      assert.equal(state.selectedCard, index);
    }
    assert.equal(state.cardStage, 'returning');
    state = reduceMiNoteReveal(state, { type: 'card-returned' });
    assert.equal(state.selectedCard, null);
    assert.equal(state.cardStage, 'pocket');
    state = reduceMiNoteReveal(state, { type: 'select-card', index: index === 0 ? 1 : 0 });
    assert.equal(state.cardStage, 'lifting');
    assert.notEqual(state.selectedCard, index);
  }
});

test('mi note stale completion events do not skip card transitions', () => {
  let state = runEvents(openEvents);
  for (const event of [{ type: 'card-lifted' }, { type: 'return-card' }, { type: 'card-returned' }] as const) {
    assert.equal(reduceMiNoteReveal(state, event), state);
  }
  state = reduceMiNoteReveal(state, { type: 'select-card', index: 0 });
  state = reduceMiNoteReveal(state, { type: 'card-lifted' });
  assert.equal(state.cardStage, 'inspecting');
  assert.equal(reduceMiNoteReveal(state, { type: 'card-lifted' }), state);
  assert.equal(reduceMiNoteReveal(state, { type: 'card-returned' }), state);
  state = reduceMiNoteReveal(state, { type: 'return-card' });
  assert.equal(reduceMiNoteReveal(state, { type: 'card-lifted' }), state);
  assert.equal(reduceMiNoteReveal(state, { type: 'return-card' }), state);
});

test('mi note transitions do not mutate state and reset starts fresh during every transition', () => {
  const initial = Object.freeze(createMiNoteRevealState());
  const tapped = reduceMiNoteReveal(initial, { type: 'activate' });
  assert.notEqual(tapped, initial);
  assert.equal(initial.taps, 0);
  const transitions: readonly MiNoteRevealEvent[] = [
    ...openEvents,
    { type: 'select-card', index: 1 },
    { type: 'card-lifted' },
    { type: 'return-card' },
    { type: 'card-returned' },
  ];
  let previous = initial;
  for (const event of transitions) {
    previous = reduceMiNoteReveal(previous, event);
    const reset = createMiNoteRevealState();
    assert.notEqual(reset, previous);
    assert.deepEqual(reset, {
      stage: 'sealed', ready: false, taps: 0, folderPose: 0, selectedCard: null, cardStage: 'pocket',
    });
    for (const completion of [{ type: 'seal-finished' }, { type: 'card-lifted' }, { type: 'card-returned' }] as const) {
      assert.equal(reduceMiNoteReveal(reset, completion), reset);
    }
  }
});
