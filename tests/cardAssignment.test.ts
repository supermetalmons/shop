import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureIrlClaimCodeForBox } from '../functions/src/cardAssignment.ts';

const ownerWallet = '11111111111111111111111111111111';
const dropRuntime = {
  dropId: 'card_nft_2',
  config: { dropFamily: 'card_nft_2' },
  itemsPerBox: 3,
  maxDudeId: 100,
};

function fakeTransactionalDb(initial: Record<string, any>) {
  const store = new Map(Object.entries(initial));
  const writes: Array<{ path: string; data: any; options?: any }> = [];
  const doc = (path: string) => ({ path });
  const snap = (path: string) => ({
    exists: store.has(path),
    data: () => store.get(path),
    ref: { path },
  });
  return {
    writes,
    doc,
    runTransaction: async (fn: (tx: any) => Promise<unknown>) =>
      fn({
        get: async (ref: { path: string }) => snap(ref.path),
        set: (ref: { path: string }, data: any, options?: any) => {
          writes.push({ path: ref.path, data, options });
          store.set(ref.path, { ...(store.get(ref.path) || {}), ...data });
        },
      }),
  };
}

test('ensureIrlClaimCodeForBox backfills a same-box legacy claim code instead of replacing it', async () => {
  const db = fakeTransactionalDb({
    'drops/card_nft_2/boxAssignments/receipt-asset': {
      dudeIds: [1, 2, 3],
      irlClaimCode: '1234567890',
    },
    'claimCodes/1234567890': {
      version: 1,
      dropId: 'card_nft_2',
      boxId: 8,
      boxAssetId: 'receipt-asset',
    },
  });

  const code = await ensureIrlClaimCodeForBox({
    db: db as any,
    dropRuntime,
    ownerWallet,
    deliveryId: 99,
    boxAssetId: 'receipt-asset',
    boxId: 8,
    dudeIds: [1, 2, 3],
  });

  assert.equal(code, '1234567890');
  assert.equal(db.writes.some((write) => write.path === 'claimCodes/1234567890' && write.data.deliveryId === 99), true);
  assert.equal(db.writes.filter((write) => write.path.startsWith('claimCodes/')).length, 1);
});

test('ensureIrlClaimCodeForBox fails same-box claim code conflicts instead of allocating a second code', async () => {
  const db = fakeTransactionalDb({
    'drops/card_nft_2/boxAssignments/receipt-asset': {
      dudeIds: [1, 2, 3],
      irlClaimCode: '1234567890',
    },
    'claimCodes/1234567890': {
      version: 2,
      namespace: 'irl_v2',
      code: '1234567890',
      dropId: 'card_nft_2',
      boxId: 8,
      boxAssetId: 'receipt-asset',
      deliveryId: 99,
      dudeIds: [4, 5, 6],
    },
  });

  await assert.rejects(
    () =>
      ensureIrlClaimCodeForBox({
        db: db as any,
        dropRuntime,
        ownerWallet,
        deliveryId: 99,
        boxAssetId: 'receipt-asset',
        boxId: 8,
        dudeIds: [1, 2, 3],
      }),
    /manual review required/,
  );
  assert.equal(db.writes.length, 0);
});
