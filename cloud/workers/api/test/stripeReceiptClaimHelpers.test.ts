import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { MPL_NOOP_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.ts';
import { buildRuntime as buildAdminIrlRedeemRuntime } from '../src/adminIrlRedeemRuntime.ts';
import { getApiDrop } from '../src/dropConfig.ts';
import { buildWithOptionalLookupTable, claimFlowFor } from '../src/stripeReceiptClaimOnchain.ts';
import { canonicalRecipient, normalizedCode, readRequestBody } from '../src/stripeReceiptClaimRequest.ts';
import { responseForClaim } from '../src/stripeReceiptClaimResult.ts';
import { StripeReceiptClaimError } from '../src/stripeReceiptClaimErrors.ts';

const CODE = 'ABCDEF-1234567890';
const DROP_ID = 'card_nft_2';
const DELIVERY_ID = 7;
const BOX_ID = 16;
const RECIPIENT = Keypair.generate().publicKey.toBase58();
const RECEIPT_ASSET_ID = Keypair.generate().publicKey.toBase58();
const SIGNATURE = 'receipt-signature';

test('receipt request parsing accepts only the bounded exact JSON contract', async () => {
  const body = { code: CODE, recipient: RECIPIENT };
  const request = (value: string, contentType = 'application/json') => new Request('https://api.mons.shop/receipts/stripe/claim', {
    method: 'POST', headers: { 'Content-Type': contentType }, body: value,
  });
  assert.deepEqual(await readRequestBody(request(JSON.stringify(body)), new AbortController().signal), body);
  for (const value of ['{', 'null', '[]', JSON.stringify({ code: CODE }), JSON.stringify({ ...body, extra: true }),
    JSON.stringify({ ...body, code: '' }), JSON.stringify({ ...body, recipient: 'short' }), ' '.repeat(1025)]) {
    await assert.rejects(readRequestBody(request(value), new AbortController().signal), { code: 'invalid-argument' });
  }
  await assert.rejects(readRequestBody(request(JSON.stringify(body), 'text/plain'), new AbortController().signal), {
    code: 'invalid-argument', message: 'Content-Type must be application/json.',
  });
});

test('receipt request identity helpers reject invalid claim codes and recipient wallets', () => {
  assert.equal(normalizedCode(CODE), CODE);
  assert.equal(canonicalRecipient(RECIPIENT).wallet, RECIPIENT);
  assert.ok(canonicalRecipient(RECIPIENT).key.equals(new PublicKey(RECIPIENT)));
  for (const code of ['', 'not-a-code', 'ABCDEF-123456789!']) {
    assert.throws(() => normalizedCode(code), { code: 'invalid-argument' });
  }
  for (const recipient of ['', ` ${RECIPIENT}`, '0'.repeat(44)]) {
    assert.throws(() => canonicalRecipient(recipient), { code: 'invalid-argument' });
  }
});

function sizedClaimTransaction(instructionBytes: number): VersionedTransaction {
  const signer = Keypair.generate();
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [new TransactionInstruction({
      programId: new PublicKey(MPL_NOOP_PROGRAM_ADDRESS),
      keys: [],
      data: Buffer.alloc(instructionBytes),
    })],
  }).compileToV0Message());
  transaction.sign([signer]);
  return transaction;
}

test('Stripe receipt claim lookup fallback preserves cancellation', async (context) => {
  const drop = getApiDrop(DROP_ID);
  assert.ok(drop);
  const lookupKey = Keypair.generate().publicKey;
  const runtime = buildAdminIrlRedeemRuntime({ ...drop, deliveryLookupTable: lookupKey.toBase58() });
  for (const wrapped of [false, true]) {
    await context.test(wrapped ? 'wrapped cancellation' : 'direct cancellation', async () => {
      const controller = new AbortController();
      const reason = new Error('client disconnected during receipt lookup');
      let lookupCalls = 0;
      await assert.rejects(buildWithOptionalLookupTable({
        provider: {
          apiKey: 'helius-test-key',
          signal: controller.signal,
          providerFetch: async (_input, init) => {
            const request = JSON.parse(String(init?.body));
            assert.equal(request.method, 'getAccountInfo');
            assert.equal(request.params[0], lookupKey.toBase58());
            lookupCalls += 1;
            controller.abort(reason);
            throw wrapped ? new Error('lookup aborted', { cause: reason }) : reason;
          },
        },
        runtime,
        build: () => sizedClaimTransaction(1100),
        encodeTooLargeMessage: 'Receipt claim transaction is too large to encode.',
        packetTooLargeMessage: (rawBytes) => `Receipt claim transaction too large (${rawBytes} bytes > 1232).`,
      }), (error: unknown) => error === reason);
      assert.equal(lookupCalls, 1);
    });
  }
});

test('Stripe receipt claim lookup fallback preserves domain sizing errors', async (context) => {
  const drop = getApiDrop(DROP_ID);
  assert.ok(drop);
  const runtime = buildAdminIrlRedeemRuntime({ ...drop, deliveryLookupTable: '' });
  for (const instructionBytes of [1100, 1400]) {
    await context.test(instructionBytes === 1100 ? 'packet size' : 'encoding overflow', async () => {
      const rawBytes = instructionBytes === 1100 ? sizedClaimTransaction(instructionBytes).serialize().length : undefined;
      await assert.rejects(buildWithOptionalLookupTable({
        provider: {
          apiKey: 'helius-test-key',
          signal: new AbortController().signal,
          providerFetch: async () => assert.fail('no lookup table is configured'),
        },
        runtime,
        build: () => sizedClaimTransaction(instructionBytes),
        encodeTooLargeMessage: 'Direct card receipt claim transaction is too large to encode.',
        packetTooLargeMessage: (size) => `Direct card receipt claim transaction too large (${size} bytes > 1232).`,
      }), (error: unknown) => {
        assert.ok(error instanceof StripeReceiptClaimError);
        assert.equal(error.code, 'failed-precondition');
        assert.equal(error.message, rawBytes === undefined
          ? 'Direct card receipt claim transaction is too large to encode.'
          : `Direct card receipt claim transaction too large (${rawBytes} bytes > 1232).`);
        assert.deepEqual(error.details, rawBytes === undefined ? undefined : { rawBytes, maxRawBytes: 1232 });
        return true;
      });
    });
  }
});

test('Stripe receipt claim selects legacy, openable, and direct flows', () => {
  assert.equal(claimFlowFor(undefined, 0), 'legacy_pack');
  assert.equal(claimFlowFor(undefined, 1), 'openable_pack');
  assert.equal(claimFlowFor({ receiptAssetId: RECEIPT_ASSET_ID, figureId: BOX_ID }, 0), 'direct_figure');
});

test('Stripe receipt claim response preserves figure counts and transaction evidence', async () => {
  assert.deepEqual(responseForClaim({
    dropId: DROP_ID,
    deliveryId: DELIVERY_ID,
    receiptTxs: [SIGNATURE, SIGNATURE],
    receiptKind: 'figure',
    figureIds: [1, 2, 3],
  }), {
    processed: true,
    dropId: DROP_ID,
    deliveryId: DELIVERY_ID,
    receiptsTransferred: 3,
    receiptTxs: [SIGNATURE, SIGNATURE],
    receiptKind: 'figure',
    figureIds: [1, 2, 3],
  });
});
