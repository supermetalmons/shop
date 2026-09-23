import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED, BOX_MINTER_CONFIG_DISCRIMINATOR } from '../../../../shared/boxMinterConfigCodec.ts';
import { MPL_CORE_PROGRAM_ADDRESS, MPL_NOOP_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.ts';
import { commerceKeys, D1CommerceRepository, type CommerceDocumentData } from '../src/commerceRepository.ts';
import { runtimeForDrop } from '../src/stripeReceiptClaim.ts';
import {
  broadcastReceiptClaimWorkflowTransaction, prepareReceiptClaimWorkflowTransaction,
  reconcileReceiptClaimWorkflowOnchain,
} from '../src/stripeReceiptClaimWorkflowOnchain.ts';
import {
  advanceReceiptClaimWorkflowGeneration, completeReceiptClaimWorkflow, failReceiptClaimWorkflow, loadReceiptClaimWorkflow,
  persistReceiptClaimWorkflowSubmission, reserveReceiptClaimWorkflow,
} from '../src/stripeReceiptClaimWorkflowStore.ts';
import type { ReceiptClaimWorkflowSubmission } from '../src/stripeReceiptClaimWorkflowState.ts';
import { ensureReceiptClaimWorkflowRunning } from '../src/stripeReceiptClaimWorkflowDispatch.ts';
import { receiptClaimWorkflowFailure } from '../src/stripeReceiptClaimWorkflowSupport.ts';
import { loadCloudflareWorkersModule } from './cloudflareWorkersTestLoader.ts';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';

const { runStripeReceiptClaimWorkflow } = await loadCloudflareWorkersModule(() => import('../src/stripeReceiptClaimWorkflow.ts'));

const CODE = 'ABCDEF-1234567890';
const RECIPIENT = Keypair.generate().publicKey.toBase58();
const ASSET = Keypair.generate().publicKey.toBase58();
const HASH = bs58.encode(Buffer.alloc(32, 7));
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

type Flow = ReceiptClaimWorkflowSubmission['target']['flow'];

function configAccounts(runtime: ReturnType<typeof runtimeForDrop>, signer: Keypair) {
  const integer = (value: number, bytes: 4 | 8) => {
    const buffer = Buffer.alloc(bytes);
    if (bytes === 4) buffer.writeUInt32LE(value);
    else buffer.writeBigUInt64LE(BigInt(value));
    return buffer;
  };
  const string = (value: string) => Buffer.concat([integer(Buffer.byteLength(value), 4), Buffer.from(value)]);
  const payload = Buffer.concat([
    Buffer.from(BOX_MINTER_CONFIG_DISCRIMINATOR), signer.publicKey.toBuffer(),
    new PublicKey(runtime.config.treasury).toBuffer(), runtime.collectionMint.toBuffer(),
    integer(1, 8), integer(1, 8), Buffer.alloc(32), integer(runtime.maxSupply, 4),
    Buffer.from([runtime.config.maxPerTx, runtime.itemsPerBox]), integer(0, 4),
    string(runtime.config.namePrefix), string(runtime.config.symbol), string(runtime.config.metadataBase),
    Buffer.from([1, 1, runtime.config.discountMintsPerWallet]), string(runtime.config.figureNamePrefix), Buffer.alloc(37),
  ]);
  const collectionData = Buffer.alloc(49);
  collectionData[0] = 5;
  return [
    { data: collectionData, owner: new PublicKey(MPL_CORE_PROGRAM_ADDRESS), executable: false, lamports: 1, rentEpoch: 0 },
    { data: Buffer.concat([payload, Buffer.alloc(BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED - payload.length)]), owner: runtime.boxMinterProgramId, executable: false, lamports: 1, rentEpoch: 0 },
  ];
}

async function fixture(t: TestContext, flow: Flow, legacyProcessing = false, receiptTxs: string[] = []) {
  const signer = Keypair.generate();
  const dropId = flow === 'legacy_pack' ? 'drifella_shirt' : 'card_nft_2';
  const runtime = runtimeForDrop(dropId);
  const harness = createCommerceD1Harness();
  const target: CommerceDocumentData = flow === 'direct_figure' ? { receiptKind: 'figure', receiptAssetId: ASSET, figureId: 7 } : {};
  const claim = {
    namespace: 'stripe_receipt_v1', code: CODE, dropId, deliveryId: 3, boxId: 7,
    status: legacyProcessing ? 'processing' : 'unclaimed',
    receiptTxs,
    ...(legacyProcessing ? { recipient: RECIPIENT, processingStartedAt: Date.now() - 600_000, processingLeaseExpiresAt: Date.now() - 500_000 } : {}),
    ...target,
  };
  seedCommerceDocument(harness, { key: commerceKeys.claimCode(CODE), data: claim });
  seedCommerceDocument(harness, {
    key: commerceKeys.deliveryOrder(dropId, '3'),
    data: { dropId, deliveryId: 3, source: 'stripe_offchain', stripeReceiptClaim: claim,
      irlClaims: flow === 'openable_pack' ? [{ boxId: 7, boxAssetId: ASSET, dudeIds: [19, 20, 21] }] : [] },
  });
  const context = { repository: new D1CommerceRepository(harness.db), nowMs: Date.now(), signal: AbortSignal.timeout(30_000) };
  const reserved = await reserveReceiptClaimWorkflow(context, CODE, RECIPIENT, context.nowMs, { requestId: crypto.randomUUID() });
  assert.equal(reserved.status, 'pending');
  if (reserved.status !== 'pending') throw new Error('Expected pending claim');
  const env = { COMMERCE_DB: harness.db, COSIGNER_SECRET: bs58.encode(signer.secretKey), HELIUS_API_KEY: 'test-key' };
  const asset = {
    id: ASSET, grouping: [{ group_key: 'collection', group_value: runtime.collectionMint.toBase58() }],
    content: { json_uri: `${runtime.config.metadataBase}/${flow === 'direct_figure' ? 'rf' : 'rb'}7.json` },
    ownership: { owner: signer.publicKey.toBase58() },
    compression: { leaf_id: 4, data_hash: HASH, creator_hash: HASH },
  };
  const chain = { height: 100 };
  const providerFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: string; method: string };
    const result = request.method === 'getBlockHeight' ? chain.height : request.method === 'getAsset' ? asset
      : request.method === 'getAssetProof' ? { tree_id: runtime.receiptsMerkleTree.toBase58(), root: HASH, proof: [] }
        : request.method === 'searchAssets' ? { total: 1, limit: 1000, page: 1, items: [asset] } : undefined;
    assert.ok(result, `Unexpected RPC ${request.method}`);
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  };
  t.mock.method(Connection.prototype, 'getMultipleAccountsInfo', async () => configAccounts(runtime, signer));
  t.mock.method(Connection.prototype, 'getLatestBlockhash', async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 200 }));
  const args = { env, snapshot: reserved.snapshot, signal: context.signal, providerFetch };
  const reload = async () => {
    const snapshot = await loadReceiptClaimWorkflow(context, reserved.snapshot.operation.operationId);
    assert.ok(snapshot);
    return { ...args, snapshot };
  };
  return { args, context, reload, harness, signer, runtime, chain, asset };
}

for (const flow of ['openable_pack', 'legacy_pack'] as const) {
  for (const retry of [false, true]) {
    test(`${flow} prepares an admin-owned receipt for a large receiver inventory on ${retry ? 'an explicit retry' : 'the first attempt'}`, async (t) => {
      const state = await fixture(t, flow);
      t.after(() => state.harness.database.close());
      if (retry) {
        await failReceiptClaimWorkflow(state.context, state.args.snapshot, {
          code: 'unavailable', message: 'Provider temporarily unavailable.', retryable: true,
        }, true);
        const resumed = await advanceReceiptClaimWorkflowGeneration(state.context, state.args.snapshot, Date.now(), {
          resetRetryWindow: true, requestId: crypto.randomUUID(),
        });
        assert.equal(resumed?.operation.generation, 2);
      }
      let receiverSearches = 0;
      const args = await state.reload();
      args.providerFetch = async (input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          id: string; method: string; params: { ownerAddress?: string; grouping?: unknown; page: number };
        };
        if (request.method !== 'searchAssets' || request.params.ownerAddress !== RECIPIENT) {
          return state.args.providerFetch(input, init);
        }
        receiverSearches += 1;
        const items = request.params.grouping ? [] : Array.from({ length: 1000 }, () => ({
          ownership: { owner: RECIPIENT }, content: { json_uri: 'https://unrelated.example/1.json' },
        }));
        return Response.json({ jsonrpc: '2.0', id: request.id, result: {
          page: request.params.page, limit: 1000, total: request.params.grouping ? 0 : 65_000, items,
        } });
      };
      assert.deepEqual(await reconcileReceiptClaimWorkflowOnchain(args), { status: 'prepare' });
      const prepared = await prepareReceiptClaimWorkflowTransaction(args);
      assert.equal(prepared.target.receiptAssetId, ASSET);
      assert.equal(receiverSearches, 0);
    });
  }
}

for (const flow of ['direct_figure', 'openable_pack', 'legacy_pack'] as const) {
  for (const retry of [false, true]) {
    test(`${flow} completes already-delivered receipts on ${retry ? 'an explicit retry' : 'the first attempt'} without a submission`, async (t) => {
      const state = await fixture(t, flow);
      t.after(() => state.harness.database.close());
      if (retry) {
        await failReceiptClaimWorkflow(state.context, state.args.snapshot, {
          code: 'unavailable', message: 'Receipt ownership is still resolving.', retryable: true,
        }, true);
        const resumed = await advanceReceiptClaimWorkflowGeneration(state.context, state.args.snapshot, Date.now(), {
          resetRetryWindow: true, requestId: crypto.randomUUID(),
        });
        assert.equal(resumed?.operation.generation, 2);
      }
      state.asset.ownership.owner = RECIPIENT;
      const args = await state.reload();
      if (flow === 'openable_pack') {
        const items = [19, 20, 21].map((id) => ({
          ...state.asset, id: Keypair.generate().publicKey.toBase58(),
          content: { json_uri: `${state.runtime.config.metadataBase}/rf${id}.json` },
        }));
        args.providerFetch = async (input, init) => {
          const request = JSON.parse(String(init?.body)) as { id: string; method: string };
          return request.method === 'searchAssets'
            ? Response.json({ jsonrpc: '2.0', id: request.id, result: { total: 3, limit: 1000, page: 1, items } })
            : state.args.providerFetch(input, init);
        };
      }
      const confirmed = await reconcileReceiptClaimWorkflowOnchain(args);
      if (confirmed.status !== 'complete') assert.fail('Expected ownership confirmation without preparing a transfer');
      assert.deepEqual(confirmed.result.receiptTxs, []);
      assert.equal(confirmed.result.receiptsTransferred, flow === 'openable_pack' ? 3 : 1);
      if (flow === 'direct_figure') assert.deepEqual(confirmed.result.receiptAssetIds, [ASSET]);
      await completeReceiptClaimWorkflow(state.context, args.snapshot, confirmed.result);
      const completed = (await state.reload()).snapshot;
      assert.equal(completed.operation.phase, 'complete');
      assert.equal(completed.operation.submission, undefined);
    });
  }
}

for (const flow of ['direct_figure', 'openable_pack', 'legacy_pack'] as const) {
  test(`${flow} can explicitly recover after correcting a signer mismatch before submission`, async (t) => {
    const state = await fixture(t, flow);
    t.after(() => state.harness.database.close());
    t.mock.method(console, 'log', () => undefined);
    let dispatches = 0;
    const env = {
      ...state.args.env,
      COSIGNER_SECRET: bs58.encode(Keypair.generate().secretKey),
      STRIPE_RECEIPT_CLAIM_WORKFLOW: { createBatch: async () => { dispatches += 1; return []; } },
    } as unknown as Env;
    const failed = await runStripeReceiptClaimWorkflow(env, {
      instanceId: `${state.args.snapshot.operation.operationId}-g1`, timestamp: new Date(),
      payload: { version: 1, operationId: state.args.snapshot.operation.operationId, generation: 1 },
    } as Parameters<typeof runStripeReceiptClaimWorkflow>[1], {
      do: async <T>(_name: string, config: unknown, action?: unknown): Promise<T> => {
        const callback = typeof config === 'function' ? config : action;
        if (typeof callback !== 'function') throw new Error('Expected Workflow step callback');
        return callback();
      },
      sleep: async () => assert.fail('Signer mismatch should fail before confirmation'),
    }, {
      reconcile: (args) => reconcileReceiptClaimWorkflowOnchain({ ...args, providerFetch: state.args.providerFetch }),
      prepare: (args) => prepareReceiptClaimWorkflowTransaction({ ...args, providerFetch: state.args.providerFetch }),
      broadcast: async () => assert.fail('Invalid signer must not broadcast'),
    });
    assert.equal(failed.status, 'failed');
    const stored = (await state.reload()).snapshot;
    assert.equal(stored.operation.error?.retryable, true);
    assert.equal(stored.operation.submission, undefined);
    assert.equal(stored.operation.recipient, RECIPIENT);
    env.COSIGNER_SECRET = state.args.env.COSIGNER_SECRET;
    const requestId = crypto.randomUUID();
    const reserved = await reserveReceiptClaimWorkflow(state.context, CODE, RECIPIENT, Date.now(), { requestId });
    if (reserved.status !== 'pending') throw new Error('Expected resumable claim');
    const resumed = await ensureReceiptClaimWorkflowRunning(env, reserved.snapshot, state.context.signal, requestId, { inspect: async () => 'terminal' });
    assert.equal(resumed.operation.operationId, stored.operation.operationId);
    assert.equal(resumed.operation.generation, 2);
    assert.equal(dispatches, 1);
    const prepared = await prepareReceiptClaimWorkflowTransaction({ ...state.args, env, snapshot: resumed });
    assert.equal(prepared.target.adminWallet, state.signer.publicKey.toBase58());
    await persistReceiptClaimWorkflowSubmission(state.context, resumed, prepared);
    t.mock.method(Connection.prototype, 'getSignatureStatuses', async () => ({
      context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
    }));
    const confirmed = await reconcileReceiptClaimWorkflowOnchain(await state.reload());
    if (confirmed.status !== 'complete') throw new Error('Expected successful recovery');
    await completeReceiptClaimWorkflow(state.context, (await state.reload()).snapshot, confirmed.result);
    assert.equal((await state.reload()).snapshot.operation.phase, 'complete');
  });
}

for (const flow of ['direct_figure', 'openable_pack'] as const) {
  for (const absence of ['rpc_null', 'rest_404', 'empty', 'root_only', 'tree_only', 'missing_path', 'null_path', 'non_array_path'] as const) {
    test(`${flow} explicitly recovers after temporary ${absence} receipt proof absence`, async (t) => {
      const state = await fixture(t, flow);
      t.after(() => state.harness.database.close());
      t.mock.method(console, 'log', () => undefined);
      let proofMissing = true;
      let proofRequests = 0;
      let restRequests = 0;
      const providerFetch: typeof fetch = async (input, init) => {
        const request = init?.body ? JSON.parse(String(init.body)) as { id: string; method: string } : null;
        if (proofMissing && request?.method === 'getAssetProof') {
          proofRequests += 1;
          const identity = { tree_id: state.runtime.receiptsMerkleTree.toBase58(), root: HASH };
          const result = {
            rpc_null: null,
            rest_404: {},
            empty: {},
            root_only: { root: HASH, proof: [] },
            tree_only: { tree_id: identity.tree_id, proof: [] },
            missing_path: identity,
            null_path: { ...identity, proof: null },
            non_array_path: { ...identity, proof: {} },
          }[absence];
          return Response.json({ jsonrpc: '2.0', id: request.id, ...(absence === 'rest_404'
            ? { error: { code: -32601, message: 'Method not found' } }
            : { result }) });
        }
        if (proofMissing && !request) {
          assert.equal(absence, 'rest_404');
          assert.ok(String(input).includes(`/assets/${ASSET}/proof?`));
          restRequests += 1;
          return new Response('Not found', { status: 404 });
        }
        return state.args.providerFetch(input, init);
      };
      let dispatches = 0;
      const env = {
        ...state.args.env,
        STRIPE_RECEIPT_CLAIM_WORKFLOW: { createBatch: async () => { dispatches += 1; return []; } },
      } as unknown as Env;
      const failed = await runStripeReceiptClaimWorkflow(env, {
        instanceId: `${state.args.snapshot.operation.operationId}-g1`, timestamp: new Date(),
        payload: { version: 1, operationId: state.args.snapshot.operation.operationId, generation: 1 },
      } as Parameters<typeof runStripeReceiptClaimWorkflow>[1], {
        do: async <T>(_name: string, config: unknown, action?: unknown): Promise<T> => {
          const callback = typeof config === 'function' ? config : action;
          if (typeof callback !== 'function') throw new Error('Expected Workflow step callback');
          const limit = typeof config === 'object' && config !== null
            ? (config as { retries: { limit: number } }).retries.limit : 0;
          for (let attempt = 0; ; attempt += 1) {
            try { return await callback(); }
            catch (error) { if (attempt >= limit) throw error; }
          }
        },
        sleep: async () => assert.fail('Missing proof should fail before confirmation'),
      }, {
        reconcile: (args) => reconcileReceiptClaimWorkflowOnchain({ ...args, providerFetch }),
        prepare: (args) => prepareReceiptClaimWorkflowTransaction({ ...args, providerFetch }),
        broadcast: async () => assert.fail('Missing proof must not broadcast'),
      });
      assert.equal(failed.status, 'failed');
      const stored = (await state.reload()).snapshot;
      assert.equal(stored.operation.error?.code, 'unavailable');
      assert.equal(stored.operation.error?.retryable, true);
      assert.equal(stored.operation.submission, undefined);
      assert.equal(stored.operation.recipient, RECIPIENT);
      assert.equal(proofRequests, 5);
      assert.equal(restRequests, absence === 'rest_404' ? 5 : 0);

      proofMissing = false;
      const requestId = crypto.randomUUID();
      const reserved = await reserveReceiptClaimWorkflow(state.context, CODE, RECIPIENT, Date.now(), { requestId });
      if (reserved.status !== 'pending') throw new Error('Expected resumable claim');
      const resumed = await ensureReceiptClaimWorkflowRunning(env, reserved.snapshot, state.context.signal, requestId, { inspect: async () => 'terminal' });
      assert.equal(resumed.operation.operationId, stored.operation.operationId);
      assert.equal(resumed.operation.generation, 2);
      assert.equal(resumed.operation.recipient, RECIPIENT);
      assert.equal(dispatches, 1);
      const prepared = await prepareReceiptClaimWorkflowTransaction({ ...state.args, env, snapshot: resumed, providerFetch });
      assert.equal(prepared.status, 'prepared');
      assert.equal(prepared.target.receiptAssetId, ASSET);
      assert.equal(prepared.target.adminWallet, state.signer.publicKey.toBase58());
    });
  }

  for (const mismatch of ['tree', 'metadata'] as const) {
    test(`${flow} still rejects genuine ${mismatch} identity mismatches`, async (t) => {
      const state = await fixture(t, flow);
      t.after(() => state.harness.database.close());
      if (mismatch === 'metadata') state.asset.content.json_uri = `${state.runtime.config.metadataBase}/rf8.json`;
      const providerFetch: typeof fetch = async (input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: string; method: string };
        if (mismatch === 'tree' && request.method === 'getAssetProof') {
          return Response.json({ jsonrpc: '2.0', id: request.id, result: {
            tree_id: Keypair.generate().publicKey.toBase58(), root: HASH, proof: [],
          } });
        }
        return state.args.providerFetch(input, init);
      };
      await assert.rejects(prepareReceiptClaimWorkflowTransaction({ ...state.args, providerFetch }), (error) => {
        const failure = receiptClaimWorkflowFailure(error);
        assert.equal(failure.code, 'failed-precondition');
        assert.equal(failure.retryable, false);
        return true;
      });
      assert.equal((await state.reload()).snapshot.operation.submission, undefined);
    });
  }
}

test('a persisted submission target mismatch remains nonretryable', async (t) => {
  const state = await fixture(t, 'direct_figure');
  t.after(() => state.harness.database.close());
  const submission = await prepareReceiptClaimWorkflowTransaction(state.args);
  await persistReceiptClaimWorkflowSubmission(state.context, state.args.snapshot, {
    ...submission, target: { ...submission.target, programId: Keypair.generate().publicKey.toBase58() },
  });
  await assert.rejects(reconcileReceiptClaimWorkflowOnchain(await state.reload()), { code: 'failed-precondition' });
});

test('an adopted direct claim without a journal transfers the exact admin-owned receipt to its original receiver', async (t) => {
  const state = await fixture(t, 'direct_figure', true);
  assert.equal(state.args.snapshot.started.resumingPreviousProcessingClaim, true);
  assert.deepEqual(state.args.snapshot.started.receiptTxs, []);
  await assert.rejects(reserveReceiptClaimWorkflow(state.context, CODE, Keypair.generate().publicKey.toBase58(), Date.now()), /original receiver/);
  assert.deepEqual(await reconcileReceiptClaimWorkflowOnchain(state.args), { status: 'prepare' });
  const submission = await prepareReceiptClaimWorkflowTransaction(state.args);
  assert.equal(submission.target.receiptAssetId, ASSET);
  await persistReceiptClaimWorkflowSubmission(state.context, state.args.snapshot, submission);
  let broadcasts = 0;
  t.mock.method(Connection.prototype, 'sendRawTransaction', async (bytes: Uint8Array) => {
    assert.equal(Buffer.from(bytes).toString('base64'), (await state.reload()).snapshot.operation.submission?.signedTransactionBase64);
    broadcasts += 1;
    return submission.signature;
  });
  await broadcastReceiptClaimWorkflowTransaction(await state.reload());
  t.mock.method(Connection.prototype, 'getSignatureStatuses', async () => ({
    context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
  }));
  const confirmed = await reconcileReceiptClaimWorkflowOnchain(await state.reload());
  assert.equal(confirmed.status, 'complete');
  if (confirmed.status !== 'complete') throw new Error('Expected confirmation');
  await completeReceiptClaimWorkflow(state.context, (await state.reload()).snapshot, confirmed.result);
  assert.equal((await state.reload()).snapshot.operation.recipient, RECIPIENT);
  assert.equal((await state.reload()).snapshot.operation.phase, 'complete');
  assert.equal(broadcasts, 1);
});

test('an adopted direct claim without a journal waits when exact admin ownership is not established', async (t) => {
  const state = await fixture(t, 'direct_figure', true);
  state.asset.ownership.owner = Keypair.generate().publicKey.toBase58();
  assert.deepEqual(await reconcileReceiptClaimWorkflowOnchain(state.args), { status: 'pending' });
  assert.equal((await state.reload()).snapshot.operation.submission, undefined);
});

for (const recovery of ['replacement', 'verified_legacy'] as const) {
  test(`direct ${recovery} recovery excludes rejected legacy signatures from completion and order history`, async (t) => {
    const state = await fixture(t, 'direct_figure', true);
    const rejected = bs58.encode(Buffer.alloc(64, 21));
    const successful = await prepareReceiptClaimWorkflowTransaction(state.args);
    const submittedAtMs = Date.now() - 300_000;
    const legacySignatures = recovery === 'verified_legacy' ? [successful.signature, rejected] : [rejected];
    await state.context.repository.run(Date.now(), async (unit) => {
      const key = commerceKeys.claimCode(CODE);
      await unit.get(key);
      await unit.update(key, {
        receiptTxs: legacySignatures,
        receiptTxSubmissions: legacySignatures.map((signature) => ({
          signature, submittedAtMs, lastValidBlockHeight: 90, status: 'submitted',
        })),
      });
    });
    const transaction = VersionedTransaction.deserialize(Buffer.from(successful.signedTransactionBase64, 'base64'));
    const eventData = Buffer.alloc(41);
    eventData[0] = 1;
    eventData.writeUInt32LE(35, 2);
    eventData[6] = 1;
    eventData[7] = 1;
    eventData[8] = 1;
    new PublicKey(ASSET).toBuffer().copy(eventData, 9);
    const noopIndex = transaction.message.staticAccountKeys.findIndex((key) => key.toBase58() === MPL_NOOP_PROGRAM_ADDRESS);
    const inspected: string[] = [];
    t.mock.method(Connection.prototype, 'getTransaction', async (signature: string) => {
      inspected.push(signature);
      return {
        slot: 1, blockTime: null, transaction: { message: transaction.message, signatures: [signature] },
        meta: { err: signature === rejected ? { InstructionError: [0, 'InvalidArgument'] } : null,
          fee: 0, preBalances: [], postBalances: [], loadedAddresses: { writable: [], readonly: [] },
          innerInstructions: [{ index: 1, instructions: [{ programIdIndex: noopIndex, accounts: [], data: bs58.encode(eventData) }] }] },
      };
    });
    let confirmed = await reconcileReceiptClaimWorkflowOnchain(await state.reload());
    assert.deepEqual(inspected, [...legacySignatures].reverse());
    if (recovery === 'replacement') {
      assert.deepEqual(confirmed, { status: 'prepare' });
      const submission = await prepareReceiptClaimWorkflowTransaction(await state.reload());
      await persistReceiptClaimWorkflowSubmission(state.context, (await state.reload()).snapshot, submission);
      t.mock.method(Connection.prototype, 'getSignatureStatuses', async () => ({
        context: { slot: 1 }, value: [{ slot: 1, confirmations: null, err: null, confirmationStatus: 'finalized' }],
      }));
      confirmed = await reconcileReceiptClaimWorkflowOnchain(await state.reload());
    } else {
      assert.equal((await state.reload()).snapshot.operation.submission, undefined);
    }
    assert.equal(confirmed.status, 'complete');
    if (confirmed.status !== 'complete') throw new Error('Expected confirmation');
    assert.deepEqual(confirmed.result.receiptTxs, [successful.signature]);
    await completeReceiptClaimWorkflow(state.context, (await state.reload()).snapshot, confirmed.result);
    const claim = await state.context.repository.get(commerceKeys.claimCode(CODE));
    const order = await state.context.repository.get(commerceKeys.deliveryOrder('card_nft_2', '3'));
    assert.deepEqual(claim?.data.receiptTxs, [successful.signature]);
    assert.deepEqual((order?.data.stripeReceiptClaim as Record<string, unknown>).receiptTxs, [successful.signature]);
    assert.deepEqual((await state.reload()).snapshot.operation.result?.receiptTxs, [successful.signature]);
    assert.equal((claim?.data.receiptTxSubmissions as Array<{ signature: string; status: string }>).find((entry) => entry.signature === rejected)?.status, 'not_landed');
  });
}

test('direct recipient ownership recovery settles rejected legacy evidence before completion', async (t) => {
  const state = await fixture(t, 'direct_figure', true);
  const rejected = bs58.encode(Buffer.alloc(64, 21));
  state.asset.ownership.owner = RECIPIENT;
  await state.context.repository.run(Date.now(), async (unit) => {
    const key = commerceKeys.claimCode(CODE);
    await unit.get(key);
    await unit.update(key, {
      receiptTxs: [rejected],
      receiptTxSubmissions: [{ signature: rejected, submittedAtMs: Date.now() - 300_000, lastValidBlockHeight: 90, status: 'submitted' }],
    });
  });
  t.mock.method(Connection.prototype, 'getTransaction', async () => ({ meta: { err: { InstructionError: [0, 'InvalidArgument'] } } }));
  const confirmed = await reconcileReceiptClaimWorkflowOnchain(await state.reload());
  assert.equal(confirmed.status, 'complete');
  if (confirmed.status !== 'complete') throw new Error('Expected ownership confirmation');
  assert.deepEqual(confirmed.result.receiptTxs, []);
  assert.equal((await state.reload()).snapshot.operation.submission, undefined);
  await completeReceiptClaimWorkflow(state.context, (await state.reload()).snapshot, confirmed.result);
  const claim = await state.context.repository.get(commerceKeys.claimCode(CODE));
  const order = await state.context.repository.get(commerceKeys.deliveryOrder('card_nft_2', '3'));
  assert.deepEqual(claim?.data.receiptTxs, []);
  assert.deepEqual((order?.data.stripeReceiptClaim as Record<string, unknown>).receiptTxs, []);
  assert.deepEqual((await state.reload()).snapshot.operation.result?.receiptTxs, []);
  assert.equal((claim?.data.receiptTxSubmissions as Array<{ status: string }>)[0].status, 'not_landed');
});

test('an adopted openable pack without a journal recovers its exact assigned receipt after an explicit retry', async (t) => {
  const state = await fixture(t, 'openable_pack', true);
  t.after(() => state.harness.database.close());
  assert.deepEqual(await reconcileReceiptClaimWorkflowOnchain(state.args), { status: 'prepare' });
  await failReceiptClaimWorkflow(state.context, state.args.snapshot, {
    code: 'deadline-exceeded', message: 'Receipt claim timed out.', retryable: true,
  }, true);
  const resumed = await advanceReceiptClaimWorkflowGeneration(state.context, (await state.reload()).snapshot, Date.now(), {
    resetRetryWindow: true, requestId: crypto.randomUUID(),
  });
  assert.equal(resumed?.operation.generation, 2);
  assert.equal(resumed?.started.resumingPreviousProcessingClaim, true);
  assert.deepEqual(await reconcileReceiptClaimWorkflowOnchain(await state.reload()), { status: 'prepare' });
  const submission = await prepareReceiptClaimWorkflowTransaction(await state.reload());
  assert.equal(submission.target.receiptAssetId, ASSET);
  assert.deepEqual(submission.target.figureIds, [19, 20, 21]);
  await persistReceiptClaimWorkflowSubmission(state.context, (await state.reload()).snapshot, submission);
  let broadcasts = 0;
  t.mock.method(Connection.prototype, 'sendRawTransaction', async (bytes: Uint8Array) => {
    assert.equal(Buffer.from(bytes).toString('base64'), (await state.reload()).snapshot.operation.submission?.signedTransactionBase64);
    broadcasts += 1;
    return submission.signature;
  });
  await broadcastReceiptClaimWorkflowTransaction(await state.reload());
  t.mock.method(Connection.prototype, 'getSignatureStatuses', async () => ({
    context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
  }));
  const confirmed = await reconcileReceiptClaimWorkflowOnchain(await state.reload());
  if (confirmed.status !== 'complete') throw new Error('Expected confirmation');
  await completeReceiptClaimWorkflow(state.context, (await state.reload()).snapshot, confirmed.result);
  assert.equal((await state.reload()).snapshot.operation.recipient, RECIPIENT);
  assert.equal((await state.reload()).snapshot.operation.phase, 'complete');
  assert.equal(broadcasts, 1);
});

test('an adopted openable pack recovers a dropped legacy signature using its exact assigned receipt', async (t) => {
  const dropped = bs58.encode(Buffer.alloc(64, 42));
  const state = await fixture(t, 'openable_pack', true, [dropped]);
  t.after(() => state.harness.database.close());
  t.mock.method(Connection.prototype, 'getSignatureStatuses', async () => ({ context: { slot: 1 }, value: [null] }));
  assert.deepEqual(state.args.snapshot.started.receiptTxs, [dropped]);
  assert.deepEqual(await reconcileReceiptClaimWorkflowOnchain(state.args), { status: 'prepare' });
  const submission = await prepareReceiptClaimWorkflowTransaction(state.args);
  assert.equal(submission.target.receiptAssetId, ASSET);
  assert.deepEqual(submission.target.figureIds, [19, 20, 21]);
  await persistReceiptClaimWorkflowSubmission(state.context, state.args.snapshot, submission);
  assert.deepEqual(await reconcileReceiptClaimWorkflowOnchain(await state.reload()), { status: 'broadcast' });
  t.mock.method(Connection.prototype, 'getSignatureStatuses', async () => ({
    context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
  }));
  const confirmed = await reconcileReceiptClaimWorkflowOnchain(await state.reload());
  if (confirmed.status !== 'complete') throw new Error('Expected confirmation');
  await completeReceiptClaimWorkflow(state.context, (await state.reload()).snapshot, confirmed.result);
  assert.equal((await state.reload()).snapshot.operation.phase, 'complete');
  assert.equal((await state.reload()).snapshot.operation.recipient, RECIPIENT);
});

test('an expired replacement recovers verified legacy delivery after an explicit retry', async (t) => {
  const state = await fixture(t, 'openable_pack', true);
  t.after(() => state.harness.database.close());
  const legacy = await prepareReceiptClaimWorkflowTransaction(state.args);
  await state.context.repository.run(Date.now(), async (unit) => {
    const key = commerceKeys.claimCode(CODE);
    await unit.get(key);
    await unit.update(key, { receiptTxs: [legacy.signature] });
  });
  let legacyStatus: 'processed' | 'finalized' | null = null;
  const inspected: string[] = [];
  t.mock.method(Connection.prototype, 'getSignatureStatuses', async (signatures: string[]) => {
    inspected.push(...signatures);
    return { context: { slot: 1 }, value: signatures.map((signature) => signature === legacy.signature && legacyStatus
      ? { slot: 1, confirmations: legacyStatus === 'finalized' ? null : 0, err: null, confirmationStatus: legacyStatus }
      : null) };
  });
  assert.deepEqual(await reconcileReceiptClaimWorkflowOnchain(await state.reload()), { status: 'prepare' });
  t.mock.method(Connection.prototype, 'getLatestBlockhash', async () => ({
    blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 200,
  }));
  const replacement = await prepareReceiptClaimWorkflowTransaction(await state.reload());
  assert.notEqual(replacement.signature, legacy.signature);
  await persistReceiptClaimWorkflowSubmission(state.context, (await state.reload()).snapshot, replacement);
  inspected.length = 0;
  assert.deepEqual(await reconcileReceiptClaimWorkflowOnchain(await state.reload()), { status: 'broadcast' });
  assert.deepEqual(inspected, [replacement.signature]);

  state.chain.height = 201;
  Object.assign(state.asset, { burnt: true });
  let transactionAvailable = false;
  const transaction = VersionedTransaction.deserialize(Buffer.from(legacy.signedTransactionBase64, 'base64'));
  t.mock.method(Connection.prototype, 'getTransaction', async (signature: string) => {
    assert.equal(signature, legacy.signature);
    return transactionAvailable ? {
      slot: 1, blockTime: null, transaction: { message: transaction.message, signatures: [signature] },
      meta: { err: null, fee: 0, preBalances: [], postBalances: [], loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [] },
    } : null;
  });
  legacyStatus = 'processed';
  assert.deepEqual(await reconcileReceiptClaimWorkflowOnchain(await state.reload()), { status: 'pending' });
  legacyStatus = 'finalized';
  assert.deepEqual(await reconcileReceiptClaimWorkflowOnchain(await state.reload()), { status: 'pending' });
  assert.equal((await state.reload()).snapshot.operation.submission?.status, 'prepared');
  await failReceiptClaimWorkflow(state.context, (await state.reload()).snapshot, {
    code: 'deadline-exceeded', message: 'Retry.', retryable: true,
  }, true);
  await advanceReceiptClaimWorkflowGeneration(state.context, (await state.reload()).snapshot, Date.now(), {
    resetRetryWindow: true, requestId: crypto.randomUUID(),
  });
  transactionAvailable = true;
  const result = await reconcileReceiptClaimWorkflowOnchain(await state.reload());
  if (result.status !== 'complete') assert.fail('Expected verified legacy delivery');
  assert.deepEqual(result.result.receiptTxs, [legacy.signature]);
  await completeReceiptClaimWorkflow(state.context, (await state.reload()).snapshot, result.result);
  const completed = (await state.reload()).snapshot;
  assert.equal(completed.operation.phase, 'complete');
  assert.equal(completed.operation.generation, 2);
  const order = await state.context.repository.get(commerceKeys.deliveryOrder('card_nft_2', '3'));
  assert.deepEqual((order?.data.stripeReceiptClaim as Record<string, unknown>).receiptTxs, [legacy.signature]);
});

for (const unresolved of ['legacy_pack', 'other_owner', 'wrong_asset', 'processed', 'unverified_confirmed'] as const) {
  test(`legacy signature recovery keeps ${unresolved} evidence pending`, async (t) => {
    const state = await fixture(t, unresolved === 'legacy_pack' ? 'legacy_pack' : 'openable_pack', true,
      [bs58.encode(Buffer.alloc(64, 42)), bs58.encode(Buffer.alloc(64, 43))]);
    t.after(() => state.harness.database.close());
    if (unresolved === 'other_owner') state.asset.ownership.owner = Keypair.generate().publicKey.toBase58();
    if (unresolved === 'wrong_asset') state.asset.id = Keypair.generate().publicKey.toBase58();
    t.mock.method(Connection.prototype, 'getSignatureStatuses', async () => ({
      context: { slot: 1 }, value: [null, unresolved === 'processed' || unresolved === 'unverified_confirmed'
        ? { slot: 1, confirmations: 1, err: null, confirmationStatus: unresolved === 'processed' ? 'processed' : 'confirmed' }
        : null],
    }));
    t.mock.method(Connection.prototype, 'getTransaction', async () => null);
    assert.deepEqual(await reconcileReceiptClaimWorkflowOnchain(state.args), { status: 'pending' });
    assert.equal((await state.reload()).snapshot.operation.submission, undefined);
  });
}

test('an adopted openable pack without a journal waits when its assigned receipt is not admin-owned', async (t) => {
  const state = await fixture(t, 'openable_pack', true);
  t.after(() => state.harness.database.close());
  state.asset.ownership.owner = Keypair.generate().publicKey.toBase58();
  assert.deepEqual(await reconcileReceiptClaimWorkflowOnchain(state.args), { status: 'pending' });
  assert.equal((await state.reload()).snapshot.operation.submission, undefined);
});

test('legacy pack adoption still waits when its broadcast journal is absent', async (t) => {
  const state = await fixture(t, 'legacy_pack', true);
  t.after(() => state.harness.database.close());
  assert.deepEqual(await reconcileReceiptClaimWorkflowOnchain(state.args), { status: 'pending' });
  assert.equal((await state.reload()).snapshot.operation.submission, undefined);
});

for (const flow of ['direct_figure', 'openable_pack', 'legacy_pack'] as const) {
  test(`${flow} persists exact signed bytes before any broadcast and completes after acknowledgement loss`, async (t) => {
    const fixtureState = await fixture(t, flow);
    let broadcasts = 0;
    let firstBytes: Buffer | undefined;
    t.mock.method(Connection.prototype, 'sendRawTransaction', async (bytes: Uint8Array) => {
      broadcasts += 1;
      const loaded = await fixtureState.reload();
      assert.ok(loaded.snapshot.operation.submission);
      assert.equal(Buffer.from(bytes).toString('base64'), loaded.snapshot.operation.submission.signedTransactionBase64);
      if (firstBytes) assert.deepEqual(Buffer.from(bytes), firstBytes);
      firstBytes = Buffer.from(bytes);
      throw new Error('RPC accepted transaction, response lost');
    });
    assert.deepEqual(await reconcileReceiptClaimWorkflowOnchain(fixtureState.args), { status: 'prepare' });
    const prepared = await prepareReceiptClaimWorkflowTransaction(fixtureState.args);
    assert.equal(broadcasts, 0);
    assert.equal(prepared.target.flow, flow);
    assert.deepEqual(prepared.target.figureIds, flow === 'openable_pack' ? [19, 20, 21] : flow === 'direct_figure' ? [7] : []);
    const transaction = VersionedTransaction.deserialize(Buffer.from(prepared.signedTransactionBase64, 'base64'));
    assert.equal(bs58.encode(transaction.signatures[0]), prepared.signature);
    assert.equal(transaction.message.compiledInstructions.length, flow === 'openable_pack' ? 3 : 2);
    await assert.rejects(broadcastReceiptClaimWorkflowTransaction(fixtureState.args), /not persisted/);
    assert.equal(broadcasts, 0);
    await persistReceiptClaimWorkflowSubmission(fixtureState.context, fixtureState.args.snapshot, prepared);
    await broadcastReceiptClaimWorkflowTransaction(await fixtureState.reload());
    await broadcastReceiptClaimWorkflowTransaction(await fixtureState.reload());
    assert.equal(broadcasts, 2);
    t.mock.method(Connection.prototype, 'getSignatureStatuses', async () => ({
      context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
    }));
    const confirmed = await reconcileReceiptClaimWorkflowOnchain(await fixtureState.reload());
    assert.equal(confirmed.status, 'complete');
    if (confirmed.status !== 'complete') throw new Error('Expected confirmation');
    assert.equal(confirmed.result.receiptsTransferred, flow === 'openable_pack' ? 3 : 1);
    assert.deepEqual(confirmed.result.receiptTxs, [prepared.signature]);
    await completeReceiptClaimWorkflow(fixtureState.context, (await fixtureState.reload()).snapshot, confirmed.result);
    assert.deepEqual(await reconcileReceiptClaimWorkflowOnchain(await fixtureState.reload()), confirmed);
    assert.equal(broadcasts, 2);
  });
}

test('a live ambiguous submission is replayed without preparing a second transaction', async (t) => {
  const state = await fixture(t, 'direct_figure');
  const submission = await prepareReceiptClaimWorkflowTransaction(state.args);
  await persistReceiptClaimWorkflowSubmission(state.context, state.args.snapshot, submission);
  t.mock.method(Connection.prototype, 'getSignatureStatuses', async () => ({ context: { slot: 1 }, value: [null] }));
  assert.deepEqual(await reconcileReceiptClaimWorkflowOnchain(await state.reload()), { status: 'broadcast' });
  assert.deepEqual(await prepareReceiptClaimWorkflowTransaction(await state.reload()), submission);
});

test('expired submission needs exact admin ownership before a replacement can be prepared', async (t) => {
  const state = await fixture(t, 'openable_pack');
  const submission = await prepareReceiptClaimWorkflowTransaction(state.args);
  await persistReceiptClaimWorkflowSubmission(state.context, state.args.snapshot, submission);
  t.mock.method(Connection.prototype, 'getSignatureStatuses', async () => ({ context: { slot: 1 }, value: [null] }));
  state.chain.height = 201;
  assert.deepEqual(await reconcileReceiptClaimWorkflowOnchain(await state.reload()), { status: 'prepare' });
  assert.equal((await state.reload()).snapshot.operation.submission?.status, 'not_landed');
  await assert.rejects(prepareReceiptClaimWorkflowTransaction(await state.reload()), { code: 'unavailable' });
});

test('generation changes fence both preparation and broadcasting', async (t) => {
  const state = await fixture(t, 'legacy_pack');
  const submission = await prepareReceiptClaimWorkflowTransaction(state.args);
  await persistReceiptClaimWorkflowSubmission(state.context, state.args.snapshot, submission);
  const stale = await state.reload();
  await advanceReceiptClaimWorkflowGeneration(state.context, stale.snapshot, Date.now());
  let broadcasts = 0;
  t.mock.method(Connection.prototype, 'sendRawTransaction', async () => { broadcasts += 1; return submission.signature; });
  await assert.rejects(prepareReceiptClaimWorkflowTransaction(stale), /execution changed/);
  await assert.rejects(broadcastReceiptClaimWorkflowTransaction(stale), /execution changed/);
  assert.equal(broadcasts, 0);
});

test('a processed-only failure cannot unlock a replacement transaction', async (t) => {
  const state = await fixture(t, 'direct_figure');
  const submission = await prepareReceiptClaimWorkflowTransaction(state.args);
  await persistReceiptClaimWorkflowSubmission(state.context, state.args.snapshot, submission);
  t.mock.method(Connection.prototype, 'getSignatureStatuses', async () => ({
    context: { slot: 1 }, value: [{ slot: 1, confirmations: 0, err: { InstructionError: [0, 'InvalidArgument'] }, confirmationStatus: 'processed' }],
  }));
  assert.deepEqual(await reconcileReceiptClaimWorkflowOnchain(await state.reload()), { status: 'pending' });
  assert.equal((await state.reload()).snapshot.operation.submission?.status, 'prepared');
});

for (const flow of ['openable_pack', 'legacy_pack'] as const) {
  test(`${flow} adopts a confirmed legacy transaction after receipts have moved onward`, async (t) => {
    const state = await fixture(t, flow);
    const prepared = await prepareReceiptClaimWorkflowTransaction(state.args);
    const transaction = VersionedTransaction.deserialize(Buffer.from(prepared.signedTransactionBase64, 'base64'));
    const eventData = Buffer.alloc(41);
    eventData[0] = 1;
    eventData.writeUInt32LE(35, 2);
    eventData[6] = 1;
    eventData[7] = 1;
    eventData[8] = 1;
    new PublicKey(ASSET).toBuffer().copy(eventData, 9);
    const noopIndex = transaction.message.staticAccountKeys.findIndex((key) => key.toBase58() === MPL_NOOP_PROGRAM_ADDRESS);
    await state.context.repository.run(Date.now(), async (unit) => {
      const key = commerceKeys.claimCode(CODE);
      await unit.get(key);
      await unit.update(key, { receiptTxs: [prepared.signature], 'receiptClaimWorkflowV1.claim.resumingPreviousProcessingClaim': true });
    });
    t.mock.method(Connection.prototype, 'getSignatureStatuses', async () => ({
      context: { slot: 1 }, value: [{ slot: 1, confirmations: null, err: null, confirmationStatus: 'finalized' }],
    }));
    t.mock.method(Connection.prototype, 'getTransaction', async () => ({
      slot: 1, blockTime: null, transaction: { message: transaction.message, signatures: [prepared.signature] },
      meta: { err: null, fee: 0, preBalances: [], postBalances: [], loadedAddresses: { writable: [], readonly: [] },
        innerInstructions: [{ index: 1, instructions: [{ programIdIndex: noopIndex, accounts: [], data: bs58.encode(eventData) }] }] },
    }));
    const result = await reconcileReceiptClaimWorkflowOnchain(await state.reload());
    assert.equal(result.status, 'complete');
    if (result.status === 'complete') assert.deepEqual(result.result.receiptTxs, [prepared.signature]);
  });
}
