import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isCanonicalMiNoteTokenIds,
  isExactMiNoteCardsResponse,
  MI_NOTE_2_CONTRACT_ADDRESS,
  MI_NOTE_3_CONTRACT_ADDRESS,
  MI_NOTE_CONTRACT_ADDRESS,
  MI_NOTE_CONTRACT_ADDRESSES,
  MI_NOTE_MODERN_CONTRACT_ADDRESSES,
  miNoteAddressFromSearch,
  normalizeMiNoteAddress,
} from '../../shared/miNoteCards.ts';

const ADDRESS = '0x000533f50ddd7f2fc4EfD06137b0c1A12CfB7Bb9';
const MAX_TOKEN_ID = ((1n << 256n) - 1n).toString();
const ERROR_CODES = ['provider-timeout', 'provider-unavailable'] as const;

function successfulResult(provider: 'alchemy' | 'opensea' = 'alchemy') {
  return { status: 'success', provider, visibilityLimited: provider === 'opensea' };
}

function response() {
  const tokenIdsByContract: Record<string, unknown> = Object.fromEntries(
    MI_NOTE_CONTRACT_ADDRESSES.map((contract) => [contract, []]),
  );
  const resultsByContract: Record<string, unknown> = Object.fromEntries(
    MI_NOTE_CONTRACT_ADDRESSES.map((contract) => [contract, successfulResult()]),
  );
  return { ok: true, tokenIdsByContract, resultsByContract };
}

function invalidTokenIds(): unknown[] {
  return [
    null, undefined, {}, '1', [1], [null], [undefined], new Array(1), ['1', '1'],
    ['00'], ['01'], ['0x1'], ['-1'], ['+1'], ['1.1'], ['1e3'], [''], [' 1'],
    ['1 '], ['1\n'], ['1\r'], ['1\t'], [(1n << 256n).toString()], ['9'.repeat(79)],
    Array.from({ length: 10_001 }, (_, index) => String(index)),
  ];
}

test('Mi Note address queries distinguish random mode from invalid owner mode', () => {
  assert.deepEqual(miNoteAddressFromSearch('?unrelated=true'), { present: false, address: null });
  assert.deepEqual(miNoteAddressFromSearch(`?address=${ADDRESS}`), {
    present: true, address: ADDRESS.toLowerCase(),
  });
  for (const search of [
    '?address', '?address=', '?address=alice.eth', `?address=${ADDRESS}&address=${ADDRESS}`,
    `?address=${ADDRESS}%0A`, `?address=${ADDRESS}%0D`,
  ]) {
    assert.deepEqual(miNoteAddressFromSearch(search), { present: true, address: null });
  }
  for (const address of [
    null, undefined, 123, ADDRESS.slice(1), `${ADDRESS}a`, ` ${ADDRESS}`,
    `${ADDRESS}\n`, `${ADDRESS}\r`, ADDRESS.replace('0x', '0X'),
  ]) {
    assert.equal(normalizeMiNoteAddress(address), null);
  }
});

test('Mi Note gallery order is 3, 2, original while modern lookup order stays 2, 3', () => {
  assert.equal(MI_NOTE_CONTRACT_ADDRESS, '0x495f947276749ce646f68ac8c248420045cb7b5e');
  assert.deepEqual(MI_NOTE_MODERN_CONTRACT_ADDRESSES, [
    MI_NOTE_2_CONTRACT_ADDRESS, MI_NOTE_3_CONTRACT_ADDRESS,
  ]);
  assert.deepEqual(MI_NOTE_CONTRACT_ADDRESSES, [
    MI_NOTE_3_CONTRACT_ADDRESS, MI_NOTE_2_CONTRACT_ADDRESS, MI_NOTE_CONTRACT_ADDRESS,
  ]);
});

test('Mi Note combined responses keep token IDs and provider results separate for all three collections', () => {
  assert.equal(isExactMiNoteCardsResponse(response()), true);
  const payload = response();
  for (const contract of MI_NOTE_CONTRACT_ADDRESSES) {
    payload.tokenIdsByContract[contract] = ['2'];
  }
  assert.equal(isExactMiNoteCardsResponse(payload), true);

  for (const contract of MI_NOTE_CONTRACT_ADDRESSES) {
    for (const provider of ['alchemy', 'opensea'] as const) {
      const payload = response();
      payload.tokenIdsByContract[contract] = ['2'];
      payload.resultsByContract[contract] = successfulResult(provider);
      assert.equal(isExactMiNoteCardsResponse(payload), true);
    }
  }
});

test('Mi Note combined responses require exact top-level and contract map shapes', () => {
  for (const value of [
    null, undefined, true, 1, '', [], {}, { ok: true, tokenIds: [] },
    { ...response(), extra: true }, { ...response(), ok: false },
    { ...response(), ok: 'true' },
    { tokenIdsByContract: response().tokenIdsByContract, resultsByContract: response().resultsByContract },
    { ok: true, tokenIdsByContract: response().tokenIdsByContract },
    { ok: true, resultsByContract: response().resultsByContract },
  ]) assert.equal(isExactMiNoteCardsResponse(value), false);

  for (const field of ['tokenIdsByContract', 'resultsByContract'] as const) {
    for (const value of [null, undefined, true, 1, '', [], {}]) {
      assert.equal(isExactMiNoteCardsResponse({ ...response(), [field]: value }), false);
    }
    for (const contract of MI_NOTE_CONTRACT_ADDRESSES) {
      const payload = response();
      delete payload[field][contract];
      assert.equal(isExactMiNoteCardsResponse(payload), false);
      payload[field].unknown = field === 'tokenIdsByContract' ? [] : successfulResult();
      assert.equal(isExactMiNoteCardsResponse(payload), false);
    }
    const payload = response();
    payload[field].unknown = field === 'tokenIdsByContract' ? [] : successfulResult();
    assert.equal(isExactMiNoteCardsResponse(payload), false);
  }
});

test('Mi Note combined responses require exact success and error result shapes', () => {
  for (const contract of MI_NOTE_CONTRACT_ADDRESSES) {
    for (const result of [
      null, undefined, true, 1, '', [], {},
      { provider: 'alchemy', visibilityLimited: false },
      { status: 'success', visibilityLimited: false },
      { status: 'success', provider: 'alchemy' },
      { ...successfulResult(), status: 'pending' },
      { ...successfulResult(), provider: 'unknown' },
      { ...successfulResult(), visibilityLimited: true },
      { ...successfulResult('opensea'), visibilityLimited: false },
      { ...successfulResult(), visibilityLimited: 'false' },
      { ...successfulResult(), visibilityLimited: null },
      { ...successfulResult(), extra: true },
      { ...successfulResult(), error: 'provider-timeout' },
      { status: 'error' }, { status: 'error', error: 'unknown' },
      { status: 'error', error: null },
      { status: 'error', error: 'provider-timeout', extra: true },
      { status: 'error', error: 'provider-timeout', provider: 'alchemy' },
      { status: 'error', error: 'provider-timeout', visibilityLimited: false },
    ]) {
      const payload = response();
      payload.resultsByContract[contract] = result;
      assert.equal(isExactMiNoteCardsResponse(payload), false);
    }
  }
});

test('Mi Note combined responses allow partial failures only with empty failed groups and at least one success', () => {
  for (const contract of MI_NOTE_CONTRACT_ADDRESSES) {
    for (const error of ERROR_CODES) {
      const payload = response();
      payload.resultsByContract[contract] = { status: 'error', error };
      assert.equal(isExactMiNoteCardsResponse(payload), true);
      payload.tokenIdsByContract[contract] = ['1'];
      assert.equal(isExactMiNoteCardsResponse(payload), false);
    }

    const payload = response();
    for (const failedContract of MI_NOTE_CONTRACT_ADDRESSES) {
      payload.resultsByContract[failedContract] = { status: 'error', error: 'provider-unavailable' };
    }
    assert.equal(isExactMiNoteCardsResponse(payload), false);
    payload.resultsByContract[contract] = successfulResult('opensea');
    assert.equal(isExactMiNoteCardsResponse(payload), true);
  }
});

test('Mi Note ownership responses require distinct canonical uint256 token IDs', () => {
  for (const contract of MI_NOTE_CONTRACT_ADDRESSES) {
    const payload = response();
    payload.tokenIdsByContract[contract] = ['0', '1', MAX_TOKEN_ID];
    assert.equal(isExactMiNoteCardsResponse(payload), true);
    for (const ids of invalidTokenIds()) {
      payload.tokenIdsByContract[contract] = ids;
      assert.equal(isExactMiNoteCardsResponse(payload), false);
    }
  }
});

test('Mi Note ownership responses limit the total across all three collections to 10,000 token IDs', () => {
  const ids = Array.from({ length: 10_000 }, (_, index) => String(index));
  for (const contract of MI_NOTE_CONTRACT_ADDRESSES) {
    const payload = response();
    payload.tokenIdsByContract[contract] = ids;
    assert.equal(isExactMiNoteCardsResponse(payload), true);
  }
  const payload = response();
  payload.tokenIdsByContract[MI_NOTE_2_CONTRACT_ADDRESS] = ids.slice(0, 4000);
  payload.tokenIdsByContract[MI_NOTE_3_CONTRACT_ADDRESS] = ids.slice(0, 3000);
  payload.tokenIdsByContract[MI_NOTE_CONTRACT_ADDRESS] = ids.slice(0, 3000);
  assert.equal(isExactMiNoteCardsResponse(payload), true);
  payload.tokenIdsByContract[MI_NOTE_CONTRACT_ADDRESS] = ids.slice(0, 3001);
  assert.equal(isExactMiNoteCardsResponse(payload), false);
});

test('Mi Note canonical token validation enforces uint256 strings, uniqueness, and the cache limit', () => {
  assert.equal(isCanonicalMiNoteTokenIds([]), true);
  assert.equal(isCanonicalMiNoteTokenIds(['0', '1', MAX_TOKEN_ID]), true);
  assert.equal(isCanonicalMiNoteTokenIds(Array.from({ length: 10_000 }, (_, index) => String(index))), true);
  for (const value of invalidTokenIds()) assert.equal(isCanonicalMiNoteTokenIds(value), false);
});
