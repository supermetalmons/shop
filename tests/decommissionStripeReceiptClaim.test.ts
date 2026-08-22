import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { decommissionFirebaseClaimStripeReceipt } from '../scripts/decommission-firebase-claim-stripe-receipt.ts';

const VERSION = '72bfa410-5c85-4e3c-b1e0-5ce0cfdb1108';
const RECIPIENT = Keypair.generate().publicKey.toBase58();
const SIGNATURE = bs58.encode(new Uint8Array(64).fill(7));

function environment() {
  return {
    STRIPE_RECEIPT_CLAIM_SMOKE_FIREBASE_TOKEN: 'firebase-token',
    STRIPE_RECEIPT_CLAIM_SMOKE_CODE: 'ABCDEF-1234567890',
    STRIPE_RECEIPT_CLAIM_SMOKE_RECIPIENT: RECIPIENT,
    STRIPE_RECEIPT_CLAIM_SMOKE_DROP_ID: 'card_nft_2',
    STRIPE_RECEIPT_CLAIM_SMOKE_DELIVERY_ID: '7',
    RETAINED_VALUE: 'retained',
  };
}

function response() {
  return {
    processed: true,
    dropId: 'card_nft_2',
    deliveryId: 7,
    receiptsTransferred: 1,
    receiptTxs: [SIGNATURE],
    receiptKind: 'box',
  };
}

function manifest(frontendVersionId = VERSION) {
  return {
    currentProduction: { apiVersionId: VERSION, frontendVersionId: VERSION },
    approvedRollback: { apiVersionId: VERSION, frontendVersionId },
  };
}

test('Stripe receipt claim decommission requires two identical production claims before deletion', async () => {
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  let childEnvironment: NodeJS.ProcessEnv | undefined;
  await decommissionFirebaseClaimStripeReceipt(environment(), {
    readManifest: () => manifest(),
    fetch: async (input, init) => {
      requests.push({ input: String(input), init });
      return Response.json(response());
    },
    runFirebaseDelete: (value) => { childEnvironment = value; },
  });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((entry) => entry.input === 'https://api.mons.shop/receipts/stripe/claim'));
  assert.ok(requests.every((entry) => new Headers(entry.init?.headers).get('authorization') === 'Bearer firebase-token'));
  assert.ok(requests.every((entry) => JSON.stringify(JSON.parse(String(entry.init?.body))) === JSON.stringify({
    code: 'ABCDEF-1234567890',
    recipient: RECIPIENT,
  })));
  assert.equal(childEnvironment?.RETAINED_VALUE, 'retained');
  for (const key of Object.keys(environment()).filter((key) => key.startsWith('STRIPE_RECEIPT_CLAIM_SMOKE_'))) {
    assert.equal(childEnvironment?.[key], undefined);
  }
});

test('Stripe receipt claim decommission rejects pre-cutover rollback metadata before smoke or deletion', async () => {
  let fetchCalled = false;
  let deleteCalled = false;
  await assert.rejects(() => decommissionFirebaseClaimStripeReceipt(environment(), {
    readManifest: () => manifest('d310f1bc-8ee3-4032-8360-ded742f2bec4'),
    fetch: async () => {
      fetchCalled = true;
      return Response.json(response());
    },
    runFirebaseDelete: () => { deleteCalled = true; },
  }), /Approved rollback/);
  assert.equal(fetchCalled, false);
  assert.equal(deleteCalled, false);
});

test('Stripe receipt claim decommission rejects malformed or non-idempotent responses', async () => {
  let deleteCalled = false;
  await assert.rejects(() => decommissionFirebaseClaimStripeReceipt(environment(), {
    readManifest: () => manifest(),
    fetch: async () => Response.json({ ...response(), deliveryId: 8 }),
    runFirebaseDelete: () => { deleteCalled = true; },
  }), /invalid receipt claim response/);
  assert.equal(deleteCalled, false);

  let calls = 0;
  await assert.rejects(() => decommissionFirebaseClaimStripeReceipt(environment(), {
    readManifest: () => manifest(),
    fetch: async () => Response.json({
      ...response(),
      receiptTxs: calls++ === 0 ? [SIGNATURE] : [SIGNATURE, bs58.encode(new Uint8Array(64).fill(8))],
    }),
    runFirebaseDelete: () => { deleteCalled = true; },
  }), /not idempotent/);
  assert.equal(deleteCalled, false);
});
