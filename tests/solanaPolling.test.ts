import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import type { Connection, SignatureStatus } from '@solana/web3.js';
import {
  confirmSubmittedTransactionByPolling,
  isPotentiallySubmittedTransactionError,
  isSubmittedTransactionFailureError,
  reconcileSubmittedTransaction,
} from '../src/lib/solana.ts';
import { rpcEndpointForCluster } from '../src/lib/shopRpc.ts';
import {
  isBase58Bytes,
  isExactShopRpcRequest,
  isNonZeroBase58Bytes,
} from '../shared/solanaRpcProxy.ts';

const SIGNATURE = bs58.encode(new Uint8Array(64).fill(7));
const RECENT_BLOCKHASH = bs58.encode(new Uint8Array(32).fill(8));
const RPC_ENDPOINT = 'https://api.mons.shop/rpc/mainnet-beta';

function rpcConnection() {
  let web3StatusCalls = 0;
  const connection = {
    rpcEndpoint: RPC_ENDPOINT,
    getSignatureStatus: () => {
      web3StatusCalls += 1;
      throw new Error('web3.js status polling must not be used');
    },
    onSignature: () => {
      throw new Error('WebSocket confirmation must not be used');
    },
  } as unknown as Connection;
  return { connection, web3StatusCalls: () => web3StatusCalls };
}

function signatureStatusResponse(request: unknown, status: unknown, contextSlot = 1): Response {
  const id = (request as { id: unknown }).id;
  return Response.json({
    jsonrpc: '2.0',
    id,
    result: {
      context: { slot: contextSlot },
      value: [status],
    },
  });
}

function blockhashValidityResponse(request: unknown, value: boolean, contextSlot = 1): Response {
  const id = (request as { id: unknown }).id;
  return Response.json({
    jsonrpc: '2.0',
    id,
    result: {
      context: { slot: contextSlot },
      value,
    },
  });
}

async function withFetch(fetchImpl: typeof fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('HTTP signature polling confirms without creating a WebSocket subscription', async () => {
  const statuses: Array<SignatureStatus | null> = [
    null,
    { slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' },
  ];
  const fake = rpcConnection();
  let calls = 0;
  await withFetch((async (input, init) => {
    assert.equal(String(input), RPC_ENDPOINT);
    assert.equal(init?.cache, 'no-store');
    assert.ok(init?.signal);
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getSignatureStatuses',
      params: [[SIGNATURE], { searchTransactionHistory: false }],
    });
    const status = statuses[Math.min(calls, statuses.length - 1)];
    calls += 1;
    return signatureStatusResponse(request, status);
  }) as typeof fetch, async () => {
    await confirmSubmittedTransactionByPolling(fake.connection, SIGNATURE, {
      delayMs: 0,
      timeoutMs: 50,
      requestTimeoutMs: 10,
    });
  });
  assert.equal(calls, 2);
  assert.equal(fake.web3StatusCalls(), 0);
});

test('HTTP signature polling accepts a confirmed status without confirmationStatus', async () => {
  const status: SignatureStatus = {
    slot: 1,
    confirmations: 1,
    err: null,
  };
  const fake = rpcConnection();
  await withFetch((async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    return signatureStatusResponse(request, status);
  }) as typeof fetch, async () => {
    await confirmSubmittedTransactionByPolling(fake.connection, SIGNATURE, {
      delayMs: 0,
      timeoutMs: 50,
      requestTimeoutMs: 10,
    });
  });
});

test('HTTP signature polling rejects unknown confirmationStatus values', async () => {
  const fake = rpcConnection();
  let calls = 0;
  await withFetch((async (_input, init) => {
    calls += 1;
    const request = JSON.parse(String(init?.body));
    return signatureStatusResponse(request, calls === 1 ? {
      slot: 1,
      confirmations: 1,
      err: null,
      confirmationStatus: 'rooted',
    } : {
      slot: 1,
      confirmations: 1,
      err: null,
    });
  }) as typeof fetch, async () => {
    await confirmSubmittedTransactionByPolling(fake.connection, SIGNATURE, {
      delayMs: 0,
      timeoutMs: 50,
      requestTimeoutMs: 10,
    });
  });
  assert.equal(calls, 2);
});

test('HTTP signature polling surfaces deterministic on-chain failure without confirmationStatus', async () => {
  const status: SignatureStatus = {
    slot: 1,
    confirmations: 1,
    err: { InstructionError: [0, 'Custom'] },
  };
  const fake = rpcConnection();
  await withFetch((async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    return signatureStatusResponse(request, status);
  }) as typeof fetch, async () => {
    await assert.rejects(
      confirmSubmittedTransactionByPolling(fake.connection, SIGNATURE, {
        delayMs: 0,
        timeoutMs: 50,
        requestTimeoutMs: 10,
      }),
      (error) => isSubmittedTransactionFailureError(error),
    );
  });
});

test('HTTP signature polling keeps processed errors nonterminal', async () => {
  const fake = rpcConnection();
  let calls = 0;
  await withFetch((async (_input, init) => {
    calls += 1;
    const request = JSON.parse(String(init?.body));
    return signatureStatusResponse(request, calls === 1 ? {
      slot: 1,
      confirmations: 0,
      err: { InstructionError: [0, 'Custom'] },
      confirmationStatus: 'processed',
    } : {
      slot: 2,
      confirmations: 1,
      err: null,
      confirmationStatus: 'confirmed',
    });
  }) as typeof fetch, async () => {
    await confirmSubmittedTransactionByPolling(fake.connection, SIGNATURE, {
      delayMs: 0,
      timeoutMs: 50,
      requestTimeoutMs: 10,
    });
  });
  assert.equal(calls, 2);
});

test('shop RPC Base58 validation rejects impossible encodings before decoding', () => {
  const zeroAddress = bs58.encode(new Uint8Array(32));
  const zeroSignature = bs58.encode(new Uint8Array(64));

  assert.equal(isBase58Bytes(zeroAddress, 32), true);
  assert.equal(isBase58Bytes(RECENT_BLOCKHASH, 32), true);
  assert.equal(isBase58Bytes(zeroSignature, 64), true);
  assert.equal(isBase58Bytes(SIGNATURE, 64), true);
  assert.equal(isNonZeroBase58Bytes(zeroAddress, 32), false);
  assert.equal(isNonZeroBase58Bytes(RECENT_BLOCKHASH, 32), true);
  assert.equal(isNonZeroBase58Bytes(zeroSignature, 64), false);
  assert.equal(isNonZeroBase58Bytes(SIGNATURE, 64), true);
  assert.equal(isBase58Bytes('1'.repeat(31), 32), false);
  assert.equal(isBase58Bytes('1'.repeat(45), 32), false);
  assert.equal(isBase58Bytes('1'.repeat(63), 64), false);
  assert.equal(isBase58Bytes('1'.repeat(89), 64), false);
  assert.equal(isBase58Bytes('0'.repeat(32), 32), false);
  assert.equal(isBase58Bytes('1'.repeat(100_000), 32), false);
});

test('shop RPC enforces per-account and aggregate data-slice budgets', () => {
  const accountRequest = (length: number) => ({
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'getAccountInfo' as const,
    params: [RECENT_BLOCKHASH, {
      commitment: 'confirmed',
      encoding: 'base64',
      dataSlice: { offset: 0, length },
    }],
  });
  const multipleAccountsRequest = (length: number) => ({
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'getMultipleAccounts' as const,
    params: [[RECENT_BLOCKHASH, RECENT_BLOCKHASH], {
      commitment: 'confirmed',
      encoding: 'base64',
      dataSlice: { offset: 0, length },
    }],
  });

  assert.equal(isExactShopRpcRequest(accountRequest(2 * 1024 * 1024)), true);
  assert.equal(isExactShopRpcRequest(accountRequest(2 * 1024 * 1024 + 1)), false);
  assert.equal(isExactShopRpcRequest(multipleAccountsRequest(1_450_000)), true);
  assert.equal(isExactShopRpcRequest(multipleAccountsRequest(1_450_001)), false);
});

test('HTTP signature polling classifies timeouts as potentially submitted', async () => {
  const fake = rpcConnection();
  let calls = 0;
  await withFetch((async (_input, init) => {
    calls += 1;
    const request = JSON.parse(String(init?.body));
    return signatureStatusResponse(request, null);
  }) as typeof fetch, async () => {
    await assert.rejects(
      confirmSubmittedTransactionByPolling(fake.connection, SIGNATURE, {
        delayMs: 1,
        timeoutMs: 8,
        requestTimeoutMs: 2,
      }),
      (error) => isPotentiallySubmittedTransactionError(error),
    );
  });
  assert.ok(calls >= 2);
});

test('default transaction confirmation accepts a proxy response slower than two seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = rpcConnection();
  let requestAborted = false;
  let requestStarted!: () => void;
  const requestStartedPromise = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  await withFetch((async (_input, init) => {
    assert.ok(init?.signal);
    const request = JSON.parse(String(init.body));
    requestStarted();
    return new Promise<Response>((resolve, reject) => {
      const responseTimer = setTimeout(() => {
        resolve(signatureStatusResponse(request, {
          slot: 1,
          confirmations: 1,
          err: null,
          confirmationStatus: 'confirmed',
        }));
      }, 10_000);
      const abort = () => {
        requestAborted = true;
        clearTimeout(responseTimer);
        reject(init.signal?.reason);
      };
      init.signal.addEventListener('abort', abort, { once: true });
      if (init.signal.aborted) abort();
    });
  }) as typeof fetch, async () => {
    const pending = confirmSubmittedTransactionByPolling(fake.connection, SIGNATURE);
    await requestStartedPromise;
    t.mock.timers.tick(2_001);
    assert.equal(requestAborted, false);
    t.mock.timers.tick(7_999);
    await pending;
  });
  assert.equal(requestAborted, false);
});

test('default transaction confirmation keeps polling history after the reserved live phase', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = rpcConnection();
  let liveCalls = 0;
  let activeLiveRequests = 0;
  let historyCalls = 0;
  await withFetch((async (_input, init) => {
    assert.ok(init?.signal);
    const request = JSON.parse(String(init.body));
    if (request.params[1]?.searchTransactionHistory !== true) {
      liveCalls += 1;
      activeLiveRequests += 1;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          activeLiveRequests -= 1;
          reject(init.signal?.reason);
        };
        init.signal.addEventListener('abort', abort, { once: true });
        if (init.signal.aborted) abort();
      });
    }
    historyCalls += 1;
    if (historyCalls === 1) return signatureStatusResponse(request, null);
    if (historyCalls === 2) throw new TypeError('transient history request failure');
    return signatureStatusResponse(request, {
      slot: 1,
      confirmations: 1,
      err: null,
      confirmationStatus: 'confirmed',
    });
  }) as typeof fetch, async () => {
    const pending = confirmSubmittedTransactionByPolling(fake.connection, SIGNATURE);
    for (let turn = 0; turn < 20 && liveCalls < 1; turn += 1) await Promise.resolve();
    assert.equal(liveCalls, 1);

    t.mock.timers.tick(35_000);
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    assert.equal(activeLiveRequests, 0);

    t.mock.timers.tick(500);
    for (let turn = 0; turn < 20 && liveCalls < 2; turn += 1) await Promise.resolve();
    assert.equal(liveCalls, 2);
    assert.equal(activeLiveRequests, 1);

    t.mock.timers.tick(4_500);
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    assert.equal(activeLiveRequests, 0);
    assert.equal(historyCalls, 1);

    t.mock.timers.tick(500);
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    assert.equal(historyCalls, 2);

    t.mock.timers.tick(500);
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    await pending;
  });
  assert.equal(liveCalls, 2);
  assert.equal(historyCalls, 3);
  assert.equal(activeLiveRequests, 0);
});

test('default transaction confirmation exhausts the overall deadline while history is pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = rpcConnection();
  let liveCalls = 0;
  let activeLiveRequests = 0;
  let historyCalls = 0;
  let historyRequestAborted = false;
  await withFetch((async (_input, init) => {
    assert.ok(init?.signal);
    const request = JSON.parse(String(init.body));
    const historical = request.params[1]?.searchTransactionHistory === true;
    if (!historical) {
      liveCalls += 1;
      activeLiveRequests += 1;
    } else {
      historyCalls += 1;
    }
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => {
        if (historical) historyRequestAborted = true;
        else activeLiveRequests -= 1;
        reject(init.signal?.reason);
      };
      init.signal.addEventListener('abort', abort, { once: true });
      if (init.signal.aborted) abort();
    });
  }) as typeof fetch, async () => {
    const pending = confirmSubmittedTransactionByPolling(fake.connection, SIGNATURE);
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejection = assert.rejects(pending, (error) => isPotentiallySubmittedTransactionError(error));
    for (let turn = 0; turn < 20 && liveCalls < 1; turn += 1) await Promise.resolve();

    t.mock.timers.tick(35_000);
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    t.mock.timers.tick(500);
    for (let turn = 0; turn < 20 && liveCalls < 2; turn += 1) await Promise.resolve();
    t.mock.timers.tick(4_500);
    for (let turn = 0; turn < 20 && historyCalls < 1; turn += 1) await Promise.resolve();
    assert.equal(historyCalls, 1);
    assert.equal(settled, false);

    t.mock.timers.tick(34_999);
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(historyRequestAborted, false);

    t.mock.timers.tick(1);
    await rejection;
    assert.equal(settled, true);
  });
  assert.equal(liveCalls, 2);
  assert.equal(activeLiveRequests, 0);
  assert.equal(historyCalls, 1);
  assert.equal(historyRequestAborted, true);
});

test('default transaction confirmation bounds a fallback Connection by the overall deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let statusCalls = 0;
  const connection = {
    getSignatureStatus() {
      statusCalls += 1;
      return new Promise<never>(() => undefined);
    },
  } as unknown as Connection;
  const pending = confirmSubmittedTransactionByPolling(connection, SIGNATURE);
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const rejection = assert.rejects(pending, (error) => isPotentiallySubmittedTransactionError(error));
  for (let turn = 0; turn < 20 && statusCalls < 1; turn += 1) await Promise.resolve();
  assert.equal(statusCalls, 1);

  t.mock.timers.tick(35_000);
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  t.mock.timers.tick(500);
  for (let turn = 0; turn < 20 && statusCalls < 2; turn += 1) await Promise.resolve();
  assert.equal(statusCalls, 2);

  t.mock.timers.tick(4_500);
  for (let turn = 0; turn < 20 && statusCalls < 3; turn += 1) await Promise.resolve();
  assert.equal(statusCalls, 3);
  assert.equal(settled, false);

  t.mock.timers.tick(34_999);
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  assert.equal(settled, false);

  t.mock.timers.tick(1);
  await rejection;
  assert.equal(settled, true);
  assert.equal(statusCalls, 3);
});

test('HTTP signature polling propagates caller aborts', async () => {
  const fake = rpcConnection();
  const controller = new AbortController();
  let activeRequests = 0;
  let requestStarted!: () => void;
  const requestStartedPromise = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  await withFetch((async (_input, init) => {
    assert.ok(init?.signal);
    activeRequests += 1;
    requestStarted();
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => {
        activeRequests -= 1;
        reject(init.signal?.reason);
      };
      init.signal.addEventListener('abort', abort, { once: true });
      if (init.signal.aborted) abort();
    });
  }) as typeof fetch, async () => {
    const pending = confirmSubmittedTransactionByPolling(fake.connection, SIGNATURE, {
      signal: controller.signal,
      timeoutMs: 50,
      requestTimeoutMs: 10,
    });
    await requestStartedPromise;
    controller.abort(new DOMException('aborted', 'AbortError'));
    await assert.rejects(pending, { name: 'AbortError' });
  });
  assert.equal(activeRequests, 0);
  assert.equal(fake.web3StatusCalls(), 0);
});

test('request timeout aborts the active status fetch before the next poll starts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = rpcConnection();
  let calls = 0;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let firstRequestStarted!: () => void;
  const firstRequestStartedPromise = new Promise<void>((resolve) => {
    firstRequestStarted = resolve;
  });
  await withFetch((async (_input, init) => {
    assert.ok(init?.signal);
    calls += 1;
    assert.equal(activeRequests, 0);
    const request = JSON.parse(String(init.body));
    if (calls > 1) {
      return signatureStatusResponse(request, {
        slot: 1,
        confirmations: 1,
        err: null,
        confirmationStatus: 'confirmed',
      });
    }
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    firstRequestStarted();
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => {
        activeRequests -= 1;
        reject(init.signal?.reason);
      };
      init.signal.addEventListener('abort', abort, { once: true });
      if (init.signal.aborted) abort();
    });
  }) as typeof fetch, async () => {
    const pending = confirmSubmittedTransactionByPolling(fake.connection, SIGNATURE, {
      delayMs: 0,
      timeoutMs: 50,
      requestTimeoutMs: 10,
    });
    await firstRequestStartedPromise;
    t.mock.timers.tick(10);
    for (let turn = 0; turn < 10 && calls < 2; turn += 1) await Promise.resolve();
    await pending;
  });
  assert.equal(calls, 2);
  assert.equal(activeRequests, 0);
  assert.equal(maxActiveRequests, 1);
  assert.equal(fake.web3StatusCalls(), 0);
});

test('reconciliation checks blockhash validity through the exact mons API contract', async () => {
  const fake = rpcConnection();
  let statusCalls = 0;
  let web3ValidityCalls = 0;
  Object.assign(fake.connection, {
    isBlockhashValid: () => {
      web3ValidityCalls += 1;
      throw new Error('web3.js blockhash polling must not be used');
    },
  });
  await withFetch((async (input, init) => {
    assert.equal(String(input), RPC_ENDPOINT);
    assert.equal(init?.cache, 'no-store');
    assert.ok(init?.signal);
    const request = JSON.parse(String(init?.body));
    if (request.method === 'getSignatureStatuses') {
      statusCalls += 1;
      return signatureStatusResponse(request, null, statusCalls === 1 ? 20 : 30);
    }
    assert.deepEqual(request, {
      jsonrpc: '2.0',
      id: 1,
      method: 'isBlockhashValid',
      params: [RECENT_BLOCKHASH, { commitment: 'confirmed', minContextSlot: 20 }],
    });
    return blockhashValidityResponse(request, false, 25);
  }) as typeof fetch, async () => {
    assert.equal(
      await reconcileSubmittedTransaction(
        fake.connection,
        { signature: SIGNATURE, recentBlockhash: RECENT_BLOCKHASH, blockhashContextSlot: 10 },
        { timeoutMs: 100, pollIntervalMs: 0, requestTimeoutMs: 20 },
      ),
      'expired',
    );
  });
  assert.equal(statusCalls, 2);
  assert.equal(web3ValidityCalls, 0);
});

test('blockhash request timeout aborts the stalled body before reconciliation continues', async () => {
  const fake = rpcConnection();
  let statusCalls = 0;
  let validityCalls = 0;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let bodyStarted!: () => void;
  const bodyStartedPromise = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  await withFetch((async (_input, init) => {
    assert.ok(init?.signal);
    const request = JSON.parse(String(init.body));
    if (request.method === 'getSignatureStatuses') {
      statusCalls += 1;
      return signatureStatusResponse(request, statusCalls === 1 ? null : {
        slot: 2,
        confirmations: 1,
        err: null,
        confirmationStatus: 'confirmed',
      });
    }
    validityCalls += 1;
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    return {
      ok: true,
      status: 200,
      json: () => new Promise<never>((_resolve, reject) => {
        bodyStarted();
        const abort = () => {
          activeRequests -= 1;
          reject(init.signal?.reason);
        };
        init.signal.addEventListener('abort', abort, { once: true });
        if (init.signal.aborted) abort();
      }),
    } as unknown as Response;
  }) as typeof fetch, async () => {
    const pending = reconcileSubmittedTransaction(
      fake.connection,
      { signature: SIGNATURE, recentBlockhash: RECENT_BLOCKHASH },
      { timeoutMs: 200, pollIntervalMs: 0, requestTimeoutMs: 10 },
    );
    await bodyStartedPromise;
    assert.equal(await pending, 'confirmed');
  });
  assert.equal(validityCalls, 1);
  assert.equal(activeRequests, 0);
  assert.equal(maxActiveRequests, 1);
});

test('caller abort cancels an active blockhash response body without another poll', async () => {
  const fake = rpcConnection();
  const controller = new AbortController();
  let calls = 0;
  let activeRequests = 0;
  let bodyStarted!: () => void;
  const bodyStartedPromise = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  await withFetch((async (_input, init) => {
    assert.ok(init?.signal);
    calls += 1;
    const request = JSON.parse(String(init.body));
    if (request.method === 'getSignatureStatuses') {
      return signatureStatusResponse(request, null);
    }
    activeRequests += 1;
    return {
      ok: true,
      status: 200,
      json: () => new Promise<never>((_resolve, reject) => {
        bodyStarted();
        const abort = () => {
          activeRequests -= 1;
          reject(init.signal?.reason);
        };
        init.signal.addEventListener('abort', abort, { once: true });
        if (init.signal.aborted) abort();
      }),
    } as unknown as Response;
  }) as typeof fetch, async () => {
    const pending = reconcileSubmittedTransaction(
      fake.connection,
      { signature: SIGNATURE, recentBlockhash: RECENT_BLOCKHASH },
      { timeoutMs: 200, pollIntervalMs: 0, requestTimeoutMs: 100, signal: controller.signal },
    );
    await bodyStartedPromise;
    controller.abort(new DOMException('aborted', 'AbortError'));
    await assert.rejects(pending, { name: 'AbortError' });
  });
  assert.equal(calls, 2);
  assert.equal(activeRequests, 0);
});

test('caller abort cancels an active reconciliation polling delay', async () => {
  const fake = rpcConnection();
  const controller = new AbortController();
  let calls = 0;
  let responseDelivered!: () => void;
  const responseDeliveredPromise = new Promise<void>((resolve) => {
    responseDelivered = resolve;
  });
  await withFetch((async (_input, init) => {
    calls += 1;
    const request = JSON.parse(String(init?.body));
    responseDelivered();
    return signatureStatusResponse(request, {
      slot: 1,
      confirmations: 0,
      err: null,
      confirmationStatus: 'processed',
    });
  }) as typeof fetch, async () => {
    const pending = reconcileSubmittedTransaction(
      fake.connection,
      { signature: SIGNATURE, recentBlockhash: RECENT_BLOCKHASH },
      { timeoutMs: 2_000, pollIntervalMs: 1_000, requestTimeoutMs: 100, signal: controller.signal },
    );
    await responseDeliveredPromise;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort(new DOMException('aborted', 'AbortError'));
    await assert.rejects(pending, { name: 'AbortError' });
  });
  assert.equal(calls, 1);
});

test('overall reconciliation deadline cancels an active blockhash body', async () => {
  const fake = rpcConnection();
  let activeRequests = 0;
  let bodyStarted!: () => void;
  const bodyStartedPromise = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  await withFetch((async (_input, init) => {
    assert.ok(init?.signal);
    const request = JSON.parse(String(init.body));
    if (request.method === 'getSignatureStatuses') {
      return signatureStatusResponse(request, null);
    }
    activeRequests += 1;
    return {
      ok: true,
      status: 200,
      json: () => new Promise<never>((_resolve, reject) => {
        bodyStarted();
        const abort = () => {
          activeRequests -= 1;
          reject(init.signal?.reason);
        };
        init.signal.addEventListener('abort', abort, { once: true });
        if (init.signal.aborted) abort();
      }),
    } as unknown as Response;
  }) as typeof fetch, async () => {
    const pending = reconcileSubmittedTransaction(
      fake.connection,
      { signature: SIGNATURE, recentBlockhash: RECENT_BLOCKHASH },
      { timeoutMs: 10, pollIntervalMs: 0, requestTimeoutMs: 100 },
    );
    await bodyStartedPromise;
    assert.equal(await pending, 'unknown');
  });
  assert.equal(activeRequests, 0);
});

for (const [name, invalidResponse] of [
  ['mismatched response ID', (request: { id: number }) => Response.json({
    jsonrpc: '2.0',
    id: request.id + 1,
    result: { context: { slot: 1 }, value: false },
  })],
  ['malformed result', (request: { id: number }) => Response.json({
    jsonrpc: '2.0',
    id: request.id,
    result: { context: { slot: 1 }, value: 'false' },
  })],
] as const) {
  test(`reconciliation does not infer expiration from ${name}`, async () => {
    const fake = rpcConnection();
    let liveStatusCalls = 0;
    await withFetch((async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === 'isBlockhashValid') return invalidResponse(request);
      const historical = request.params[1]?.searchTransactionHistory === true;
      if (!historical) liveStatusCalls += 1;
      return signatureStatusResponse(request, liveStatusCalls === 1 || historical ? null : {
        slot: 2,
        confirmations: 1,
        err: null,
        confirmationStatus: 'confirmed',
      });
    }) as typeof fetch, async () => {
      assert.equal(
        await reconcileSubmittedTransaction(
          fake.connection,
          { signature: SIGNATURE, recentBlockhash: RECENT_BLOCKHASH },
          { timeoutMs: 100, pollIntervalMs: 0, requestTimeoutMs: 20 },
        ),
        'confirmed',
      );
    });
    assert.equal(liveStatusCalls, 2);
  });
}

test('unsupported testnet RPC routes are rejected before URL construction', () => {
  assert.throws(
    () => rpcEndpointForCluster('testnet'),
    /unsupported mons API Solana cluster: testnet/i,
  );
});
