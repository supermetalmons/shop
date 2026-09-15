import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isExactMiNoteCardsResponse,
  isExactMiNoteCardsResponseV2,
  MI_NOTE_2_CONTRACT_ADDRESS,
  MI_NOTE_3_CONTRACT_ADDRESS,
  miNoteAddressFromSearch,
  normalizeMiNoteAddress,
} from '../../shared/miNoteCards.ts';

const ADDRESS = '0x000533f50ddd7f2fc4EfD06137b0c1A12CfB7Bb9';

test('Mi Note address queries distinguish random mode from invalid owner mode', () => {
  assert.deepEqual(miNoteAddressFromSearch('?unrelated=true'), { present: false, address: null });
  assert.deepEqual(miNoteAddressFromSearch(`?address=${ADDRESS}`), {
    present: true, address: ADDRESS.toLowerCase(),
  });
  for (const search of ['?address', '?address=', '?address=alice.eth', `?address=${ADDRESS}&address=${ADDRESS}`]) {
    assert.deepEqual(miNoteAddressFromSearch(search), { present: true, address: null });
  }
  for (const address of [null, undefined, 123, ADDRESS.slice(1), `${ADDRESS}a`, ` ${ADDRESS}`, ADDRESS.replace('0x', '0X')]) {
    assert.equal(normalizeMiNoteAddress(address), null);
  }
});

test('Mi Note v2 responses keep token IDs separate for each collection', () => {
  const payload = (two: unknown, three: unknown) => ({
    ok: true,
    tokenIdsByContract: {
      [MI_NOTE_2_CONTRACT_ADDRESS]: two,
      [MI_NOTE_3_CONTRACT_ADDRESS]: three,
    },
  });
  assert.equal(isExactMiNoteCardsResponseV2(payload([], [])), true);
  assert.equal(isExactMiNoteCardsResponseV2(payload(['2'], ['2'])), true);
  assert.equal(isExactMiNoteCardsResponseV2(payload([], ['2'])), true);
  for (const value of [
    null, [], {}, { ok: true, tokenIds: [] },
    { ...payload([], []), extra: true },
    { ...payload([], []), ok: false },
    { ok: true, tokenIdsByContract: null },
    { ok: true, tokenIdsByContract: [] },
    { ok: true, tokenIdsByContract: { [MI_NOTE_2_CONTRACT_ADDRESS]: [] } },
    { ok: true, tokenIdsByContract: { ...payload([], []).tokenIdsByContract, unknown: [] } },
    { ok: true, tokenIdsByContract: { [MI_NOTE_2_CONTRACT_ADDRESS]: [], unknown: [] } },
    payload(['2', '2'], []), payload([], ['2', '2']), payload(['01'], []),
    payload([], ['0x2']), payload([], [2]), payload(null, []),
    payload([], [(1n << 256n).toString()]),
  ]) assert.equal(isExactMiNoteCardsResponseV2(value), false);

  const ids = Array.from({ length: 5000 }, (_, index) => String(index));
  assert.equal(isExactMiNoteCardsResponseV2(payload(ids, ids)), true);
  assert.equal(isExactMiNoteCardsResponseV2(payload(ids, [...ids, '5000'])), false);
});

test('Mi Note ownership responses require distinct canonical uint256 token IDs', () => {
  const maxId = ((1n << 256n) - 1n).toString();
  assert.equal(isExactMiNoteCardsResponse({ ok: true, tokenIds: [] }), true);
  assert.equal(isExactMiNoteCardsResponse({ ok: true, tokenIds: ['0', '1', maxId] }), true);
  for (const value of [
    null, [], {}, { ok: false, tokenIds: [] }, { ok: true },
    { ok: true, tokenIds: [], extra: true },
    ...[[1], ['1', '1'], ['01'], ['0x1'], ['-1'], ['1.1'], [''], [(1n << 256n).toString()],
      Array.from({ length: 10_001 }, (_, index) => String(index))]
      .map((tokenIds) => ({ ok: true, tokenIds })),
  ]) {
    assert.equal(isExactMiNoteCardsResponse(value), false);
  }
});
