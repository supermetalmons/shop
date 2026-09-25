import assert from 'node:assert/strict';
import test from 'node:test';
import { Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { verifyArchivedPreorderAbsence } from '../scripts/shared/preorderArchive.ts';

function encoded(value: number, length = 32): string {
  const bytes = Buffer.alloc(length);
  bytes.writeUInt32LE(value);
  return bs58.encode(bytes);
}

const args = { signature: encoded(1, 64), blockhashContextSlot: 100, lastValidBlockHeight: 502, finalizedSlot: 1000 };
type Block = {
  blockhash: string; previousBlockhash: string; parentSlot: number; blockHeight: number;
  signatures: string[]; blockTime: number | null;
};

function fixture(slots = [100, 101, 103, 104]) {
  const blocks = new Map<number, Block>(slots.map((slot, index) => [slot, {
    blockhash: encoded(slot), previousBlockhash: encoded(index ? slots[index - 1] : 99),
    parentSlot: index ? slots[index - 1] : 99, blockHeight: 500 + index,
    signatures: [encoded(slot, 64)], blockTime: null,
  }]));
  const calls: Array<[number, number]> = [];
  const fetched: number[] = [];
  const connection = {
    getBlocks: async (start: number, end: number, commitment: string) => {
      assert.equal(commitment, 'finalized');
      calls.push([start, end]);
      return slots.filter((slot) => slot >= start && slot <= end);
    },
    getBlockSignatures: async (slot: number, commitment: string) => {
      assert.equal(commitment, 'finalized');
      fetched.push(slot);
      return blocks.get(slot)!;
    },
  };
  return { blocks, calls, fetched, connection };
}

test('archive absence requires a linked finalized chain beyond the entire validity window', async () => {
  const h = fixture();
  assert.equal(await verifyArchivedPreorderAbsence(h.connection, args), true);
  assert.deepEqual(h.fetched, [100, 101, 103, 104]);
  assert.deepEqual(h.calls, [[100, 355]]);
});

test('archive scans handle skipped context slots and empty pages while retaining parent continuity', async () => {
  const h = fixture([102, 700, 701, 703]);
  assert.equal(await verifyArchivedPreorderAbsence(h.connection, args), true);
  assert.deepEqual(h.calls, [[100, 355], [356, 611], [612, 867]]);
});

test('any occurrence of the transaction signature prevents absence resolution', async () => {
  for (const slot of [100, 101, 103, 104]) {
    const h = fixture();
    h.blocks.get(slot)!.signatures.push(args.signature);
    assert.equal(await verifyArchivedPreorderAbsence(h.connection, args), false);
  }
});

test('archive enumeration cannot omit initial or intermediate produced blocks', async () => {
  for (const missing of [100, 101, 103]) {
    const h = fixture();
    const enumerate = h.connection.getBlocks;
    h.connection.getBlocks = async (...values) => (await enumerate(...values)).filter((slot) => slot !== missing);
    assert.equal(await verifyArchivedPreorderAbsence(h.connection, args), false);
  }
});

test('archive block parent, hash, and height mismatches fail closed', async () => {
  for (const patch of [
    { parentSlot: 99 }, { previousBlockhash: encoded(98) }, { blockHeight: 502 },
    { blockHeight: null }, { parentSlot: 101 }, { blockhash: '' },
    { signatures: undefined }, { signatures: ['invalid'] },
  ]) {
    const h = fixture();
    Object.assign(h.blocks.get(101)!, patch);
    assert.equal(await verifyArchivedPreorderAbsence(h.connection, args), false);
  }
  const h = fixture();
  h.connection.getBlockSignatures = async () => null!;
  assert.equal(await verifyArchivedPreorderAbsence(h.connection, args), false);
});

test('archive slot lists must be ordered, unique, and contained in the requested page', async () => {
  for (const slots of [[101, 100], [100, 100], [99], [356], [100.5], [NaN], [Infinity]]) {
    const h = fixture();
    h.connection.getBlocks = async () => slots;
    assert.equal(await verifyArchivedPreorderAbsence(h.connection, args), false);
    assert.deepEqual(h.fetched, []);
  }
});

test('incomplete history cannot resolve absence at or before the last valid height', async () => {
  const h = fixture();
  assert.equal(await verifyArchivedPreorderAbsence(h.connection, { ...args, finalizedSlot: 103 }), false);
  assert.deepEqual(h.calls, [[100, 103]]);
  const truncated = fixture([100, 101, 103]);
  assert.equal(await verifyArchivedPreorderAbsence(truncated.connection, args), false);
});

test('archive scanning is capped at 4096 slots rather than covering the entire outage', async () => {
  const h = fixture([100]);
  assert.equal(await verifyArchivedPreorderAbsence(h.connection, { ...args, finalizedSlot: 1_000_000 }), false);
  assert.equal(h.calls.length, 16);
  assert.deepEqual(h.calls.at(-1), [3940, 4195]);
});

test('invalid archive proof inputs are rejected before reading RPC data', async () => {
  for (const patch of [
    { signature: '' }, { blockhashContextSlot: -1 }, { blockhashContextSlot: 0.5 },
    { lastValidBlockHeight: NaN }, { finalizedSlot: Infinity }, { finalizedSlot: 99 },
  ]) {
    const h = fixture();
    assert.equal(await verifyArchivedPreorderAbsence(h.connection, { ...args, ...patch }), false);
    assert.deepEqual(h.calls, []);
  }
});

test('archive provider failures preserve an unresolved outcome', async () => {
  for (const method of ['getBlocks', 'getBlockSignatures'] as const) {
    const h = fixture();
    h.connection[method] = async () => { throw new Error('Archive unavailable'); };
    await assert.rejects(verifyArchivedPreorderAbsence(h.connection, args), /Archive unavailable/);
  }
});

test('the installed Solana SDK retains blockHeight in signature-only archive responses', async () => {
  const h = fixture();
  const connection = new Connection('https://archive.invalid', { fetch: async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    let result: unknown;
    if (request.method === 'getBlocks') {
      result = await h.connection.getBlocks(request.params[0], request.params[1], request.params[2].commitment);
    } else {
      assert.equal(request.method, 'getBlock');
      assert.deepEqual(request.params[1], { commitment: 'finalized', transactionDetails: 'signatures', rewards: false });
      result = await h.connection.getBlockSignatures(request.params[0], request.params[1].commitment);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  } });
  assert.equal(await verifyArchivedPreorderAbsence(connection, args), true);
});
