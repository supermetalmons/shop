import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_NFT_2_MAX_CARD_ID } from '../shared/cardNft2AssetCore.ts';
import {
  MI_NOTE_PACK_DISCARD_DELAY_MS,
  MI_NOTE_PACK_DISCARD_DURATION_MS,
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

test('mi note reveal needs two activations and automatically discards the opened pack', () => {
  let state = reduceMiNoteReveal(createMiNoteRevealState(), { type: 'ready', ready: true });
  assert.equal(state.stage, 'sealed');
  state = reduceMiNoteReveal(state, { type: 'activate' });
  assert.equal(state.stage, 'seal-falling');
  assert.equal(state.openRequested, false);
  state = reduceMiNoteReveal(state, { type: 'seal-finished' });
  assert.equal(state.stage, 'unsealed');
  state = reduceMiNoteReveal(state, { type: 'activate' });
  assert.equal(state.stage, 'opening');
  state = reduceMiNoteReveal(state, { type: 'opened' });
  assert.equal(state.stage, 'pack-falling');
  state = reduceMiNoteReveal(state, { type: 'discarded' });
  assert.equal(state.stage, 'revealed');
  assert.equal(MI_NOTE_PACK_DISCARD_DELAY_MS, 420);
  assert.equal(MI_NOTE_PACK_DISCARD_DURATION_MS, 380);
});

test('mi note queued opening waits for seal clearance and readiness in either completion order', () => {
  const queuedEvents: MiNoteRevealEvent[] = [{ type: 'activate' }, { type: 'activate' }];
  const completions: MiNoteRevealEvent[] = [{ type: 'seal-finished' }, { type: 'ready', ready: true }];
  for (const order of [completions, [...completions].reverse()]) {
    let state = runEvents(queuedEvents);
    assert.equal(state.stage, 'seal-falling');
    assert.equal(state.openRequested, true);
    state = reduceMiNoteReveal(state, order[0]);
    assert.notEqual(state.stage, 'opening');
    state = reduceMiNoteReveal(state, order[1]);
    assert.equal(state.stage, 'opening');
  }
});

test('mi note opening stays queued during a preload error and resumes on retry readiness', () => {
  let state = runEvents([
    { type: 'ready', ready: true },
    { type: 'activate' },
    { type: 'activate' },
    { type: 'ready', ready: false },
    { type: 'seal-finished' },
  ]);
  assert.equal(state.stage, 'unsealed');
  assert.equal(state.openRequested, true);
  state = reduceMiNoteReveal(state, { type: 'ready', ready: true });
  assert.equal(state.stage, 'opening');
});

test('mi note repeated activations and obsolete completion events cannot restart or skip stages', () => {
  let state = createMiNoteRevealState();
  for (const event of [{ type: 'seal-finished' }, { type: 'opened' }, { type: 'discarded' }] as const) {
    assert.equal(reduceMiNoteReveal(state, event), state);
  }
  state = runEvents([{ type: 'activate' }, { type: 'activate' }]);
  for (let index = 0; index < 10; index += 1) {
    assert.equal(reduceMiNoteReveal(state, { type: 'activate' }), state);
  }
  assert.equal(reduceMiNoteReveal(state, { type: 'opened' }), state);
  assert.equal(reduceMiNoteReveal(state, { type: 'discarded' }), state);
  state = reduceMiNoteReveal(state, { type: 'seal-finished' });
  assert.equal(reduceMiNoteReveal(state, { type: 'seal-finished' }), state);
  state = reduceMiNoteReveal(state, { type: 'ready', ready: true });
  for (const event of [
    { type: 'activate' },
    { type: 'seal-finished' },
    { type: 'ready', ready: false },
    { type: 'discarded' },
  ] as const) {
    assert.equal(reduceMiNoteReveal(state, event), state);
  }
  state = reduceMiNoteReveal(state, { type: 'opened' });
  assert.equal(reduceMiNoteReveal(state, { type: 'opened' }), state);
  state = reduceMiNoteReveal(state, { type: 'discarded' });
  for (const event of [
    { type: 'activate' },
    { type: 'seal-finished' },
    { type: 'ready', ready: false },
    { type: 'opened' },
    { type: 'discarded' },
  ] as const) {
    assert.equal(reduceMiNoteReveal(state, event), state);
  }
});

test('mi note transitions do not mutate state and reset starts fresh during loading or animation', () => {
  const initial = Object.freeze(createMiNoteRevealState());
  const falling = reduceMiNoteReveal(initial, { type: 'activate' });
  assert.notEqual(falling, initial);
  assert.equal(initial.stage, 'sealed');
  const opening = runEvents([
    { type: 'activate' },
    { type: 'activate' },
    { type: 'seal-finished' },
    { type: 'ready', ready: true },
  ]);
  for (const previous of [falling, opening]) {
    const reset = createMiNoteRevealState();
    assert.notEqual(reset, previous);
    assert.deepEqual(reset, { stage: 'sealed', ready: false, openRequested: false });
    assert.equal(reduceMiNoteReveal(reset, { type: 'opened' }), reset);
    assert.equal(reduceMiNoteReveal(reset, { type: 'discarded' }), reset);
  }
});
