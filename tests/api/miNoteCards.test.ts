import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isExactMiNoteCardsResponse,
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
