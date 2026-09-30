import assert from 'node:assert/strict';
import test from 'node:test';
import { AddressLookupTableProgram, PublicKey } from '@solana/web3.js';
import { parseSolanaRpcAccount } from '../src/solanaProvider.ts';
import {
  readLatestBlockhash,
  readLatestBlockhashWithContext,
  readSolanaLookupTable,
} from '../src/solanaRpcReads.ts';

const ADDRESS = new PublicKey(new Uint8Array(32).fill(1));
const MEMBER = new PublicKey(new Uint8Array(32).fill(2));
const BLOCKHASH = new PublicKey(new Uint8Array(32).fill(3)).toBase58();
const ACTIVE_SLOT = 0xffffffffffffffffn;

function lookupAccount(deactivationSlot = ACTIVE_SLOT) {
  const data = Buffer.alloc(56 + 32);
  data.writeUInt32LE(1, 0);
  data.writeBigUInt64LE(deactivationSlot, 4);
  MEMBER.toBuffer().copy(data, 56);
  return {
    owner: AddressLookupTableProgram.programId.toBase58(),
    data: [data.toString('base64'), 'base64'],
  };
}

function lookupOptions(result: unknown): Parameters<typeof readSolanaLookupTable>[0] {
  return {
    rpc: async () => result,
    address: ADDRESS,
    parseAccount: (value) => parseSolanaRpcAccount(value, { maxEncodedBytes: 1024 }),
    label: 'DELIVERY_LOOKUP_TABLE',
    missing: 'error',
    inactive: 'error',
    configurationError: (message) => new Error(message),
  };
}

test('blockhash readers retain confirmed RPC arguments and their distinct output shapes', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const options = {
    rpc: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return { context: { slot: 123 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 456 } };
    },
    invalidResponse: () => new Error('Invalid blockhash'),
  };
  assert.equal(await readLatestBlockhash(options), BLOCKHASH);
  assert.deepEqual(await readLatestBlockhashWithContext(options), {
    blockhash: BLOCKHASH,
    blockhashContextSlot: 123,
  });
  assert.deepEqual(calls, [
    { method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] },
    { method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] },
  ]);
});

test('key-only blockhash reads preserve compatibility without context or expiry', async () => {
  for (const blockhash of [BLOCKHASH, PublicKey.default.toBase58()]) {
    assert.equal(await readLatestBlockhash({
      rpc: async () => ({ value: { blockhash } }),
      invalidResponse: () => assert.fail('unexpected blockhash error'),
    }), blockhash);
  }
});

test('both blockhash readers retain supplied errors for invalid blockhash values', async () => {
  const failure = new Error('Domain blockhash error');
  for (const read of [readLatestBlockhash, readLatestBlockhashWithContext]) {
    for (const blockhash of [undefined, null, '', 123, 'invalid', '1']) {
      await assert.rejects(read({
        rpc: async () => ({ context: { slot: 0 }, value: { blockhash, lastValidBlockHeight: 0 } }),
        invalidResponse: () => failure,
      }), (error) => error === failure);
    }
  }
});

test('strict blockhash reads reject invalid context, expiry, and zero hashes', async () => {
  const failure = new Error('Domain blockhash context error');
  const result = { context: { slot: 0 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 0 } };
  const malformed: unknown[] = [
    null,
    {},
    { value: result.value },
    { ...result, value: { ...result.value, blockhash: PublicKey.default.toBase58() } },
  ];
  for (const value of [undefined, null, '0', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    malformed.push(
      { ...result, context: { slot: value } },
      { ...result, value: { ...result.value, lastValidBlockHeight: value } },
    );
  }
  for (const value of malformed) {
    await assert.rejects(readLatestBlockhashWithContext({
      rpc: async () => value,
      invalidResponse: () => failure,
    }), (error) => error === failure);
  }
  assert.deepEqual(await readLatestBlockhashWithContext({
    rpc: async () => result,
    invalidResponse: () => failure,
  }), { blockhash: BLOCKHASH, blockhashContextSlot: 0 });
});

test('lookup reads skip unconfigured addresses and decode confirmed base64 accounts', async () => {
  assert.deepEqual(await readSolanaLookupTable({
    ...lookupOptions(undefined),
    address: undefined,
    rpc: async () => assert.fail('unconfigured lookup should not fetch'),
  }), []);

  const calls: Array<{ method: string; params: unknown }> = [];
  const tables = await readSolanaLookupTable({
    ...lookupOptions(undefined),
    rpc: async (method, params) => {
      calls.push({ method, params });
      return { value: lookupAccount() };
    },
  });
  assert.deepEqual(calls, [{
    method: 'getAccountInfo',
    params: [ADDRESS.toBase58(), { commitment: 'confirmed', encoding: 'base64' }],
  }]);
  assert.equal(tables.length, 1);
  assert.ok(tables[0].key.equals(ADDRESS));
  assert.ok(tables[0].state.addresses[0].equals(MEMBER));
  assert.equal(tables[0].isActive(), true);
});

test('lookup missing-account policies preserve absent and falsy response handling', async () => {
  const failure = new Error('Required lookup missing');
  for (const result of [null, {}, { value: null }, { value: false }, { value: 0 }]) {
    const options = lookupOptions(result);
    assert.deepEqual(await readSolanaLookupTable({ ...options, missing: 'empty' }), []);
    await assert.rejects(readSolanaLookupTable({
      ...options,
      configurationError: (message) => {
        assert.equal(message, 'DELIVERY_LOOKUP_TABLE not found on-chain.');
        return failure;
      },
    }), (error) => error === failure);
  }
});

test('lookup inactive policies independently allow, omit, or reject the decoded table', async () => {
  const options = lookupOptions({ value: lookupAccount(1n) });
  const tables = await readSolanaLookupTable({ ...options, inactive: 'allow' });
  assert.equal(tables.length, 1);
  assert.equal(tables[0].isActive(), false);
  assert.deepEqual(await readSolanaLookupTable({ ...options, inactive: 'empty' }), []);
  await assert.rejects(readSolanaLookupTable(options), {
    message: 'DELIVERY_LOOKUP_TABLE is inactive.',
  });
});

test('lookup ownership and decoding failures retain distinct configuration errors', async () => {
  await assert.rejects(readSolanaLookupTable(lookupOptions({
    value: { ...lookupAccount(), owner: PublicKey.default.toBase58() },
  })), { message: 'DELIVERY_LOOKUP_TABLE has an unexpected owner.' });
  await assert.rejects(readSolanaLookupTable(lookupOptions({
    value: { ...lookupAccount(), data: [Buffer.alloc(1).toString('base64'), 'base64'] },
  })), { message: 'DELIVERY_LOOKUP_TABLE is invalid.' });
});

test('shared readers preserve RPC and account-parser failures without reclassification', async () => {
  const cancellation = new DOMException('Client disconnected', 'AbortError');
  for (const failure of [
    new Error('Provider unavailable'),
    cancellation,
    new Error('Lookup interrupted', { cause: cancellation }),
  ]) {
    const rpc = async () => { throw failure; };
    const invalidResponse = () => assert.fail('RPC failures must not become validation failures');
    await assert.rejects(readLatestBlockhash({ rpc, invalidResponse }), (error) => error === failure);
    await assert.rejects(readLatestBlockhashWithContext({ rpc, invalidResponse }), (error) => error === failure);
    await assert.rejects(readSolanaLookupTable({
      ...lookupOptions({ value: lookupAccount() }),
      rpc,
      configurationError: invalidResponse,
    }), (error) => error === failure);
    await assert.rejects(readSolanaLookupTable({
      ...lookupOptions({ value: lookupAccount() }),
      parseAccount: () => { throw failure; },
      configurationError: invalidResponse,
    }), (error) => error === failure);
  }
});
