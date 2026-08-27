import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1, createCommerceD1Harness } from './commerceD1Harness.ts';
import bs58 from 'bs58';
import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { PENDING_OPEN_BOX_DISCRIMINATOR } from '../../../../shared/pendingOpenCodec.ts';
import { RequestIdentityError } from '../src/requestIdentity.ts';
import { D1CommerceRepository, commerceKeys } from '../src/commerceRepository.ts';
import {
  REVEAL_DUDES_PATH,
  RevealDudesError,
  handleRevealDudes,
  isRevealBackgroundJob,
  processRevealBackgroundJobMessage,
  revealBackgroundJobRetryDelaySeconds,
  revealDudesTestHooks,
  type RevealBackgroundJob,
} from '../src/revealDudes.ts';

const OWNER = Keypair.generate().publicKey;
const BOX_ASSET = Keypair.generate().publicKey;
const COSIGNER = Keypair.generate();
const PLACEHOLDER = Keypair.generate().publicKey;
const PENDING = Keypair.generate().publicKey;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const BLOCKHASH_CONTEXT_SLOT = 1;
const LAST_VALID_BLOCK_HEIGHT = 123_456;
const SIGNATURE = bs58.encode(new Uint8Array(64).fill(7));
const DROP_ID = 'clear_cards_devnet_v2';
const allowRateLimit = { limit: async () => ({ success: true }) } satisfies RateLimit;

function queue(send: Queue['send'] = async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } })): Queue {
  return {
    send,
    sendBatch: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
  };
}

function env(signer = COSIGNER, backgroundQueue = queue()): Env {
  return {
    DATA_DB: {} as D1Database,
    OPS_DB: {} as D1Database,
    COMMERCE_DB: createCommerceD1(),
    STAFF_AUTH_CHALLENGE_RATE_LIMITER: allowRateLimit,
    STAFF_AUTH_SESSION_RATE_LIMITER: allowRateLimit,
    ANONYMOUS_AUTH_SESSION_RATE_LIMITER: allowRateLimit,
    NOTIFICATION_EMAIL_QUEUE: queue(),
    REVEAL_BACKGROUND_QUEUE: backgroundQueue,
    STRIPE_FULFILLMENT_QUEUE: queue(),
    HELIUS_API_KEY: 'helius-test-key',
    COSIGNER_SECRET: bs58.encode(signer.secretKey),
    RESEND_API_KEY: '',
    RESEND_CONTACTS_API_KEY: '',
    NOTIFICATION_ENQUEUE_SECRET: '',
    ADDRESS_DECRYPTION_SECRET: '',
    SHIPSTATION_API_KEY: '',
    SHIPSTATION_SHIP_FROM: '',
    STRIPE_SECRET_KEY: '',
    STRIPE_RESTRICTED_KEY: '',
    STRIPE_SECRET_KEY_LIVE: '',
    STRIPE_RESTRICTED_KEY_LIVE: '',
    STRIPE_WEBHOOK_SECRET_DEVNET: '',
    STRIPE_WEBHOOK_SECRET: '',
  };
}

function request(body: unknown, init: { method?: string; headers?: HeadersInit } = {}): Request {
  return new Request(`https://api.mons.shop${REVEAL_DUDES_PATH}`, {
    method: init.method ?? 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
      ...init.headers,
    },
    ...(init.method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'anon:reveal-test' }),
    loadBoundWallet: async () => OWNER.toBase58(),
    loadStorageControl: async () => ({
      paused: false,
      source: 'd1' as const,
      revision: 1,
      updatedAtMs: 0,
      cutoverAtMs: 500,
    }),
    validateOnchainConfig: async () => ({
      admin: COSIGNER.publicKey,
      coreCollection: new PublicKey(revealDudesTestHooks.runtimeForDrop(DROP_ID).config.collectionMint),
    }),
    loadPendingOpen: async () => ({
      pendingPda: PENDING,
      dudeAssets: [PLACEHOLDER],
      layout: 'vec' as const,
    }),
    loadRevealSubmission: async () => null,
    assignDudes: async () => ({ dudeIds: [9], outcome: 'created' as const }),
    loadLatestBlockhash: async () => ({
      blockhash: BLOCKHASH,
      blockhashContextSlot: BLOCKHASH_CONTEXT_SLOT,
    }),
    sendAndConfirmTransaction: async (_context: unknown, _runtime: unknown, transaction: VersionedTransaction) => {
      assert.equal(transaction.signatures.length, 1);
      assert.equal(transaction.signatures[0].some((byte) => byte !== 0), true);
      return bs58.encode(transaction.signatures[0]);
    },
    reconcileRevealSubmission: async () => 'unknown' as const,
    reserveRevealSubmission: async (
      _context: unknown,
      _runtime: unknown,
      _boxAssetId: string,
      candidate: Parameters<typeof revealDudesTestHooks.reserveRevealSubmission>[3],
    ) => {
      assert.equal(Object.hasOwn(candidate, 'lastValidBlockHeight'), false);
      assert.equal(candidate.blockhashContextSlot, BLOCKHASH_CONTEXT_SLOT);
      return { submission: candidate, owned: true };
    },
    confirmRevealSubmission: async () => undefined,
    failRevealSubmission: async () => 'failed' as const,
    countOnlineRevealPackStatus: async () => undefined,
    providerFetch: async () => {
      throw new Error('unexpected provider fetch');
    },
    nowMs: () => 1_700_000_000_000,
    randomInt: () => 0,
    sleep: async () => undefined,
    ...overrides,
  };
}

test('reveal handler returns the confirmed signature and assigned ids', async () => {
  let confirmations = 0;
  let counted = false;
  let waitUntilCalls = 0;
  const queued: Array<{ body: unknown; options?: QueueSendOptions }> = [];
  const result = await handleRevealDudes(
    request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
    env(COSIGNER, queue(async (body, options) => {
      queued.push({ body, options });
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    })),
    dependencies({
      confirmRevealSubmission: async () => {
        confirmations += 1;
      },
      countOnlineRevealPackStatus: async () => {
        counted = true;
      },
    }),
    () => {
      waitUntilCalls += 1;
    },
  );

  assert.equal(result.response.status, 200);
  assert.equal(result.authOutcome, 'accepted');
  assert.equal(result.dropId, DROP_ID);
  assert.equal(result.boxAssetId, BOX_ASSET.toBase58());
  assert.equal(result.assignmentOutcome, 'created');
  assert.equal(result.transactionOutcome, 'confirmed');
  const payload = await result.response.json() as { signature: string; dudeIds: number[] };
  assert.equal(bs58.decode(payload.signature).length, 64);
  assert.deepEqual(payload.dudeIds, [9]);
  assert.equal(confirmations, 1);
  assert.equal(counted, true);
  assert.equal(waitUntilCalls, 1);
  assert.equal(queued.length, 1);
  assert.equal(isRevealBackgroundJob(queued[0].body), true);
  assert.equal(queued[0].options?.delaySeconds, 5);
});

test('reveal handler rejects wallet-session mismatches before any reveal work', async () => {
  let onchainCalls = 0;
  const result = await handleRevealDudes(
    request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
    env(),
    dependencies({
      loadBoundWallet: async () => Keypair.generate().publicKey.toBase58(),
      validateOnchainConfig: async () => {
        onchainCalls += 1;
        throw new Error('unexpected');
      },
    }),
  );

  assert.equal(result.response.status, 403);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'permission-denied');
  assert.equal(onchainCalls, 0);
});

test('paused reveal storage rejects requests before reveal reads or mutations', async () => {
  let revealReads = 0;
  let assignments = 0;
  const result = await handleRevealDudes(
    request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
    env(),
    dependencies({
      loadStorageControl: async () => ({
        paused: true,
        source: 'd1' as const,
        revision: 1,
        updatedAtMs: 0,
        cutoverAtMs: 500,
      }),
      loadRevealSubmission: async () => {
        revealReads += 1;
        return null;
      },
      assignDudes: async () => {
        assignments += 1;
        return { dudeIds: [9], outcome: 'created' as const };
      },
    }),
  );

  assert.equal(result.response.status, 503);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'unavailable');
  assert.equal(revealReads, 0);
  assert.equal(assignments, 0);
});

test('reveal handler maps invalid and unavailable request identity', async () => {
  for (const [kind, status, code] of [
    ['invalid-token', 401, 'unauthenticated'],
    ['provider-timeout', 504, 'deadline-exceeded'],
    ['provider-unavailable', 503, 'unavailable'],
  ] as const) {
    const result = await handleRevealDudes(
      request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
      env(),
      dependencies({
        verifyIdentity: async () => {
          throw new RequestIdentityError(kind);
        },
      }),
    );
    assert.equal(result.response.status, status);
    assert.equal((await result.response.json() as { error: { code: string } }).error.code, code);
  }
});

test('reveal handler rejects methods and malformed exact request bodies', async () => {
  const method = await handleRevealDudes(request({}, { method: 'GET' }), env(), dependencies());
  assert.equal(method.response.status, 405);
  assert.equal(method.response.headers.get('allow'), 'POST, OPTIONS');

  for (const body of [
    {},
    { owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID, extra: true },
    { owner: 'invalid', boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID },
    { owner: OWNER.toBase58(), boxAssetId: 'invalid', dropId: DROP_ID },
    { owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: 'unsupported' },
  ]) {
    const result = await handleRevealDudes(request(body), env(), dependencies());
    assert.equal(result.response.status, 400);
    assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'invalid-argument');
  }
});

test('reveal handler queues before send and returns stable recovery details for an unknown submission', async () => {
  let submittedSignature = '';
  const events: string[] = [];
  const queued: unknown[] = [];
  const background: Promise<unknown>[] = [];
  const result = await handleRevealDudes(
    request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
    env(COSIGNER, queue(async (body) => {
      events.push('queue');
      queued.push(body);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    })),
    dependencies({
      sendAndConfirmTransaction: async (_context: unknown, _runtime: unknown, transaction: VersionedTransaction) => {
        events.push('send');
        submittedSignature = bs58.encode(transaction.signatures[0]);
        throw new RevealDudesError('unavailable', 'unknown', { signature: SIGNATURE, maybeSubmitted: true });
      },
      countOnlineRevealPackStatus: async () => {
        throw new Error('unexpected direct pack-status count');
      },
    }),
    (promise) => {
      background.push(promise);
    },
  );

  assert.equal(result.response.status, 503);
  assert.equal(result.transactionOutcome, 'unknown');
  const payload = await result.response.json() as { error: { details: unknown } };
  assert.deepEqual(payload.error.details, {
    kind: 'reveal-submission-unknown',
    submission: {
      signature: submittedSignature,
      recentBlockhash: BLOCKHASH,
      dudeIds: [9],
    },
  });
  assert.deepEqual(events, ['queue', 'send']);
  assert.equal(queued.length, 1);
  assert.equal(isRevealBackgroundJob(queued[0]), true);
  assert.equal(background.length, 0);
});

test('durably confirmed stored submission recovers without a provider secret or RPC reads', async () => {
  let pendingCalls = 0;
  let reconcileCalls = 0;
  let sendCalls = 0;
  let confirmCalls = 0;
  let countCalls = 0;
  let waitUntilCalls = 0;
  let requestSignal: AbortSignal | undefined;
  let repairSignal: AbortSignal | undefined;
  const stored = submission({ status: 'confirmed' });
  const result = await handleRevealDudes(
    request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
    { ...env(), HELIUS_API_KEY: '' },
    dependencies({
      loadRevealSubmission: async (context: Parameters<typeof revealDudesTestHooks.loadRevealSubmission>[0]) => {
        requestSignal = context.signal;
        return stored;
      },
      reconcileRevealSubmission: async () => {
        reconcileCalls += 1;
        throw new Error('unexpected reconciliation');
      },
      loadPendingOpen: async () => {
        pendingCalls += 1;
        throw new Error('unexpected pending read');
      },
      sendAndConfirmTransaction: async () => {
        sendCalls += 1;
        throw new Error('unexpected send');
      },
      confirmRevealSubmission: async () => {
        confirmCalls += 1;
        throw new Error('unexpected confirmation rewrite');
      },
      countOnlineRevealPackStatus: async (context: Parameters<typeof revealDudesTestHooks.countOnlineRevealPackStatus>[0]) => {
        countCalls += 1;
        repairSignal = context.signal;
      },
    }),
    () => {
      waitUntilCalls += 1;
    },
  );

  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), { signature: SIGNATURE, dudeIds: [9] });
  assert.equal(reconcileCalls, 0);
  assert.equal(pendingCalls, 0);
  assert.equal(sendCalls, 0);
  assert.equal(confirmCalls, 0);
  assert.equal(countCalls, 1);
  assert.equal(waitUntilCalls, 1);
  assert.ok(requestSignal);
  assert.ok(repairSignal);
  assert.notEqual(repairSignal, requestSignal);
  assert.equal(repairSignal.aborted, false);
});

test('stored reveal submission rejects a different owner before reconciliation or send', async () => {
  let reconcileCalls = 0;
  let pendingCalls = 0;
  let sendCalls = 0;
  const result = await handleRevealDudes(
    request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
    env(),
    dependencies({
      loadRevealSubmission: async () => submission({ owner: Keypair.generate().publicKey.toBase58() }),
      reconcileRevealSubmission: async () => {
        reconcileCalls += 1;
        return 'confirmed';
      },
      loadPendingOpen: async () => {
        pendingCalls += 1;
        throw new Error('unexpected pending read');
      },
      sendAndConfirmTransaction: async () => {
        sendCalls += 1;
        throw new Error('unexpected send');
      },
    }),
  );

  assert.equal(result.response.status, 403);
  assert.equal(result.authOutcome, 'rejected');
  const payload = await result.response.json() as { error: { code: string; details?: unknown } };
  assert.equal(payload.error.code, 'permission-denied');
  assert.equal(Object.hasOwn(payload.error, 'details'), false);
  assert.equal(reconcileCalls, 0);
  assert.equal(pendingCalls, 0);
  assert.equal(sendCalls, 0);
});

test('unknown stored submission returns recovery details without resending or re-enqueuing', async () => {
  let pendingCalls = 0;
  let sendCalls = 0;
  let queueCalls = 0;
  const background: Promise<unknown>[] = [];
  const stored = submission();
  const result = await handleRevealDudes(
    request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
    env(COSIGNER, queue(async () => {
      queueCalls += 1;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    })),
    dependencies({
      loadRevealSubmission: async () => stored,
      reconcileRevealSubmission: async () => 'unknown',
      loadPendingOpen: async () => {
        pendingCalls += 1;
        throw new Error('unexpected pending read');
      },
      sendAndConfirmTransaction: async () => {
        sendCalls += 1;
        throw new Error('unexpected send');
      },
    }),
    (promise) => {
      background.push(promise);
    },
  );

  assert.equal(result.response.status, 503);
  assert.equal(result.transactionOutcome, 'unknown');
  assert.deepEqual((await result.response.json() as { error: { details: unknown } }).error.details, {
    kind: 'reveal-submission-unknown',
    submission: {
      signature: SIGNATURE,
      recentBlockhash: BLOCKHASH,
      dudeIds: [9],
    },
  });
  assert.equal(pendingCalls, 0);
  assert.equal(sendCalls, 0);
  assert.equal(queueCalls, 0);
  assert.equal(background.length, 0);
});

test('reconciled stored submission completes durable bookkeeping before acknowledgement', async () => {
  const stored = submission();
  let confirmCalls = 0;
  let countCalls = 0;
  let waitUntilCalls = 0;
  const result = await handleRevealDudes(
    request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
    env(),
    dependencies({
      loadRevealSubmission: async () => stored,
      reconcileRevealSubmission: async () => 'confirmed',
      confirmRevealSubmission: async (
        _context: unknown,
        _runtime: unknown,
        boxAssetId: string,
        confirmed: ReturnType<typeof submission>,
      ) => {
        confirmCalls += 1;
        assert.equal(boxAssetId, BOX_ASSET.toBase58());
        assert.equal(confirmed.signature, SIGNATURE);
      },
      countOnlineRevealPackStatus: async (_context: unknown, _runtime: unknown, boxAssetId: string, signature: string) => {
        countCalls += 1;
        assert.equal(boxAssetId, BOX_ASSET.toBase58());
        assert.equal(signature, SIGNATURE);
      },
      loadPendingOpen: async () => {
        throw new Error('unexpected pending read');
      },
      sendAndConfirmTransaction: async () => {
        throw new Error('unexpected send');
      },
    }),
    () => {
      waitUntilCalls += 1;
    },
  );

  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), { signature: SIGNATURE, dudeIds: [9] });
  assert.equal(confirmCalls, 1);
  assert.equal(countCalls, 1);
  assert.equal(waitUntilCalls, 1);
});

test('failed or expired stored submissions are conditionally replaced after pending validation', async () => {
  for (const storedOutcome of ['failed', 'expired'] as const) {
    let pendingCalls = 0;
    let replacementSignature = '';
    let sendCalls = 0;
    const stored = submission(storedOutcome === 'failed' ? { status: 'failed' } : {});
    const result = await handleRevealDudes(
      request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
      env(),
      dependencies({
        loadRevealSubmission: async () => stored,
        reconcileRevealSubmission: async () => {
          if (storedOutcome === 'failed') throw new Error('persisted failures should not be reconciled');
          return storedOutcome;
        },
        loadPendingOpen: async () => {
          pendingCalls += 1;
          return { pendingPda: PENDING, dudeAssets: [PLACEHOLDER], layout: 'vec' as const };
        },
        reserveRevealSubmission: async (
          _context: unknown,
          _runtime: unknown,
          _boxAssetId: string,
          candidate: Parameters<typeof revealDudesTestHooks.reserveRevealSubmission>[3],
          replaceSubmission: Parameters<typeof revealDudesTestHooks.reserveRevealSubmission>[4],
        ) => {
          assert.deepEqual(replaceSubmission, stored);
          replacementSignature = candidate.signature;
          return { submission: candidate, owned: true };
        },
        sendAndConfirmTransaction: async () => {
          sendCalls += 1;
          return replacementSignature;
        },
      }),
    );

    assert.equal(result.response.status, 200);
    assert.equal(pendingCalls, 1);
    assert.equal(sendCalls, 1);
    assert.deepEqual(await result.response.json(), { signature: replacementSignature, dudeIds: [9] });
  }
});

test('reservation loser returns the confirmed winner without sending its candidate', async () => {
  const winner = submission();
  let candidateSignature = '';
  let sendCalls = 0;
  let confirmCalls = 0;
  let countCalls = 0;
  const background: Promise<unknown>[] = [];
  const result = await handleRevealDudes(
    request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
    env(),
    dependencies({
      reserveRevealSubmission: async (
        _context: unknown,
        _runtime: unknown,
        _boxAssetId: string,
        candidate: Parameters<typeof revealDudesTestHooks.reserveRevealSubmission>[3],
      ) => {
        candidateSignature = candidate.signature;
        return { submission: winner, owned: false };
      },
      reconcileRevealSubmission: async () => 'confirmed',
      sendAndConfirmTransaction: async () => {
        sendCalls += 1;
        throw new Error('unexpected send');
      },
      confirmRevealSubmission: async () => {
        confirmCalls += 1;
      },
      countOnlineRevealPackStatus: async () => {
        countCalls += 1;
      },
    }),
    (promise) => {
      background.push(promise);
    },
  );

  assert.notEqual(candidateSignature, winner.signature);
  assert.equal(sendCalls, 0);
  assert.equal(result.response.status, 200);
  assert.equal(result.transactionOutcome, 'confirmed');
  assert.deepEqual(await result.response.json(), { signature: winner.signature, dudeIds: winner.dudeIds });
  assert.equal(confirmCalls, 1);
  assert.equal(countCalls, 1);
  assert.equal(background.length, 1);
  await background[0];
});

test('reservation loser returns an unknown winner without sending or re-enqueuing', async () => {
  const winner = submission();
  let sendCalls = 0;
  let queueCalls = 0;
  const background: Promise<unknown>[] = [];
  const result = await handleRevealDudes(
    request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
    env(COSIGNER, queue(async () => {
      queueCalls += 1;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    })),
    dependencies({
      reserveRevealSubmission: async () => ({ submission: winner, owned: false }),
      reconcileRevealSubmission: async () => 'unknown',
      sendAndConfirmTransaction: async () => {
        sendCalls += 1;
        throw new Error('unexpected send');
      },
    }),
    (promise) => {
      background.push(promise);
    },
  );

  assert.equal(result.response.status, 503);
  assert.equal(result.transactionOutcome, 'unknown');
  assert.equal(sendCalls, 0);
  assert.equal(queueCalls, 0);
  assert.equal(background.length, 0);
});

test('reveal handler records explicit transaction failures as failed for retry', async () => {
  let failedSignature = '';
  const result = await handleRevealDudes(
    request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
    env(),
    dependencies({
      sendAndConfirmTransaction: async () => {
        throw new RevealDudesError('failed-precondition', 'transaction failed', {
          signature: SIGNATURE,
          lastError: 'custom program error',
        });
      },
      failRevealSubmission: async (
        _context: unknown,
        _runtime: unknown,
        _boxAssetId: string,
        stored: Parameters<typeof revealDudesTestHooks.failRevealSubmission>[3],
      ) => {
        failedSignature = stored.signature;
        return 'failed' as const;
      },
    }),
  );

  assert.equal(result.response.status, 409);
  assert.equal(result.transactionOutcome, 'failed');
  assert.equal(bs58.decode(failedSignature).length, 64);
});

test('queue failure schedules fresh cleanup and prevents broadcast', async () => {
  let failCalls = 0;
  let sendCalls = 0;
  let requestSignal: AbortSignal | undefined;
  let failureSignal: AbortSignal | undefined;
  const background: Promise<unknown>[] = [];
  const result = await handleRevealDudes(
    request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
    env(COSIGNER, queue(async () => {
      throw new Error('queue unavailable');
    })),
    dependencies({
      reserveRevealSubmission: async (
        context: Parameters<typeof revealDudesTestHooks.reserveRevealSubmission>[0],
        _runtime: unknown,
        _boxAssetId: string,
        candidate: Parameters<typeof revealDudesTestHooks.reserveRevealSubmission>[3],
      ) => {
        requestSignal = context.signal;
        return { submission: candidate, owned: true };
      },
      failRevealSubmission: async (
        context: Parameters<typeof revealDudesTestHooks.failRevealSubmission>[0],
      ) => {
        failCalls += 1;
        failureSignal = context.signal;
        return 'failed' as const;
      },
      sendAndConfirmTransaction: async () => {
        sendCalls += 1;
        throw new Error('unexpected send');
      },
    }),
    (promise) => {
      background.push(promise);
    },
  );

  assert.equal(result.response.status, 503);
  assert.equal(result.transactionOutcome, 'failed');
  assert.equal(sendCalls, 0);
  assert.equal(background.length, 1);
  await background[0];
  assert.equal(failCalls, 1);
  assert.ok(requestSignal);
  assert.ok(failureSignal);
  assert.notEqual(failureSignal, requestSignal);
  assert.equal(failureSignal.aborted, false);
});

test('pre-send abort after reservation schedules one fresh failure transition without sending', async () => {
  let requestSignal: AbortSignal | undefined;
  let failureSignal: AbortSignal | undefined;
  let failureCalls = 0;
  let providerCalls = 0;
  const background: Promise<unknown>[] = [];
  const result = await handleRevealDudes(
    request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
    env(),
    dependencies({
      providerFetch: async () => {
        providerCalls += 1;
        throw new Error('unexpected provider fetch');
      },
      reserveRevealSubmission: async (
        context: Parameters<typeof revealDudesTestHooks.reserveRevealSubmission>[0],
        _runtime: unknown,
        _boxAssetId: string,
        candidate: Parameters<typeof revealDudesTestHooks.reserveRevealSubmission>[3],
      ) => {
        requestSignal = context.signal;
        Object.defineProperty(context.signal, 'aborted', { configurable: true, value: true });
        Object.defineProperty(context.signal, 'reason', {
          configurable: true,
          value: new DOMException('request expired', 'AbortError'),
        });
        return { submission: candidate, owned: true };
      },
      sendAndConfirmTransaction: revealDudesTestHooks.sendAndConfirmTransaction,
      failRevealSubmission: async (
        context: Parameters<typeof revealDudesTestHooks.failRevealSubmission>[0],
      ) => {
        failureCalls += 1;
        failureSignal = context.signal;
        return 'failed' as const;
      },
    }),
    (promise) => {
      background.push(promise);
    },
  );

  assert.equal(result.response.status, 504);
  assert.equal(result.transactionOutcome, 'failed');
  assert.equal(providerCalls, 0);
  assert.equal(background.length, 1);
  await background[0];
  assert.equal(failureCalls, 1);
  assert.ok(requestSignal);
  assert.ok(failureSignal);
  assert.equal(requestSignal.aborted, true);
  assert.equal(failureSignal.aborted, false);
  assert.notEqual(failureSignal, requestSignal);
});

test('aborted reservation commit recovery schedules a fresh conditional failure transition', async () => {
  let requestSignal: AbortSignal | undefined;
  let failureSignal: AbortSignal | undefined;
  let failedSignature = '';
  const background: Promise<unknown>[] = [];
  const result = await handleRevealDudes(
    request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
    env(),
    dependencies({
      reserveRevealSubmission: async (
        context: Parameters<typeof revealDudesTestHooks.reserveRevealSubmission>[0],
      ) => {
        requestSignal = context.signal;
        const reason = new DOMException('reservation response lost at deadline', 'AbortError');
        Object.defineProperty(context.signal, 'aborted', { configurable: true, value: true });
        Object.defineProperty(context.signal, 'reason', { configurable: true, value: reason });
        throw reason;
      },
      sendAndConfirmTransaction: async () => {
        throw new Error('unexpected send');
      },
      failRevealSubmission: async (
        context: Parameters<typeof revealDudesTestHooks.failRevealSubmission>[0],
        _runtime: unknown,
        _boxAssetId: string,
        candidate: Parameters<typeof revealDudesTestHooks.failRevealSubmission>[3],
      ) => {
        failureSignal = context.signal;
        failedSignature = candidate.signature;
        return 'failed' as const;
      },
    }),
    (promise) => {
      background.push(promise);
    },
  );

  assert.equal(result.response.status, 504);
  assert.equal(background.length, 1);
  await background[0];
  assert.ok(requestSignal);
  assert.ok(failureSignal);
  assert.equal(requestSignal.aborted, true);
  assert.equal(failureSignal.aborted, false);
  assert.notEqual(failureSignal, requestSignal);
  assert.equal(bs58.decode(failedSignature).length, 64);
});

test('confirmed reveal status-write failures return recovery details and leave repair to the pre-enqueued job', async () => {
  let confirmCalls = 0;
  let countCalls = 0;
  let queueCalls = 0;
  const background: Promise<unknown>[] = [];
  const result = await handleRevealDudes(
    request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
    env(COSIGNER, queue(async () => {
      queueCalls += 1;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    })),
    dependencies({
      confirmRevealSubmission: async () => {
        confirmCalls += 1;
        throw new Error('confirmation write unavailable');
      },
      countOnlineRevealPackStatus: async () => {
        countCalls += 1;
      },
    }),
    (promise) => {
      background.push(promise);
    },
  );

  assert.equal(result.response.status, 503);
  assert.equal(result.transactionOutcome, 'confirmed');
  const payload = await result.response.json() as { error: { code: string; details: { kind: string } } };
  assert.equal(payload.error.code, 'unavailable');
  assert.equal(payload.error.details.kind, 'reveal-submission-unknown');
  assert.equal(background.length, 0);
  assert.equal(confirmCalls, 1);
  assert.equal(countCalls, 0);
  assert.equal(queueCalls, 1);
});

test('pack-status count outages cannot block a confirmed response', async () => {
  let countCalls = 0;
  const result = await handleRevealDudes(
    request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
    env(),
    dependencies({
      countOnlineRevealPackStatus: async () => {
        countCalls += 1;
        throw new Error('pack status unavailable');
      },
    }),
  );

  assert.equal(result.response.status, 200);
  assert.equal(result.transactionOutcome, 'confirmed');
  assert.equal(countCalls, 1);
});

function revealContext(commerceDb: D1Database = createCommerceD1(), providerFetch: typeof fetch = fetch) {
  return {
    commerceDb,
    nowMs: 1_700_000_000_000,
    providerFetch,
    signal: new AbortController().signal,
  };
}

const RESERVATION_ID = '123e4567-e89b-42d3-a456-426614174000';

function submission(overrides: Partial<{
  owner: string;
  signature: string;
  recentBlockhash: string;
  blockhashContextSlot: number;
  dudeIds: number[];
  reservationId: string;
  status: 'pending' | 'confirmed' | 'failed';
}> = {}) {
  return {
    owner: OWNER.toBase58(),
    signature: SIGNATURE,
    recentBlockhash: BLOCKHASH,
    blockhashContextSlot: BLOCKHASH_CONTEXT_SLOT,
    dudeIds: [9],
    reservationId: RESERVATION_ID,
    status: 'pending' as const,
    ...overrides,
  };
}

function revealJob(overrides: Partial<RevealBackgroundJob> = {}): RevealBackgroundJob {
  return {
    kind: 'reveal_submission_reconcile',
    dropId: DROP_ID,
    boxAssetId: BOX_ASSET.toBase58(),
    reservationId: RESERVATION_ID,
    signature: SIGNATURE,
    ...overrides,
  };
}

function revealQueueMessage(body: unknown = revealJob(), attempts = 1) {
  const actions: { acks: number; retries: Array<QueueRetryOptions | undefined> } = {
    acks: 0,
    retries: [],
  };
  const message: Message<unknown> = {
    id: `reveal-message-${attempts}`,
    timestamp: new Date('2026-08-21T12:00:00.000Z'),
    body,
    attempts,
    ack: () => {
      actions.acks += 1;
    },
    retry: (options) => {
      actions.retries.push(options);
    },
  };
  return { actions, message };
}

function revealConsumerEnv(apiKey = 'helius-test-key') {
  return {
    COMMERCE_DB: createCommerceD1(),
    OPS_DB: {} as D1Database,
    HELIUS_API_KEY: apiKey,
  };
}

test('D1 assignment atomically creates markers, updates the pool, and creates the box assignment', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  await repository.run(1, async (unit) => unit.create(commerceKeys.dudePool(DROP_ID), {
    available: [1, 2, 3],
  }));
  const runtime = revealDudesTestHooks.runtimeForDrop(DROP_ID);
  const dependencySubset = {
    randomInt: () => 0,
    sleep: async () => undefined,
  };

  const result = await revealDudesTestHooks.assignDudes(
    revealContext(harness.db),
    runtime,
    BOX_ASSET.toBase58(),
    dependencySubset,
  );

  assert.deepEqual(result, { dudeIds: [1], outcome: 'created' });
  assert.equal((await repository.get(commerceKeys.dudeAssignment(DROP_ID, '1')))?.data.boxAssetId, BOX_ASSET.toBase58());
  assert.deepEqual((await repository.get(commerceKeys.dudePool(DROP_ID)))?.data.available, [2, 3]);
  assert.deepEqual((await repository.get(commerceKeys.boxAssignment(DROP_ID, BOX_ASSET.toBase58())))?.data.dudeIds, [1]);
});

test('D1 assignment returns an existing valid assignment without touching the pool', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  await repository.run(1, async (unit) => unit.create(
    commerceKeys.boxAssignment(DROP_ID, BOX_ASSET.toBase58()),
    { dudeIds: [7] },
  ));
  const dependencySubset = {
    randomInt: () => 0,
    sleep: async () => undefined,
  };

  const result = await revealDudesTestHooks.assignDudes(
    revealContext(harness.db),
    revealDudesTestHooks.runtimeForDrop(DROP_ID),
    BOX_ASSET.toBase58(),
    dependencySubset,
  );

  assert.deepEqual(result, { dudeIds: [7], outcome: 'existing' });
  assert.equal(await repository.get(commerceKeys.dudePool(DROP_ID)), null);
});

test('D1 assignment removes stale markers and retries commit conflicts', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  await repository.run(1, async (unit) => {
    await unit.create(commerceKeys.dudePool(DROP_ID), { available: [1, 2] });
    await unit.create(commerceKeys.dudeAssignment(DROP_ID, '1'), { dudeId: 1, boxAssetId: 'stale-box' });
  });
  let sleeps = 0;
  let batches = 0;
  const baseBatch = harness.db.batch.bind(harness.db);
  const flakyDb = {
    prepare: harness.db.prepare.bind(harness.db),
    async batch<T>(statements: D1PreparedStatement[]) {
      batches += 1;
      if (batches === 1) throw new Error('commerce transaction conflict');
      return baseBatch<T>(statements);
    },
  } as D1Database;
  const dependencySubset = {
    randomInt: () => 0,
    sleep: async () => {
      sleeps += 1;
    },
  };

  const result = await revealDudesTestHooks.assignDudes(
    revealContext(flakyDb),
    revealDudesTestHooks.runtimeForDrop(DROP_ID),
    BOX_ASSET.toBase58(),
    dependencySubset,
  );

  assert.deepEqual(result, { dudeIds: [2], outcome: 'created' });
  assert.equal(sleeps, 1);
  assert.equal((await repository.get(commerceKeys.dudeAssignment(DROP_ID, '2')))?.data.boxAssetId, BOX_ASSET.toBase58());
  assert.deepEqual((await repository.get(commerceKeys.boxAssignment(DROP_ID, BOX_ASSET.toBase58())))?.data.dudeIds, [2]);
});

test('D1 assignment fails closed when the pool is exhausted', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  await repository.run(1, async (unit) => unit.create(commerceKeys.dudePool(DROP_ID), { available: [] }));
  const dependencySubset = {
    randomInt: () => 0,
    sleep: async () => undefined,
  };

  await assert.rejects(
    revealDudesTestHooks.assignDudes(
      revealContext(harness.db),
      revealDudesTestHooks.runtimeForDrop(DROP_ID),
      BOX_ASSET.toBase58(),
      dependencySubset,
    ),
    (error: unknown) => error instanceof RevealDudesError && error.code === 'resource-exhausted',
  );
});

function rpcResponse(body: Record<string, unknown>, result?: unknown, error?: Record<string, unknown>): Response {
  return Response.json({
    jsonrpc: '2.0',
    id: body.id,
    ...(error ? { error } : { result }),
  });
}

function signatureStatusResult(status: null | {
  err?: unknown;
  confirmationStatus: 'processed' | 'confirmed' | 'finalized';
}, contextSlot = BLOCKHASH_CONTEXT_SLOT) {
  return {
    context: { slot: contextSlot },
    value: [status === null ? null : {
      slot: contextSlot,
      confirmations: status.confirmationStatus === 'processed' ? 0 : 1,
      ...status,
    }],
  };
}

function providerContext(fetcher: typeof fetch, signal = new AbortController().signal) {
  return {
    apiKey: 'helius-test-key',
    fetch: fetcher,
    signal,
  };
}

function signedTransaction(): VersionedTransaction {
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: COSIGNER.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [],
  }).compileToV0Message());
  transaction.sign([COSIGNER]);
  return transaction;
}

test('RPC calls reject an already-aborted context without fetching', async () => {
  const controller = new AbortController();
  const reason = new DOMException('request expired', 'AbortError');
  controller.abort(reason);
  let fetches = 0;

  await assert.rejects(
    revealDudesTestHooks.rpcCall(
      providerContext(async () => {
        fetches += 1;
        throw new Error('unexpected fetch');
      }, controller.signal),
      revealDudesTestHooks.runtimeForDrop(DROP_ID),
      'getAccountInfo',
      [],
    ),
    (error: unknown) => error === reason,
  );
  assert.equal(fetches, 0);
});

test('RPC calls reject malformed result and error envelopes', async () => {
  for (const malformed of [
    { result: null, error: { code: -32002, message: 'simulation failed', data: { err: 'BlockhashNotFound', logs: [] } } },
    { error: { code: -32002, data: { err: 'BlockhashNotFound', logs: [] } } },
  ]) {
    await assert.rejects(
      revealDudesTestHooks.rpcCall(
        providerContext(async (_input, init) => {
          const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json({ jsonrpc: '2.0', id: requestBody.id, ...malformed });
        }),
        revealDudesTestHooks.runtimeForDrop(DROP_ID),
        'sendTransaction',
        [],
        { attempts: 1 },
      ),
      (error: unknown) => error instanceof RevealDudesError && error.code === 'unavailable',
    );
  }
});

test('RPC calls retry transient JSON-RPC errors for idempotent reads', async () => {
  let fetches = 0;
  const result = await revealDudesTestHooks.rpcCall(
    providerContext(async (_input, init) => {
      fetches += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return fetches === 1
        ? rpcResponse(body, undefined, { code: -32005, message: 'Node is temporarily unhealthy' })
        : rpcResponse(body, { value: 'ok' });
    }),
    revealDudesTestHooks.runtimeForDrop(DROP_ID),
    'getAccountInfo',
    [],
  );

  assert.deepEqual(result, { value: 'ok' });
  assert.equal(fetches, 2);
});

test('latest blockhash parsing preserves its strict RPC context', async () => {
  const runtime = revealDudesTestHooks.runtimeForDrop(DROP_ID);
  const valid = await revealDudesTestHooks.loadLatestBlockhash(
    providerContext(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return rpcResponse(body, {
        context: { slot: 1 },
        value: { blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT },
      });
    }),
    runtime,
  );
  assert.deepEqual(valid, {
    blockhash: BLOCKHASH,
    blockhashContextSlot: BLOCKHASH_CONTEXT_SLOT,
  });

  for (const malformed of [
    { value: { blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT } },
    { context: { slot: -1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT } },
    { context: { slot: 1 }, value: { blockhash: BLOCKHASH } },
    { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: -1 } },
  ]) {
    await assert.rejects(
      revealDudesTestHooks.loadLatestBlockhash(
        providerContext(async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return rpcResponse(body, malformed);
        }),
        runtime,
      ),
      (error: unknown) => error instanceof RevealDudesError && error.code === 'unavailable',
    );
  }
});

test('stored submission remains live while its blockhash is valid', async () => {
  const methods: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    methods.push(body.method);
    if (body.method === 'getSignatureStatuses') {
      return rpcResponse(body, signatureStatusResult(null));
    }
    if (body.method === 'isBlockhashValid') {
      return rpcResponse(body, { context: { slot: 1 }, value: true });
    }
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  const outcome = await revealDudesTestHooks.reconcileRevealSubmission(
    providerContext(fetcher),
    revealDudesTestHooks.runtimeForDrop(DROP_ID),
    submission(),
  );

  assert.equal(outcome, 'unknown');
  assert.deepEqual(methods, ['getSignatureStatuses', 'isBlockhashValid']);
});

test('stored submission expires only after an invalid blockhash and a history miss', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string; params: unknown };
    calls.push({ method: body.method, params: body.params });
    if (body.method === 'getSignatureStatuses') return rpcResponse(body, signatureStatusResult(null));
    if (body.method === 'isBlockhashValid') {
      return rpcResponse(body, { context: { slot: 1 }, value: false });
    }
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  const outcome = await revealDudesTestHooks.reconcileRevealSubmission(
    providerContext(fetcher),
    revealDudesTestHooks.runtimeForDrop(DROP_ID),
    submission(),
  );

  assert.equal(outcome, 'expired');
  assert.deepEqual(calls.map(({ method }) => method), [
    'getSignatureStatuses',
    'isBlockhashValid',
    'getSignatureStatuses',
  ]);
  assert.deepEqual(calls[0].params, [[SIGNATURE], { searchTransactionHistory: false }]);
  assert.deepEqual(calls[1].params, [BLOCKHASH, {
    commitment: 'confirmed',
    minContextSlot: BLOCKHASH_CONTEXT_SLOT,
  }]);
  assert.deepEqual(calls[2].params, [[SIGNATURE], { searchTransactionHistory: true }]);
});

test('expiry requires ordered RPC contexts and uses the newest known slot', async () => {
  const cases = [
    { origin: 7, current: 9, invalidity: 10, historical: 9, expected: 'unknown' },
    { origin: 7, current: 9, invalidity: 10, historical: 10, expected: 'expired' },
    { origin: 7, current: 9, invalidity: 10, historical: 11, expected: 'expired' },
    { origin: 12, current: 9, invalidity: 12, historical: 12, expected: 'expired' },
  ] as const;

  for (const testCase of cases) {
    let statusCalls = 0;
    let validityParams: unknown;
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> & {
        method: string;
        params: unknown;
      };
      if (body.method === 'getSignatureStatuses') {
        statusCalls += 1;
        return rpcResponse(body, signatureStatusResult(
          null,
          statusCalls === 1 ? testCase.current : testCase.historical,
        ));
      }
      if (body.method === 'isBlockhashValid') {
        validityParams = body.params;
        return rpcResponse(body, { context: { slot: testCase.invalidity }, value: false });
      }
      throw new Error(`Unexpected RPC method: ${body.method}`);
    };

    const outcome = await revealDudesTestHooks.reconcileRevealSubmission(
      providerContext(fetcher),
      revealDudesTestHooks.runtimeForDrop(DROP_ID),
      submission({ blockhashContextSlot: testCase.origin }),
    );

    assert.equal(outcome, testCase.expected);
    assert.deepEqual(validityParams, [BLOCKHASH, {
      commitment: 'confirmed',
      minContextSlot: Math.max(testCase.origin, testCase.current),
    }]);
  }
});

test('malformed blockhash validity cannot expire a stored submission', async () => {
  for (const malformed of [
    { value: false },
    { context: {}, value: false },
    { context: { slot: 1 }, value: 'false' },
  ]) {
    const methods: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
      methods.push(body.method);
      if (body.method === 'getSignatureStatuses') {
        return rpcResponse(body, signatureStatusResult(null));
      }
      if (body.method === 'isBlockhashValid') return rpcResponse(body, malformed);
      throw new Error(`Unexpected RPC method: ${body.method}`);
    };

    const outcome = await revealDudesTestHooks.reconcileRevealSubmission(
      providerContext(fetcher),
      revealDudesTestHooks.runtimeForDrop(DROP_ID),
      submission(),
    );

    assert.equal(outcome, 'unknown');
    assert.deepEqual(methods, ['getSignatureStatuses', 'isBlockhashValid']);
  }
});

test('processed transaction errors remain nonterminal', async () => {
  const methods: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    methods.push(body.method);
    if (body.method === 'getSignatureStatuses') {
      return rpcResponse(body, signatureStatusResult({
        err: { InstructionError: [0, { Custom: 6_001 }] },
        confirmationStatus: 'processed',
      }));
    }
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  const outcome = await revealDudesTestHooks.reconcileRevealSubmission(
    providerContext(fetcher),
    revealDudesTestHooks.runtimeForDrop(DROP_ID),
    submission(),
  );

  assert.equal(outcome, 'unknown');
  assert.deepEqual(methods, ['getSignatureStatuses']);
});

test('signature status falls back to confirmations when confirmationStatus is omitted', async () => {
  for (const confirmations of [1, null] as const) {
    const methods: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
      methods.push(body.method);
      if (body.method === 'getSignatureStatuses') {
        return rpcResponse(body, {
          context: { slot: 1 },
          value: [{ slot: 1, confirmations, err: null }],
        });
      }
      throw new Error(`Unexpected RPC method: ${body.method}`);
    };

    const outcome = await revealDudesTestHooks.reconcileRevealSubmission(
      providerContext(fetcher),
      revealDudesTestHooks.runtimeForDrop(DROP_ID),
      submission(),
    );

    assert.equal(outcome, 'confirmed');
    assert.deepEqual(methods, ['getSignatureStatuses']);
  }

  const pendingFetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return rpcResponse(body, {
      context: { slot: 1 },
      value: [{ slot: 1, confirmations: 0, err: null }],
    });
  };
  const pending = await revealDudesTestHooks.reconcileRevealSubmission(
    providerContext(pendingFetcher),
    revealDudesTestHooks.runtimeForDrop(DROP_ID),
    submission(),
  );
  assert.equal(pending, 'unknown');
});

test('failed status falls back to confirmations when confirmationStatus is omitted', async () => {
  const transactionError = { InstructionError: [0, { Custom: 6_001 }] };
  const methods: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    methods.push(body.method);
    if (body.method === 'getSignatureStatuses') {
      return rpcResponse(body, {
        context: { slot: 1 },
        value: [{ slot: 1, confirmations: 1, err: transactionError }],
      });
    }
    if (body.method === 'getTransaction') {
      return rpcResponse(body, {
        slot: 42,
        transaction: { signatures: [SIGNATURE] },
        meta: { err: transactionError, logMessages: [] },
      });
    }
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  const outcome = await revealDudesTestHooks.reconcileRevealSubmission(
    providerContext(fetcher),
    revealDudesTestHooks.runtimeForDrop(DROP_ID),
    submission(),
  );

  assert.equal(outcome, 'failed');
  assert.deepEqual(methods, ['getSignatureStatuses', 'getTransaction']);
});

test('confirmation status without an explicit null error remains unknown', async () => {
  const methods: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    methods.push(body.method);
    if (body.method === 'getSignatureStatuses') {
      return rpcResponse(body, signatureStatusResult({ confirmationStatus: 'confirmed' }));
    }
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  const outcome = await revealDudesTestHooks.reconcileRevealSubmission(
    providerContext(fetcher),
    revealDudesTestHooks.runtimeForDrop(DROP_ID),
    submission(),
  );

  assert.equal(outcome, 'unknown');
  assert.deepEqual(methods, ['getSignatureStatuses']);
});

test('signature status decisions require a valid response context and status shape', async () => {
  const malformedResults = [
    {
      value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
    },
    {
      context: { slot: 1 },
      value: [{ confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
    },
    {
      value: [null],
    },
  ];

  for (const malformed of malformedResults) {
    const methods: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
      methods.push(body.method);
      if (body.method === 'getSignatureStatuses') return rpcResponse(body, malformed);
      throw new Error(`Unexpected RPC method: ${body.method}`);
    };

    const outcome = await revealDudesTestHooks.reconcileRevealSubmission(
      providerContext(fetcher),
      revealDudesTestHooks.runtimeForDrop(DROP_ID),
      submission(),
    );

    assert.equal(outcome, 'unknown');
    assert.deepEqual(methods, ['getSignatureStatuses']);
  }
});

test('confirmed status failures require matching explicit transaction evidence', async () => {
  const transactionError = { InstructionError: [0, { Custom: 6_001 }] };
  const methods: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    methods.push(body.method);
    if (body.method === 'getSignatureStatuses') {
      return rpcResponse(body, signatureStatusResult({
        err: transactionError,
        confirmationStatus: 'confirmed',
      }));
    }
    if (body.method === 'getTransaction') {
      return rpcResponse(body, {
        slot: 42,
        transaction: { signatures: [SIGNATURE] },
        meta: { err: transactionError, logMessages: ['program failed'] },
      });
    }
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  const outcome = await revealDudesTestHooks.reconcileRevealSubmission(
    providerContext(fetcher),
    revealDudesTestHooks.runtimeForDrop(DROP_ID),
    submission(),
  );

  assert.equal(outcome, 'failed');
  assert.deepEqual(methods, ['getSignatureStatuses', 'getTransaction']);
});

test('mismatched or malformed transaction evidence keeps a status failure unknown', async () => {
  const transactionError = { InstructionError: [0, { Custom: 6_001 }] };
  const malformedTransactions = [
    {
      slot: 42,
      transaction: { signatures: [bs58.encode(new Uint8Array(64).fill(8))] },
      meta: { err: transactionError, logMessages: ['wrong signature'] },
    },
    {
      slot: 42,
      transaction: { signatures: [SIGNATURE] },
      meta: { logMessages: ['missing error'] },
    },
    {
      slot: 42,
      transaction: { signatures: [SIGNATURE] },
      meta: { err: { bogus: true }, logMessages: ['malformed error'] },
    },
    {
      slot: 42,
      transaction: { signatures: [SIGNATURE] },
      meta: { err: { InstructionError: [0, { bogus: true }] }, logMessages: ['malformed instruction error'] },
    },
  ];

  for (const transaction of malformedTransactions) {
    const methods: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
      methods.push(body.method);
      if (body.method === 'getSignatureStatuses') {
        return rpcResponse(body, signatureStatusResult({
          err: transactionError,
          confirmationStatus: 'confirmed',
        }));
      }
      if (body.method === 'getTransaction') return rpcResponse(body, transaction);
      throw new Error(`Unexpected RPC method: ${body.method}`);
    };

    const outcome = await revealDudesTestHooks.reconcileRevealSubmission(
      providerContext(fetcher),
      revealDudesTestHooks.runtimeForDrop(DROP_ID),
      submission(),
    );

    assert.equal(outcome, 'unknown');
    assert.deepEqual(methods, ['getSignatureStatuses', 'getTransaction']);
  }
});

test('transaction metadata without an explicit null error never confirms', async () => {
  const methods: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    methods.push(body.method);
    if (body.method === 'getTransaction') {
      return rpcResponse(body, { meta: { logMessages: [] } });
    }
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  const outcome = await revealDudesTestHooks.waitForSignature(
    providerContext(fetcher),
    revealDudesTestHooks.runtimeForDrop(DROP_ID),
    SIGNATURE,
    0,
  );

  assert.deepEqual(outcome, { ok: false, error: 'timeout', logs: [] });
  assert.deepEqual(methods, ['getTransaction']);
});

test('transaction submission confirms the exact signed transaction signature', async () => {
  const transaction = signedTransaction();
  const expectedSignature = bs58.encode(transaction.signatures[0]);
  const methods: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    methods.push(body.method);
    if (body.method === 'sendTransaction') return rpcResponse(body, expectedSignature);
    if (body.method === 'getSignatureStatuses') {
      return rpcResponse(body, signatureStatusResult({ err: null, confirmationStatus: 'confirmed' }));
    }
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  const signature = await revealDudesTestHooks.sendAndConfirmTransaction(
    providerContext(fetcher),
    revealDudesTestHooks.runtimeForDrop(DROP_ID),
    transaction,
  );

  assert.equal(signature, expectedSignature);
  assert.deepEqual(methods, ['sendTransaction', 'getSignatureStatuses']);
});

test('accepted transaction with unresolved confirmation is maybe submitted', async () => {
  const transaction = signedTransaction();
  const expectedSignature = bs58.encode(transaction.signatures[0]);
  const methods: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    methods.push(body.method);
    if (body.method === 'sendTransaction') return rpcResponse(body, expectedSignature);
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  await assert.rejects(
    revealDudesTestHooks.sendAndConfirmTransaction(
      providerContext(fetcher),
      revealDudesTestHooks.runtimeForDrop(DROP_ID),
      transaction,
      {
        waitForSignature: async () => ({ ok: false, error: 'timeout', logs: [] }),
      },
    ),
    (error: unknown) => {
      if (!(error instanceof RevealDudesError)) return false;
      assert.equal(error.code, 'deadline-exceeded');
      assert.deepEqual(error.details, {
        signature: expectedSignature,
        lastError: 'timeout',
        lastLogs: [],
        maybeSubmitted: true,
      });
      return true;
    },
  );
  assert.deepEqual(methods, ['sendTransaction']);
});

test('explicit on-chain transaction errors remain final failures', async () => {
  const transaction = signedTransaction();
  const expectedSignature = bs58.encode(transaction.signatures[0]);
  const methods: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    methods.push(body.method);
    if (body.method === 'sendTransaction') return rpcResponse(body, expectedSignature);
    if (body.method === 'getSignatureStatuses') {
      return rpcResponse(body, signatureStatusResult({
        err: { InstructionError: [0, { Custom: 6_001 }] },
        confirmationStatus: 'confirmed',
      }));
    }
    if (body.method === 'getTransaction') {
      return rpcResponse(body, {
        slot: 42,
        transaction: { signatures: [expectedSignature] },
        meta: { err: { InstructionError: [0, { Custom: 6_001 }] }, logMessages: ['program failed'] },
      });
    }
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  await assert.rejects(
    revealDudesTestHooks.sendAndConfirmTransaction(
      providerContext(fetcher),
      revealDudesTestHooks.runtimeForDrop(DROP_ID),
      transaction,
    ),
    (error: unknown) => {
      if (!(error instanceof RevealDudesError)) return false;
      assert.equal(error.code, 'failed-precondition');
      assert.equal((error.details as { maybeSubmitted?: boolean }).maybeSubmitted, undefined);
      assert.deepEqual((error.details as { lastLogs: string[] }).lastLogs, ['program failed']);
      return true;
    },
  );
  assert.deepEqual(methods, ['sendTransaction', 'getSignatureStatuses', 'getTransaction']);
});

test('reveal background job guard is strict and independent of the current drop registry', () => {
  assert.equal(isRevealBackgroundJob(revealJob()), true);
  assert.equal(isRevealBackgroundJob({ ...revealJob(), extra: true }), false);
  assert.equal(isRevealBackgroundJob({ ...revealJob(), signature: 'invalid' }), false);
  assert.equal(isRevealBackgroundJob({ ...revealJob(), dropId: 'future_drop' }), true);
  assert.equal(revealDudesTestHooks.revealBackgroundJobTimeoutMs, 60_000);
});

test('reveal background consumer retries structurally valid jobs for unsupported drops', async () => {
  const unsupported = revealQueueMessage(revealJob({ dropId: 'future_drop' }));

  await processRevealBackgroundJobMessage(unsupported.message, revealConsumerEnv(), {
    loadStorageControl: dependencies().loadStorageControl,
    loadRevealSubmission: async () => {
      throw new Error('unexpected submission read');
    },
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });

  assert.equal(unsupported.actions.acks, 0);
  assert.deepEqual(unsupported.actions.retries, [{ delaySeconds: 5 }]);
});

test('paused reveal storage retries background jobs without reading submissions', async () => {
  const paused = revealQueueMessage();
  let reads = 0;

  await processRevealBackgroundJobMessage(paused.message, revealConsumerEnv(), {
    loadStorageControl: async () => ({
      paused: true,
      source: 'd1' as const,
      revision: 1,
      updatedAtMs: 0,
      cutoverAtMs: 500,
    }),
    loadRevealSubmission: async () => {
      reads += 1;
      return null;
    },
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });

  assert.equal(reads, 0);
  assert.equal(paused.actions.acks, 0);
  assert.deepEqual(paused.actions.retries, [{ delaySeconds: 5 }]);
});

test('reveal background consumer confirms, counts, and safely repeats confirmed jobs', async () => {
  let stored = submission();
  let reconcileCalls = 0;
  let confirmCalls = 0;
  let countCalls = 0;
  const overrides = {
    loadStorageControl: dependencies().loadStorageControl,
    loadRevealSubmission: async () => stored,
    reconcileRevealSubmission: async () => {
      reconcileCalls += 1;
      return 'confirmed' as const;
    },
    confirmRevealSubmission: async () => {
      confirmCalls += 1;
      stored = submission({ status: 'confirmed' });
    },
    countOnlineRevealPackStatus: async () => {
      countCalls += 1;
    },
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const first = revealQueueMessage();
  const duplicate = revealQueueMessage();

  await processRevealBackgroundJobMessage(first.message, revealConsumerEnv(), overrides);
  await processRevealBackgroundJobMessage(duplicate.message, revealConsumerEnv(''), overrides);

  assert.equal(reconcileCalls, 1);
  assert.equal(confirmCalls, 1);
  assert.equal(countCalls, 2);
  assert.equal(first.actions.acks, 1);
  assert.equal(duplicate.actions.acks, 1);
  assert.deepEqual(first.actions.retries, []);
  assert.deepEqual(duplicate.actions.retries, []);
});

test('reveal background consumer retries unknown outcomes and pack-count outages with bounded delays', async () => {
  const unknown = revealQueueMessage(revealJob(), 99);
  await processRevealBackgroundJobMessage(unknown.message, revealConsumerEnv(), {
    loadStorageControl: dependencies().loadStorageControl,
    loadRevealSubmission: async () => submission(),
    reconcileRevealSubmission: async () => 'unknown',
    confirmRevealSubmission: async () => {
      throw new Error('unexpected confirmation write');
    },
    failRevealSubmission: async () => {
      throw new Error('unexpected failure write');
    },
    countOnlineRevealPackStatus: async () => {
      throw new Error('unexpected pack-status count');
    },
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });

  const countOutage = revealQueueMessage(revealJob(), 2);
  await processRevealBackgroundJobMessage(countOutage.message, revealConsumerEnv(''), {
    loadStorageControl: dependencies().loadStorageControl,
    loadRevealSubmission: async () => submission({ status: 'confirmed' }),
    reconcileRevealSubmission: async () => {
      throw new Error('unexpected reconciliation');
    },
    countOnlineRevealPackStatus: async () => {
      throw new Error('pack count unavailable');
    },
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });

  assert.equal(unknown.actions.acks, 0);
  assert.deepEqual(unknown.actions.retries, [{ delaySeconds: 300 }]);
  assert.equal(revealBackgroundJobRetryDelaySeconds(10_000), 300);
  assert.equal(countOutage.actions.acks, 0);
  assert.deepEqual(countOutage.actions.retries, [{ delaySeconds: 15 }]);
});

test('reveal background consumer marks expired submissions failed and acknowledges stale jobs', async () => {
  let failCalls = 0;
  const expired = revealQueueMessage();
  await processRevealBackgroundJobMessage(expired.message, revealConsumerEnv(), {
    loadStorageControl: dependencies().loadStorageControl,
    loadRevealSubmission: async () => submission(),
    reconcileRevealSubmission: async () => 'expired',
    failRevealSubmission: async () => {
      failCalls += 1;
      return 'failed' as const;
    },
    countOnlineRevealPackStatus: async () => {
      throw new Error('unexpected pack-status count');
    },
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });

  const stale = revealQueueMessage();
  await processRevealBackgroundJobMessage(stale.message, revealConsumerEnv(''), {
    loadStorageControl: dependencies().loadStorageControl,
    loadRevealSubmission: async () => submission({
      reservationId: '123e4567-e89b-42d3-b456-426614174001',
    }),
    reconcileRevealSubmission: async () => {
      throw new Error('unexpected reconciliation');
    },
    countOnlineRevealPackStatus: async () => {
      throw new Error('unexpected pack-status count');
    },
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });

  assert.equal(failCalls, 1);
  assert.equal(expired.actions.acks, 1);
  assert.deepEqual(expired.actions.retries, []);
  assert.equal(stale.actions.acks, 1);
  assert.deepEqual(stale.actions.retries, []);
});

test('reveal background consumer counts when a failure transition loses to confirmation', async () => {
  let countCalls = 0;
  const confirmed = revealQueueMessage();

  await processRevealBackgroundJobMessage(confirmed.message, revealConsumerEnv(), {
    loadStorageControl: dependencies().loadStorageControl,
    loadRevealSubmission: async () => submission(),
    reconcileRevealSubmission: async () => 'expired',
    failRevealSubmission: async () => 'confirmed' as const,
    countOnlineRevealPackStatus: async () => {
      countCalls += 1;
    },
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });

  assert.equal(countCalls, 1);
  assert.equal(confirmed.actions.acks, 1);
  assert.deepEqual(confirmed.actions.retries, []);
});

test('ambiguous transaction submission succeeds when its derived signature confirms', async () => {
  const transaction = signedTransaction();
  const expectedSignature = bs58.encode(transaction.signatures[0]);
  let sendCalls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    if (body.method === 'sendTransaction') {
      sendCalls += 1;
      throw new Error('network reset');
    }
    if (body.method === 'getSignatureStatuses') {
      return rpcResponse(body, signatureStatusResult({ err: null, confirmationStatus: 'confirmed' }));
    }
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  const signature = await revealDudesTestHooks.sendAndConfirmTransaction(
    providerContext(fetcher),
    revealDudesTestHooks.runtimeForDrop(DROP_ID),
    transaction,
  );

  assert.equal(signature, expectedSignature);
  assert.equal(sendCalls, 1);
});

test('non-preflight RPC errors with simulation data remain unknown submissions', async () => {
  const transaction = signedTransaction();
  const expectedSignature = bs58.encode(transaction.signatures[0]);
  let waitCalls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    if (body.method === 'sendTransaction') {
      return rpcResponse(body, undefined, {
        code: -32000,
        message: 'provider rejected request',
        data: {
          err: { InstructionError: [0, { Custom: 6_001 }] },
          logs: ['untrusted simulation-shaped data'],
        },
      });
    }
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  await assert.rejects(
    revealDudesTestHooks.sendAndConfirmTransaction(
      providerContext(fetcher),
      revealDudesTestHooks.runtimeForDrop(DROP_ID),
      transaction,
      {
        waitForSignature: async () => {
          waitCalls += 1;
          return { ok: false, error: 'timeout', logs: [] };
        },
      },
    ),
    (error: unknown) => {
      if (!(error instanceof RevealDudesError)) return false;
      assert.equal(error.code, 'unavailable');
      assert.equal((error.details as { signature?: string }).signature, expectedSignature);
      assert.equal((error.details as { maybeSubmitted?: boolean }).maybeSubmitted, true);
      return true;
    },
  );
  assert.equal(waitCalls, 1);
});

test('already-processed preflight responses reconcile the existing signature', async () => {
  const transaction = signedTransaction();
  const expectedSignature = bs58.encode(transaction.signatures[0]);
  const methods: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    methods.push(body.method);
    if (body.method === 'sendTransaction') {
      return rpcResponse(body, undefined, {
        code: -32002,
        message: 'transaction simulation failed',
        data: { err: 'AlreadyProcessed', logs: [] },
      });
    }
    if (body.method === 'getSignatureStatuses') {
      return rpcResponse(body, signatureStatusResult({ err: null, confirmationStatus: 'confirmed' }));
    }
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  const signature = await revealDudesTestHooks.sendAndConfirmTransaction(
    providerContext(fetcher),
    revealDudesTestHooks.runtimeForDrop(DROP_ID),
    transaction,
  );

  assert.equal(signature, expectedSignature);
  assert.deepEqual(methods, ['sendTransaction', 'getSignatureStatuses']);
});

test('malformed nested preflight errors remain unknown submissions', async () => {
  const transaction = signedTransaction();
  let waitCalls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    if (body.method === 'sendTransaction') {
      return rpcResponse(body, undefined, {
        code: -32002,
        message: 'transaction simulation failed',
        data: { err: { InstructionError: [0, { bogus: true }] }, logs: [] },
      });
    }
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  await assert.rejects(
    revealDudesTestHooks.sendAndConfirmTransaction(
      providerContext(fetcher),
      revealDudesTestHooks.runtimeForDrop(DROP_ID),
      transaction,
      {
        waitForSignature: async () => {
          waitCalls += 1;
          return { ok: false, error: 'timeout', logs: [] };
        },
      },
    ),
    (error: unknown) => error instanceof RevealDudesError &&
      error.code === 'unavailable' &&
      (error.details as { maybeSubmitted?: boolean }).maybeSubmitted === true,
  );
  assert.equal(waitCalls, 1);
});

test('transaction preflight errors preserve provider logs and never poll status', async () => {
  const transaction = signedTransaction();
  let statusCalls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    if (body.method === 'sendTransaction') {
      return rpcResponse(body, undefined, {
        code: -32002,
        message: 'simulation failed',
        data: {
          err: { InstructionError: [0, { Custom: 6_001 }] },
          logs: ['program failed'],
        },
      });
    }
    if (body.method === 'getSignatureStatuses') statusCalls += 1;
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  await assert.rejects(
    revealDudesTestHooks.sendAndConfirmTransaction(
      providerContext(fetcher),
      revealDudesTestHooks.runtimeForDrop(DROP_ID),
      transaction,
    ),
    (error: unknown) => {
      if (!(error instanceof RevealDudesError)) return false;
      assert.equal(error.code, 'failed-precondition');
      assert.deepEqual((error.details as { lastLogs: string[] }).lastLogs, ['program failed']);
      return true;
    },
  );
  assert.equal(statusCalls, 0);
});

test('transaction preflight errors with empty logs remain deterministic failures', async () => {
  const transaction = signedTransaction();
  let statusCalls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    if (body.method === 'sendTransaction') {
      return rpcResponse(body, undefined, {
        code: -32002,
        message: 'simulation failed',
        data: {
          err: { InstructionError: [0, { Custom: 6_001 }] },
          logs: [],
        },
      });
    }
    if (body.method === 'getSignatureStatuses') statusCalls += 1;
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  await assert.rejects(
    revealDudesTestHooks.sendAndConfirmTransaction(
      providerContext(fetcher),
      revealDudesTestHooks.runtimeForDrop(DROP_ID),
      transaction,
    ),
    (error: unknown) => {
      if (!(error instanceof RevealDudesError)) return false;
      assert.equal(error.code, 'failed-precondition');
      assert.deepEqual((error.details as { lastLogs: string[] }).lastLogs, []);
      assert.equal((error.details as { maybeSubmitted?: boolean }).maybeSubmitted, undefined);
      return true;
    },
  );
  assert.equal(statusCalls, 0);
});

function pendingAccountData(args: {
  owner?: PublicKey;
  boxAsset?: PublicKey;
  dudeAssets?: PublicKey[];
  config?: PublicKey;
  layout?: 'legacyFixed' | 'vec';
} = {}): Uint8Array {
  const owner = args.owner ?? OWNER;
  const boxAsset = args.boxAsset ?? BOX_ASSET;
  const dudeAssets = args.dudeAssets ?? [PLACEHOLDER];
  const layout = args.layout ?? 'vec';
  const vectorPrefix = layout === 'vec' ? 4 : 0;
  const configBytes = args.config ? 32 : 0;
  const data = new Uint8Array(8 + 32 + 32 + vectorPrefix + dudeAssets.length * 32 + 8 + 1 + configBytes);
  let offset = 0;
  data.set(PENDING_OPEN_BOX_DISCRIMINATOR, offset);
  offset += 8;
  data.set(owner.toBytes(), offset);
  offset += 32;
  data.set(boxAsset.toBytes(), offset);
  offset += 32;
  if (layout === 'vec') {
    new DataView(data.buffer).setUint32(offset, dudeAssets.length, true);
    offset += 4;
  }
  for (const dudeAsset of dudeAssets) {
    data.set(dudeAsset.toBytes(), offset);
    offset += 32;
  }
  offset += 8;
  data[offset] = 1;
  offset += 1;
  if (args.config) data.set(args.config.toBytes(), offset);
  return data;
}

function rpcAccount(owner: PublicKey, data: Uint8Array): Record<string, unknown> {
  return { owner: owner.toBase58(), data: [Buffer.from(data).toString('base64'), 'base64'] };
}

test('pending-open validation accepts the exact owner, box, config, and placeholder count', async () => {
  const runtime = revealDudesTestHooks.runtimeForDrop(DROP_ID);
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    assert.equal(body.method, 'getAccountInfo');
    return rpcResponse(body, {
      value: rpcAccount(runtime.boxMinterProgramId, pendingAccountData({ config: runtime.boxMinterConfigPda })),
    });
  };

  const pending = await revealDudesTestHooks.loadPendingOpen(
    providerContext(fetcher),
    runtime,
    OWNER,
    BOX_ASSET,
  );

  assert.equal(pending.layout, 'vec');
  assert.deepEqual(pending.dudeAssets.map((key) => key.toBase58()), [PLACEHOLDER.toBase58()]);
});

test('pending-open validation rejects another owner and mismatched config', async () => {
  const runtime = revealDudesTestHooks.runtimeForDrop(DROP_ID);
  for (const data of [
    pendingAccountData({ owner: Keypair.generate().publicKey, config: runtime.boxMinterConfigPda }),
    pendingAccountData({ config: Keypair.generate().publicKey }),
  ]) {
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return rpcResponse(body, { value: rpcAccount(runtime.boxMinterProgramId, data) });
    };
    await assert.rejects(
      revealDudesTestHooks.loadPendingOpen(providerContext(fetcher), runtime, OWNER, BOX_ASSET),
      (error: unknown) => error instanceof RevealDudesError &&
        (error.code === 'permission-denied' || error.code === 'failed-precondition'),
    );
  }
});

test('legacy pending-open disambiguation rejects an asset from another configured drop', async () => {
  const runtime = revealDudesTestHooks.runtimeForDrop(DROP_ID);
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    calls += 1;
    if (body.method === 'getAccountInfo') {
      return rpcResponse(body, {
        value: rpcAccount(runtime.boxMinterProgramId, pendingAccountData({ layout: 'legacyFixed' })),
      });
    }
    if (body.method === 'getAsset') {
      const other = revealDudesTestHooks.runtimeForDrop('clear_cards_devnet_v3');
      return rpcResponse(body, {
        id: BOX_ASSET.toBase58(),
        interface: 'MplCoreAsset',
        burnt: false,
        grouping: [{ group_key: 'collection', group_value: other.config.collectionMint }],
        content: {
          json_uri: `${other.config.metadataBase}/b1.json`,
          metadata: { name: 'pack 1', attributes: [{ trait_type: 'type', value: 'box' }] },
        },
      });
    }
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  await assert.rejects(
    revealDudesTestHooks.loadPendingOpen(providerContext(fetcher), runtime, OWNER, BOX_ASSET),
    (error: unknown) => error instanceof RevealDudesError && error.code === 'failed-precondition',
  );
  assert.equal(calls, 2);
});

test('online reveal pack status writes one idempotent D1 event without commerce storage access', async () => {
  let query = '';
  let bindings: unknown[] = [];
  let runs = 0;
  const dataDb = {
    prepare(value: string) {
      query = value;
      return {
        bind(...values: unknown[]) {
          bindings = values;
          return this;
        },
        async run() {
          runs += 1;
          return { success: true, results: [], meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;

  await revealDudesTestHooks.countOnlineRevealPackStatus(
    {
      ...revealContext(createCommerceD1(), async () => assert.fail('pack-status projection must not access commerce storage')),
      dataDb,
    },
    revealDudesTestHooks.runtimeForDrop('card_nft_2'),
    BOX_ASSET.toBase58(),
    SIGNATURE,
  );

  assert.match(query, /INSERT INTO pack_status_events/);
  assert.equal(runs, 1);
  assert.equal(bindings[0], 'card_nft_2');
  assert.equal(bindings[1], 'onlineReveal');
  assert.equal(bindings[2], BOX_ASSET.toBase58());
  assert.equal(bindings[10], BOX_ASSET.toBase58());
  assert.equal(bindings[11], SIGNATURE);
  assert.equal(bindings[12], 1);
});
