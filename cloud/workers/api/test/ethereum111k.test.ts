import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { encodeAbi, decodeReturn, ETHEREUM_EVENT_TOPICS, encodeCall } from '../../../../shared/ethereum/abi.ts';
import { ETHEREUM_API_PATHS as paths, ETHEREUM_SESSION_HEADER, type EthereumAuthChallenge,
  type EthereumSession, type EthereumDeliveryPrepareResponse, type EthereumClaimPrepareResponse, type EthereumStats } from '../../../../shared/ethereum/api.ts';
import { deliveryDigest, crateClaimDigest, ethereumReceiptIdsHash, ethereumSignerAddress, personalMessageHash, recoverEthereumAddress, signDigest } from '../../../../shared/ethereum/crypto.ts';
import { physicalCrateArtworkIds, ethereumHexQuantity, ethereumItemKind, ethereumMetadataTokenId, type EthereumInventoryItem, type EthereumMetadata } from '../../../../shared/ethereum/protocol.ts';
import { handleEthereumRequest } from '../src/ethereumHandler.ts';
import { reconcileEthereum111k } from '../src/ethereumReconciliation.ts';
import { cleanupEthereumAuth } from '../src/ethereumAuth.ts';
import { reconcileEthereumCheckoutAttempt, type EthereumCheckoutAttemptRow } from '../src/ethereumCheckout.ts';
import { ethereumCallBatch, ethereumConfig, type EthereumContext, type EthereumEnvironment } from '../src/ethereumRuntime.ts';
import { ethereumInventoryItems, ethereumTokenInfos, type EthereumLog, type EthereumReceipt } from '../src/ethereumRead.ts';
import { D1CommerceRepository, commerceKeys } from '../src/commerceRepository.ts';
import { planReadyToShipNotifications } from '../src/readyToShipNotifications.ts';
import { requireShipStationEnabled } from '../src/shipstation/common.ts';
import { createCommerceD1Harness, d1Database } from './commerceD1Harness.ts';
import { ETHEREUM_CHECKOUT_PATHS as checkoutPaths, type EthereumCheckoutStatusResponse,
  type EthereumCheckoutSubmissionResponse } from '../../../../shared/ethereum/checkout.ts';

const SYNTHETIC_METADATA: EthereumMetadata = {
  name: 'Synthetic metadata fixture', image: 'data:image/svg+xml;base64,PHN2Zy8+',
  description: 'Synthetic HTTP response for tests.', attributes: [],
};
const NOW = 2_000_000_000_000;
const ORIGIN = 'https://mons.shop';
const CONTRACT = '0x1111111111111111111111111111111111111111';
const OTHER_CONTRACT = '0x9999999999999999999999999999999999999999';
const ZERO = '0x0000000000000000000000000000000000000000';
const WALLET_KEY = `0x${'11'.repeat(32)}`;
const OTHER_KEY = `0x${'22'.repeat(32)}`;
const SIGNER_KEY = `0x${'0'.repeat(59)}a11ce`;
const WALLET = ethereumSignerAddress(WALLET_KEY);
const OTHER_WALLET = ethereumSignerAddress(OTHER_KEY);
const SIGNER = ethereumSignerAddress(SIGNER_KEY);
const ADDRESS_ID = 'ABCDEFGHIJKLMNOPQRST';
const REQUEST_ID = '10000000-0000-4000-8000-000000000001';
const HASH = `0x${'aa'.repeat(32)}`;
const CLAIM_HASH = `0x${'bb'.repeat(32)}`;
const blockHash = (number: number) => `0x${number.toString(16).padStart(64, '0')}`;
const functionSelector = (signature: string) => encodeCall(signature, [], []).slice(0, 10);
const topicNumber = (value: number | string) => encodeAbi(['uint256'], [value]);
const topicAddress = (value: string) => encodeAbi(['address'], [value]);
const readPaths = new Set<string>([paths.config, paths.stats, paths.inventory, paths.metadata, paths.profile, paths.shipments, checkoutPaths.status]);
type Rpc = { id: number; method: string; params: unknown[] };
type Item = { kind: number; displayId: number; owner: string };

function fixture(controlActive = true) {
  const ops = new DatabaseSync(':memory:');
  ops.exec(readFileSync('cloud/workers/api/ops-migrations/0008_ethereum_profiles.sql', 'utf8'));
  const failures = { quoteWrite: false, publishWrite: false, deliveryRetirementAck: false, claimRetirementAck: false };
  const databaseCalls = { requests: 0, statements: 0, limit: Infinity, claimReads: 0, claimInserts: 0 };
  const commerce = createCommerceD1Harness({ observeCall: (operation) => {
    databaseCalls.requests++;
    databaseCalls.statements += operation.method === 'batch' ? operation.statements.length : 1;
    if (databaseCalls.statements > databaseCalls.limit) throw new Error('D1 invocation query limit exceeded');
    const queries = operation.method === 'batch' ? operation.statements.map((statement) => statement.sql) : [operation.sql];
    databaseCalls.claimReads += queries.filter((sql) => /SELECT \* FROM ethereum_crate_claims/.test(sql)).length;
    databaseCalls.claimInserts += queries.filter((sql) => /INSERT OR IGNORE INTO ethereum_crate_claims/.test(sql)).length;
    if (failures.quoteWrite && operation.method === 'run' && operation.sql.includes('INSERT OR IGNORE INTO ethereum_delivery_quotes')) {
      throw new Error('Injected quote persistence failure');
    }
    if (failures.publishWrite && operation.method === 'batch' && operation.statements.some(statement => statement.sql.includes('INSERT INTO commerce_documents'))) {
      throw new Error('Injected order publication failure');
    }
    if (failures.deliveryRetirementAck && operation.method === 'run' && operation.sql.includes('UPDATE ethereum_delivery_quotes SET transaction_hash = NULL')) {
      throw new Error('Injected delivery retirement acknowledgement failure');
    }
    if (failures.claimRetirementAck && operation.method === 'run' && operation.sql.includes('UPDATE ethereum_crate_claims SET transaction_hash = NULL')) {
      throw new Error('Injected claim retirement acknowledgement failure');
    }
  } });
  if (controlActive) commerce.database.prepare(`UPDATE ethereum_111k_control SET paused = 0, revision = revision + 1,
    paused_at_ms = NULL, chain_id = 31337, contract_address = ?, updated_at_ms = ? WHERE singleton = 1`)
    .run(CONTRACT, NOW);
  const limiter: RateLimit = { limit: async () => ({ success: true }) };
  const env: EthereumEnvironment = {
    OPS_DB: d1Database(ops), COMMERCE_DB: commerce.db, ALCHEMY_MI_NOTE_API_KEY: 'test-alchemy-key',
    ETHEREUM_111K_CHAIN_ID: '31337', ETHEREUM_111K_CONTRACT_ADDRESS: CONTRACT,
    ETHEREUM_111K_DEPLOYMENT_BLOCK: '2',
    ETHEREUM_111K_METADATA_BASE_URI: 'https://cdn.mons.shop/111k-sepolia/',
    ETHEREUM_111K_RPC_URL: 'http://127.0.0.1:8545', ETHEREUM_111K_SIGNER_SECRET: SIGNER_KEY,
    STAFF_AUTH_CHALLENGE_RATE_LIMITER: limiter, STAFF_AUTH_SESSION_RATE_LIMITER: limiter, PUBLIC_SHOP_RATE_LIMITER: limiter,
  };
  const state = {
    now: NOW, head: 102, blockTimestamp: null as number | null, rpcChainId: null as number | null,
    finalizedBlock: null as { number: number; timestamp: number } | null,
    expectedSigner: SIGNER, contractCode: new Set<string>(), magic: '0x1626ba7e',
    discountRoot: `0x${'ab'.repeat(32)}`, discountAllowance: 3, discountUsed: new Map<string, number>([[WALLET, 1]]),
    tokens: new Map<string, Item>([['111112', { kind: 2, displayId: 1, owner: WALLET }],
      ['111113', { kind: 2, displayId: 2, owner: WALLET }], ['7', { kind: 1, displayId: 7, owner: WALLET }]]),
    receipts: new Map<string, EthereumReceipt>(), canonical: new Map<number, string>(),
    transactions: new Map<string, Record<string, unknown>>(), transactionCount: '0x0',
    logs: [] as EthereumLog[], calls: [] as Rpc[], batchSizes: [] as number[], urls: [] as string[], usedOrders: new Set<number>(),
    alchemyNfts: [] as Record<string, unknown>[], alchemyCursor: null as string | null,
    metadataValues: new Map<string, EthereumMetadata>(),
    metadataRequests: [] as { url: string; init?: RequestInit }[],
    afterRpc: null as ((payload: Rpc, result: unknown) => Promise<void>) | null,
  };
  const metadata: { fetch: typeof fetch } = {
    fetch: async (input, init) => {
      const url = String(input);
      state.metadataRequests.push({ url, init });
      const value = state.metadataValues.get(url);
      return value ? Response.json(value) : new Response(null, { status: 404 });
    },
  };
  const responseFor = async (payload: Rpc): Promise<unknown> => {
    state.calls.push(payload);
    const params = payload.params;
    if (payload.method === 'eth_chainId') return ethereumHexQuantity(state.rpcChainId ?? Number(env.ETHEREUM_111K_CHAIN_ID));
    if (payload.method === 'eth_getCode') return state.contractCode.has(String(params[0])) ? '0x60006000' : '0x';
    if (payload.method === 'eth_getTransactionCount') return state.transactionCount;
    if (payload.method === 'eth_getTransactionByHash') return state.transactions.get(String(params[0])) || null;
    if (payload.method === 'eth_blockNumber') return ethereumHexQuantity(state.head);
    if (payload.method === 'eth_getBlockByNumber') {
      if (params[0] === 'finalized') {
        const finalized = state.finalizedBlock;
        return finalized ? { number: ethereumHexQuantity(finalized.number), hash: state.canonical.get(finalized.number) || blockHash(finalized.number),
          timestamp: ethereumHexQuantity(finalized.timestamp) } : null;
      }
      const number = params[0] === 'latest' ? state.head : Number(BigInt(String(params[0])));
      return { number: ethereumHexQuantity(number), hash: state.canonical.get(number) || blockHash(number),
        timestamp: ethereumHexQuantity(state.blockTimestamp ?? Math.floor(state.now / 1000)) };
    }
    if (payload.method === 'eth_getTransactionReceipt') return state.receipts.get(String(params[0])) || null;
    if (payload.method === 'eth_getLogs') {
      const filter = params[0] as { topics?: (string | string[] | null)[]; fromBlock: string; toBlock: string };
      const firstTopic = filter.topics?.[0];
      return state.logs.filter(log => BigInt(log.blockNumber) >= BigInt(filter.fromBlock) && BigInt(log.blockNumber) <= BigInt(filter.toBlock) &&
        (Array.isArray(firstTopic) ? firstTopic.includes(log.topics[0]) : !firstTopic || log.topics[0] === firstTopic));
    }
    if (payload.method === 'eth_call') {
      const call = params[0] as { to: string; data: string };
      const selector = call.data.slice(0, 10);
      const argumentsHex = `0x${call.data.slice(10)}`;
      if (selector === functionSelector('quoteSigner()')) return encodeAbi(['address'], [state.expectedSigner]);
      if (selector === functionSelector('usedDeliveryOrders(uint256)')) {
        const orderId = Number(decodeReturn(['uint256'], argumentsHex)[0]);
        const canonical = [...state.receipts.values()].some((receipt) => receipt.status === '0x1' &&
          receipt.blockHash === (state.canonical.get(Number(BigInt(receipt.blockNumber))) || blockHash(Number(BigInt(receipt.blockNumber)))) &&
          receipt.logs.some((log) => log.topics[0] === ETHEREUM_EVENT_TOPICS.DeliveryRedeemed && Number(BigInt(log.topics[1])) === orderId));
        return encodeAbi(['bool'], [state.usedOrders.has(orderId) || canonical]);
      }
      if (selector === functionSelector('usedClaims(bytes32)')) {
        const claimId = String(decodeReturn(['bytes32'], argumentsHex)[0]);
        const used = [...state.receipts.values()].some((receipt) => receipt.status === '0x1' &&
          receipt.blockHash === (state.canonical.get(Number(BigInt(receipt.blockNumber))) || blockHash(Number(BigInt(receipt.blockNumber)))) &&
          receipt.logs.some((log) => log.topics[0] === ETHEREUM_EVENT_TOPICS.CrateReceiptClaimed && log.topics[1] === claimId));
        return encodeAbi(['bool'], [used]);
      }
      if (selector === functionSelector('getTokenInfos(uint256[])')) {
        const [ids] = decodeReturn(['uint256[]'], argumentsHex) as [bigint[]];
        return encodeAbi(['(uint8,uint256,address)[]'], [ids.map(id => {
          const item = state.tokens.get(String(id));
          return item ? [item.kind, item.displayId, item.owner] : [0, 0, ZERO];
        })]);
      }
      if (selector === functionSelector('previewTokenURI(uint8,uint256)') || selector === functionSelector('previewTokenURIs(uint8[],uint256[])')) {
        const batched = selector === functionSelector('previewTokenURIs(uint8[],uint256[])');
        const [kinds, ids] = batched ? decodeReturn(['uint8[]', 'uint256[]'], argumentsHex) as [bigint[], bigint[]] :
          decodeReturn(['uint8', 'uint256'], argumentsHex).map(value => [value]) as [bigint[], bigint[]];
        const uris = kinds.map((kind, index) => {
          const uri = `${env.ETHEREUM_111K_METADATA_BASE_URI}${ethereumMetadataTokenId(ethereumItemKind(Number(kind))!, Number(ids[index]))}.json`;
          if (!state.metadataValues.has(uri)) state.metadataValues.set(uri, SYNTHETIC_METADATA);
          return uri;
        });
        return encodeAbi([batched ? 'string[]' : 'string'], batched ? [uris] : [uris[0]]);
      }
      if (selector === functionSelector('isValidSignature(bytes32,bytes)')) return encodeAbi(['bytes4'], [state.magic]);
      if (selector === functionSelector('stats(address)')) {
        const [owner] = decodeReturn(['address'], argumentsHex) as [string];
        return encodeAbi(['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32', 'uint256', 'uint256', 'uint256'],
          [25, 2, 20, '100000000000000', '1100000000000000', true, state.discountRoot,
            '50000000000000', state.discountAllowance, state.discountUsed.get(owner) ?? 0]);
      }
    }
    throw new Error(`Unexpected mocked RPC: ${payload.method}`);
  };
  const providerFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(env.ETHEREUM_111K_METADATA_BASE_URI)) return metadata.fetch(input, init);
    state.urls.push(url);
    if (url.includes('/getNFTsForOwner')) return Response.json({ ownedNfts: state.alchemyNfts,
      ...(state.alchemyCursor ? { pageKey: state.alchemyCursor } : {}) });
    const payload = JSON.parse(String(init?.body)) as Rpc | Rpc[];
    if (Array.isArray(payload)) state.batchSizes.push(payload.length);
    const handle = async (entry: Rpc) => {
      const result = await responseFor(entry);
      await state.afterRpc?.(entry, result);
      return { jsonrpc: '2.0', id: entry.id, result };
    };
    const body = Array.isArray(payload) ? (await Promise.all(payload.map(handle))).reverse() : await handle(payload);
    return Response.json(body);
  };
  async function request<T = Record<string, unknown>>(pathWithQuery: string, body?: unknown, session?: string,
    options: { origin?: string; method?: string; csrf?: boolean; headers?: Record<string, string>; fetch?: typeof fetch } = {}) {
    const path = pathWithQuery.split('?')[0];
    const method = options.method || (readPaths.has(path) || path === paths.addresses && body === undefined ? 'GET' : 'POST');
    const request = new Request(`${ORIGIN}${pathWithQuery}`, { method, headers: {
      Origin: options.origin || ORIGIN, 'CF-Connecting-IP': '127.0.0.1', 'Content-Type': 'application/json',
      ...(options.csrf !== false ? { 'X-Mons-CSRF': '1' } : {}),
      ...(session ? { [ETHEREUM_SESSION_HEADER]: session } : {}), ...options.headers,
    }, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) });
    const response = await handleEthereumRequest(request, env, path, { nowMs: () => state.now, fetch: options.fetch ?? providerFetch });
    return { response, body: await response.json() as T };
  }
  async function challenge(wallet = WALLET) {
    const result = await request<EthereumAuthChallenge>(paths.authChallenge, { dropId: '111k_devnet', address: wallet, chainId: Number(env.ETHEREUM_111K_CHAIN_ID) });
    assert.equal(result.response.status, 200);
    return result.body;
  }
  async function session(key = WALLET_KEY) {
    const proof = await challenge(ethereumSignerAddress(key));
    const result = await request<EthereumSession>(paths.authVerify, { challengeId: proof.challengeId,
      signature: signDigest(key, personalMessageHash(proof.message)) });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  async function saveAddress(token: string, id = ADDRESS_ID) {
    const result = await request(paths.addresses, { id, encrypted: 'encrypted-test-address', country: 'United States',
      hint: 'Test recipient, US', email: 'test@example.com' }, token);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    return id;
  }
  async function prepared(tokenIds = ['111112'], requestId = REQUEST_ID) {
    const authentication = await session();
    await saveAddress(authentication.token);
    const result = await request<EthereumDeliveryPrepareResponse>(paths.deliveryPrepare,
      { tokenIds, addressId: ADDRESS_ID, requestId }, authentication.token);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    return { authentication, prepared: result.body };
  }
  function setReceipt(hash: string, logs: EthereumLog[], block = 100) {
    state.receipts.set(hash, { transactionHash: hash, blockNumber: ethereumHexQuantity(block), blockHash: blockHash(block),
      status: '0x1', from: WALLET, to: CONTRACT, logs });
  }
  function deliveryLog(prepared: EthereumDeliveryPrepareResponse, ids = ['111112'], receipts = ['2000001'], hash = HASH): EthereumLog {
    return { address: CONTRACT, topics: [ETHEREUM_EVENT_TOPICS.DeliveryRedeemed,
      topicNumber(prepared.orderId), topicAddress(prepared.quote.wallet)],
    data: encodeAbi(['uint256', 'uint256[]', 'uint256[]'], [prepared.quote.fee, ids, receipts]),
    blockNumber: '0x64', blockHash: blockHash(100), transactionHash: hash, logIndex: '0x0' };
  }
  function claimLog(prepared: EthereumClaimPrepareResponse, ids = physicalCrateArtworkIds(1).map(id => String(1_000_000 + id)), hash = CLAIM_HASH): EthereumLog {
    return { address: CONTRACT, topics: [ETHEREUM_EVENT_TOPICS.CrateReceiptClaimed,
      prepared.claimId, topicAddress(WALLET), topicNumber(prepared.receiptId)],
    data: encodeAbi(['uint256[]'], [ids]), blockNumber: '0x64', blockHash: blockHash(100), transactionHash: hash, logIndex: '0x0' };
  }
  function quoteRow(orderId: number) { return commerce.database.prepare('SELECT * FROM ethereum_delivery_quotes WHERE order_id = ?').get(orderId)!; }
  function claimRow(receipt = '2000001') { return commerce.database.prepare('SELECT * FROM ethereum_crate_claims WHERE receipt_id = ?').get(receipt)!; }
  function order(orderId: number): Record<string, unknown> | null {
    const row = commerce.database.prepare("SELECT document_json FROM commerce_documents WHERE document_kind = 'delivery_order' AND drop_id = '111k_devnet' AND document_id = ?").get(String(orderId));
    return row ? JSON.parse(String(row.document_json)) : null;
  }
  async function confirmed() {
    const ready = await prepared();
    const log = deliveryLog(ready.prepared);
    setReceipt(HASH, [log]);
    state.logs = [log];
    state.tokens.delete('111112');
    state.tokens.set('2000001', { kind: 5, displayId: 1, owner: WALLET });
    const result = await request(paths.deliveryConfirm, { orderId: ready.prepared.orderId, transactionHash: HASH }, ready.authentication.token);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.status, 'confirmed');
    return ready;
  }
  return { env, ops, commerce, failures, databaseCalls, state, metadata, providerFetch, request, challenge, session, saveAddress, prepared,
    setReceipt, deliveryLog, claimLog, quoteRow, claimRow, order, confirmed,
    close: () => { ops.close(); commerce.database.close(); } };
}

function pauseRpc(f: ReturnType<typeof fixture>, matches: (payload: Rpc) => boolean) {
  let resume!: () => void;
  let reached!: () => void;
  const paused = new Promise<void>((resolve) => { reached = resolve; });
  const released = new Promise<void>((resolve) => { resume = resolve; });
  f.state.afterRpc = async (payload) => {
    if (!matches(payload)) return;
    f.state.afterRpc = null;
    reached();
    await released;
  };
  return { paused, resume };
}

function readContext(f: ReturnType<typeof fixture>, providerFetch = f.providerFetch): EthereumContext {
  return { env: f.env, config: ethereumConfig(f.env), signal: AbortSignal.timeout(10_000), nowMs: f.state.now, fetch: providerFetch };
}

async function draftCheckout(f: ReturnType<typeof fixture>, tokenIds = ['111112'], requestId = crypto.randomUUID()) {
  const input = { requestId, dropId: '111k_devnet', tokenIds, callbackUrl: 'https://vvv.so/callback', state: 'caller-order-42' };
  const created = await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.create, input);
  assert.equal(created.response.status, 200, JSON.stringify(created.body));
  return { checkout: created.body, input };
}

async function preparedCheckout(f: ReturnType<typeof fixture>, tokenIds = ['111112']) {
  const { checkout, input } = await draftCheckout(f, tokenIds);
  const authentication = await f.session();
  await f.saveAddress(authentication.token);
  const prepared = await f.request<EthereumDeliveryPrepareResponse>(checkoutPaths.prepare,
    { checkoutId: checkout.checkoutId, addressId: ADDRESS_ID }, authentication.token);
  assert.equal(prepared.response.status, 200, JSON.stringify(prepared.body));
  return { checkout, input, authentication, prepared: prepared.body };
}

async function startedCheckout(f: ReturnType<typeof fixture>, tokenIds = ['111112']) {
  const ready = await preparedCheckout(f, tokenIds);
  const attemptId = crypto.randomUUID();
  const started = await f.request<EthereumCheckoutSubmissionResponse>(checkoutPaths.submission,
    { checkoutId: ready.checkout.checkoutId, attemptId, action: 'start', quoteDeadline: ready.prepared.quote.deadline }, ready.authentication.token);
  assert.equal(started.response.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.canSend, true);
  return { ...ready, attemptId };
}

test('checkout drafts are immutable, idempotent, unconnected previews with only approved callbacks', async () => {
  const f = fixture();
  try {
    const { checkout, input } = await draftCheckout(f, ['111113', '7']);
    assert.equal(checkout.status, 'ready');
    assert.equal(checkout.wallet, null);
    assert.deepEqual(checkout.tokenIds, ['7', '111113']);
    assert.equal(checkout.items.length, 2);
    assert.equal(new URL(checkout.returnUrl!).searchParams.get('result'), 'canceled');
    assert.equal(new URL(checkout.returnUrl!).searchParams.get('state'), input.state);
    const retried = await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.create, { ...input, tokenIds: ['7', '111113'] });
    assert.equal(retried.response.status, 200);
    assert.equal(retried.body.checkoutId, checkout.checkoutId);
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_delivery_checkouts').get()!.n, 1);
    assert.equal((await f.request(checkoutPaths.create, { ...input, tokenIds: ['111112'] })).response.status, 409);
    for (const callbackUrl of ['https://evil.example/callback', 'https://vvv.so.evil.example/callback',
      'https://vvv.so/callback?next=https://evil.example', 'javascript:alert(1)', '//evil.example/callback']) {
      assert.equal((await f.request(checkoutPaths.create, { ...input, requestId: crypto.randomUUID(), callbackUrl })).response.status, 400);
    }
    for (const tokenIds of [['7', '7'], ['0'], ['1.2'], Array.from({ length: 51 }, (_, index) => String(index + 1))]) {
      assert.equal((await f.request(checkoutPaths.create, { ...input, requestId: crypto.randomUUID(), tokenIds })).response.status, 400);
    }
    assert.equal((await f.request(checkoutPaths.create, { ...input, requestId: crypto.randomUUID(), dropId: '111k' })).response.status, 400);
  } finally { f.close(); }
});

test('checkout creation preserves every approved VVV path and callback result fields', async () => {
  const f = fixture();
  try {
    for (const host of ['vvv.so', 'www.vvv.so']) {
      for (const path of ['/', '/callback', '/111k', '/111k/floor', '/111k-sepolia-test', '/111k-sepolia-test/floor', '/any/nested/path/']) {
        const callbackUrl = `https://${host}${path}`;
        const created = await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.create, {
          requestId: crypto.randomUUID(), dropId: '111k_devnet', tokenIds: ['111112'], callbackUrl, state: 'caller+42/next',
        });
        assert.equal(created.response.status, 200, callbackUrl);
        const returned = new URL(created.body.returnUrl!);
        assert.equal(returned.origin, `https://${host}`);
        assert.equal(returned.pathname, path);
        assert.equal(returned.searchParams.get('checkout_id'), created.body.checkoutId);
        assert.equal(returned.searchParams.get('result'), 'canceled');
        assert.equal(returned.searchParams.get('chain_id'), String(created.body.chainId));
        assert.equal(returned.searchParams.get('state'), 'caller+42/next');
      }
    }
  } finally { f.close(); }
});

test('checkout draft writes use the narrow creation limiter without blocking public recovery reads', async () => {
  const f = fixture();
  try {
    const { checkout, input } = await draftCheckout(f);
    let creationCalls = 0;
    f.env.STAFF_AUTH_CHALLENGE_RATE_LIMITER = { limit: async () => { creationCalls++; return { success: false }; } };
    const limited = await f.request(checkoutPaths.create, { ...input, requestId: crypto.randomUUID() });
    assert.equal(limited.response.status, 429);
    assert.equal(creationCalls, 1);
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_delivery_checkouts').get()!.n, 1);
    assert.equal((await f.request(`${checkoutPaths.status}?checkoutId=${checkout.checkoutId}`)).response.status, 200);
    assert.equal((await f.request(checkoutPaths.refresh, { checkoutId: checkout.checkoutId })).response.status, 200);
    assert.equal(creationCalls, 1);
  } finally { f.close(); }
});

test('checkout status exposes no private data to either VVV origin and does not open any mutation', async () => {
  const f = fixture();
  try {
    const ready = await preparedCheckout(f);
    for (const origin of ['https://vvv.so', 'https://www.vvv.so']) {
      const result = await f.request<EthereumCheckoutStatusResponse>(`${checkoutPaths.status}?checkoutId=${ready.checkout.checkoutId}`,
        undefined, undefined, { origin });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.wallet, WALLET);
      assert.equal(result.body.orderId, ready.prepared.orderId);
      assert.equal(result.body.returnUrl, undefined);
      const serialized = JSON.stringify(result.body);
      for (const privateValue of ['encrypted-test-address', 'test@example.com', 'Test recipient', ADDRESS_ID, 'caller-order-42', ready.authentication.token]) {
        assert.equal(serialized.includes(privateValue), false, privateValue);
      }
      for (const path of [checkoutPaths.create, checkoutPaths.prepare, checkoutPaths.submission, checkoutPaths.refresh, paths.profile, paths.authChallenge]) {
        assert.equal((await f.request(path, {}, ready.authentication.token, { origin })).response.status, 403, path);
      }
    }
    for (const origin of ['https://evil.example', 'https://other.vvv.so', 'https://www.vvv.so.evil.example', 'http://www.vvv.so', 'https://www.vvv.so:8443']) {
      assert.equal((await f.request(`${checkoutPaths.status}?checkoutId=${ready.checkout.checkoutId}`, undefined, undefined,
        { origin })).response.status, 403, origin);
    }
    assert.equal((await f.request(checkoutPaths.prepare, { checkoutId: ready.checkout.checkoutId, addressId: ADDRESS_ID })).response.status, 401);
  } finally { f.close(); }
});

test('checkout ownership refresh supports a changed wallet while preparation binds one immutable address and order', async () => {
  const f = fixture();
  try {
    const { checkout } = await draftCheckout(f);
    const first = await f.session();
    const second = await f.session(OTHER_KEY);
    await f.saveAddress(first.token);
    await f.saveAddress(second.token);
    assert.equal((await f.request(checkoutPaths.prepare, { checkoutId: checkout.checkoutId, addressId: ADDRESS_ID }, second.token)).response.status, 403);
    f.state.tokens.set('111112', { kind: 2, displayId: 1, owner: OTHER_WALLET });
    const status = await f.request<EthereumCheckoutStatusResponse>(`${checkoutPaths.status}?checkoutId=${checkout.checkoutId}`);
    assert.equal(status.body.items[0].owner, OTHER_WALLET);
    const input = { checkoutId: checkout.checkoutId, addressId: ADDRESS_ID };
    const [left, right] = await Promise.all([
      f.request<EthereumDeliveryPrepareResponse>(checkoutPaths.prepare, input, second.token),
      f.request<EthereumDeliveryPrepareResponse>(checkoutPaths.prepare, input, second.token),
    ]);
    assert.equal(left.response.status, 200, JSON.stringify(left.body));
    assert.equal(right.response.status, 200, JSON.stringify(right.body));
    assert.equal(left.body.orderId, right.body.orderId);
    assert.equal(f.quoteRow(left.body.orderId).checkout_id, checkout.checkoutId);
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_delivery_quotes WHERE checkout_id = ?').get(checkout.checkoutId)!.n, 1);
    const resumed = await f.request<EthereumDeliveryPrepareResponse>(checkoutPaths.prepare, { checkoutId: checkout.checkoutId }, second.token);
    assert.equal(resumed.body.orderId, left.body.orderId);
    assert.equal((await f.request(checkoutPaths.prepare, input, first.token)).response.status, 403);
    await f.saveAddress(second.token, 'UVWXYZABCDEFGHIJKLMN');
    assert.equal((await f.request(checkoutPaths.prepare, { ...input, addressId: 'UVWXYZABCDEFGHIJKLMN' }, second.token)).response.status, 409);
  } finally { f.close(); }
});

test('checkout quote persistence failure never returns a transaction and retries retain the original draft', async () => {
  const f = fixture();
  try {
    const { checkout } = await draftCheckout(f);
    const auth = await f.session();
    await f.saveAddress(auth.token);
    f.failures.quoteWrite = true;
    const failed = await f.request(checkoutPaths.prepare, { checkoutId: checkout.checkoutId, addressId: ADDRESS_ID }, auth.token);
    assert.equal(failed.response.status, 503);
    assert.equal(failed.body.transaction, undefined);
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_delivery_quotes').get()!.n, 0);
    f.failures.quoteWrite = false;
    const prepared = await f.request<EthereumDeliveryPrepareResponse>(checkoutPaths.prepare,
      { checkoutId: checkout.checkoutId, addressId: ADDRESS_ID }, auth.token);
    assert.equal(prepared.response.status, 200);
    assert.equal(f.quoteRow(prepared.body.orderId).checkout_id, checkout.checkoutId);
  } finally { f.close(); }
});

test('checkout start locks across concurrent tabs and a replay never authorizes a second wallet send', async () => {
  const f = fixture();
  try {
    const ready = await preparedCheckout(f);
    const body = { checkoutId: ready.checkout.checkoutId, attemptId: crypto.randomUUID(), action: 'start', quoteDeadline: ready.prepared.quote.deadline };
    const results = await Promise.all([0, 1].map(() => f.request<EthereumCheckoutSubmissionResponse>(checkoutPaths.submission, body, ready.authentication.token)));
    assert.deepEqual(results.map(result => result.response.status), [200, 200]);
    assert.equal(results.filter(result => result.body.canSend).length, 1);
    const retry = await f.request<EthereumCheckoutSubmissionResponse>(checkoutPaths.submission, body, ready.authentication.token);
    assert.equal(retry.body.canSend, false);
    assert.equal(retry.body.checkout.status, 'submitting');
    assert.equal((await f.request(checkoutPaths.submission, { ...body, attemptId: crypto.randomUUID() }, ready.authentication.token)).response.status, 409);
    assert.equal((await f.request(checkoutPaths.prepare, { checkoutId: ready.checkout.checkoutId }, ready.authentication.token)).response.status, 409);
    assert.equal((await f.request<EthereumCheckoutStatusResponse>(`${checkoutPaths.status}?checkoutId=${ready.checkout.checkoutId}`)).body.status, 'submitting');
  } finally { f.close(); }
});

test('checkout start requires the prepared deadline and rejects a quote renewed by another client', async () => {
  const f = fixture();
  try {
    const ready = await preparedCheckout(f);
    const body = { checkoutId: ready.checkout.checkoutId, attemptId: crypto.randomUUID(), action: 'start' };
    assert.equal((await f.request(checkoutPaths.submission, body, ready.authentication.token)).response.status, 400);
    f.state.now = (ready.prepared.quote.deadline + 1) * 1000;
    const renewed = await f.request<EthereumDeliveryPrepareResponse>(checkoutPaths.prepare,
      { checkoutId: ready.checkout.checkoutId }, ready.authentication.token);
    assert.equal(renewed.response.status, 200);
    assert.ok(renewed.body.quote.deadline > ready.prepared.quote.deadline);
    const stale = await f.request(checkoutPaths.submission,
      { ...body, quoteDeadline: ready.prepared.quote.deadline }, ready.authentication.token);
    assert.equal(stale.response.status, 409);
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_delivery_checkout_attempts').get()!.n, 0);
    const current = { ...body, quoteDeadline: renewed.body.quote.deadline };
    const started = await f.request<EthereumCheckoutSubmissionResponse>(checkoutPaths.submission, current, ready.authentication.token);
    assert.equal(started.response.status, 200);
    assert.equal(started.body.canSend, true);
    const repeated = await f.request<EthereumCheckoutSubmissionResponse>(checkoutPaths.submission, current, ready.authentication.token);
    assert.equal(repeated.response.status, 200);
    assert.equal(repeated.body.canSend, false);
    assert.equal((await f.request(checkoutPaths.submission,
      { ...body, quoteDeadline: ready.prepared.quote.deadline }, ready.authentication.token)).response.status, 409);
  } finally { f.close(); }
});

test('checkout start cannot reuse an earlier attempt ID for a renewed quote', async () => {
  const f = fixture();
  try {
    const ready = await startedCheckout(f);
    const attempt = { checkoutId: ready.checkout.checkoutId, attemptId: ready.attemptId };
    assert.equal((await f.request(checkoutPaths.submission,
      { ...attempt, action: 'reject' }, ready.authentication.token)).response.status, 200);
    f.state.now = (ready.prepared.quote.deadline + 1) * 1000;
    const renewed = await f.request<EthereumDeliveryPrepareResponse>(checkoutPaths.prepare,
      { checkoutId: ready.checkout.checkoutId }, ready.authentication.token);
    assert.equal(renewed.response.status, 200);
    assert.ok(renewed.body.quote.deadline > ready.prepared.quote.deadline);
    const repeated = await f.request(checkoutPaths.submission,
      { ...attempt, action: 'start', quoteDeadline: renewed.body.quote.deadline }, ready.authentication.token);
    assert.equal(repeated.response.status, 409);
    assert.equal(f.commerce.database.prepare('SELECT status FROM ethereum_delivery_checkout_attempts WHERE attempt_id = ?')
      .get(ready.attemptId)!.status, 'rejected');
  } finally { f.close(); }
});

test('checkout start reserves overlapping items atomically across separate sessions while disjoint selections proceed', async () => {
  const f = fixture();
  try {
    const left = await preparedCheckout(f, ['7', '111112']);
    const right = await preparedCheckout(f, ['111112', '111113']);
    const disjoint = await preparedCheckout(f, ['111113']);
    const [first, second] = await Promise.all([left, right].map(ready => f.request<EthereumCheckoutSubmissionResponse>(checkoutPaths.submission,
      { checkoutId: ready.checkout.checkoutId, attemptId: crypto.randomUUID(), action: 'start', quoteDeadline: ready.prepared.quote.deadline }, ready.authentication.token)));
    const outcomes = [first, second];
    assert.deepEqual(outcomes.map(outcome => outcome.response.status).sort(), [200, 409]);
    assert.equal(outcomes.filter(outcome => outcome.body.canSend).length, 1);
    const winning = first.response.status === 200 ? left : right;
    const losing = first.response.status === 200 ? second : first;
    assert.equal((losing.body as unknown as { error: { details: { blockingCheckoutId: string } } }).error.details.blockingCheckoutId, winning.checkout.checkoutId);
    if (winning === right) {
      const winnerAttempt = (second.body as EthereumCheckoutSubmissionResponse).checkout.attempt!;
      await f.request(checkoutPaths.submission, { checkoutId: right.checkout.checkoutId, attemptId: winnerAttempt.attemptId, action: 'reject' }, right.authentication.token);
      const startLeft = await f.request<EthereumCheckoutSubmissionResponse>(checkoutPaths.submission,
        { checkoutId: left.checkout.checkoutId, attemptId: crypto.randomUUID(), action: 'start', quoteDeadline: left.prepared.quote.deadline }, left.authentication.token);
      assert.equal(startLeft.body.canSend, true);
    }
    const independent = await f.request<EthereumCheckoutSubmissionResponse>(checkoutPaths.submission,
      { checkoutId: disjoint.checkout.checkoutId, attemptId: crypto.randomUUID(), action: 'start', quoteDeadline: disjoint.prepared.quote.deadline }, disjoint.authentication.token);
    assert.equal(independent.response.status, 200, JSON.stringify(independent.body));
    assert.equal(independent.body.canSend, true);
  } finally { f.close(); }
});

test('checkout revalidates ownership before reserving a wallet send', async () => {
  const f = fixture();
  try {
    const ready = await preparedCheckout(f);
    f.state.tokens.set('111112', { kind: 2, displayId: 1, owner: OTHER_WALLET });
    const started = await f.request(checkoutPaths.submission,
      { checkoutId: ready.checkout.checkoutId, attemptId: crypto.randomUUID(), action: 'start', quoteDeadline: ready.prepared.quote.deadline }, ready.authentication.token);
    assert.equal(started.response.status, 409);
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_delivery_checkout_attempts').get()!.n, 0);
  } finally { f.close(); }
});

for (const phase of ['initial', 'late'] as const) test(`checkout preparation identifies overlapping submissions at the ${phase} guard`, async () => {
  const f = fixture();
  try {
    const ready = await preparedCheckout(f);
    const { checkout } = await draftCheckout(f);
    const input = { checkoutId: checkout.checkoutId, addressId: ADDRESS_ID };
    if (phase === 'late') assert.equal((await f.request(checkoutPaths.prepare, input, ready.authentication.token)).response.status, 200);
    const paused = phase === 'late' ? pauseRpc(f, payload => payload.method === 'eth_getBlockByNumber' && payload.params[0] === 'latest') : null;
    const pending = paused ? f.request(checkoutPaths.prepare, input, ready.authentication.token) : null;
    if (paused) await paused.paused;
    const started = await f.request<EthereumCheckoutSubmissionResponse>(checkoutPaths.submission,
      { checkoutId: ready.checkout.checkoutId, attemptId: crypto.randomUUID(), action: 'start', quoteDeadline: ready.prepared.quote.deadline }, ready.authentication.token);
    assert.equal(started.body.canSend, true);
    paused?.resume();
    const result = await (pending ?? f.request(checkoutPaths.prepare, input, ready.authentication.token));
    assert.equal(result.response.status, 409, JSON.stringify(result.body));
    assert.equal((result.body.error as { details: { blockingCheckoutId: string } }).details.blockingCheckoutId, ready.checkout.checkoutId);
    assert.equal(result.body.signature, undefined);
  } finally { f.close(); }
});

test('canonical reverted and completed checkouts release overlapping item reservations', async () => {
  const f = fixture();
  try {
    const next = await preparedCheckout(f);
    const previous = await startedCheckout(f);
    const start = () => f.request<EthereumCheckoutSubmissionResponse>(checkoutPaths.submission,
      { checkoutId: next.checkout.checkoutId, attemptId: crypto.randomUUID(), action: 'start', quoteDeadline: next.prepared.quote.deadline }, next.authentication.token);
    assert.equal((await start()).response.status, 409);
    setCheckoutTransaction(f, previous.prepared);
    await f.request(checkoutPaths.submission, { checkoutId: previous.checkout.checkoutId, attemptId: previous.attemptId, action: 'report', transactionHash: HASH }, previous.authentication.token);
    f.setReceipt(HASH, []);
    f.state.receipts.get(HASH)!.status = '0x0';
    const failed = await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId: previous.checkout.checkoutId });
    assert.equal(failed.body.status, 'failed');
    const allowed = await start();
    assert.equal(allowed.response.status, 200, JSON.stringify(allowed.body));
    assert.equal(allowed.body.canSend, true);
    await f.request(checkoutPaths.submission, { checkoutId: next.checkout.checkoutId,
      attemptId: allowed.body.checkout.attempt!.attemptId, action: 'reject' }, next.authentication.token);
    const log = f.deliveryLog(previous.prepared);
    f.setReceipt(HASH, [log]);
    f.state.logs = [log];
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.order(previous.prepared.orderId)!.status, 'ready_to_ship');
    const afterSuccess = await start();
    assert.equal(afterSuccess.response.status, 200, JSON.stringify(afterSuccess.body));
    assert.equal(afterSuccess.body.canSend, true);
  } finally { f.close(); }
});

test('checkout rejection cannot erase a reported hash and missing receipts remain pending in durable storage', async () => {
  const f = fixture();
  try {
    const ready = await startedCheckout(f);
    const body = { checkoutId: ready.checkout.checkoutId, attemptId: ready.attemptId };
    const report = await f.request<EthereumCheckoutSubmissionResponse>(checkoutPaths.submission,
      { ...body, action: 'report', transactionHash: HASH }, ready.authentication.token);
    assert.equal(report.response.status, 200);
    assert.equal(report.body.checkout.status, 'pending');
    assert.equal(report.body.checkout.transactionHash, HASH);
    assert.equal(f.quoteRow(ready.prepared.orderId).transaction_hash, null);
    assert.equal((await f.request(checkoutPaths.submission, { ...body, action: 'reject' }, ready.authentication.token)).response.status, 409);
    const refreshed = await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId: ready.checkout.checkoutId });
    assert.equal(refreshed.response.status, 200, JSON.stringify(refreshed.body));
    assert.equal(refreshed.body.status, 'pending');
    assert.equal(refreshed.body.transactionHash, HASH);
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.commerce.database.prepare('SELECT transaction_hash FROM ethereum_delivery_checkout_attempts WHERE attempt_id = ?').get(ready.attemptId)!.transaction_hash, HASH);
  } finally { f.close(); }
});

test('checkout rejection followed by a late report explicitly fails instead of pretending the hash was saved', async () => {
  const f = fixture();
  try {
    const ready = await startedCheckout(f);
    const body = { checkoutId: ready.checkout.checkoutId, attemptId: ready.attemptId };
    assert.equal((await f.request(checkoutPaths.submission, { ...body, action: 'reject' }, ready.authentication.token)).response.status, 200);
    assert.equal((await f.request(checkoutPaths.submission, { ...body, action: 'report', transactionHash: HASH }, ready.authentication.token)).response.status, 409);
    const resumed = await f.request<EthereumDeliveryPrepareResponse>(checkoutPaths.prepare, { checkoutId: ready.checkout.checkoutId }, ready.authentication.token);
    assert.equal(resumed.response.status, 200);
    assert.equal(resumed.body.orderId, ready.prepared.orderId);
  } finally { f.close(); }
});

for (const recovery of ['scheduled', 'foreground'] as const) test(`checkout ${recovery} recovery releases an abandoned attempt only after unused authorization is finalized expired`, async () => {
  const f = fixture();
  try {
    const ready = await startedCheckout(f);
    f.state.now = (ready.prepared.quote.deadline + 3600) * 1000;
    f.state.head = 1000;
    f.state.finalizedBlock = { number: 990, timestamp: ready.prepared.quote.deadline + 1 };
    if (recovery === 'scheduled') await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    else assert.equal((await f.request(checkoutPaths.refresh, { checkoutId: ready.checkout.checkoutId })).response.status, 200);
    const status = await f.request<EthereumCheckoutStatusResponse>(`${checkoutPaths.status}?checkoutId=${ready.checkout.checkoutId}`);
    assert.equal(status.body.status, 'failed');
    assert.equal(status.body.transactionHash, null);
    assert.equal(status.body.attempt!.status, 'failed');
    assert.equal(new URL(status.body.returnUrl!).searchParams.get('result'), 'failed');
    const attempt = f.commerce.database.prepare('SELECT status, block_number, block_hash FROM ethereum_delivery_checkout_attempts WHERE attempt_id = ?').get(ready.attemptId)!;
    assert.deepEqual({ ...attempt }, { status: 'expired', block_number: 990, block_hash: blockHash(990) });
    assert.ok(f.state.calls.some(call => call.method === 'eth_call' && typeof call.params[1] === 'object' &&
      JSON.stringify(call.params[1]) === JSON.stringify({ blockHash: blockHash(990), requireCanonical: true })));
    const authentication = await f.session();
    assert.equal((await f.request(checkoutPaths.prepare, { checkoutId: ready.checkout.checkoutId }, authentication.token)).response.status, 409);
    assert.equal((await f.request(paths.deliveryPrepare, { tokenIds: ['111112'], addressId: ADDRESS_ID,
      requestId: ready.checkout.checkoutId }, authentication.token)).response.status, 409);
    const checkedTime = f.state.now;
    f.state.now = NOW;
    assert.equal((await f.request(checkoutPaths.submission, { checkoutId: ready.checkout.checkoutId,
      attemptId: crypto.randomUUID(), action: 'start', quoteDeadline: ready.prepared.quote.deadline }, authentication.token)).response.status, 409);
    setCheckoutTransaction(f, ready.prepared);
    assert.equal((await f.request(checkoutPaths.submission, { checkoutId: ready.checkout.checkoutId,
      attemptId: crypto.randomUUID(), action: 'recover', transactionHash: HASH }, authentication.token)).response.status, 409);
    f.state.now = checkedTime;
    const next = await startedCheckout(f);
    assert.notEqual(next.checkout.checkoutId, ready.checkout.checkoutId);
    const expiredLegacy = await f.request(paths.deliveryPrepare, { tokenIds: ['111112'], addressId: ADDRESS_ID,
      requestId: ready.checkout.checkoutId }, authentication.token);
    assert.equal(expiredLegacy.response.status, 409);
    assert.equal((expiredLegacy.body.error as { details?: unknown }).details, undefined);
  } finally { f.close(); }
});

for (const safety of ['before-deadline', 'no-finalized-block', 'provider-error', 'snapshot-reorg', 'quote-renewal'] as const) {
  test(`checkout expiry keeps an abandoned attempt unresolved for ${safety}`, async () => {
    const f = fixture();
    try {
      const ready = await startedCheckout(f);
      f.state.now = (ready.prepared.quote.deadline + 3600) * 1000;
      f.state.head = 1000;
      f.state.finalizedBlock = safety === 'no-finalized-block' ? null : {
        number: 990, timestamp: ready.prepared.quote.deadline + (safety === 'before-deadline' ? 0 : 1),
      };
      f.state.afterRpc = async (payload) => {
        if (safety === 'provider-error' && payload.method === 'eth_getBlockByNumber' && payload.params[0] === 'finalized') throw new Error('Finality unavailable');
        if (payload.method !== 'eth_call' || typeof payload.params[1] !== 'object') return;
        if (safety === 'snapshot-reorg') f.state.canonical.set(990, blockHash(9999));
        if (safety === 'quote-renewal') f.commerce.database.prepare(`UPDATE ethereum_delivery_quotes SET deadline = deadline + 10000,
          updated_at_ms = updated_at_ms + 1 WHERE order_id = ?`).run(ready.prepared.orderId);
      };
      const refreshed = await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId: ready.checkout.checkoutId });
      assert.equal(refreshed.response.status, 200, JSON.stringify(refreshed.body));
      assert.equal(refreshed.body.status, 'submitting');
      assert.equal(f.commerce.database.prepare('SELECT status FROM ethereum_delivery_checkout_attempts WHERE attempt_id = ?').get(ready.attemptId)!.status, 'started');
    } finally { f.close(); }
  });
}

test('a finalized used order remains reserved and recovers its successful redemption instead of expiring', async () => {
  const f = fixture();
  try {
    f.state.head = 98;
    const ready = await startedCheckout(f);
    f.state.now = (ready.prepared.quote.deadline + 3600) * 1000;
    f.state.head = 1000;
    f.state.finalizedBlock = { number: 990, timestamp: ready.prepared.quote.deadline + 1 };
    f.state.usedOrders.add(ready.prepared.orderId);
    let refreshed = await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId: ready.checkout.checkoutId });
    assert.equal(refreshed.body.status, 'submitting');
    const log = f.deliveryLog(ready.prepared);
    f.setReceipt(HASH, [log]);
    f.state.logs = [log];
    f.state.tokens.delete('111112');
    refreshed = await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId: ready.checkout.checkoutId });
    assert.equal(refreshed.response.status, 200, JSON.stringify(refreshed.body));
    assert.equal(refreshed.body.status, 'success');
    assert.equal(f.commerce.database.prepare('SELECT status FROM ethereum_delivery_checkout_attempts WHERE attempt_id = ?').get(ready.attemptId)!.status, 'started');
    assert.equal(f.order(ready.prepared.orderId)!.status, 'ready_to_ship');
  } finally { f.close(); }
});

test('expiry cannot discard a transaction hash reported while finalized state is being checked', async () => {
  const f = fixture();
  try {
    const ready = await startedCheckout(f);
    f.state.now = (ready.prepared.quote.deadline + 1) * 1000;
    f.state.finalizedBlock = { number: 100, timestamp: ready.prepared.quote.deadline + 1 };
    const paused = pauseRpc(f, payload => payload.method === 'eth_call' && typeof payload.params[1] === 'object');
    const refresh = f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId: ready.checkout.checkoutId });
    await paused.paused;
    const reported = await f.request(checkoutPaths.submission, { checkoutId: ready.checkout.checkoutId,
      attemptId: ready.attemptId, action: 'report', transactionHash: HASH }, ready.authentication.token);
    assert.equal(reported.response.status, 200);
    paused.resume();
    const result = await refresh;
    assert.equal(result.body.status, 'pending');
    assert.equal(result.body.transactionHash, HASH);
    const attempt = f.commerce.database.prepare('SELECT status, transaction_hash FROM ethereum_delivery_checkout_attempts WHERE attempt_id = ?').get(ready.attemptId)!;
    assert.deepEqual({ ...attempt }, { status: 'submitted', transaction_hash: HASH });
  } finally { f.close(); }
});

test('legacy delivery preparation cannot renew a checkout quote while its transaction is unresolved', async () => {
  const f = fixture();
  try {
    const ready = await startedCheckout(f);
    f.state.now = (ready.prepared.quote.deadline + 1) * 1000;
    const renewed = await f.request(paths.deliveryPrepare, { tokenIds: ['111112'], addressId: ADDRESS_ID,
      requestId: ready.checkout.checkoutId }, ready.authentication.token);
    assert.equal(renewed.response.status, 409);
    assert.equal(f.quoteRow(ready.prepared.orderId).deadline, ready.prepared.quote.deadline);
  } finally { f.close(); }
});

test('a checkout submission that starts during legacy quote renewal prevents the deadline update and signature', async () => {
  const f = fixture();
  try {
    const ready = await preparedCheckout(f);
    f.state.now = (ready.prepared.quote.deadline + 1) * 1000;
    const paused = pauseRpc(f, payload => payload.method === 'eth_getBlockByNumber' && payload.params[0] === 'latest');
    const renewed = f.request(paths.deliveryPrepare, { tokenIds: ['111112'], addressId: ADDRESS_ID,
      requestId: ready.checkout.checkoutId }, ready.authentication.token);
    await paused.paused;
    f.state.now = (ready.prepared.quote.deadline - 1) * 1000;
    const started = await f.request<EthereumCheckoutSubmissionResponse>(checkoutPaths.submission, {
      checkoutId: ready.checkout.checkoutId, attemptId: crypto.randomUUID(), action: 'start', quoteDeadline: ready.prepared.quote.deadline,
    }, ready.authentication.token);
    assert.equal(started.response.status, 200);
    assert.equal(started.body.canSend, true);
    paused.resume();
    const result = await renewed;
    assert.equal(result.response.status, 409);
    assert.equal(result.body.signature, undefined);
    assert.equal(f.quoteRow(ready.prepared.orderId).deadline, ready.prepared.quote.deadline);
  } finally { f.close(); }
});

for (const receiptStatus of ['0x0', '0x1']) test(`contract-wallet outer transaction ${receiptStatus} resolves only after finalized unused expiry`, async () => {
  const f = fixture();
  try {
    f.state.contractCode.add(WALLET);
    const ready = await startedCheckout(f);
    setCheckoutTransaction(f, ready.prepared, HASH, { from: OTHER_WALLET, to: WALLET, input: '0x1234', value: '0x0' });
    await f.request(checkoutPaths.submission, { checkoutId: ready.checkout.checkoutId, attemptId: ready.attemptId,
      action: 'report', transactionHash: HASH }, ready.authentication.token);
    f.setReceipt(HASH, []);
    f.state.receipts.set(HASH, { ...f.state.receipts.get(HASH)!, from: OTHER_WALLET, to: WALLET, status: receiptStatus });
    f.state.finalizedBlock = { number: 100, timestamp: ready.prepared.quote.deadline - 1 };
    let refreshed = await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId: ready.checkout.checkoutId });
    assert.equal(refreshed.response.status, 200, JSON.stringify(refreshed.body));
    assert.equal(refreshed.body.status, 'pending');
    assert.equal(f.commerce.database.prepare('SELECT status FROM ethereum_delivery_checkout_attempts WHERE attempt_id = ?').get(ready.attemptId)!.status, 'submitted');
    f.state.now = (ready.prepared.quote.deadline + 3600) * 1000;
    f.state.head = 1000;
    f.state.finalizedBlock = { number: 990, timestamp: ready.prepared.quote.deadline + 1 };
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    refreshed = await f.request<EthereumCheckoutStatusResponse>(`${checkoutPaths.status}?checkoutId=${ready.checkout.checkoutId}`);
    assert.equal(refreshed.body.status, 'failed');
    assert.equal(refreshed.body.transactionHash, HASH);
    const attempt = f.commerce.database.prepare('SELECT status, block_hash, transaction_hash FROM ethereum_delivery_checkout_attempts WHERE attempt_id = ?').get(ready.attemptId)!;
    assert.deepEqual({ ...attempt }, { status: 'expired', block_hash: blockHash(990), transaction_hash: HASH });
  } finally { f.close(); }
});

for (const recovery of ['scheduled', 'foreground'] as const) test(`checkout ${recovery} recovery completes after closing before the hash report without wallet authentication`, async () => {
  const f = fixture();
  try {
    f.state.head = 98;
    const ready = await startedCheckout(f);
    const log = f.deliveryLog(ready.prepared);
    f.setReceipt(HASH, [log]);
    f.state.logs = [log];
    f.state.head = 102;
    f.state.tokens.delete('111112');
    f.ops.exec('DELETE FROM ethereum_auth_sessions');
    if (recovery === 'scheduled') await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    else assert.equal((await f.request(checkoutPaths.refresh, { checkoutId: ready.checkout.checkoutId })).response.status, 200);
    const result = await f.request<EthereumCheckoutStatusResponse>(`${checkoutPaths.status}?checkoutId=${ready.checkout.checkoutId}`,
      undefined, undefined, { origin: 'https://vvv.so' });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.status, 'success');
    assert.equal(result.body.transactionHash, HASH);
    assert.equal(result.body.confirmations, 3);
    assert.equal(result.body.items[0].tokenId, '111112');
    assert.equal(f.order(ready.prepared.orderId)!.status, 'ready_to_ship');
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.commerce.database.prepare("SELECT COUNT(*) AS n FROM commerce_documents WHERE document_kind = 'delivery_order'").get()!.n, 1);
  } finally { f.close(); }
});

test('checkout reports real confirmations, waits for publication, and stops advertising success after a reorg', async () => {
  const f = fixture();
  try {
    f.state.head = 98;
    const ready = await startedCheckout(f);
    const log = f.deliveryLog(ready.prepared);
    f.setReceipt(HASH, [log]);
    f.state.logs = [log];
    f.state.head = 100;
    let result = await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId: ready.checkout.checkoutId });
    assert.equal(result.body.status, 'pending');
    assert.equal(result.body.confirmations, 1);
    f.state.head = 102;
    f.failures.publishWrite = true;
    assert.equal((await f.request(checkoutPaths.refresh, { checkoutId: ready.checkout.checkoutId })).response.status, 503);
    result = await f.request<EthereumCheckoutStatusResponse>(`${checkoutPaths.status}?checkoutId=${ready.checkout.checkoutId}`);
    assert.equal(result.body.status, 'pending');
    assert.equal(result.body.confirmations, 3);
    f.failures.publishWrite = false;
    result = await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId: ready.checkout.checkoutId });
    assert.equal(result.body.status, 'success');
    f.state.canonical.set(100, blockHash(999));
    result = await f.request<EthereumCheckoutStatusResponse>(`${checkoutPaths.status}?checkoutId=${ready.checkout.checkoutId}`);
    assert.equal(result.body.status, 'pending');
    assert.equal(result.body.confirmations, 0);
  } finally { f.close(); }
});

for (const includedBlock of [100, 103]) test(`checkout status rejects stale publication after demotion at block ${includedBlock}`, async () => {
  const f = fixture();
  try {
    f.state.head = 98;
    const ready = await startedCheckout(f);
    const checkoutId = ready.checkout.checkoutId;
    await f.request(checkoutPaths.submission, { checkoutId, attemptId: ready.attemptId, action: 'report', transactionHash: HASH }, ready.authentication.token);
    const log = f.deliveryLog(ready.prepared);
    f.setReceipt(HASH, [log]);
    f.state.logs = [log];
    f.state.head = 102;
    assert.equal((await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId })).body.status, 'success');
    const reorgLog = { ...log, blockNumber: ethereumHexQuantity(includedBlock), blockHash: blockHash(includedBlock) };
    f.setReceipt(HASH, [reorgLog], includedBlock);
    f.state.logs = [reorgLog];
    f.state.head = includedBlock;
    const paused = pauseRpc(f, payload => payload.method === 'eth_getTransactionReceipt');
    const pending = f.request<EthereumCheckoutStatusResponse>(`${checkoutPaths.status}?checkoutId=${checkoutId}`);
    await paused.paused;
    assert.equal((await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId })).body.status, 'pending');
    f.state.head = includedBlock + 2;
    paused.resume();
    const result = await pending;
    assert.equal(result.body.confirmations, 3);
    assert.equal(result.body.status, 'pending');
    assert.equal(new URL(result.body.returnUrl!).searchParams.get('result'), 'pending');
    assert.equal(f.quoteRow(ready.prepared.orderId).published_at_ms, null);
    assert.equal(f.order(ready.prepared.orderId)!.status, 'processing');
    assert.equal((await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId })).body.status, 'success');
    assert.equal(f.order(ready.prepared.orderId)!.status, 'ready_to_ship');
  } finally { f.close(); }
});

for (const change of ['reactivated', 'started', 'rejected', 'confirmed'] as const) test(`checkout status keeps a stale failure pending after the checkout is ${change}`, async () => {
  const f = fixture();
  try {
    const ready = await startedCheckout(f);
    const checkoutId = ready.checkout.checkoutId;
    setCheckoutTransaction(f, ready.prepared);
    await f.request(checkoutPaths.submission,
      { checkoutId, attemptId: ready.attemptId, action: 'report', transactionHash: HASH }, ready.authentication.token);
    f.setReceipt(HASH, []);
    f.state.receipts.get(HASH)!.status = '0x0';
    assert.equal((await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId })).body.status, 'failed');
    const attempt = f.commerce.database.prepare('SELECT * FROM ethereum_delivery_checkout_attempts WHERE attempt_id = ?')
      .get(ready.attemptId) as EthereumCheckoutAttemptRow;
    let canonicalReads = 0;
    const paused = pauseRpc(f, rpc => rpc.method === 'eth_getBlockByNumber' && rpc.params[0] === '0x64' && ++canonicalReads === 2);
    const pending = f.request<EthereumCheckoutStatusResponse>(`${checkoutPaths.status}?checkoutId=${checkoutId}`);
    await paused.paused;
    if (change === 'reactivated') {
      f.state.canonical.set(100, blockHash(999));
      f.state.receipts.delete(HASH);
      await reconcileEthereumCheckoutAttempt(readContext(f), attempt);
      assert.equal(f.commerce.database.prepare('SELECT status FROM ethereum_delivery_checkout_attempts WHERE attempt_id = ?')
        .get(ready.attemptId)!.status, 'submitted');
    } else if (change === 'confirmed') {
      const transactionHash = `0x${'cc'.repeat(32)}`;
      const log = f.deliveryLog(ready.prepared, ['111112'], ['2000001'], transactionHash);
      f.setReceipt(transactionHash, [log]);
      f.state.logs = [log];
      assert.equal((await f.request(paths.deliveryConfirm,
        { orderId: ready.prepared.orderId, transactionHash }, ready.authentication.token)).body.status, 'confirmed');
    } else {
      const attemptId = crypto.randomUUID();
      f.state.transactionCount = '0x1';
      const started = await f.request<EthereumCheckoutSubmissionResponse>(checkoutPaths.submission,
        { checkoutId, attemptId, action: 'start', quoteDeadline: ready.prepared.quote.deadline }, ready.authentication.token);
      assert.equal(started.body.canSend, true);
      if (change === 'rejected') {
        assert.equal((await f.request(checkoutPaths.submission, { checkoutId, attemptId, action: 'reject' }, ready.authentication.token)).response.status, 200);
      }
    }
    paused.resume();
    const result = await pending;
    assert.equal(result.response.status, 200);
    assert.equal(result.body.status, 'pending');
    assert.equal(new URL(result.body.returnUrl!).searchParams.get('result'), 'pending');
    const fresh = await f.request<EthereumCheckoutStatusResponse>(`${checkoutPaths.status}?checkoutId=${checkoutId}`);
    assert.equal(fresh.body.status, change === 'reactivated' ? 'pending' : change === 'started' ? 'submitting' : change === 'rejected' ? 'prepared' : 'success');
  } finally { f.close(); }
});

for (const reported of [false, true]) test(`pending checkout refresh verifies and projects its ${reported ? 'reported' : 'discovered'} delivery once`, async () => {
  const f = fixture();
  try {
    f.state.head = 98;
    const ready = await startedCheckout(f);
    const checkoutId = ready.checkout.checkoutId;
    if (reported) await f.request(checkoutPaths.submission,
      { checkoutId, attemptId: ready.attemptId, action: 'report', transactionHash: HASH }, ready.authentication.token);
    const log = f.deliveryLog(ready.prepared);
    f.setReceipt(HASH, [log]);
    f.state.logs = [log];
    f.state.head = 100;
    assert.equal((await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId })).body.status, 'pending');
    f.state.calls = [];
    f.databaseCalls.statements = 0;
    const previousUpdate = Number(f.quoteRow(ready.prepared.orderId).updated_at_ms);
    const result = await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.status, 'pending');
    assert.equal(result.body.confirmations, 1);
    assert.equal(f.state.calls.filter(call => call.method === 'eth_getTransactionReceipt').length, 1);
    assert.ok(f.state.calls.length <= 5);
    assert.ok(f.databaseCalls.statements <= 16);
    assert.equal(Number(f.quoteRow(ready.prepared.orderId).updated_at_ms), previousUpdate + 1);
    assert.equal(f.state.calls.some(call => call.method === 'eth_getLogs'), false);
  } finally { f.close(); }
});

test('checkout lost-hash recovery verifies immutable transaction intent and nonce and never enables another send', async () => {
  const f = fixture();
  try {
    f.state.transactionCount = '0x4';
    const ready = await startedCheckout(f);
    const input = { checkoutId: ready.checkout.checkoutId, attemptId: crypto.randomUUID(), action: 'recover', transactionHash: HASH };
    setCheckoutTransaction(f, ready.prepared, HASH, { nonce: '0x3' });
    assert.equal((await f.request(checkoutPaths.submission, input, ready.authentication.token)).response.status, 409);
    setCheckoutTransaction(f, ready.prepared, HASH, { nonce: '0x4', value: '0x0' });
    assert.equal((await f.request(checkoutPaths.submission, input, ready.authentication.token)).response.status, 409);
    setCheckoutTransaction(f, ready.prepared, HASH, { nonce: '0x4' });
    const recovered = await f.request<EthereumCheckoutSubmissionResponse>(checkoutPaths.submission, input, ready.authentication.token);
    assert.equal(recovered.response.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.canSend, false);
    assert.equal(recovered.body.checkout.transactionHash, HASH);
    assert.equal(f.commerce.database.prepare('SELECT status FROM ethereum_delivery_checkout_attempts WHERE attempt_id = ?').get(ready.attemptId)!.status, 'superseded');
    assert.equal((await f.request<EthereumCheckoutSubmissionResponse>(checkoutPaths.submission, input, ready.authentication.token)).body.canSend, false);
  } finally { f.close(); }
});

test('checkout replacement validates the original nonce, tracks cancellation, and reopens uncertainty after a reorg', async () => {
  const f = fixture();
  try {
    const ready = await startedCheckout(f);
    setCheckoutTransaction(f, ready.prepared);
    await f.request(checkoutPaths.submission, { checkoutId: ready.checkout.checkoutId, attemptId: ready.attemptId, action: 'report', transactionHash: HASH }, ready.authentication.token);
    const replacement = `0x${'cc'.repeat(32)}`;
    setCheckoutTransaction(f, ready.prepared, replacement, { to: WALLET, input: '0x', value: '0x0', nonce: '0x1' });
    const body = { checkoutId: ready.checkout.checkoutId, attemptId: crypto.randomUUID(), action: 'recover', transactionHash: replacement };
    assert.equal((await f.request(checkoutPaths.submission, body, ready.authentication.token)).response.status, 409);
    setCheckoutTransaction(f, ready.prepared, replacement, { to: WALLET, input: '0x', value: '0x0' });
    assert.equal((await f.request(checkoutPaths.submission, body, ready.authentication.token)).response.status, 200);
    f.setReceipt(replacement, []);
    let result = await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId: ready.checkout.checkoutId });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.status, 'failed');
    assert.equal(result.body.transactionHash, replacement);
    f.state.canonical.set(100, blockHash(999));
    result = await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId: ready.checkout.checkoutId });
    assert.equal(result.body.status, 'pending');
  } finally { f.close(); }
});

function setCheckoutTransaction(f: ReturnType<typeof fixture>, prepared: EthereumDeliveryPrepareResponse,
  hash = HASH, fields: Record<string, unknown> = {}) {
  f.state.transactions.set(hash, { hash, from: prepared.quote.wallet, to: prepared.transaction.to,
    input: prepared.transaction.data, value: prepared.transaction.value, nonce: '0x0', chainId: '0x7a69', ...fields });
}

test('foreground checkout reads and retry guards find an older orphan across failure-history pages', async () => {
  const f = fixture();
  try {
    const next = await preparedCheckout(f);
    const ready = await startedCheckout(f);
    const checkoutId = ready.checkout.checkoutId;
    setCheckoutTransaction(f, ready.prepared);
    await f.request(checkoutPaths.submission, { checkoutId, attemptId: ready.attemptId, action: 'report', transactionHash: HASH }, ready.authentication.token);
    f.setReceipt(HASH, []);
    f.state.receipts.get(HASH)!.status = '0x0';
    assert.equal((await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId })).body.status, 'failed');
    for (let index = 0; index < 10; index++) {
      const hash = blockHash(2000 + index);
      f.setReceipt(hash, []);
      f.state.receipts.get(hash)!.status = '0x0';
      f.commerce.database.prepare(`INSERT INTO ethereum_delivery_checkout_attempts
        (attempt_id, checkout_id, order_id, wallet, status, transaction_hash, quote_deadline, block_number, block_hash,
          verified_at_block, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, 'reverted', ?, ?, 100, ?, 102, ?, ?)`)
        .run(crypto.randomUUID(), checkoutId, ready.prepared.orderId, WALLET, hash, ready.prepared.quote.deadline, blockHash(100), NOW, NOW);
    }
    const rejectedAttemptId = crypto.randomUUID();
    const retry = await f.request<EthereumCheckoutSubmissionResponse>(checkoutPaths.submission,
      { checkoutId, attemptId: rejectedAttemptId, action: 'start', quoteDeadline: ready.prepared.quote.deadline }, ready.authentication.token);
    assert.equal(retry.body.canSend, true, JSON.stringify(retry.body));
    await f.request(checkoutPaths.submission, { checkoutId, attemptId: rejectedAttemptId, action: 'reject' }, ready.authentication.token);
    f.state.receipts.delete(HASH);
    const status = await f.request<EthereumCheckoutStatusResponse>(`${checkoutPaths.status}?checkoutId=${checkoutId}`);
    assert.equal(status.body.status, 'pending');
    assert.equal(status.body.transactionHash, HASH);
    assert.equal(status.body.attempt?.attemptId, ready.attemptId);
    assert.equal(f.commerce.database.prepare('SELECT status FROM ethereum_delivery_checkout_attempts WHERE attempt_id = ?')
      .get(ready.attemptId)!.status, 'reverted');
    for (const candidate of [ready, next]) {
      const started = await f.request(checkoutPaths.submission, { checkoutId: candidate.checkout.checkoutId,
        attemptId: crypto.randomUUID(), action: 'start', quoteDeadline: candidate.prepared.quote.deadline }, candidate.authentication.token);
      assert.equal(started.response.status, 409, JSON.stringify(started.body));
      assert.equal((started.body.error as { details: { blockingCheckoutId: string } }).details.blockingCheckoutId, checkoutId);
    }
    f.state.now = (ready.prepared.quote.deadline + 1) * 1000;
    for (const candidate of [ready, next]) {
      assert.equal((await f.request(checkoutPaths.prepare, { checkoutId: candidate.checkout.checkoutId }, candidate.authentication.token)).response.status, 409);
      assert.equal(f.quoteRow(candidate.prepared.orderId).deadline, candidate.prepared.quote.deadline);
    }
    for (const requestId of [checkoutId, crypto.randomUUID()]) {
      assert.equal((await f.request(paths.deliveryPrepare,
        { tokenIds: ['111112'], addressId: ADDRESS_ID, requestId }, ready.authentication.token)).response.status, 409);
    }
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_delivery_quotes').get()!.n, 2);
    const refreshed = await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId });
    assert.equal(refreshed.body.status, 'pending');
    assert.equal(refreshed.body.transactionHash, HASH);
    assert.equal(f.commerce.database.prepare('SELECT status FROM ethereum_delivery_checkout_attempts WHERE attempt_id = ?')
      .get(ready.attemptId)!.status, 'submitted');
    f.state.receipts.delete(blockHash(2000));
    f.state.head = 1000;
    f.state.finalizedBlock = { number: 990, timestamp: ready.prepared.quote.deadline + 1 };
    assert.equal((await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId })).body.status, 'failed');
    assert.equal(f.commerce.database.prepare('SELECT status FROM ethereum_delivery_checkout_attempts WHERE transaction_hash = ?')
      .get(blockHash(2000))!.status, 'reverted');
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.commerce.database.prepare('SELECT status FROM ethereum_delivery_checkout_attempts WHERE transaction_hash = ?')
      .get(blockHash(2000))!.status, 'reverted');
    f.commerce.database.prepare(`UPDATE ethereum_delivery_checkout_attempts SET status = 'submitted'
      WHERE transaction_hash = ?`).run(blockHash(2000));
    assert.notEqual((await startedCheckout(f)).checkout.checkoutId, checkoutId);
  } finally { f.close(); }
});

test('checkout expiry fences an older failure already being reconciled', async () => {
  const f = fixture();
  try {
    const ready = await startedCheckout(f);
    const checkoutId = ready.checkout.checkoutId;
    setCheckoutTransaction(f, ready.prepared);
    await f.request(checkoutPaths.submission, { checkoutId, attemptId: ready.attemptId, action: 'report', transactionHash: HASH }, ready.authentication.token);
    f.setReceipt(HASH, []);
    f.state.receipts.get(HASH)!.status = '0x0';
    await f.request(checkoutPaths.refresh, { checkoutId });
    const retry = await f.request<EthereumCheckoutSubmissionResponse>(checkoutPaths.submission,
      { checkoutId, attemptId: crypto.randomUUID(), action: 'start', quoteDeadline: ready.prepared.quote.deadline }, ready.authentication.token);
    assert.equal(retry.body.canSend, true);
    const earlier = f.commerce.database.prepare('SELECT * FROM ethereum_delivery_checkout_attempts WHERE attempt_id = ?')
      .get(ready.attemptId) as EthereumCheckoutAttemptRow;
    f.state.receipts.delete(HASH);
    f.state.now = (ready.prepared.quote.deadline + 1) * 1000;
    f.state.head = 1000;
    f.state.finalizedBlock = { number: 990, timestamp: ready.prepared.quote.deadline + 1 };
    const paused = pauseRpc(f, payload => payload.method === 'eth_getTransactionReceipt');
    const reconciliation = reconcileEthereumCheckoutAttempt(readContext(f), earlier);
    await paused.paused;
    assert.equal((await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId })).body.status, 'failed');
    paused.resume();
    await reconciliation;
    assert.equal(f.commerce.database.prepare('SELECT status FROM ethereum_delivery_checkout_attempts WHERE attempt_id = ?')
      .get(ready.attemptId)!.status, 'reverted');
    f.state.calls = [];
    await reconcileEthereumCheckoutAttempt(readContext(f), earlier);
    assert.equal(f.state.calls.length, 0);
    assert.notEqual((await startedCheckout(f)).checkout.checkoutId, checkoutId);
  } finally { f.close(); }
});

for (const reported of [false, true]) test(`an orphaned published checkout blocks overlapping retries with ${reported ? 'a reported' : 'an unreported'} hash`, async () => {
  const f = fixture();
  try {
    f.state.head = 98;
    const next = await preparedCheckout(f);
    const ready = await startedCheckout(f);
    const checkoutId = ready.checkout.checkoutId;
    if (reported) await f.request(checkoutPaths.submission,
      { checkoutId, attemptId: ready.attemptId, action: 'report', transactionHash: HASH }, ready.authentication.token);
    const log = f.deliveryLog(ready.prepared);
    f.setReceipt(HASH, [log]);
    f.state.logs = [log];
    f.state.head = 102;
    f.state.tokens.delete('111112');
    assert.equal((await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId })).body.status, 'success');
    f.state.receipts.delete(HASH);
    f.state.logs = [];
    f.state.tokens.set('111112', { kind: 2, displayId: 1, owner: WALLET });
    assert.equal((await f.request<EthereumCheckoutStatusResponse>(`${checkoutPaths.status}?checkoutId=${checkoutId}`)).body.status, 'pending');
    assert.equal(f.quoteRow(ready.prepared.orderId).status, 'confirmed');
    assert.notEqual(f.quoteRow(ready.prepared.orderId).published_at_ms, null);
    const started = await f.request(checkoutPaths.submission, { checkoutId: next.checkout.checkoutId,
      attemptId: crypto.randomUUID(), action: 'start', quoteDeadline: next.prepared.quote.deadline }, next.authentication.token);
    assert.equal(started.response.status, 409, JSON.stringify(started.body));
    assert.equal((started.body.error as { details: { blockingCheckoutId: string } }).details.blockingCheckoutId, checkoutId);
    assert.equal((await f.request(checkoutPaths.prepare, { checkoutId: next.checkout.checkoutId }, next.authentication.token)).response.status, 409);
    assert.equal((await f.request(paths.deliveryPrepare,
      { tokenIds: ['111112'], addressId: ADDRESS_ID, requestId: crypto.randomUUID() }, ready.authentication.token)).response.status, 409);
  } finally { f.close(); }
});

for (const action of ['start', 'legacy-prepare'] as const) test(`a concurrently reopened checkout failure blocks ${action}`, async () => {
  const f = fixture();
  try {
    const next = await preparedCheckout(f);
    const ready = await startedCheckout(f);
    const checkoutId = ready.checkout.checkoutId;
    setCheckoutTransaction(f, ready.prepared);
    await f.request(checkoutPaths.submission, { checkoutId, attemptId: ready.attemptId, action: 'report', transactionHash: HASH }, ready.authentication.token);
    f.setReceipt(HASH, []);
    f.state.receipts.get(HASH)!.status = '0x0';
    await f.request(checkoutPaths.refresh, { checkoutId });
    const paused = pauseRpc(f, payload => action === 'start' ? payload.method === 'eth_getTransactionCount' :
      payload.method === 'eth_getBlockByNumber' && payload.params[0] === 'latest');
    const pending = action === 'start' ? f.request(checkoutPaths.submission, { checkoutId: next.checkout.checkoutId,
      attemptId: crypto.randomUUID(), action: 'start', quoteDeadline: next.prepared.quote.deadline }, next.authentication.token) :
      f.request(paths.deliveryPrepare, { tokenIds: ['111112'], addressId: ADDRESS_ID, requestId: crypto.randomUUID() }, ready.authentication.token);
    await paused.paused;
    f.state.receipts.delete(HASH);
    await f.request(checkoutPaths.refresh, { checkoutId });
    paused.resume();
    const result = await pending;
    assert.equal(result.response.status, 409, JSON.stringify(result.body));
    assert.equal((result.body.error as { details: { blockingCheckoutId: string } }).details.blockingCheckoutId, checkoutId);
    assert.equal(result.body.signature, undefined);
    assert.equal(result.body.canSend, undefined);
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_delivery_quotes').get()!.n, 2);
  } finally { f.close(); }
});

test('checkout preparation keeps proof-only conflicts generic and retryable', async () => {
  const f = fixture();
  try {
    const ready = await startedCheckout(f);
    const checkoutId = ready.checkout.checkoutId;
    setCheckoutTransaction(f, ready.prepared);
    await f.request(checkoutPaths.submission, { checkoutId, attemptId: ready.attemptId, action: 'report', transactionHash: HASH }, ready.authentication.token);
    f.setReceipt(HASH, []);
    f.state.receipts.get(HASH)!.status = '0x0';
    await f.request(checkoutPaths.refresh, { checkoutId });
    const paused = pauseRpc(f, payload => payload.method === 'eth_getBlockByNumber' && payload.params[0] === 'latest');
    const input = { tokenIds: ['111112'], addressId: ADDRESS_ID, requestId: crypto.randomUUID() };
    const pending = f.request(paths.deliveryPrepare, input, ready.authentication.token);
    await paused.paused;
    const attempt = f.commerce.database.prepare('SELECT * FROM ethereum_delivery_checkout_attempts WHERE attempt_id = ?')
      .get(ready.attemptId) as EthereumCheckoutAttemptRow;
    await reconcileEthereumCheckoutAttempt(readContext(f), attempt);
    paused.resume();
    const result = await pending;
    assert.equal(result.response.status, 409);
    assert.equal((result.body.error as { details?: unknown }).details, undefined);
    assert.equal(result.body.signature, undefined);
    assert.equal((await f.request(paths.deliveryPrepare, input, ready.authentication.token)).response.status, 200);
  } finally { f.close(); }
});

for (const resolution of ['expiry', 'replacement'] as const) test(`a reactivated checkout attempt survives a newer rejection through ${resolution}`, async () => {
  const f = fixture();
  try {
    const ready = await startedCheckout(f);
    const checkoutId = ready.checkout.checkoutId;
    setCheckoutTransaction(f, ready.prepared);
    await f.request(checkoutPaths.submission, { checkoutId, attemptId: ready.attemptId, action: 'report', transactionHash: HASH }, ready.authentication.token);
    f.setReceipt(HASH, []);
    f.state.receipts.set(HASH, { ...f.state.receipts.get(HASH)!, status: '0x0' });
    assert.equal((await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId })).body.status, 'failed');
    f.state.transactionCount = '0x1';
    const rejectedAttemptId = crypto.randomUUID();
    const started = await f.request<EthereumCheckoutSubmissionResponse>(checkoutPaths.submission,
      { checkoutId, attemptId: rejectedAttemptId, action: 'start', quoteDeadline: ready.prepared.quote.deadline }, ready.authentication.token);
    assert.equal(started.body.canSend, true);
    assert.equal((await f.request(checkoutPaths.submission,
      { checkoutId, attemptId: rejectedAttemptId, action: 'reject' }, ready.authentication.token)).response.status, 200);
    f.state.receipts.delete(HASH);
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    const status = await f.request<EthereumCheckoutStatusResponse>(`${checkoutPaths.status}?checkoutId=${checkoutId}`);
    assert.equal(status.body.status, 'pending');
    assert.equal(status.body.attempt?.attemptId, ready.attemptId);
    assert.equal(status.body.transactionHash, HASH);
    assert.equal(new URL(status.body.returnUrl!).searchParams.get('result'), 'pending');
    assert.equal((await f.request(checkoutPaths.prepare, { checkoutId }, ready.authentication.token)).response.status, 409);
    if (resolution === 'expiry') {
      f.state.now = (ready.prepared.quote.deadline + 1) * 1000;
      f.state.head = 1000;
      f.state.finalizedBlock = { number: 990, timestamp: ready.prepared.quote.deadline + 1 };
      const expired = await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId });
      assert.equal(expired.response.status, 200, JSON.stringify(expired.body));
      assert.equal(expired.body.status, 'failed');
      assert.equal(expired.body.attempt?.attemptId, ready.attemptId);
      assert.equal(new URL(expired.body.returnUrl!).searchParams.get('result'), 'failed');
      assert.equal((await f.request(checkoutPaths.prepare, { checkoutId }, ready.authentication.token)).response.status, 409);
    } else {
      const replacement = `0x${'cc'.repeat(32)}`;
      setCheckoutTransaction(f, ready.prepared, replacement);
      const recovered = await f.request<EthereumCheckoutSubmissionResponse>(checkoutPaths.submission,
        { checkoutId, attemptId: crypto.randomUUID(), action: 'recover', transactionHash: replacement }, ready.authentication.token);
      assert.equal(recovered.response.status, 200, JSON.stringify(recovered.body));
      assert.equal(recovered.body.canSend, false);
      assert.equal(recovered.body.checkout.transactionHash, replacement);
      assert.equal(f.commerce.database.prepare('SELECT status FROM ethereum_delivery_checkout_attempts WHERE attempt_id = ?')
        .get(ready.attemptId)!.status, 'superseded');
      f.setReceipt(replacement, [f.deliveryLog(ready.prepared, ['111112'], ['2000001'], replacement)]);
      assert.equal((await f.request<EthereumCheckoutStatusResponse>(checkoutPaths.refresh, { checkoutId })).body.status, 'success');
    }
  } finally { f.close(); }
});

function pauseCommerceBatch(f: ReturnType<typeof fixture>, matches: () => boolean) {
  const database = f.env.COMMERCE_DB;
  let resume!: () => void;
  let reached!: () => void;
  let waiting = true;
  const paused = new Promise<void>((resolve) => { reached = resolve; });
  const released = new Promise<void>((resolve) => { resume = resolve; });
  const batch = async <T,>(statements: D1PreparedStatement[]) => {
    const result = await database.batch<T>(statements);
    if (waiting && matches()) {
      waiting = false;
      reached();
      await released;
    }
    return result;
  };
  f.env.COMMERCE_DB = new Proxy(database, { get(target, property, receiver) {
    return property === 'batch' ? batch : Reflect.get(target, property, receiver);
  } });
  return { paused, resume };
}

function pauseCommerceWrite(f: ReturnType<typeof fixture>, matches: () => boolean) {
  const database = f.env.COMMERCE_DB;
  let resume!: () => void;
  let reached!: () => void;
  let waiting = true;
  const paused = new Promise<void>((resolve) => { reached = resolve; });
  const released = new Promise<void>((resolve) => { resume = resolve; });
  const batch = async <T,>(statements: D1PreparedStatement[]) => {
    if (waiting && matches() && statements.some((statement) =>
      (statement as unknown as { sql: string }).sql.includes('INSERT INTO commerce_documents'))) {
      waiting = false;
      reached();
      await released;
    }
    return database.batch<T>(statements);
  };
  f.env.COMMERCE_DB = new Proxy(database, { get(target, property, receiver) {
    return property === 'batch' ? batch : Reflect.get(target, property, receiver);
  } });
  return { paused, resume };
}

function orphanCrateDelivery(f: ReturnType<typeof fixture>) {
  f.state.receipts.delete(HASH);
  f.state.receipts.delete(CLAIM_HASH);
  f.state.logs = [];
  f.state.tokens.delete('2000001');
  f.state.tokens.set('111112', { kind: 2, displayId: 1, owner: WALLET });
}

async function confirmedCrateClaim(f: ReturnType<typeof fixture>) {
  const delivery = await f.confirmed();
  const prepared = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare,
    { receiptId: '2000001', code: f.claimRow().code }, delivery.authentication.token);
  assert.equal(prepared.response.status, 200, JSON.stringify(prepared.body));
  const log = { ...f.claimLog(prepared.body), blockNumber: '0xc8', blockHash: blockHash(200) };
  f.setReceipt(CLAIM_HASH, [log], 200);
  f.state.logs.push(log);
  f.state.head = 202;
  const confirmed = await f.request(paths.claimConfirm,
    { claimId: prepared.body.claimId, transactionHash: CLAIM_HASH }, delivery.authentication.token);
  assert.equal(confirmed.body.status, 'confirmed', JSON.stringify(confirmed.body));
  return { ...delivery, claim: prepared.body, log };
}

async function replaceCrateDelivery(f: ReturnType<typeof fixture>) {
  const next = await f.prepared(['111112'], '10000000-0000-4000-8000-000000000002');
  const hash = `0x${'cc'.repeat(32)}`;
  const log = f.deliveryLog(next.prepared, ['111112'], ['2000001'], hash);
  f.setReceipt(hash, [log]);
  f.state.logs = [log];
  f.state.tokens.delete('111112');
  f.state.tokens.set('2000001', { kind: 5, displayId: 1, owner: WALLET });
  const confirmed = await f.request(paths.deliveryConfirm,
    { orderId: next.prepared.orderId, transactionHash: hash }, next.authentication.token);
  assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.status, 'confirmed');
  return next;
}

for (const cancellation of ['deadline', 'client'] as const) {
  test(`111k incomplete request bodies stop on ${cancellation} cancellation`, { timeout: 1000 }, async (t) => {
    const f = fixture();
    const deadline = new AbortController();
    const client = new AbortController();
    t.after(() => client.abort());
    t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
      assert.equal(milliseconds, 45_000);
      return deadline.signal;
    });
    const reason = new DOMException('Request cancelled', cancellation === 'deadline' ? 'TimeoutError' : 'AbortError');
    let cancelReason: unknown;
    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"dropId":')); },
      pull() { reading(); },
      cancel(reason) { cancelReason = reason; },
    }, { highWaterMark: 0 });
    const request = new Request(`${ORIGIN}${paths.authChallenge}`, {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Mons-CSRF': '1' },
      body, signal: client.signal, duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    try {
      const pending = handleEthereumRequest(request, f.env, paths.authChallenge);
      await started;
      (cancellation === 'deadline' ? deadline : client).abort(reason);
      if (cancellation === 'deadline') {
        const response = await pending;
        assert.equal(response.status, 503);
        assert.equal((await response.json() as { error: { code: string } }).error.code, 'unavailable');
        assert.equal(client.signal.aborted, false);
      } else {
        await assert.rejects(pending, (error: unknown) => error === reason);
      }
      assert.equal(cancelReason, reason);
      assert.equal(f.ops.prepare('SELECT COUNT(*) AS n FROM ethereum_auth_challenges').get()!.n, 0);
      assert.equal(f.databaseCalls.requests, 0);
    } finally { f.close(); }
  });
}

test('public stats include wallet discount usage with one coherent contract read and no session', async () => {
  const f = fixture();
  try {
    for (const owner of [null, WALLET, OTHER_WALLET]) {
      f.state.calls.length = 0;
      const result = await f.request<EthereumStats>(`${paths.stats}${owner ? `?owner=${owner.toUpperCase().replace('0X', '0x')}` : ''}`);
      assert.equal(result.response.status, 200);
      assert.deepEqual(result.body, {
        chainId: 31337, contractAddress: CONTRACT, owner,
        allocatedCrates: 25, warehousesMinted: 2, artworksMinted: 20,
        cratePriceWei: '100000000000000', warehousePriceWei: '1100000000000000', saleActive: true,
        remainingCrates: 5530, remainingWarehouses: 502,
        discountMerkleRoot: f.state.discountRoot, discountCratePriceWei: '50000000000000',
        discountAllowance: 3, discountUsed: owner === WALLET ? 1 : 0,
      });
      assert.deepEqual(f.state.calls.map(call => call.method), ['eth_chainId', 'eth_call']);
      assert.deepEqual(f.state.calls[1].params, [{
        to: CONTRACT, data: encodeCall('stats(address)', ['address'], [owner ?? ZERO]),
      }, 'latest']);
      assert.match(result.response.headers.get('cache-control') ?? '', /no-store/);
    }
    f.state.discountAllowance = 1;
    f.state.discountUsed.set(WALLET, 3);
    const reduced = await f.request<EthereumStats>(`${paths.stats}?owner=${WALLET}`);
    assert.equal(reduced.body.discountAllowance, 1);
    assert.equal(reduced.body.discountUsed, 3);
    assert.equal(f.databaseCalls.requests, 0);
  } finally { f.close(); }
});

test('stats reject invalid wallet identities before any RPC request', async () => {
  const f = fixture();
  try {
    for (const owner of ['', 'invalid', ZERO, `${WALLET}00`]) {
      const result = await f.request(`${paths.stats}?owner=${owner}`);
      assert.equal(result.response.status, 400);
    }
    assert.deepEqual(f.state.calls, []);
  } finally { f.close(); }
});

test('111k EOA auth is one-use, chain/origin scoped, expires, and keeps shipping addresses isolated', async () => {
  const f = fixture();
  try {
    const proof = await f.challenge();
    assert.equal(proof.message.split('\n')[1], '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A');
    assert.equal(proof.message.split('\n')[3], 'Sign in to the 111K test collection for delivery and receipt claims.');
    const input = { challengeId: proof.challengeId, signature: signDigest(WALLET_KEY, personalMessageHash(proof.message)) };
    const raced = await Promise.all([f.request<EthereumSession>(paths.authVerify, input), f.request<EthereumSession>(paths.authVerify, input)]);
    assert.deepEqual(raced.map(result => result.response.status).sort(), [200, 409]);
    const session = raced.find(result => result.response.status === 200)!.body;
    assert.equal(f.ops.prepare('SELECT COUNT(*) AS n FROM ethereum_auth_sessions').get()!.n, 1);
    assert.equal((await f.request(paths.profile, undefined, session.token)).body.wallet, WALLET);
    assert.equal((await f.request(paths.profile, undefined, session.token, { origin: 'https://www.mons.shop' })).response.status, 401);
    f.env.ETHEREUM_111K_CHAIN_ID = '11155111';
    assert.equal((await f.request(paths.profile, undefined, session.token)).response.status, 401);
    f.env.ETHEREUM_111K_CHAIN_ID = '31337';
    await f.saveAddress(session.token);
    const other = await f.session(OTHER_KEY);
    assert.deepEqual((await f.request(paths.addresses, undefined, other.token)).body.addresses, []);
    const altered = await f.request(paths.addresses, { id: ADDRESS_ID, encrypted: 'changed', country: 'US', hint: 'Changed' }, session.token);
    assert.equal(altered.response.status, 409);
    const saved = (await f.request(paths.addresses, undefined, session.token)).body.addresses as Record<string, unknown>[];
    assert.equal(saved[0].encrypted, 'encrypted-test-address');
    f.state.now = session.expiresAtMs;
    assert.equal((await f.request(paths.profile, undefined, session.token)).response.status, 401);
  } finally { f.close(); }
});

test('Ethereum auth cleanup runs independently of disabled collection reconciliation', async () => {
  const f = fixture();
  try {
    f.env.ETHEREUM_111K_CONTRACT_ADDRESS = '';
    const session = await f.session();
    f.state.now = session.expiresAtMs;
    f.state.calls.length = 0;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.deepEqual(await cleanupEthereumAuth(f.env.OPS_DB, f.state.now), {
      sessionsDeleted: 1, challengesDeleted: 1, limitReached: false, hasMore: false,
    });
    assert.equal(f.ops.prepare('SELECT COUNT(*) AS n FROM ethereum_auth_challenges').get()!.n, 0);
    assert.equal(f.ops.prepare('SELECT COUNT(*) AS n FROM ethereum_auth_sessions').get()!.n, 0);
    assert.deepEqual(f.state.calls, []);
  } finally { f.close(); }
});

test('fresh Ethereum control fails closed while account and read-only routes remain available', async () => {
  const f = fixture(false);
  try {
    assert.equal((await f.request(paths.config)).body.enabled, false);
    f.state.calls.length = 0;
    for (const path of [paths.deliveryPrepare, paths.deliveryConfirm, paths.claimPrepare, paths.claimConfirm]) {
      const result = await f.request(path);
      assert.equal(result.response.status, 503, path);
      assert.equal((result.body.error as { code: string }).code, 'unavailable');
    }
    assert.deepEqual(f.state.calls, []);
    const session = await f.session();
    await f.saveAddress(session.token);
    assert.equal((await f.request(paths.profile, undefined, session.token)).response.status, 200);
    assert.equal(((await f.request(paths.addresses, undefined, session.token)).body.addresses as unknown[]).length, 1);
    assert.equal((await f.request(`${paths.inventory}?owner=${WALLET}`)).response.status, 200);
    assert.equal((await f.request(paths.stats)).response.status, 200);
    assert.equal((await f.request(paths.transactionsConfirm, { transactionHash: HASH })).response.status, 200);
    f.state.calls.length = 0;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.deepEqual(f.state.calls, []);
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_reconciliation_cursor').get()!.n, 0);
  } finally { f.close(); }
});

for (const failure of ['missing', 'malformed', 'read-error'] as const) {
  test(`Ethereum control ${failure} disables config, mutations and reconciliation`, async () => {
    const f = fixture();
    try {
      f.env.COMMERCE_DB = new Proxy(f.commerce.db, {
        get(target, property) {
          if (property !== 'prepare') return Reflect.get(target, property, target);
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes('FROM ethereum_111k_control')) return statement;
            return new Proxy(statement, {
              get(target, property) {
                if (property !== 'first') return Reflect.get(target, property, target);
                return async () => {
                  if (failure === 'read-error') throw new Error('Injected control read failure');
                  return failure === 'missing' ? null : { paused: 0 };
                };
              },
            });
          };
        },
      });
      assert.equal((await f.request(paths.config)).body.enabled, false);
      assert.equal((await f.request(paths.deliveryPrepare)).response.status, 503);
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.deepEqual(f.state.calls, []);
    } finally { f.close(); }
  });
}

for (const reason of ['paused', 'scope-mismatch'] as const) {
  test(`${reason} Ethereum control disables configuration, mutations and reconciliation without removing account or order data`, async () => {
    const f = fixture();
    try {
      const { prepared, authentication } = await f.confirmed();
      const order = f.order(prepared.orderId);
      const quote = f.quoteRow(prepared.orderId);
      const claims = f.commerce.database.prepare('SELECT * FROM ethereum_crate_claims').all();
      f.commerce.database.prepare(`UPDATE ethereum_111k_control SET revision = revision + 1,
        paused = ?, paused_at_ms = ?, contract_address = ? WHERE singleton = 1`)
        .run(reason === 'paused' ? 1 : 0, reason === 'paused' ? NOW : null, reason === 'paused' ? CONTRACT : OTHER_CONTRACT);
      assert.equal((await f.request(paths.config)).body.enabled, false);
      f.state.calls.length = 0;
      for (const path of [paths.deliveryPrepare, paths.deliveryConfirm, paths.claimPrepare, paths.claimConfirm]) {
        assert.equal((await f.request(path, {}, authentication.token)).response.status, 503, path);
      }
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.deepEqual(f.state.calls, []);
      assert.deepEqual(f.order(prepared.orderId), order);
      assert.deepEqual(f.quoteRow(prepared.orderId), quote);
      assert.deepEqual(f.commerce.database.prepare('SELECT * FROM ethereum_crate_claims').all(), claims);
      assert.equal((await f.request(paths.shipments, undefined, authentication.token)).response.status, 200);
      assert.equal(((await f.request(paths.addresses, undefined, authentication.token)).body.addresses as unknown[]).length, 1);
      await f.saveAddress(authentication.token, 'UVWXYZABCDEFGHIJKLMN');
      const repository = new D1CommerceRepository(f.env.COMMERCE_DB);
      const otherDrop = commerceKeys.deliveryOrder('card_nft_2', '7');
      await repository.run(NOW, unit => unit.create(otherDrop, { owner: 'other-wallet', status: 'processing' }));
      assert.equal((await repository.get(otherDrop))?.data.status, 'processing');
    } finally { f.close(); }
  });
}

test('an existing delivery quote is not signed when the pause arrives during its validation', async () => {
  const f = fixture();
  try {
    const { prepared, authentication } = await f.prepared();
    const original = f.quoteRow(prepared.orderId);
    f.state.afterRpc = async (call) => {
      if (call.method !== 'eth_getBlockByNumber') return;
      f.state.afterRpc = null;
      f.commerce.database.prepare(`UPDATE ethereum_111k_control SET paused = 1,
        paused_at_ms = ?, revision = revision + 1 WHERE singleton = 1`).run(NOW);
    };
    const result = await f.request(paths.deliveryPrepare,
      { tokenIds: ['111112'], addressId: ADDRESS_ID, requestId: REQUEST_ID }, authentication.token);
    assert.equal(result.response.status, 503);
    assert.equal(result.body.signature, undefined);
    assert.deepEqual(f.quoteRow(prepared.orderId), original);
  } finally { f.close(); }
});

test('a pause after the mutation gate maps the native quote fence to unavailable', async () => {
  const f = fixture();
  try {
    const authentication = await f.session();
    await f.saveAddress(authentication.token);
    f.state.afterRpc = async (call) => {
      if (call.method !== 'eth_call') return;
      f.state.afterRpc = null;
      f.commerce.database.prepare(`UPDATE ethereum_111k_control SET paused = 1,
        paused_at_ms = ?, revision = revision + 1 WHERE singleton = 1`).run(NOW);
    };
    const result = await f.request(paths.deliveryPrepare,
      { tokenIds: ['111112'], addressId: ADDRESS_ID, requestId: REQUEST_ID }, authentication.token);
    assert.equal(result.response.status, 503);
    assert.equal((result.body.error as { code: string }).code, 'unavailable');
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_delivery_quotes').get()!.n, 0);
  } finally { f.close(); }
});

for (const signature of ['0x', '0x1234']) {
  test(`111k auth accepts ERC-1271 signature ${signature} only for a deployed wallet returning its magic value`, async () => {
    const f = fixture();
    try {
      const smartWallet = '0x4444444444444444444444444444444444444444';
      const proof = await f.challenge(smartWallet);
      const body = { challengeId: proof.challengeId, signature };
      assert.equal((await f.request(paths.authVerify, body)).response.status, 401);
      f.state.contractCode.add(smartWallet);
      f.state.magic = '0xffffffff';
      assert.equal((await f.request(paths.authVerify, body)).response.status, 401);
      assert.equal(f.ops.prepare('SELECT COUNT(*) AS n FROM ethereum_auth_sessions').get()!.n, 0);
      assert.equal(f.ops.prepare('SELECT consumed_at_ms FROM ethereum_auth_challenges WHERE challenge_id = ?').get(proof.challengeId)!.consumed_at_ms, null);
      f.state.magic = '0x1626ba7e';
      const accepted = await f.request<EthereumSession>(paths.authVerify, body);
      assert.equal(accepted.response.status, 200);
      assert.equal(accepted.body.address, smartWallet);
      const checked = f.state.calls.filter(call => call.method === 'eth_call').at(-1)!;
      const call = checked.params[0] as { to: string; data: string };
      assert.equal(call.to, smartWallet);
      assert.deepEqual(decodeReturn(['bytes32', 'bytes'], `0x${call.data.slice(10)}`), [personalMessageHash(proof.message), signature]);
    } finally { f.close(); }
  });
}

test('111k auth and mutations reject missing CSRF, wrong origin, wrong chain, and rate exhaustion', async () => {
  const f = fixture();
  try {
    const body = { dropId: '111k_devnet', address: WALLET, chainId: 31337 };
    assert.equal((await f.request(paths.authChallenge, body, undefined, { csrf: false })).response.status, 403);
    assert.equal((await f.request(paths.authChallenge, body, undefined, { origin: 'https://evil.example' })).response.status, 403);
    assert.equal((await f.request(paths.authChallenge, { ...body, chainId: 1 })).response.status, 400);
    assert.equal((await f.request(paths.authChallenge, undefined, undefined, { method: 'GET' })).response.status, 405);
    f.env.STAFF_AUTH_CHALLENGE_RATE_LIMITER = { limit: async () => ({ success: false }) };
    const denied = await f.request(paths.authChallenge, body);
    assert.equal(denied.response.status, 429);
    assert.equal(denied.response.headers.get('Retry-After'), '60');
    assert.equal(f.ops.prepare('SELECT COUNT(*) AS n FROM ethereum_auth_challenges').get()!.n, 0);
  } finally { f.close(); }
});

test('delivery preparation persists one immutable selection before returning a verifiable quote, including retries', async () => {
  const f = fixture();
  try {
    const session = await f.session();
    await f.saveAddress(session.token);
    const input = { tokenIds: ['111112', '7'], addressId: ADDRESS_ID, requestId: REQUEST_ID };
    const results = await Promise.all([f.request<EthereumDeliveryPrepareResponse>(paths.deliveryPrepare, input, session.token),
      f.request<EthereumDeliveryPrepareResponse>(paths.deliveryPrepare, input, session.token)]);
    assert.ok(results.every(result => result.response.status === 200), JSON.stringify(results.map(result => result.body)));
    assert.equal(results[0].body.orderId, results[1].body.orderId);
    assert.equal(results[0].body.signature, results[1].body.signature);
    const prepared = results[0].body;
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_delivery_quotes').get()!.n, 1);
    const stored = f.quoteRow(prepared.orderId);
    assert.equal(stored.token_ids_json, JSON.stringify(input.tokenIds));
    assert.equal(JSON.parse(String(stored.address_json)).encrypted, 'encrypted-test-address');
    assert.equal(prepared.quote.receiptIdsHash, ethereumReceiptIdsHash(['2000001', '1000007']));
    assert.deepEqual(decodeReturn(['uint256[]', '(uint256,address,uint256,uint256,bytes32)', 'bytes'], `0x${prepared.transaction.data.slice(10)}`),
      [[111112n, 7n], [BigInt(prepared.orderId), WALLET, BigInt(prepared.quote.fee), BigInt(prepared.quote.deadline), prepared.quote.receiptIdsHash], prepared.signature]);
    assert.equal(recoverEthereumAddress(deliveryDigest({ ...prepared.quote, chainId: 31337, contractAddress: CONTRACT, tokenIds: input.tokenIds }), prepared.signature), SIGNER);
    assert.equal((await f.request(paths.deliveryPrepare, { ...input, tokenIds: ['111112'] }, session.token)).response.status, 409);
    f.state.now = prepared.expiresAtMs + 1000;
    const refreshed = await f.request<EthereumDeliveryPrepareResponse>(paths.deliveryPrepare, input, session.token);
    assert.equal(refreshed.response.status, 200);
    assert.equal(refreshed.body.orderId, prepared.orderId);
    assert.ok(refreshed.body.quote.deadline > prepared.quote.deadline);
    assert.notEqual(refreshed.body.signature, prepared.signature);
  } finally { f.close(); }
});

test('delivery retries reject changed artwork identities and require a fresh request bound to canonical receipts', async () => {
  const f = fixture();
  try {
    const { authentication, prepared } = await f.prepared(['7']);
    const originalItems = f.quoteRow(prepared.orderId).items_json;
    f.state.tokens.get('7')!.displayId = 822;
    const input = { tokenIds: ['7'], addressId: ADDRESS_ID, requestId: REQUEST_ID };
    const rejected = await f.request(paths.deliveryPrepare, input, authentication.token);
    assert.equal(rejected.response.status, 409);
    assert.equal(rejected.body.signature, undefined);
    assert.equal(f.quoteRow(prepared.orderId).items_json, originalItems);
    const refreshed = await f.request<EthereumDeliveryPrepareResponse>(paths.deliveryPrepare,
      { ...input, requestId: '10000000-0000-4000-8000-000000000002' }, authentication.token);
    assert.equal(refreshed.response.status, 200, JSON.stringify(refreshed.body));
    assert.notEqual(refreshed.body.orderId, prepared.orderId);
    assert.equal(refreshed.body.quote.receiptIdsHash, ethereumReceiptIdsHash(['1000822']));
    assert.notEqual(refreshed.body.quote.receiptIdsHash, prepared.quote.receiptIdsHash);
  } finally { f.close(); }
});

test('delivery preparation rejects unsafe selections and refuses to return a signature after persistence failure', async () => {
  const f = fixture();
  try {
    const session = await f.session();
    await f.saveAddress(session.token);
    f.state.tokens.set('116667', { kind: 3, displayId: 1, owner: WALLET });
    f.state.tokens.set('1000001', { kind: 4, displayId: 1, owner: WALLET });
    f.state.tokens.set('111114', { kind: 2, displayId: 3, owner: OTHER_WALLET });
    for (const tokenIds of [[], ['111112', '111112'], ['116667'], ['1000001'], ['111114'], ['9999999']]) {
      const result = await f.request(paths.deliveryPrepare, { tokenIds, addressId: ADDRESS_ID, requestId: crypto.randomUUID() }, session.token);
      assert.ok([400, 403].includes(result.response.status), JSON.stringify(result.body));
    }
    f.failures.quoteWrite = true;
    const failed = await f.request(paths.deliveryPrepare, { tokenIds: ['111112'], addressId: ADDRESS_ID, requestId: REQUEST_ID }, session.token);
    assert.equal(failed.response.status, 503);
    assert.equal(failed.body.signature, undefined);
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_delivery_quotes').get()!.n, 0);
    f.failures.quoteWrite = false;
    f.state.expectedSigner = OTHER_WALLET;
    assert.equal((await f.request(paths.deliveryPrepare, { tokenIds: ['111112'], addressId: ADDRESS_ID, requestId: REQUEST_ID }, session.token)).response.status, 503);
  } finally { f.close(); }
});

test('delivery and crate claim authorization deadlines stay within the contract window when the latest block lags by 12 seconds', async () => {
  const f = fixture();
  try {
    const now = Math.floor(f.state.now / 1000);
    const chainTime = now - 12;
    f.state.blockTimestamp = chainTime;
    const { authentication, prepared } = await f.confirmed();
    assert.equal(prepared.quote.deadline, chainTime + 600);
    assert.equal(prepared.expiresAtMs, (chainTime + 600) * 1000);
    assert.ok(prepared.quote.deadline > now);
    assert.ok(prepared.quote.deadline <= chainTime + 600);
    const claim = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare,
      { receiptId: '2000001', code: String(f.claimRow().code) }, authentication.token);
    assert.equal(claim.response.status, 200, JSON.stringify(claim.body));
    assert.equal(claim.body.deadline, chainTime + 600);
    assert.equal(claim.body.expiresAtMs, (chainTime + 600) * 1000);
    assert.ok(claim.body.deadline > now);
    assert.ok(claim.body.deadline <= chainTime + 600);
  } finally { f.close(); }
});

test('stale chain timestamps fail closed before delivery or crate claim signatures are returned', async () => {
  const f = fixture();
  try {
    const { authentication } = await f.confirmed();
    const code = String(f.claimRow().code);
    f.state.blockTimestamp = Math.floor(f.state.now / 1000) - 601;
    const delivery = await f.request(paths.deliveryPrepare, { tokenIds: ['111113'], addressId: ADDRESS_ID,
      requestId: '10000000-0000-4000-8000-000000000002' }, authentication.token);
    assert.equal(delivery.response.status, 503, JSON.stringify(delivery.body));
    assert.equal(delivery.body.signature, undefined);
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_delivery_quotes').get()!.n, 1);
    const claim = await f.request(paths.claimPrepare, { receiptId: '2000001', code }, authentication.token);
    assert.equal(claim.response.status, 503, JSON.stringify(claim.body));
    assert.equal(claim.body.signature, undefined);
    assert.equal(f.claimRow().status, 'available');
    assert.equal(f.claimRow().code, code);
  } finally { f.close(); }
});

test('delivery confirmation requires the exact contract event and three canonical confirmations before publishing', async () => {
  const f = fixture();
  try {
    const { authentication, prepared } = await f.prepared();
    const confirm = () => f.request(paths.deliveryConfirm, { orderId: prepared.orderId, transactionHash: HASH }, authentication.token);
    const log = f.deliveryLog(prepared);
    f.setReceipt(HASH, [{ ...log, address: OTHER_CONTRACT }]);
    assert.equal((await confirm()).response.status, 403);
    assert.equal(f.quoteRow(prepared.orderId).transaction_hash, null);
    f.setReceipt(HASH, [f.deliveryLog(prepared, ['111113'])]);
    assert.equal((await confirm()).response.status, 403);
    f.setReceipt(HASH, [log]);
    f.state.canonical.set(100, blockHash(999));
    assert.deepEqual((await confirm()).body, { status: 'pending', confirmations: 0, orderId: prepared.orderId });
    f.state.canonical.delete(100);
    f.state.head = 100;
    assert.equal((await confirm()).body.status, 'pending');
    assert.equal(f.order(prepared.orderId), null);
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_crate_claims').get()!.n, 0);
    f.state.head = 102;
    assert.equal((await confirm()).body.status, 'confirmed');
    const order = f.order(prepared.orderId)!;
    assert.equal(order.status, 'ready_to_ship');
    assert.equal(order.testnet, true);
    assert.equal(order.source, 'ethereum');
    assert.equal(order.owner, WALLET);
    const code = String(f.claimRow().code);
    assert.match(code, /^[A-F0-9]{12}$/);
    assert.equal((await confirm()).body.status, 'confirmed');
    assert.equal(f.claimRow().code, code);
    assert.equal(f.commerce.database.prepare("SELECT COUNT(*) AS n FROM commerce_documents WHERE document_kind = 'delivery_order'").get()!.n, 1);
  } finally { f.close(); }
});

test('an orphaned failed receipt stays pending until its transaction is observed in the canonical chain', async () => {
  const f = fixture();
  try {
    f.setReceipt(HASH, []);
    f.state.receipts.get(HASH)!.status = '0x0';
    f.state.canonical.set(100, blockHash(999));
    const orphaned = await f.request(paths.transactionsConfirm, { transactionHash: HASH });
    assert.equal(orphaned.response.status, 200, JSON.stringify(orphaned.body));
    assert.equal(orphaned.body.status, 'pending');
    assert.equal(orphaned.body.confirmations, 0);
    f.state.canonical.delete(100);
    const reverted = await f.request(paths.transactionsConfirm, { transactionHash: HASH });
    assert.equal(reverted.response.status, 409);
    assert.equal((reverted.body.error as { details?: { kind?: string } }).details?.kind, 'transaction-reverted');
  } finally { f.close(); }
});

test('transaction confirmation returns canonical collection events independently of minted holdings', async () => {
  const f = fixture();
  try {
    const log: EthereumLog = { address: CONTRACT, topics: [ETHEREUM_EVENT_TOPICS.Transfer,
      topicAddress(WALLET), topicAddress(OTHER_WALLET), topicNumber('2000001')], data: '0x',
      blockNumber: '0x64', blockHash: blockHash(100), transactionHash: HASH, logIndex: '0x0' };
    f.setReceipt(HASH, [log, { ...log, address: OTHER_CONTRACT }]);
    const result = await f.request(paths.transactionsConfirm, { transactionHash: HASH });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.logs, [log]);
    assert.deepEqual(result.body.items, []);
    f.state.canonical.set(100, blockHash(999));
    assert.equal((await f.request(paths.transactionsConfirm, { transactionHash: HASH })).body.status, 'pending');
  } finally { f.close(); }
});

test('confirmed deliveries recover a failed publication through durable reconciliation without regenerating codes', async () => {
  const f = fixture();
  try {
    const { authentication, prepared } = await f.prepared();
    const log = f.deliveryLog(prepared);
    f.setReceipt(HASH, [log]);
    f.state.logs = [log];
    f.failures.publishWrite = true;
    const failed = await f.request(paths.deliveryConfirm, { orderId: prepared.orderId, transactionHash: HASH }, authentication.token);
    assert.equal(failed.response.status, 503);
    assert.equal(f.quoteRow(prepared.orderId).status, 'confirmed');
    assert.equal(f.quoteRow(prepared.orderId).published_at_ms, null);
    const code = f.claimRow().code;
    f.failures.publishWrite = false;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.order(prepared.orderId)!.status, 'ready_to_ship');
    assert.equal(f.claimRow().code, code);
    assert.equal(f.quoteRow(prepared.orderId).published_at_ms, NOW);
  } finally { f.close(); }
});

test('large crate orders reconcile within each invocation budget and reuse existing claim identities', async () => {
  const f = fixture();
  try {
    f.state.head = 80;
    const orders: { orderId: number; hash: string; tokenIds: string[] }[] = [];
    for (let index = 0; index < 10; index++) {
      const ids = Array.from({ length: 50 }, (_, offset) => 1 + index * 50 + offset);
      const tokenIds = ids.map((id) => String(111111 + id));
      ids.forEach((id, offset) => f.state.tokens.set(tokenIds[offset], { kind: 2, displayId: id, owner: WALLET }));
      const { prepared } = await f.prepared(tokenIds, crypto.randomUUID());
      const hash = blockHash(50_000 + index);
      const block = 100 + index;
      const log = { ...f.deliveryLog(prepared, tokenIds, ids.map((id) => String(2_000_000 + id)), hash),
        blockNumber: ethereumHexQuantity(block), blockHash: blockHash(block) };
      f.setReceipt(hash, [log], block);
      f.state.logs.push(log);
      orders.push({ orderId: prepared.orderId, hash, tokenIds });
    }
    f.state.head = 112;
    f.databaseCalls.limit = 1000;
    let published = 0;
    let limited = false;
    for (let attempt = 0; attempt < 10 && published < orders.length; attempt++) {
      f.databaseCalls.requests = 0;
      f.databaseCalls.statements = 0;
      const result = await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.ok(f.databaseCalls.statements <= 400, `Reconciliation used ${f.databaseCalls.statements} queries`);
      limited ||= result.hasMore === true;
      const next = orders.filter((order) => f.order(order.orderId)?.status === 'ready_to_ship').length;
      assert.ok(next > published, 'Each invocation must publish another order');
      published = next;
      f.state.now++;
    }
    assert.equal(published, orders.length);
    assert.equal(limited, true);
    const originalClaims = f.commerce.database.prepare('SELECT receipt_id, code, claim_id FROM ethereum_crate_claims ORDER BY receipt_id').all();
    assert.equal(originalClaims.length, 500);
    const session = await f.session();
    f.databaseCalls.limit = Infinity;
    Object.assign(f.databaseCalls, { requests: 0, statements: 0, claimReads: 0, claimInserts: 0 });
    const confirmed = await f.request(paths.deliveryConfirm, { orderId: orders[0].orderId, transactionHash: orders[0].hash }, session.token);
    assert.equal(confirmed.body.status, 'confirmed');
    assert.equal(f.databaseCalls.claimInserts, 0);
    assert.ok(f.databaseCalls.claimReads <= 2, 'Existing crate claims must be read together');
    assert.ok(f.databaseCalls.requests < 20);
    assert.deepEqual(f.commerce.database.prepare('SELECT receipt_id, code, claim_id FROM ethereum_crate_claims ORDER BY receipt_id').all(), originalClaims);
  } finally { f.close(); }
});

test('repeated confirmation preserves fulfillment progress and reconciles orphaned deliveries back to processing', async () => {
  const f = fixture();
  try {
    const { authentication, prepared } = await f.confirmed();
    const repository = new D1CommerceRepository(f.env.COMMERCE_DB);
    await repository.run(NOW, async transaction => { await transaction.update(commerceKeys.deliveryOrder('111k_devnet', String(prepared.orderId)), { status: 'shipped' }); });
    const result = await f.request(paths.deliveryConfirm, { orderId: prepared.orderId, transactionHash: HASH }, authentication.token);
    assert.equal(result.response.status, 200);
    assert.equal(f.order(prepared.orderId)!.status, 'shipped');
    f.state.receipts.delete(HASH);
    f.state.logs = [];
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.quoteRow(prepared.orderId).status, 'prepared');
    assert.equal(f.order(prepared.orderId)!.status, 'processing');
  } finally { f.close(); }
});

for (const kind of ['delivery', 'claim'] as const) {
  test(`untouched orphaned ${kind} backlogs remain eligible after the recent-block window`, async () => {
    const f = fixture();
    try {
      const { prepared } = await f.prepared(['7']);
      const source = f.quoteRow(prepared.orderId);
      const insertDelivery = f.commerce.database.prepare(`INSERT INTO ethereum_delivery_quotes
        (chain_id, contract_address, order_id, request_id, wallet, address_id, address_json, token_ids_json,
          items_json, fee_wei, deadline, status, transaction_hash, block_number, block_hash, published_at_ms,
          verified_at_block, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?)`);
      const insertClaim = f.commerce.database.prepare(`INSERT INTO ethereum_crate_claims
        (chain_id, contract_address, receipt_id, crate_id, order_id, code_hash, code, claim_id, status,
          transaction_hash, block_number, block_hash, verified_at_block, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, 100, ?, 102, ?)`);
      const repository = new D1CommerceRepository(f.env.COMMERCE_DB);
      for (let index = 0; index < 61; index++) {
        const orderId = 10_000 + index;
        const hash = `0x${(index + 1).toString(16).padStart(64, '0')}`;
        const code = `CODE${index}`;
        insertDelivery.run(31337, CONTRACT, orderId, crypto.randomUUID(), WALLET, ADDRESS_ID, source.address_json,
          source.token_ids_json, source.items_json, source.fee_wei, source.deadline, hash,
          kind === 'delivery' ? 100 : 10, blockHash(kind === 'delivery' ? 100 : 10), NOW,
          kind === 'delivery' ? 102 : 100, NOW, NOW);
        if (kind === 'claim') {
          insertClaim.run(31337, CONTRACT, String(2_000_001 + index), index + 1,
            orderId, hash, code, hash, hash, blockHash(100), NOW);
          f.state.tokens.set(String(2_000_001 + index), { kind: 5, displayId: index + 1, owner: WALLET });
        }
        await repository.run(NOW, async (unit) => {
          await unit.create(commerceKeys.deliveryOrder('111k_devnet', String(orderId)), {
            source: 'ethereum', owner: WALLET, chainId: 31337, contractAddress: CONTRACT, status: 'ready_to_ship',
            irlClaims: kind === 'claim' ? [{ code, boxId: index + 1, status: 'claimed' }] : [],
          });
        });
      }
      const table = kind === 'delivery' ? 'ethereum_delivery_quotes' : 'ethereum_crate_claims';
      const status = kind === 'delivery' ? 'confirmed' : 'claimed';
      let remaining = 61;
      for (let attempt = 0; attempt < 10 && remaining; attempt++) {
        f.state.head = 127 + attempt * 25;
        f.state.now += 300_000;
        f.databaseCalls.statements = 0;
        await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
        const next = Number(f.commerce.database.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status = ?`).get(status)!.n);
        assert.ok(next < remaining, 'Unfinished recovery must keep advancing after the reorg window');
        assert.ok(f.databaseCalls.statements <= 400);
        remaining = next;
      }
      assert.equal(remaining, 0);
      for (let index = 0; index < 61; index++) {
        const order = f.order(10_000 + index)!;
        if (kind === 'delivery') assert.equal(order.status, 'processing');
        else assert.equal((order.irlClaims as Record<string, unknown>[])[0].status, 'available');
      }
    } finally { f.close(); }
  });
}

test('a re-mined delivery loses fulfillment readiness until it regains three confirmations', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const claim = f.claimRow();
    const moved = { ...f.deliveryLog(first.prepared), blockNumber: '0x67', blockHash: blockHash(103) };
    f.setReceipt(HASH, [moved], 103);
    f.state.logs = [moved];
    f.state.head = 103;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.quoteRow(first.prepared.orderId).status, 'pending');
    assert.equal(f.quoteRow(first.prepared.orderId).published_at_ms, null);
    assert.equal(f.order(first.prepared.orderId)!.status, 'processing');
    assert.deepEqual(f.order(first.prepared.orderId)!.irlClaims, []);
    assert.deepEqual(f.claimRow(), claim);
    f.state.head = 105;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.order(first.prepared.orderId)!.status, 'ready_to_ship');
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].code, claim.code);
  } finally { f.close(); }
});

test('a re-mined claim projects pending until three confirmations and recovers a failed projection', async () => {
  const f = fixture();
  try {
    const first = await confirmedCrateClaim(f);
    const originalClaim = f.claimRow();
    const moved = { ...first.log, blockNumber: '0xcb', blockHash: blockHash(203) };
    f.state.canonical.set(200, blockHash(10_200));
    f.setReceipt(CLAIM_HASH, [moved], 203);
    f.state.logs = f.state.logs.filter((log) => log.transactionHash !== CLAIM_HASH).concat(moved);
    f.state.head = 203;
    f.failures.publishWrite = true;
    await assert.rejects(reconcileEthereum111k(f.env, AbortSignal.timeout(10_000),
      { fetch: f.providerFetch, nowMs: () => f.state.now }), /Injected/);
    assert.equal(f.claimRow().status, 'pending');
    assert.equal(f.claimRow().verified_at_block, null);
    f.failures.publishWrite = false;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'pending');
    assert.equal(f.claimRow().code, originalClaim.code);
    assert.equal(f.claimRow().claim_id, originalClaim.claim_id);
    f.state.head = 205;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.claimRow().status, 'claimed');
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'claimed');
  } finally { f.close(); }
});

test('a pending claim projection cannot overwrite a concurrent reconfirmation', async () => {
  const f = fixture();
  try {
    const first = await confirmedCrateClaim(f);
    const moved = { ...first.log, blockNumber: '0xcb', blockHash: blockHash(203) };
    f.state.canonical.set(200, blockHash(10_200));
    f.setReceipt(CLAIM_HASH, [moved], 203);
    f.state.logs = f.state.logs.filter((log) => log.transactionHash !== CLAIM_HASH).concat(moved);
    f.state.head = 203;
    const barrier = pauseCommerceWrite(f, () => f.claimRow().status === 'pending');
    const pending = f.request(paths.claimConfirm, { claimId: first.claim.claimId, transactionHash: CLAIM_HASH }, first.authentication.token);
    await barrier.paused;
    f.state.head = 205;
    const confirmed = await f.request(paths.claimConfirm, { claimId: first.claim.claimId, transactionHash: CLAIM_HASH }, first.authentication.token);
    assert.equal(confirmed.body.status, 'confirmed');
    const canonical = f.claimRow();
    barrier.resume();
    assert.equal((await pending).response.status, 503);
    assert.deepEqual(f.claimRow(), canonical);
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'claimed');
  } finally { f.close(); }
});

test('a failed pending-delivery projection is retried and preserves the original claim identity', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const claim = f.claimRow();
    const moved = { ...f.deliveryLog(first.prepared), blockNumber: '0x67', blockHash: blockHash(103) };
    f.setReceipt(HASH, [moved], 103);
    f.state.logs = [moved];
    f.state.head = 103;
    f.failures.publishWrite = true;
    await assert.rejects(reconcileEthereum111k(f.env, AbortSignal.timeout(10_000),
      { fetch: f.providerFetch, nowMs: () => f.state.now }), /Injected/);
    assert.equal(f.quoteRow(first.prepared.orderId).status, 'pending');
    assert.equal(f.quoteRow(first.prepared.orderId).published_at_ms, null);
    assert.equal(f.quoteRow(first.prepared.orderId).verified_at_block, null);
    f.failures.publishWrite = false;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.order(first.prepared.orderId)!.status, 'processing');
    assert.deepEqual(f.order(first.prepared.orderId)!.irlClaims, []);
    assert.deepEqual(f.claimRow(), claim);
    f.state.head = 200;
    f.failures.publishWrite = true;
    await assert.rejects(reconcileEthereum111k(f.env, AbortSignal.timeout(10_000),
      { fetch: f.providerFetch, nowMs: () => f.state.now }), /Injected/);
    assert.equal(f.quoteRow(first.prepared.orderId).verified_at_block, null);
    f.failures.publishWrite = false;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.order(first.prepared.orderId)!.status, 'ready_to_ship');
    assert.equal(f.quoteRow(first.prepared.orderId).verified_at_block, 200);
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].code, claim.code);
  } finally { f.close(); }
});

test('an old claimed receipt stays eligible until its failed projection is acknowledged', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    f.state.head = 300;
    const prepared = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare,
      { receiptId: '2000001', code: f.claimRow().code }, first.authentication.token);
    assert.equal(prepared.response.status, 200);
    const log = { ...f.claimLog(prepared.body), blockNumber: '0xc8', blockHash: blockHash(200) };
    f.setReceipt(CLAIM_HASH, [log], 200);
    f.failures.publishWrite = true;
    const failed = await f.request(paths.claimConfirm,
      { claimId: prepared.body.claimId, transactionHash: CLAIM_HASH }, first.authentication.token);
    assert.equal(failed.response.status, 503);
    assert.equal(f.claimRow().status, 'claimed');
    assert.equal(f.claimRow().verified_at_block, null);
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'available');
    f.commerce.database.prepare(`INSERT INTO ethereum_reconciliation_cursor (chain_id, contract_address, next_block)
      VALUES (?, ?, 301)`).run(31337, CONTRACT);
    f.failures.publishWrite = false;
    f.state.head = 400;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.claimRow().verified_at_block, 400);
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'claimed');
  } finally { f.close(); }
});

test('retirement cannot commit over a canonical reconfirmation that leaves the order unchanged', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const claim = f.claimRow();
    orphanCrateDelivery(f);
    f.state.head = 164;
    const barrier = pauseCommerceWrite(f, () => f.quoteRow(first.prepared.orderId).status === 'prepared');
    const reconciliation = reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    await barrier.paused;
    const moved = { ...f.deliveryLog(first.prepared), blockNumber: '0x65', blockHash: blockHash(101) };
    f.setReceipt(HASH, [moved], 101);
    f.state.logs = [moved];
    const reconfirmed = await f.request(paths.deliveryConfirm,
      { orderId: first.prepared.orderId, transactionHash: HASH }, first.authentication.token);
    assert.equal(reconfirmed.body.status, 'confirmed');
    barrier.resume();
    const result = await reconciliation;
    assert.ok(result.deferred > 0);
    assert.equal(result.failed, 0);
    assert.equal(f.quoteRow(first.prepared.orderId).status, 'confirmed');
    assert.equal(f.order(first.prepared.orderId)!.status, 'ready_to_ship');
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].code, claim.code);
    f.state.head = 189;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.order(first.prepared.orderId)!.status, 'ready_to_ship');
  } finally { f.close(); }
});

for (const failure of ['publishWrite', 'deliveryRetirementAck'] as const) {
  test(`delivery retirement survives ${failure} and retries beyond the recent-block window`, async () => {
    const f = fixture();
    try {
      const first = await f.confirmed();
      const originalClaim = f.claimRow();
      orphanCrateDelivery(f);
      f.failures[failure] = true;
      await assert.rejects(reconcileEthereum111k(f.env, AbortSignal.timeout(10_000),
        { fetch: f.providerFetch, nowMs: () => f.state.now }), /Injected/);
      const retired = f.quoteRow(first.prepared.orderId);
      assert.equal(retired.status, 'prepared');
      assert.equal(retired.transaction_hash, HASH);
      assert.equal(retired.block_hash, blockHash(100));
      assert.equal(retired.block_number, 100);
      assert.equal(retired.published_at_ms, null);
      assert.equal(f.order(first.prepared.orderId)!.status, failure === 'publishWrite' ? 'ready_to_ship' : 'processing');
      f.failures[failure] = false;
      f.state.head = 300;
      f.state.now += 2_400_000;
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.equal(f.quoteRow(first.prepared.orderId).transaction_hash, null);
      assert.equal(f.quoteRow(first.prepared.orderId).block_hash, null);
      assert.equal(f.quoteRow(first.prepared.orderId).block_number, null);
      assert.equal(f.order(first.prepared.orderId)!.status, 'processing');
      assert.deepEqual(f.order(first.prepared.orderId)!.irlClaims, []);
      assert.deepEqual(f.claimRow(), originalClaim);
    } finally { f.close(); }
  });
}

for (const failure of ['publishWrite', 'claimRetirementAck'] as const) {
  test(`claim retirement survives ${failure} and retries beyond the recent-block window`, async () => {
    const f = fixture();
    try {
      const first = await confirmedCrateClaim(f);
      const originalClaim = f.claimRow();
      f.state.receipts.delete(CLAIM_HASH);
      f.state.logs = f.state.logs.filter((log) => log.transactionHash !== CLAIM_HASH);
      f.failures[failure] = true;
      await assert.rejects(reconcileEthereum111k(f.env, AbortSignal.timeout(10_000),
        { fetch: f.providerFetch, nowMs: () => f.state.now }), /Injected/);
      assert.equal(f.claimRow().status, 'available');
      assert.equal(f.claimRow().transaction_hash, CLAIM_HASH);
      assert.equal(f.claimRow().block_hash, blockHash(200));
      assert.equal(f.claimRow().block_number, 200);
      assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status,
        failure === 'publishWrite' ? 'claimed' : 'available');
      f.failures[failure] = false;
      f.state.head = 400;
      f.state.now += 2_400_000;
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      const claim = f.claimRow();
      assert.equal(claim.status, 'available');
      assert.equal(claim.transaction_hash, null);
      assert.equal(claim.block_hash, null);
      assert.equal(claim.block_number, null);
      assert.equal(claim.claim_id, originalClaim.claim_id);
      assert.equal(claim.code, originalClaim.code);
      assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'available');
    } finally { f.close(); }
  });
}

test('a delivery retirement acknowledgement cannot clear a concurrent canonical reconfirmation', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const originalClaim = f.claimRow();
    orphanCrateDelivery(f);
    const barrier = pauseCommerceBatch(f, () => f.order(first.prepared.orderId)?.status === 'processing');
    const reconciliation = reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    await barrier.paused;
    assert.equal(f.quoteRow(first.prepared.orderId).transaction_hash, HASH);
    f.setReceipt(HASH, [f.deliveryLog(first.prepared)]);
    const reconfirmed = await f.request(paths.deliveryConfirm,
      { orderId: first.prepared.orderId, transactionHash: HASH }, first.authentication.token);
    assert.equal(reconfirmed.body.status, 'confirmed');
    const canonical = f.quoteRow(first.prepared.orderId);
    barrier.resume();
    await reconciliation;
    assert.deepEqual(f.quoteRow(first.prepared.orderId), canonical);
    assert.equal(f.order(first.prepared.orderId)!.status, 'ready_to_ship');
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].code, originalClaim.code);
  } finally { f.close(); }
});

test('a claim retirement acknowledgement cannot clear a concurrent canonical reconfirmation', async () => {
  const f = fixture();
  try {
    const first = await confirmedCrateClaim(f);
    f.state.receipts.delete(CLAIM_HASH);
    f.state.logs = f.state.logs.filter((log) => log.transactionHash !== CLAIM_HASH);
    const barrier = pauseCommerceBatch(f, () =>
      (f.order(first.prepared.orderId)?.irlClaims as Record<string, unknown>[])[0].status === 'available');
    const reconciliation = reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    await barrier.paused;
    assert.equal(f.claimRow().transaction_hash, CLAIM_HASH);
    f.setReceipt(CLAIM_HASH, [first.log], 200);
    const reconfirmed = await f.request(paths.claimConfirm,
      { claimId: first.claim.claimId, transactionHash: CLAIM_HASH }, first.authentication.token);
    assert.equal(reconfirmed.body.status, 'confirmed');
    const canonical = f.claimRow();
    barrier.resume();
    await reconciliation;
    assert.deepEqual(f.claimRow(), canonical);
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'claimed');
  } finally { f.close(); }
});

test('replacement delivery retries a failed old-order retirement without losing claim identity fences', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const originalClaim = f.claimRow();
    orphanCrateDelivery(f);
    const next = await f.prepared(['111112'], '10000000-0000-4000-8000-000000000002');
    const hash = `0x${'cc'.repeat(32)}`;
    const log = f.deliveryLog(next.prepared, ['111112'], ['2000001'], hash);
    f.setReceipt(hash, [log]);
    f.state.logs = [log];
    f.failures.publishWrite = true;
    const failed = await f.request(paths.deliveryConfirm,
      { orderId: next.prepared.orderId, transactionHash: hash }, next.authentication.token);
    assert.equal(failed.response.status, 503);
    assert.equal(f.quoteRow(first.prepared.orderId).transaction_hash, HASH);
    assert.deepEqual(f.claimRow(), originalClaim);
    assert.equal(f.order(next.prepared.orderId), null);
    f.failures.publishWrite = false;
    f.state.head = 300;
    f.state.now += 2_400_000;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.quoteRow(first.prepared.orderId).transaction_hash, null);
    assert.equal(f.order(first.prepared.orderId)!.status, 'processing');
    assert.deepEqual(f.order(first.prepared.orderId)!.irlClaims, []);
    assert.equal(f.order(next.prepared.orderId)!.status, 'ready_to_ship');
    assert.equal(f.claimRow().order_id, next.prepared.orderId);
    assert.notEqual(f.claimRow().claim_id, originalClaim.claim_id);
    assert.notEqual(f.claimRow().code, originalClaim.code);
  } finally { f.close(); }
});

for (const status of ['0x0', '0x1']) test(`a re-mined delivery with outer status ${status} and no delivery event is retired without blocking discovery`, async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const originalClaim = f.claimRow();
    f.state.canonical.set(100, blockHash(10_100));
    orphanCrateDelivery(f);
    f.state.now = first.prepared.expiresAtMs + 1000;
    f.setReceipt(HASH, [], 101);
    Object.assign(f.state.receipts.get(HASH)!, { status, to: WALLET, from: OTHER_WALLET });
    const second = await f.prepared(['111113'], '10000000-0000-4000-8000-000000000002');
    const secondHash = `0x${'cc'.repeat(32)}`;
    const secondLog = { ...f.deliveryLog(second.prepared, ['111113'], ['2000002'], secondHash),
      blockNumber: '0x67', blockHash: blockHash(103) };
    f.setReceipt(secondHash, [secondLog], 103);
    f.state.head = 105;
    f.state.logs = [secondLog];
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.quoteRow(first.prepared.orderId).status, 'prepared');
    assert.equal(f.quoteRow(first.prepared.orderId).transaction_hash, null);
    assert.equal(f.order(first.prepared.orderId)!.status, 'processing');
    assert.deepEqual(f.order(first.prepared.orderId)!.irlClaims, []);
    assert.deepEqual(f.claimRow(), originalClaim);
    assert.equal(f.quoteRow(second.prepared.orderId).status, 'confirmed');
    assert.equal(f.order(second.prepared.orderId)!.status, 'ready_to_ship');
    const secondOrder = f.order(second.prepared.orderId);
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.deepEqual(f.order(second.prepared.orderId), secondOrder);
  } finally { f.close(); }
});

test('a re-mined successful wrapper without its claim event restores the code and still discovers other orders', async () => {
  const f = fixture();
  try {
    const first = await confirmedCrateClaim(f);
    const originalClaim = f.claimRow();
    f.state.canonical.set(200, blockHash(10_200));
    f.state.logs = f.state.logs.filter((log) => log.transactionHash !== CLAIM_HASH);
    f.state.tokens.set('2000001', { kind: 5, displayId: 1, owner: OTHER_WALLET });
    f.setReceipt(CLAIM_HASH, [], 201);
    Object.assign(f.state.receipts.get(CLAIM_HASH)!, { to: WALLET, from: OTHER_WALLET });
    const second = await f.prepared(['111113'], '10000000-0000-4000-8000-000000000002');
    const secondHash = `0x${'cc'.repeat(32)}`;
    const secondLog = { ...f.deliveryLog(second.prepared, ['111113'], ['2000002'], secondHash),
      blockNumber: '0xcb', blockHash: blockHash(203) };
    f.setReceipt(secondHash, [secondLog], 203);
    f.state.logs.push(secondLog);
    f.state.head = 205;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.claimRow().status, 'available');
    assert.equal(f.claimRow().transaction_hash, null);
    assert.equal(f.claimRow().code, originalClaim.code);
    assert.equal(f.claimRow().claim_id, originalClaim.claim_id);
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'available');
    assert.equal(f.order(second.prepared.orderId)!.status, 'ready_to_ship');
    const claim = f.claimRow();
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.deepEqual(f.claimRow(), claim);
  } finally { f.close(); }
});

test('a missing delivery event suspends fulfillment until another canonical transaction is verified', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const originalClaim = f.claimRow();
    const replacementHash = `0x${'cc'.repeat(32)}`;
    const replacementLog = { ...f.deliveryLog(first.prepared, ['111112'], ['2000001'], replacementHash),
      blockNumber: '0x67', blockHash: blockHash(103) };
    f.state.canonical.set(100, blockHash(10_100));
    f.setReceipt(HASH, [], 101);
    f.setReceipt(replacementHash, [replacementLog], 103);
    f.state.head = 105;
    f.state.logs = [];
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.order(first.prepared.orderId)!.status, 'processing');
    assert.deepEqual(f.order(first.prepared.orderId)!.irlClaims, []);
    assert.equal(f.quoteRow(first.prepared.orderId).status, 'pending');
    assert.equal(f.quoteRow(first.prepared.orderId).transaction_hash, HASH);
    assert.deepEqual(f.claimRow(), originalClaim);
    f.state.logs = [replacementLog];
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.quoteRow(first.prepared.orderId).transaction_hash, replacementHash);
    assert.equal(f.order(first.prepared.orderId)!.status, 'ready_to_ship');
    assert.deepEqual(f.claimRow(), originalClaim);
  } finally { f.close(); }
});

test('a replacement delivery stays unfulfillable during discovery catch-up and until three confirmations', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const originalClaim = f.claimRow();
    const originalLog = { ...f.deliveryLog(first.prepared), blockNumber: '0x1385', blockHash: blockHash(4997) };
    f.setReceipt(HASH, [originalLog], 4997);
    f.state.head = 4999;
    assert.equal((await f.request(paths.deliveryConfirm,
      { orderId: first.prepared.orderId, transactionHash: HASH }, first.authentication.token)).body.status, 'confirmed');
    f.state.canonical.set(4997, blockHash(14997));
    f.state.receipts.delete(HASH);
    const replacementHash = blockHash(60_000);
    const replacementLog = { ...f.deliveryLog(first.prepared, ['111112'], ['2000001'], replacementHash),
      blockNumber: '0x1388', blockHash: blockHash(5000) };
    f.setReceipt(replacementHash, [replacementLog], 5000);
    f.state.logs = [replacementLog];
    f.state.head = 5000;
    for (let pass = 0; pass < 3; pass++) {
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.equal(f.quoteRow(first.prepared.orderId).status, 'pending');
      assert.equal(f.quoteRow(first.prepared.orderId).transaction_hash, pass < 2 ? HASH : replacementHash);
      assert.equal(f.quoteRow(first.prepared.orderId).published_at_ms, null);
      assert.equal(f.order(first.prepared.orderId)!.status, 'processing');
      assert.deepEqual(f.order(first.prepared.orderId)!.irlClaims, []);
      assert.deepEqual(f.claimRow(), originalClaim);
      assert.equal((await f.request(paths.claimPrepare,
        { receiptId: '2000001', code: originalClaim.code }, first.authentication.token)).response.status, 409);
    }
    f.state.head = 5002;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.quoteRow(first.prepared.orderId).status, 'confirmed');
    assert.equal(f.order(first.prepared.orderId)!.status, 'ready_to_ship');
    assert.deepEqual(f.claimRow(), originalClaim);
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].code, originalClaim.code);
    assert.equal((await f.request(paths.claimPrepare,
      { receiptId: '2000001', code: originalClaim.code }, first.authentication.token)).response.status, 200);
  } finally { f.close(); }
});

test('a delayed replacement-delivery suspension cannot erase its canonical reconfirmation', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const originalClaim = f.claimRow();
    const replacementHash = blockHash(60_000);
    const replacementLog = { ...f.deliveryLog(first.prepared, ['111112'], ['2000001'], replacementHash),
      blockNumber: '0x67', blockHash: blockHash(103) };
    f.state.canonical.set(100, blockHash(10_100));
    f.state.receipts.delete(HASH);
    f.setReceipt(replacementHash, [replacementLog], 103);
    f.state.logs = [];
    f.state.head = 105;
    const barrier = pauseCommerceBatch(f, () => f.quoteRow(first.prepared.orderId).status === 'pending');
    const reconciliation = reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    await barrier.paused;
    assert.equal((await f.request(paths.deliveryConfirm,
      { orderId: first.prepared.orderId, transactionHash: replacementHash }, first.authentication.token)).body.status, 'confirmed');
    barrier.resume();
    await reconciliation;
    assert.equal(f.quoteRow(first.prepared.orderId).transaction_hash, replacementHash);
    assert.equal(f.quoteRow(first.prepared.orderId).status, 'confirmed');
    assert.equal(f.order(first.prepared.orderId)!.status, 'ready_to_ship');
    assert.deepEqual(f.claimRow(), originalClaim);
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].code, originalClaim.code);
  } finally { f.close(); }
});

for (const changedClaimId of [false, true]) test(`a missing claim event preserves a canonical replacement with ${changedClaimId ? 'another' : 'the same'} claim ID`, async () => {
  const f = fixture();
  try {
    const first = await confirmedCrateClaim(f);
    const originalClaim = f.claimRow();
    const replacementHash = `0x${'cc'.repeat(32)}`;
    const claimId = changedClaimId ? `0x${'dd'.repeat(32)}` : first.claim.claimId;
    const replacementLog = { ...f.claimLog({ ...first.claim, claimId }, undefined, replacementHash),
      blockNumber: '0xcb', blockHash: blockHash(203) };
    f.state.canonical.set(200, blockHash(10_200));
    f.setReceipt(CLAIM_HASH, [], 201);
    f.setReceipt(replacementHash, [replacementLog], 203);
    f.state.tokens.delete('2000001');
    f.state.head = 205;
    f.state.logs = f.state.logs.filter((log) => log.transactionHash !== CLAIM_HASH);
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.deepEqual({ ...f.claimRow() }, { ...originalClaim, updated_at_ms: Math.max(Number(originalClaim.updated_at_ms) + 1, f.state.now) });
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'claimed');
    f.state.logs.push(replacementLog);
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.claimRow().transaction_hash, replacementHash);
    assert.equal(f.claimRow().claim_id, claimId);
    assert.equal(f.claimRow().code, originalClaim.code);
    assert.equal(f.claimRow().status, 'claimed');
  } finally { f.close(); }
});

for (const oldReceipt of ['missing', 'reverted'] as const) {
  for (const changedClaimId of [false, true]) {
    test(`${oldReceipt} claim receipts preserve ${changedClaimId ? 'another' : 'the same'} canonical claim ID while discovery catches up`, async () => {
      const f = fixture();
      try {
        const first = await confirmedCrateClaim(f);
        const originalLog = { ...first.log, blockNumber: '0x1388', blockHash: blockHash(5000) };
        f.setReceipt(CLAIM_HASH, [originalLog], 5000);
        f.state.head = 5002;
        assert.equal((await f.request(paths.claimConfirm,
          { claimId: first.claim.claimId, transactionHash: CLAIM_HASH }, first.authentication.token)).body.status, 'confirmed');
        const original = f.claimRow();
        f.state.canonical.set(5000, blockHash(15_000));
        f.state.receipts.delete(CLAIM_HASH);
        if (oldReceipt === 'reverted') {
          f.setReceipt(CLAIM_HASH, [], 5001);
          f.state.receipts.get(CLAIM_HASH)!.status = '0x0';
        }
        const replacementHash = blockHash(50_000);
        const claimId = changedClaimId ? blockHash(60_000) : first.claim.claimId;
        const replacementLog = { ...f.claimLog({ ...first.claim, claimId }, undefined, replacementHash),
          blockNumber: '0x138b', blockHash: blockHash(5003) };
        f.setReceipt(replacementHash, [replacementLog], 5003);
        f.state.logs = f.state.logs.filter((log) => log.transactionHash !== CLAIM_HASH).concat(replacementLog);
        f.state.tokens.delete('2000001');
        f.state.head = 5005;
        for (let pass = 0; pass < 3; pass++) {
          await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
          assert.equal(f.claimRow().status, 'claimed');
          assert.equal(f.claimRow().code, original.code);
          assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'claimed');
          if (pass < 2) assert.equal(f.claimRow().transaction_hash, CLAIM_HASH);
        }
        assert.equal(f.claimRow().transaction_hash, replacementHash);
        assert.equal(f.claimRow().claim_id, claimId);
      } finally { f.close(); }
    });
  }
}

test('deferred deliveries rotate so later orphaned orders can be retired', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const original = f.quoteRow(first.prepared.orderId);
    f.commerce.database.prepare('DELETE FROM ethereum_crate_claims').run();
    f.commerce.database.prepare('DELETE FROM ethereum_delivery_quotes').run();
    f.state.receipts.clear();
    f.state.logs = [];
    for (let index = 0; index < 21; index++) {
      const row = { ...original, order_id: 10_000 + index, request_id: crypto.randomUUID(),
        transaction_hash: blockHash(50_000 + index), created_at_ms: NOW - 2000, published_at_ms: NOW - 1000,
        updated_at_ms: NOW - 1000 + index };
      f.commerce.database.prepare(`INSERT INTO ethereum_delivery_quotes (${Object.keys(row).join(',')})
        VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
      if (index < 20) f.state.usedOrders.add(row.order_id);
      await new D1CommerceRepository(f.env.COMMERCE_DB).run(NOW, async (unit) => {
        await unit.create(commerceKeys.deliveryOrder('111k_devnet', String(row.order_id)), {
          source: 'ethereum', owner: WALLET, chainId: 31337, contractAddress: CONTRACT, status: 'ready_to_ship', irlClaims: [],
        });
      });
    }
    const deferred = f.quoteRow(10_000);
    for (let attempt = 0; attempt < 4; attempt++) {
      f.state.head = 205 + attempt * 25;
      f.state.now += 300_000;
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.equal(f.order(10_000)!.status, 'processing');
    }
    const { updated_at_ms, ...unchanged } = f.quoteRow(10_000);
    assert.deepEqual(unchanged, { ...Object.fromEntries(Object.entries(deferred).filter(([key]) => key !== 'updated_at_ms')),
      status: 'pending', published_at_ms: null, verified_at_block: null });
    assert.ok(Number(updated_at_ms) > Number(deferred.updated_at_ms));
    assert.equal(f.quoteRow(10_020).transaction_hash, null);
    assert.equal(f.order(10_020)!.status, 'processing');
  } finally { f.close(); }
});

test('deferred delivery rotation cannot overwrite a concurrent canonical confirmation', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    f.state.receipts.delete(HASH);
    f.state.logs = [];
    f.state.usedOrders.add(first.prepared.orderId);
    const barrier = pauseRpc(f, (rpc) => rpc.method === 'eth_call' &&
      String((rpc.params[0] as { data: string }).data).startsWith(functionSelector('usedDeliveryOrders(uint256)')));
    const reconciliation = reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    await barrier.paused;
    const replacementHash = blockHash(50_000);
    const replacementLog = f.deliveryLog(first.prepared, ['111112'], ['2000001'], replacementHash);
    f.setReceipt(replacementHash, [replacementLog]);
    const confirmed = await f.request(paths.deliveryConfirm,
      { orderId: first.prepared.orderId, transactionHash: replacementHash }, first.authentication.token);
    assert.equal(confirmed.body.status, 'confirmed');
    const canonical = f.quoteRow(first.prepared.orderId);
    barrier.resume();
    await reconciliation;
    assert.deepEqual(f.quoteRow(first.prepared.orderId), canonical);
  } finally { f.close(); }
});

test('deferred claims rotate so newer orphaned claims can recover', async () => {
  const f = fixture();
  try {
    const current = await confirmedCrateClaim(f);
    const originalClaim = f.claimRow();
    const oldOrderId = current.prepared.orderId === 2147483647 ? 1 : current.prepared.orderId + 1;
    const oldParent = { ...f.quoteRow(current.prepared.orderId), order_id: oldOrderId,
      request_id: crypto.randomUUID(), transaction_hash: `0x${'dd'.repeat(32)}`,
      block_number: 180, block_hash: blockHash(180), verified_at_block: 192,
      created_at_ms: NOW - 2000, published_at_ms: NOW - 1000, updated_at_ms: NOW - 1000,
      token_ids_json: JSON.stringify(Array.from({ length: 20 }, (_, i) => String(111113 + i))),
      items_json: JSON.stringify(Array.from({ length: 20 }, (_, i) =>
        ({ tokenId: String(111113 + i), kind: 'crate', displayId: i + 2, owner: WALLET }))),
    };
    f.commerce.database.prepare(`INSERT INTO ethereum_delivery_quotes (${Object.keys(oldParent).join(',')})
      VALUES (${Object.keys(oldParent).map(() => '?').join(',')})`).run(...Object.values(oldParent));
    await new D1CommerceRepository(f.env.COMMERCE_DB).run(NOW, async (unit) => {
      await unit.create(commerceKeys.deliveryOrder('111k_devnet', String(oldOrderId)), {
        source: 'ethereum', owner: WALLET, chainId: 31337, contractAddress: CONTRACT, status: 'ready_to_ship',
        irlClaims: Array.from({ length: 20 }, (_, i) => ({ boxId: i + 2, code: `CODE${i + 2}`, status: 'claimed' })),
      });
    });
    const wrapperHash = `0x${'cc'.repeat(32)}`;
    f.setReceipt(wrapperHash, [], 201);
    const insertClaim = f.commerce.database.prepare(`INSERT INTO ethereum_crate_claims
      (chain_id, contract_address, receipt_id, crate_id, order_id, code_hash, code, claim_id, status,
       transaction_hash, block_number, block_hash, verified_at_block, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, 190, ?, 192, ?)`);
    for (let i = 2; i <= 21; i++) insertClaim.run(31337, CONTRACT, String(2_000_000 + i), i, oldOrderId,
      `codehash${i}`, `CODE${i}`, `0x${i.toString(16).padStart(64, '0')}`, wrapperHash, blockHash(190), NOW - 1000);
    const deferred = f.claimRow('2000002');
    f.state.receipts.delete(CLAIM_HASH);
    f.state.logs = f.state.logs.filter((log) => log.transactionHash !== CLAIM_HASH);
    f.state.tokens.set('2000001', { kind: 5, displayId: 1, owner: WALLET });
    f.commerce.database.prepare('INSERT INTO ethereum_reconciliation_cursor (chain_id, contract_address, next_block) VALUES (?, ?, ?)').run(31337, CONTRACT, 203);
    for (let attempt = 0; attempt < 3; attempt++) {
      f.state.head = 205 + attempt * 25;
      f.state.now += 300_000;
      f.state.calls.length = 0;
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      if (!attempt) {
        assert.equal(f.claimRow().status, 'claimed');
        assert.deepEqual({ ...f.claimRow('2000002') }, { ...deferred, updated_at_ms: f.state.now });
      } else {
        assert.equal(f.claimRow().status, 'available');
        assert.equal(f.claimRow().transaction_hash, null);
        assert.equal(f.claimRow().code, originalClaim.code);
        assert.equal(f.claimRow().claim_id, originalClaim.claim_id);
        if (attempt === 1) assert.ok(f.state.calls.some((rpc) => rpc.method === 'eth_getTransactionReceipt' && rpc.params[0] === CLAIM_HASH));
      }
    }
    assert.equal(f.order(oldOrderId)!.status, 'processing');
    assert.equal((f.order(current.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'available');
    const ready = await f.request(paths.claimPrepare,
      { receiptId: '2000001', code: f.claimRow().code }, current.authentication.token);
    assert.equal(ready.response.status, 200, JSON.stringify(ready.body));
  } finally { f.close(); }
});

test('deferred queue rotation cannot overwrite a concurrent canonical claim confirmation', async () => {
  const f = fixture();
  try {
    const first = await confirmedCrateClaim(f);
    const replacementHash = `0x${'cc'.repeat(32)}`;
    const replacementLog = { ...f.claimLog(first.claim, undefined, replacementHash),
      blockNumber: '0xcb', blockHash: blockHash(203) };
    f.state.canonical.set(200, blockHash(10_200));
    f.setReceipt(CLAIM_HASH, [], 201);
    f.setReceipt(replacementHash, [replacementLog], 203);
    f.state.tokens.delete('2000001');
    f.state.head = 205;
    f.state.logs = f.state.logs.filter((log) => log.transactionHash !== CLAIM_HASH);
    const barrier = pauseRpc(f, (rpc) => rpc.method === 'eth_call' &&
      String((rpc.params[0] as { data: string }).data).startsWith(functionSelector('getTokenInfos(uint256[])')));
    const reconciliation = reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    await barrier.paused;
    const confirmed = await f.request(paths.claimConfirm,
      { claimId: first.claim.claimId, transactionHash: replacementHash }, first.authentication.token);
    assert.equal(confirmed.body.status, 'confirmed');
    const canonical = f.claimRow();
    barrier.resume();
    await reconciliation;
    assert.deepEqual(f.claimRow(), canonical);
  } finally { f.close(); }
});

test('one failed receipt does not block later records or discovery and is counted once', async () => {
  const f = fixture();
  try {
    await f.confirmed();
    const second = await f.prepared(['111113'], '10000000-0000-4000-8000-000000000002');
    const secondHash = `0x${'cc'.repeat(32)}`;
    const secondLog = { ...f.deliveryLog(second.prepared, ['111113'], ['2000002'], secondHash),
      blockNumber: '0x67', blockHash: blockHash(103) };
    f.setReceipt(secondHash, [secondLog], 103);
    f.state.head = 103;
    assert.equal((await f.request(paths.deliveryConfirm, { orderId: second.prepared.orderId, transactionHash: secondHash }, second.authentication.token)).body.status, 'pending');
    const third = await f.prepared(['7'], '10000000-0000-4000-8000-000000000003');
    const thirdHash = `0x${'dd'.repeat(32)}`;
    const thirdLog = { ...f.deliveryLog(third.prepared, ['7'], ['1000007'], thirdHash),
      blockNumber: '0x69', blockHash: blockHash(105) };
    f.setReceipt(thirdHash, [thirdLog], 105);
    f.state.head = 107;
    f.state.logs.push(secondLog, thirdLog);
    const failure = new Error('One receipt is unavailable');
    f.state.afterRpc = async (rpc) => { if (rpc.method === 'eth_getTransactionReceipt' && rpc.params[0] === HASH) throw failure; };
    let failed = 0;
    await assert.rejects(reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), {
      fetch: f.providerFetch, nowMs: () => f.state.now, onResult: (result) => { failed = result.failed; },
    }), (error: unknown) => error === failure);
    assert.equal(failed, 1);
    assert.equal(f.order(second.prepared.orderId)!.status, 'ready_to_ship');
    assert.equal(f.order(third.prepared.orderId)!.status, 'ready_to_ship');
    f.state.afterRpc = null;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
  } finally { f.close(); }
});

test('receipt reconciliation propagates cancellation without starting discovery', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const original = f.quoteRow(first.prepared.orderId);
    const controller = new AbortController();
    const reason = new Error('Reconciliation cancelled');
    f.state.calls.length = 0;
    f.state.afterRpc = async (rpc) => { if (rpc.method === 'eth_getTransactionReceipt') controller.abort(reason); };
    await assert.rejects(reconcileEthereum111k(f.env, controller.signal,
      { fetch: f.providerFetch, nowMs: () => f.state.now }), (error: unknown) => error === reason);
    assert.deepEqual(f.quoteRow(first.prepared.orderId), original);
    assert.equal(f.state.calls.some((rpc) => rpc.method === 'eth_getLogs'), false);
  } finally { f.close(); }
});

test('a new canonical crate delivery retires orphaned claims before cron and invalidates the old code', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const oldClaim = f.claimRow();
    orphanCrateDelivery(f);
    const next = await replaceCrateDelivery(f);
    const claim = f.claimRow();
    assert.equal(claim.order_id, next.prepared.orderId);
    assert.notEqual(claim.code, oldClaim.code);
    assert.notEqual(claim.claim_id, oldClaim.claim_id);
    assert.equal(f.quoteRow(first.prepared.orderId).status, 'prepared');
    assert.deepEqual(f.order(first.prepared.orderId)!.irlClaims, []);
    assert.equal(f.order(first.prepared.orderId)!.status, 'processing');
    assert.equal((await f.request(paths.claimPrepare, { receiptId: '2000001', code: oldClaim.code }, next.authentication.token)).response.status, 400);
    assert.equal((await f.request(paths.claimPrepare, { receiptId: '2000001', code: claim.code }, next.authentication.token)).response.status, 200);
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.order(next.prepared.orderId)!.status, 'ready_to_ship');
    assert.equal(f.claimRow().code, claim.code);
  } finally { f.close(); }
});

test('re-mined canonical deliveries retain claim identities through same-order retirement', async () => {
  const f = fixture();
  try {
    const { authentication, prepared } = await f.confirmed();
    const oldCode = f.claimRow().code;
    const movedLog = { ...f.deliveryLog(prepared), blockNumber: '0x65', blockHash: blockHash(101) };
    f.setReceipt(HASH, [movedLog], 101);
    f.state.logs = [movedLog];
    f.state.head = 103;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.claimRow().code, oldCode);
    assert.equal(f.quoteRow(prepared.orderId).block_hash, blockHash(101));
    orphanCrateDelivery(f);
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.claimRow().code, oldCode);
    f.setReceipt(HASH, [movedLog], 101);
    f.state.logs = [movedLog];
    f.state.tokens.set('2000001', { kind: 5, displayId: 1, owner: WALLET });
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    const claim = f.claimRow();
    assert.equal(claim.code, oldCode);
    assert.equal((f.order(prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].code, claim.code);
    assert.equal((await f.request(paths.claimPrepare, { receiptId: '2000001', code: claim.code }, authentication.token)).response.status, 200);
  } finally { f.close(); }
});

test('a delayed retirement projection cannot erase a reconfirmed order or its claim code', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const claim = f.claimRow();
    orphanCrateDelivery(f);
    const barrier = pauseCommerceBatch(f, () => f.quoteRow(first.prepared.orderId).status === 'prepared');
    const reconciliation = reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    await barrier.paused;
    f.setReceipt(HASH, [f.deliveryLog(first.prepared)]);
    assert.equal((await f.request(paths.deliveryConfirm,
      { orderId: first.prepared.orderId, transactionHash: HASH }, first.authentication.token)).body.status, 'confirmed');
    barrier.resume();
    await reconciliation;
    assert.equal(f.order(first.prepared.orderId)!.status, 'ready_to_ship');
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].code, claim.code);
  } finally { f.close(); }
});

test('stale claim projection cannot mark a new canonical order claim as claimed', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const prepared = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare,
      { receiptId: '2000001', code: f.claimRow().code }, first.authentication.token);
    f.setReceipt(CLAIM_HASH, [f.claimLog(prepared.body)]);
    const barrier = pauseCommerceBatch(f, () => f.claimRow().status === 'claimed');
    const stale = f.request(paths.claimConfirm,
      { claimId: prepared.body.claimId, transactionHash: CLAIM_HASH }, first.authentication.token);
    await barrier.paused;
    orphanCrateDelivery(f);
    const next = await replaceCrateDelivery(f);
    const claim = f.claimRow();
    barrier.resume();
    await stale;
    assert.deepEqual(f.claimRow(), claim);
    assert.equal((f.order(next.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'available');
    assert.deepEqual(f.order(first.prepared.orderId)!.irlClaims, []);
  } finally { f.close(); }
});

test('canonical replay of an old claim authorization updates the current receipt identity and skips completed replay', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const prepared = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare,
      { receiptId: '2000001', code: f.claimRow().code }, first.authentication.token);
    orphanCrateDelivery(f);
    const next = await replaceCrateDelivery(f);
    const code = f.claimRow().code;
    assert.notEqual(f.claimRow().claim_id, prepared.body.claimId);
    const log = f.claimLog(prepared.body);
    f.setReceipt(CLAIM_HASH, [log]);
    f.state.logs.push(log);
    assert.equal((await f.request(paths.claimConfirm,
      { claimId: prepared.body.claimId, transactionHash: CLAIM_HASH }, next.authentication.token)).body.status, 'confirmed');
    assert.equal(f.claimRow().claim_id, prepared.body.claimId);
    assert.equal(f.claimRow().code, code);
    assert.equal((f.order(next.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'claimed');
    f.state.head = 200;
    f.state.calls.length = 0;
    let recentReceiptReads = 0;
    f.state.afterRpc = async rpc => {
      if (rpc.method === 'eth_getLogs') recentReceiptReads = f.state.calls.filter(call => call.method === 'eth_getTransactionReceipt').length;
    };
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(recentReceiptReads, 2);
    f.state.afterRpc = null;
    f.state.calls.length = 0;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.state.calls.filter((call) => call.method === 'eth_getTransactionReceipt').length, 0);
    const repository = new D1CommerceRepository(f.env.COMMERCE_DB);
    await repository.run(NOW, async (unit) => {
      const key = commerceKeys.deliveryOrder('111k_devnet', String(next.prepared.orderId));
      const order = await unit.get(key);
      await unit.update(key, { irlClaims: (order!.data.irlClaims as Record<string, string>[]).map((claim) => ({ ...claim, status: 'available' })) });
    });
    f.commerce.database.prepare('DELETE FROM ethereum_reconciliation_cursor').run();
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.state.calls.filter((call) => call.method === 'eth_getTransactionReceipt').length, 1);
    assert.equal((f.order(next.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'claimed');
  } finally { f.close(); }
});

test('a stale delivery confirmation cannot recreate claims after a replacement order wins', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const barrier = pauseRpc(f, (payload) => payload.method === 'eth_getBlockByNumber' && payload.params[0] === '0x64');
    const stale = f.request(paths.deliveryConfirm,
      { orderId: first.prepared.orderId, transactionHash: HASH }, first.authentication.token);
    await barrier.paused;
    orphanCrateDelivery(f);
    const next = await replaceCrateDelivery(f);
    const claim = f.claimRow();
    barrier.resume();
    assert.equal((await stale).body.status, 'pending');
    assert.deepEqual(f.claimRow(), claim);
    assert.equal(f.quoteRow(first.prepared.orderId).status, 'prepared');
    assert.equal(f.order(next.prepared.orderId)!.status, 'ready_to_ship');
  } finally { f.close(); }
});

test('a stale claim confirmation cannot mutate the replacement receipt claim', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const prepared = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare,
      { receiptId: '2000001', code: f.claimRow().code }, first.authentication.token);
    f.setReceipt(CLAIM_HASH, [f.claimLog(prepared.body)]);
    const barrier = pauseRpc(f, (payload) => payload.method === 'eth_getBlockByNumber' && payload.params[0] === '0x64');
    const stale = f.request(paths.claimConfirm,
      { claimId: prepared.body.claimId, transactionHash: CLAIM_HASH }, first.authentication.token);
    await barrier.paused;
    orphanCrateDelivery(f);
    const next = await replaceCrateDelivery(f);
    const claim = f.claimRow();
    barrier.resume();
    assert.equal((await stale).body.status, 'pending');
    assert.deepEqual(f.claimRow(), claim);
    assert.equal((f.order(next.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'available');
  } finally { f.close(); }
});

test('stale orphan detection cannot delete a same-millisecond canonical reconfirmation', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const claim = f.claimRow();
    orphanCrateDelivery(f);
    const barrier = pauseRpc(f, (payload) => payload.method === 'eth_call' &&
      (payload.params[0] as { data: string }).data.startsWith(functionSelector('usedDeliveryOrders(uint256)')));
    const reconciliation = reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    await barrier.paused;
    f.setReceipt(HASH, [f.deliveryLog(first.prepared)]);
    assert.equal((await f.request(paths.deliveryConfirm,
      { orderId: first.prepared.orderId, transactionHash: HASH }, first.authentication.token)).body.status, 'confirmed');
    barrier.resume();
    await reconciliation;
    assert.deepEqual(f.claimRow(), claim);
    assert.equal(f.quoteRow(first.prepared.orderId).status, 'confirmed');
    assert.equal(f.order(first.prepared.orderId)!.status, 'ready_to_ship');
  } finally { f.close(); }
});

test('crowded event windows split and resume a hot block without replaying completed confirmations', async () => {
  const f = fixture();
  try {
    const { prepared } = await f.prepared(['7']);
    const source = f.quoteRow(prepared.orderId);
    f.state.head = 2200;
    const insert = f.commerce.database.prepare(`INSERT INTO ethereum_delivery_quotes
      (chain_id, contract_address, order_id, request_id, wallet, address_id, address_json, token_ids_json,
        items_json, fee_wei, deadline, status, transaction_hash, block_number, block_hash, published_at_ms,
        verified_at_block, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let index = 0; index < 1001; index++) {
      const orderId = index + 10_000;
      const tokenId = String(index + 1);
      const hash = `0x${(index + 1).toString(16).padStart(64, '0')}`;
      const completed = index < 955;
      const moved = index === 955;
      const log = { ...f.deliveryLog({ ...prepared, orderId }, [tokenId], [String(1_000_001 + index)], hash),
        logIndex: ethereumHexQuantity(index) };
      f.state.logs.push(log);
      f.setReceipt(hash, [log]);
      insert.run(31337, CONTRACT, orderId, crypto.randomUUID(), WALLET, ADDRESS_ID, source.address_json,
        JSON.stringify([tokenId]), JSON.stringify([{ tokenId, kind: 'artwork', displayId: index + 1, owner: WALLET }]),
        source.fee_wei, source.deadline, completed || moved ? 'confirmed' : 'prepared',
        completed || moved ? hash : null, completed || moved ? 100 : null, moved ? blockHash(999) : completed ? blockHash(100) : null,
        completed || moved ? NOW : null, completed || moved ? 2200 : null, NOW, NOW);
    }
    let remaining = 46;
    for (let attempt = 0; attempt < 5 && remaining; attempt++) {
      const completedHashes = new Set(f.commerce.database.prepare(`SELECT transaction_hash FROM ethereum_delivery_quotes
        WHERE order_id BETWEEN 10000 AND 11000 AND status = 'confirmed' AND block_hash = ? AND published_at_ms IS NOT NULL`)
        .all(blockHash(100)).map((row) => row.transaction_hash));
      f.state.calls.length = 0;
      f.databaseCalls.statements = 0;
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      const reads = f.state.calls.filter((call) => call.method === 'eth_getTransactionReceipt');
      assert.ok(reads.every((call) => !completedHashes.has(String(call.params[0]))));
      assert.ok(f.databaseCalls.statements <= 400);
      const next = Number(f.commerce.database.prepare(`SELECT COUNT(*) AS n FROM ethereum_delivery_quotes
        WHERE order_id BETWEEN 10000 AND 11000 AND (status != 'confirmed' OR block_hash != ? OR published_at_ms IS NULL)`)
        .get(blockHash(100))!.n);
      assert.ok(next < remaining, 'The hot block must resume without replaying completed confirmations');
      remaining = next;
      if (remaining) assert.ok(Number(f.commerce.database.prepare('SELECT next_block FROM ethereum_reconciliation_cursor').get()!.next_block) <= 100);
      if (!attempt) assert.ok(f.state.calls.filter((call) => call.method === 'eth_getLogs').length > 1);
    }
    assert.equal(remaining, 0);
    assert.equal(f.quoteRow(10_955).block_hash, blockHash(100));
    assert.ok(Number(f.commerce.database.prepare('SELECT next_block FROM ethereum_reconciliation_cursor').get()!.next_block) > 100);
    assert.equal(f.commerce.database.prepare("SELECT COUNT(*) AS n FROM ethereum_delivery_quotes WHERE order_id BETWEEN 10000 AND 11000 AND status = 'confirmed'").get()!.n, 1001);
  } finally { f.close(); }
});

test('a previous worker checkpoint cannot strand an exhausted scan', async () => {
  const f = fixture();
  try {
    const { prepared } = await f.prepared(['7']);
    const log = f.deliveryLog(prepared, ['7'], ['1000007']);
    f.state.logs = [log];
    f.setReceipt(HASH, [log]);
    f.state.head = 200;
    f.commerce.database.prepare(`INSERT INTO ethereum_reconciliation_cursor
      (chain_id, contract_address, next_block, scan_end_block) VALUES (?, ?, 53, 102)`).run(31337, CONTRACT);
    f.commerce.database.prepare(`INSERT INTO ethereum_reconciliation_cursor (chain_id, contract_address, next_block)
      VALUES (?, ?, ?) ON CONFLICT(chain_id, contract_address) DO UPDATE SET next_block = MAX(next_block, excluded.next_block)`)
      .run(31337, CONTRACT, 103);
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.quoteRow(prepared.orderId).status, 'confirmed');
    const scan = f.state.calls.find(call => call.method === 'eth_getLogs')!.params[0] as { fromBlock: string };
    assert.equal(BigInt(scan.fromBlock), 38n);
    const cursor = f.commerce.database.prepare('SELECT next_block, scan_end_block FROM ethereum_reconciliation_cursor').get()!;
    assert.equal(cursor.next_block, 201);
    assert.equal(cursor.scan_end_block, null);
  } finally { f.close(); }
});

test('exhausted scan repair preserves a concurrently started scan', async () => {
  const f = fixture();
  try {
    f.state.head = 200;
    f.commerce.database.prepare(`INSERT INTO ethereum_reconciliation_cursor
      (chain_id, contract_address, next_block, scan_end_block) VALUES (?, ?, 103, 102)`).run(31337, CONTRACT);
    let replaced = false;
    f.env.COMMERCE_DB = d1Database(f.commerce.database, ({ method, sql }) => {
      if (replaced || method !== 'first' || !sql.includes('SELECT next_block, scan_end_block')) return;
      replaced = true;
      f.commerce.database.prepare('UPDATE ethereum_reconciliation_cursor SET scan_end_block = 200').run();
    });
    const result = await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(result.deferred, 1);
    assert.equal(f.state.calls.some(call => call.method === 'eth_getLogs'), false);
    const cursor = f.commerce.database.prepare('SELECT next_block, scan_end_block FROM ethereum_reconciliation_cursor').get()!;
    assert.equal(cursor.next_block, 103);
    assert.equal(cursor.scan_end_block, 200);
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.commerce.database.prepare('SELECT next_block FROM ethereum_reconciliation_cursor').get()!.next_block, 201);
    assert.equal(f.commerce.database.prepare('SELECT scan_end_block FROM ethereum_reconciliation_cursor').get()!.scan_end_block, null);
  } finally { f.close(); }
});

test('limited event ranges resume a fixed scan and retain the next reorg sweep', async () => {
  const f = fixture();
  try {
    const first = await f.prepared(['7']);
    const reorg = await f.prepared(['111112'], '10000000-0000-4000-8000-000000000002');
    const log = f.deliveryLog(first.prepared, ['7'], ['1000007']);
    f.state.logs = [log];
    f.setReceipt(HASH, [log]);
    const loadCursor = () => f.commerce.database.prepare('SELECT next_block, scan_end_block FROM ethereum_reconciliation_cursor').get()!;
    let requests = 0;
    const limitedFetch: typeof fetch = async (input, init) => {
      if (!init?.body) return f.providerFetch(input, init);
      const rpc = JSON.parse(String(init?.body)) as Rpc;
      if (rpc.method === 'eth_getLogs') {
        requests++;
        const range = rpc.params[0] as { fromBlock: string; toBlock: string };
        if (BigInt(range.toBlock) - BigInt(range.fromBlock) + 1n > 2n) {
          return Response.json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'Log range too large' } });
        }
      }
      return f.providerFetch(input, init);
    };
    let previous = 2;
    for (let run = 0; run < 5; run++) {
      requests = 0;
      f.databaseCalls.statements = 0;
      const summary = await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: limitedFetch, nowMs: () => f.state.now });
      const cursor = loadCursor();
      assert.ok(Number(cursor.next_block) > previous);
      assert.ok(requests <= 64);
      assert.ok(f.databaseCalls.statements <= 400);
      if (cursor.scan_end_block === null) break;
      assert.equal(cursor.scan_end_block, 102);
      assert.equal(summary.hasMore, true);
      previous = Number(cursor.next_block);
      f.state.head = 164;
    }
    assert.equal(loadCursor().scan_end_block, null);
    assert.equal(loadCursor().next_block, 103);
    assert.equal(f.quoteRow(first.prepared.orderId).status, 'confirmed');
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(loadCursor().next_block, 165);
    const reorgHash = `0x${'cc'.repeat(32)}`;
    const reorgLog = f.deliveryLog(reorg.prepared, ['111112'], ['2000001'], reorgHash);
    f.state.logs.push(reorgLog);
    f.setReceipt(reorgHash, [reorgLog]);
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.quoteRow(reorg.prepared.orderId).status, 'confirmed');
    assert.equal(loadCursor().scan_end_block, null);
  } finally { f.close(); }
});

for (const depth of [20, 64]) {
  test(`event discovery recovers a previously unobserved delivery after a ${depth}-block reorg`, async () => {
    const f = fixture();
    try {
      f.state.head = 80;
      const { prepared } = await f.prepared();
      f.state.head = 100 + depth;
      f.state.now += (f.state.head - 80) * 12_000;
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.equal(f.commerce.database.prepare('SELECT next_block FROM ethereum_reconciliation_cursor').get()!.next_block, f.state.head + 1);
      assert.equal(f.quoteRow(prepared.orderId).transaction_hash, null);
      assert.equal(f.order(prepared.orderId), null);
      const log = { ...f.deliveryLog(prepared), blockHash: blockHash(10_100) };
      f.setReceipt(HASH, [log]);
      f.state.receipts.get(HASH)!.blockHash = log.blockHash;
      f.state.canonical.set(100, log.blockHash);
      f.state.logs = [log];
      f.state.tokens.delete('111112');
      f.state.tokens.set('2000001', { kind: 5, displayId: 1, owner: WALLET });
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.equal(f.quoteRow(prepared.orderId).status, 'confirmed');
      assert.equal(f.quoteRow(prepared.orderId).transaction_hash, HASH);
      assert.equal(f.quoteRow(prepared.orderId).block_hash, log.blockHash);
      const order = f.order(prepared.orderId)!;
      assert.equal(order.status, 'ready_to_ship');
      const claim = f.claimRow();
      assert.equal((order.irlClaims as Record<string, unknown>[])[0].code, claim.code);
      f.state.head++;
      f.state.now += 12_000;
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.deepEqual(f.order(prepared.orderId), order);
      assert.equal(f.claimRow().code, claim.code);
      assert.equal(f.claimRow().claim_id, claim.claim_id);
      assert.equal(f.commerce.database.prepare("SELECT COUNT(*) AS n FROM commerce_documents WHERE document_kind = 'delivery_order'").get()!.n, 1);
    } finally { f.close(); }
  });

  test(`event discovery recovers a previously unobserved claim after a ${depth}-block reorg`, async () => {
    const f = fixture();
    try {
      f.state.head = 80;
      const { authentication, prepared } = await f.prepared();
      const deliveryLog = { ...f.deliveryLog(prepared), blockNumber: '0x5a', blockHash: blockHash(90) };
      f.setReceipt(HASH, [deliveryLog], 90);
      f.state.logs = [deliveryLog];
      f.state.tokens.delete('111112');
      f.state.tokens.set('2000001', { kind: 5, displayId: 1, owner: WALLET });
      f.state.head = 92;
      f.state.now += 12 * 12_000;
      assert.equal((await f.request(paths.deliveryConfirm,
        { orderId: prepared.orderId, transactionHash: HASH }, authentication.token)).body.status, 'confirmed');
      const claim = f.claimRow();
      const authorization = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare,
        { receiptId: '2000001', code: claim.code }, authentication.token);
      assert.equal(authorization.response.status, 200, JSON.stringify(authorization.body));
      f.state.head = 100 + depth;
      f.state.now += (f.state.head - 92) * 12_000;
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.equal(f.commerce.database.prepare('SELECT next_block FROM ethereum_reconciliation_cursor').get()!.next_block, f.state.head + 1);
      assert.equal(f.claimRow().transaction_hash, null);
      assert.equal(f.claimRow().status, 'available');
      const log = { ...f.claimLog(authorization.body), blockHash: blockHash(10_100) };
      f.setReceipt(CLAIM_HASH, [log]);
      f.state.receipts.get(CLAIM_HASH)!.blockHash = log.blockHash;
      f.state.canonical.set(100, log.blockHash);
      f.state.logs.push(log);
      f.state.tokens.delete('2000001');
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.equal(f.claimRow().status, 'claimed');
      assert.equal(f.claimRow().transaction_hash, CLAIM_HASH);
      assert.equal(f.claimRow().block_hash, log.blockHash);
      const order = f.order(prepared.orderId)!;
      assert.equal((order.irlClaims as Record<string, unknown>[])[0].status, 'claimed');
      f.state.head++;
      f.state.now += 12_000;
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.deepEqual(f.order(prepared.orderId), order);
      assert.equal(f.claimRow().code, claim.code);
      assert.equal(f.claimRow().claim_id, claim.claim_id);
      assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_crate_claims').get()!.n, 1);
    } finally { f.close(); }
  });
}

test('event discovery retains its cursor when a receipt has not been durably confirmed', async () => {
  const f = fixture();
  try {
    const { prepared } = await f.prepared();
    const log = f.deliveryLog(prepared);
    f.state.logs = [log];
    f.state.head = 2000;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.quoteRow(prepared.orderId).transaction_hash, null);
    assert.equal(f.commerce.database.prepare('SELECT next_block FROM ethereum_reconciliation_cursor').get()!.next_block, 100);
    f.setReceipt(HASH, [log]);
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.order(prepared.orderId)!.status, 'ready_to_ship');
    assert.equal(f.commerce.database.prepare('SELECT next_block FROM ethereum_reconciliation_cursor').get()!.next_block, 2001);
  } finally { f.close(); }
});

test('physical claim authorization needs the exact receipt, code and owner and survives failed or reorged submissions', async () => {
  const f = fixture();
  try {
    const { authentication, prepared: delivery } = await f.confirmed();
    const code = String(f.claimRow().code);
    assert.equal((await f.request(paths.claimPrepare, { receiptId: '2000001', code: 'wrong' }, authentication.token)).response.status, 400);
    const other = await f.session(OTHER_KEY);
    assert.equal((await f.request(paths.claimPrepare, { receiptId: '2000001', code }, other.token)).response.status, 403);
    const input = { receiptId: '2000001', code: `${code.slice(0, 6)}-${code.slice(6)}`.toLowerCase() };
    const prepared = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare, input, authentication.token);
    assert.equal(prepared.response.status, 200, JSON.stringify(prepared.body));
    assert.equal(f.claimRow().status, 'available');
    assert.equal(recoverEthereumAddress(crateClaimDigest({ chainId: 31337, contractAddress: CONTRACT, wallet: WALLET,
      receiptId: prepared.body.receiptId, claimId: prepared.body.claimId, deadline: prepared.body.deadline }), prepared.body.signature), SIGNER);
    const confirmInput = { claimId: prepared.body.claimId, transactionHash: CLAIM_HASH };
    assert.equal((await f.request(paths.claimConfirm, confirmInput, authentication.token)).body.status, 'pending');
    const log = f.claimLog(prepared.body);
    f.setReceipt(CLAIM_HASH, [log]);
    f.state.head = 100;
    assert.equal((await f.request(paths.claimConfirm, confirmInput, authentication.token)).body.status, 'pending');
    assert.equal(f.claimRow().status, 'pending');
    f.state.head = 102;
    assert.equal((await f.request(paths.claimConfirm, confirmInput, authentication.token)).body.status, 'confirmed');
    assert.equal(f.claimRow().status, 'claimed');
    assert.equal((f.order(delivery.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'claimed');
    f.state.receipts.delete(CLAIM_HASH);
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.claimRow().status, 'available');
    assert.equal((f.order(delivery.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'available');
    const retry = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare, input, authentication.token);
    assert.equal(retry.response.status, 200);
    assert.equal(retry.body.claimId, prepared.body.claimId);
    assert.equal(f.claimRow().code, code);
  } finally { f.close(); }
});

test('contract read batches preserve duplicate positions and omit absent token tuples', async () => {
  const f = fixture();
  try {
    const context = readContext(f);
    assert.deepEqual(await ethereumTokenInfos(context, []), []);
    assert.deepEqual(await ethereumInventoryItems(context, []), []);
    assert.equal(f.state.calls.length, 0);
    f.state.metadataValues.set(`${f.env.ETHEREUM_111K_METADATA_BASE_URI}111112.json`, { ...SYNTHETIC_METADATA, name: 'First response' });
    f.state.metadataValues.set(`${f.env.ETHEREUM_111K_METADATA_BASE_URI}111113.json`, { ...SYNTHETIC_METADATA, name: 'Second response' });
    const infos = await ethereumTokenInfos(context, ['111112', '999999', '111112', '111113']);
    assert.deepEqual(infos.map(info => info.tokenId), ['111112', '111112', '111113']);
    const items = await ethereumInventoryItems(context, infos);
    assert.deepEqual(items.map(item => item.name), ['First response', 'First response', 'Second response']);
    assert.equal(f.state.metadataRequests.length, 2);
    assert.deepEqual(f.state.batchSizes, [1, 1]);
    assert.ok(f.state.calls.filter(call => call.method === 'eth_call').every(call => call.params[1] === 'latest'));
  } finally { f.close(); }
});

test('offchain metadata fetches current JSON over HTTP without storing previous responses', async () => {
  const f = fixture();
  try {
    const original = f.metadata.fetch;
    let revision = 1;
    f.metadata.fetch = async (input, init) => {
      assert.equal(init?.cache, 'no-store');
      assert.equal(init?.redirect, 'manual');
      const response = await original(input, init);
      return Response.json({ ...await response.json() as object, name: `Revision ${revision}` });
    };
    const path = `${paths.metadata}?kind=artwork_receipt&displayId=222222`;
    const first = await f.request(path);
    assert.equal(first.response.status, 200);
    assert.equal(first.body.name, 'Revision 1');
    revision++;
    const second = await f.request(path);
    assert.equal(second.response.status, 200);
    assert.equal(second.body.name, 'Revision 2');
    assert.deepEqual(f.state.metadataRequests.map(request => request.url), [
      'https://cdn.mons.shop/111k-sepolia/1222222.json', 'https://cdn.mons.shop/111k-sepolia/1222222.json',
    ]);
    assert.equal((await f.request(`${paths.metadata}?kind=artwork_receipt&displayId=222223`)).response.status, 400);
    assert.equal((await f.request(`${paths.metadata}?kind=artwork&displayId=111112`)).response.status, 400);
  } finally { f.close(); }
});

test('all five metadata kinds preserve HTTPS images, empty descriptions and a single type attribute', async () => {
  const f = fixture();
  try {
    const kinds = ['artwork', 'warehouse', 'crate', 'crate_receipt', 'artwork_receipt'] as const;
    const metadata = kinds.map(kind => ({ name: `${kind} #1`, description: '',
      image: `https://future-cdn.example/${kind}.webp`, attributes: [{ trait_type: 'type', value: kind }] }));
    const infos = kinds.map(kind => ({ tokenId: ethereumMetadataTokenId(kind, 1), kind, displayId: 1, owner: WALLET }));
    for (const [index, info] of infos.entries()) {
      f.state.metadataValues.set(`${f.env.ETHEREUM_111K_METADATA_BASE_URI}${info.tokenId}.json`, metadata[index]);
      const result = await f.request(`${paths.metadata}?kind=${info.kind}&displayId=1`);
      assert.equal(result.response.status, 200);
      assert.deepEqual(result.body, metadata[index]);
    }
    const items = await ethereumInventoryItems(readContext(f), infos);
    assert.deepEqual(items.map(({ name, description, image, attributes }) => ({ name, description, image, attributes })), metadata);
  } finally { f.close(); }
});

test('artwork metadata preserves video playback and exact aspect ratios without unsafe media URLs', async () => {
  const f = fixture();
  try {
    const metadata = { name: '1', image: 'https://wip.lil.org/videos/1.webp',
      animation_url: 'https://wip.lil.org/videos/1.mp4', aspectRatio: { width: 16, height: 9 },
      category: 'video' as const, revealStatus: 'revealed' as const };
    f.state.metadataValues.set(`${f.env.ETHEREUM_111K_METADATA_BASE_URI}1.json`, metadata);
    const result = await f.request(`${paths.metadata}?kind=artwork&displayId=1`);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, metadata);
    const items = await ethereumInventoryItems(readContext(f), [{ tokenId: '1', kind: 'artwork', displayId: 1, owner: WALLET }]);
    assert.equal(items[0].animation_url, metadata.animation_url);
    assert.deepEqual(items[0].aspectRatio, metadata.aspectRatio);
    assert.equal(items[0].category, 'video');
    assert.equal(items[0].revealStatus, 'revealed');
    f.metadata.fetch = async () => Response.json({ ...metadata, animation_url: 'javascript:alert(1)',
      aspectRatio: { width: -1, height: 9 }, category: 'unknown', revealStatus: true });
    const unsafe = await f.request(`${paths.metadata}?kind=artwork&displayId=1`);
    assert.equal(unsafe.response.status, 200);
    assert.equal(unsafe.body.animation_url, undefined);
    assert.equal(unsafe.body.aspectRatio, undefined);
    assert.equal(unsafe.body.category, undefined);
    assert.equal(unsafe.body.revealStatus, undefined);
  } finally { f.close(); }
});

for (const uri of ['https://other.example/1.json', 'https://cdn.mons.shop/111k/1.json',
  'https://cdn.mons.shop/111k-sepolia/2.json', 'https://cdn.mons.shop/111k-sepolia/01.json',
  'https://cdn.mons.shop/111k-sepolia/1.json?version=2', 'data:application/json;base64,e30=']) {
  test(`offchain metadata rejects an unexpected token URL ${uri}`, async () => {
    const f = fixture();
    try {
      const providerFetch: typeof fetch = async (input, init) => {
        if (!init?.body) return f.providerFetch(input, init);
        const payload = JSON.parse(String(init?.body)) as Rpc | Rpc[];
        if (!Array.isArray(payload)) return f.providerFetch(input, init);
        return Response.json(payload.map(call => ({ jsonrpc: '2.0', id: call.id, result: encodeAbi(['string[]'], [[uri]]) })));
      };
      await assert.rejects(ethereumInventoryItems(readContext(f, providerFetch), [
        { tokenId: '1', kind: 'artwork', displayId: 1, owner: WALLET },
      ]), /Invalid Ethereum metadata URL/);
      assert.equal(f.state.metadataRequests.length, 0);
    } finally { f.close(); }
  });
}

for (const [name, response] of [
  ['redirect', () => new Response(null, { status: 302, headers: { Location: 'https://other.example/1.json' } })],
  ['missing', () => new Response(null, { status: 404 })],
  ['wrong content type', () => new Response('{}', { headers: { 'Content-Type': 'text/plain' } })],
  ['invalid JSON', () => new Response('{', { headers: { 'Content-Type': 'application/json' } })],
  ['oversized JSON', () => Response.json({ name: 'x'.repeat(128 * 1024), image: 'data:image/svg+xml;base64,AA==' })],
  ['invalid image', () => Response.json({ name: 'Artwork', image: 'javascript:alert(1)' })],
  ['HTTP image', () => Response.json({ name: 'Artwork', image: 'http://wip.lil.org/artwork.webp' })],
  ['image credentials', () => Response.json({ name: 'Artwork', image: 'https://user:password@wip.lil.org/artwork.webp' })],
] as const) {
  test(`offchain metadata fails closed for ${name}`, async () => {
    const f = fixture();
    try {
      f.metadata.fetch = async () => response();
      const result = await f.request(`${paths.metadata}?kind=artwork&displayId=1`);
      assert.equal(result.response.status, 503);
      assert.equal(result.body.image, undefined);
    } finally { f.close(); }
  });
}

test('offchain inventory metadata uses at most eight concurrent reads and preserves output order', { timeout: 5000 }, async t => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  try {
    const original = f.metadata.fetch;
    let started!: () => void;
    const eightStarted = new Promise<void>(resolve => { started = resolve; });
    let active = 0;
    let maximum = 0;
    let count = 0;
    f.metadata.fetch = async (input, init) => {
      active++;
      maximum = Math.max(maximum, active);
      if (++count === 8) started();
      try {
        await held;
        return await original(input, init);
      } finally { active--; }
    };
    const infos = Array.from({ length: 31 }, (_, index) => ({ tokenId: String(index + 1), kind: 'artwork' as const,
      displayId: index + 1, owner: WALLET }));
    f.state.metadataValues.set(`${f.env.ETHEREUM_111K_METADATA_BASE_URI}1.json`, { ...SYNTHETIC_METADATA, name: 'First concurrent response' });
    f.state.metadataValues.set(`${f.env.ETHEREUM_111K_METADATA_BASE_URI}31.json`, { ...SYNTHETIC_METADATA, name: 'Last concurrent response' });
    const pending = ethereumInventoryItems(readContext(f), infos);
    await eightStarted;
    assert.equal(count, 8);
    release();
    const items = await pending;
    assert.equal(maximum, 8);
    assert.equal(count, 31);
    assert.deepEqual(items.map(item => item.tokenId), infos.map(info => info.tokenId));
    assert.deepEqual(items.map(item => item.name), [
      'First concurrent response', ...Array(29).fill(SYNTHETIC_METADATA.name), 'Last concurrent response',
    ]);
  } finally { release(); f.close(); }
});

test('an offchain metadata failure cancels pending reads and returns no partial inventory', { timeout: 5000 }, async () => {
  const f = fixture();
  try {
    let reads = 0;
    let cancelled = false;
    f.metadata.fetch = async (_input, init) => {
      if (++reads !== 1) return new Response(null, { status: 503 });
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => { cancelled = true; reject(init!.signal!.reason); }, { once: true });
      });
    };
    const infos = Array.from({ length: 20 }, (_, index) => ({ tokenId: String(index + 1), kind: 'artwork' as const,
      displayId: index + 1, owner: WALLET }));
    await assert.rejects(ethereumInventoryItems(readContext(f), infos), /metadata is temporarily unavailable/);
    assert.equal(cancelled, true);
    assert.ok(reads <= 8);
  } finally { f.close(); }
});

test('offchain metadata HTTP reads stop when the request deadline expires', { timeout: 5000 }, async () => {
  const f = fixture();
  const controller = new AbortController();
  const reason = new DOMException('Request deadline expired', 'TimeoutError');
  let cancelled = false;
  try {
    f.metadata.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { cancelled = true; reject(init!.signal!.reason); }, { once: true });
    });
    const timer = setTimeout(() => controller.abort(reason), 25);
    try {
      await assert.rejects(ethereumInventoryItems({ ...readContext(f), signal: controller.signal }, [
        { tokenId: '1', kind: 'artwork', displayId: 1, owner: WALLET },
      ]), error => error === reason);
      assert.equal(cancelled, true);
    } finally { clearTimeout(timer); }
  } finally { f.close(); }
});

for (const token of [[0, 1, WALLET], [6, 1, WALLET], [1, 0, WALLET], [2, 5556, WALLET], [1, 1, ZERO]]) {
  test(`token information rejects an inconsistent tuple ${token.join(':')}`, async () => {
    const f = fixture();
    try {
      const providerFetch: typeof fetch = async (input, init) => {
        if (!init?.body) return f.providerFetch(input, init);
        const payload = JSON.parse(String(init?.body)) as Rpc | Rpc[];
        if (!Array.isArray(payload)) return f.providerFetch(input, init);
        return Response.json(payload.map(rpc => ({ jsonrpc: '2.0', id: rpc.id, result: encodeAbi(['(uint8,uint256,address)[]'], [[token]]) })));
      };
      await assert.rejects(ethereumTokenInfos(readContext(f, providerFetch), ['111112']), /Invalid Ethereum token information/);
    } finally { f.close(); }
  });
}

test('a later metadata envelope failure returns no partial inventory and cancels the other envelope', { timeout: 5000 }, async () => {
  const f = fixture();
  try {
    let envelopes = 0;
    let cancelled = false;
    let started!: () => void;
    const held = new Promise<void>(resolve => { started = resolve; });
    const providerFetch: typeof fetch = async (input, init) => {
      if (!init?.body) return f.providerFetch(input, init);
      const payload = JSON.parse(String(init?.body)) as Rpc | Rpc[];
      if (!Array.isArray(payload)) return f.providerFetch(input, init);
      if (++envelopes === 1) {
        started();
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => { cancelled = true; reject(init!.signal!.reason); }, { once: true });
        });
      }
      await held;
      return Response.json(payload.map(rpc => ({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'Metadata unavailable' } })));
    };
    const infos = Array.from({ length: 311 }, (_, index) => ({ tokenId: String(index + 1), kind: 'artwork' as const,
      displayId: index + 1, owner: WALLET }));
    await assert.rejects(ethereumInventoryItems(readContext(f, providerFetch), infos), /Ethereum RPC returned an invalid response/);
    assert.equal(envelopes, 2);
    assert.equal(cancelled, true);
  } finally { f.close(); }
});

test('contract read envelopes stay bounded and preserve order when concurrent responses arrive out of order', { timeout: 5000 }, async t => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  try {
    let active = 0;
    let maximum = 0;
    let envelopes = 0;
    let started!: () => void;
    const concurrent = new Promise<void>(resolve => { started = resolve; });
    const providerFetch: typeof fetch = async (input, init) => {
      if (!init?.body) return f.providerFetch(input, init);
      const payload = JSON.parse(String(init?.body)) as Rpc | Rpc[];
      if (!Array.isArray(payload)) return f.providerFetch(input, init);
      const envelope = ++envelopes;
      active++;
      maximum = Math.max(maximum, active);
      if (active === 2) started();
      if (envelope === 1) await held;
      try { return await f.providerFetch(input, init); }
      finally { active--; }
    };
    const calls = Array.from({ length: 13 }, (_, index) => encodeCall('previewTokenURI(uint8,uint256)', ['uint8', 'uint256'], [1, index + 1]));
    const pending = ethereumCallBatch(readContext(f, providerFetch), calls, '0x64');
    await concurrent;
    release();
    const values = await pending;
    assert.equal(maximum, 2);
    assert.deepEqual(f.state.batchSizes.slice().sort((a, b) => a - b), [1, 4, 4, 4]);
    assert.deepEqual(values.map(value => String(decodeReturn(['string'], value)[0])),
      calls.map((_call, index) => `${f.env.ETHEREUM_111K_METADATA_BASE_URI}${index + 1}.json`));
    assert.ok(f.state.calls.filter(call => call.method === 'eth_call').every(call => call.params[1] === '0x64'));
  } finally { release(); f.close(); }
});

for (const failure of ['missing-response', 'duplicate-id', 'unknown-id', 'rpc-error', 'invalid-result', 'oversized-response'] as const) {
  test(`contract read envelopes reject ${failure} without returning partial data`, async () => {
    const f = fixture();
    try {
      const providerFetch: typeof fetch = async (input, init) => {
        const response = await f.providerFetch(input, init);
        if (!init?.body) return response;
        const payload = JSON.parse(String(init?.body)) as Rpc | Rpc[];
        if (!Array.isArray(payload)) return response;
        const body = await response.json() as { id: number; result: string; error?: object }[];
        if (failure === 'missing-response') body.pop();
        if (failure === 'duplicate-id') body[0].id = body[1].id;
        if (failure === 'unknown-id') body[0].id = payload.length + 1;
        if (failure === 'rpc-error') body[0].error = { code: -32000, message: 'Read failed' };
        if (failure === 'invalid-result') body[0].result = '0xzz';
        if (failure === 'oversized-response') body[0].result = `0x${'00'.repeat(3 * 1024 * 1024 / 2)}`;
        return Response.json(body);
      };
      await assert.rejects(ethereumCallBatch(readContext(f, providerFetch), [
        encodeCall('getTokenInfos(uint256[])', ['uint256[]'], [['111112']]),
        encodeCall('getTokenInfos(uint256[])', ['uint256[]'], [['111113']]),
      ]), /Ethereum RPC returned an (?:incomplete|invalid) response/);
    } finally { f.close(); }
  });
}

for (const kind of ['token information', 'metadata'] as const) for (const extra of [false, true]) {
  test(`inventory rejects ${extra ? 'extra' : 'missing'} ${kind} rows instead of shifting identities`, async () => {
    const f = fixture();
    try {
      f.env.ETHEREUM_111K_CHAIN_ID = '11155111';
      f.state.alchemyNfts = ['111112', '111113'].map(tokenId => ({ tokenId, contract: { address: CONTRACT } }));
      const signature = kind === 'metadata' ? 'previewTokenURIs(uint8[],uint256[])' : 'getTokenInfos(uint256[])';
      const type = kind === 'metadata' ? 'string[]' : '(uint8,uint256,address)[]';
      const providerFetch: typeof fetch = async (input, init) => {
        const response = await f.providerFetch(input, init);
        if (!init?.body) return response;
        const payload = JSON.parse(String(init.body)) as Rpc | Rpc[];
        if (!Array.isArray(payload)) return response;
        const body = await response.json() as { id: number; result: string }[];
        for (const result of body) {
          const call = payload.find(entry => entry.id === result.id)!;
          if (!(call.params[0] as { data: string }).data.startsWith(functionSelector(signature))) continue;
          const [values] = decodeReturn([type], result.result) as [unknown[]];
          result.result = encodeAbi([type], [extra ? [...values, values[0]] : values.slice(1)]);
        }
        return Response.json(body);
      };
      const result = await f.request(`${paths.inventory}?owner=${WALLET}`, undefined, undefined, { fetch: providerFetch });
      assert.equal(result.response.status, 503);
      assert.equal(result.body.items, undefined);
    } finally { f.close(); }
  });
}

for (const chainId of [31337, 11155111]) {
  test(`${chainId} inventory reads 30 items in two contract calls pinned to the returned block`, async () => {
    const f = fixture();
    try {
      f.env.ETHEREUM_111K_CHAIN_ID = String(chainId);
      f.state.tokens.clear();
      const ids = Array.from({ length: 30 }, (_, index) => String(index + 1));
      for (const id of ids) {
        f.state.tokens.set(id, { kind: 1, displayId: Number(id), owner: WALLET });
        f.state.logs.push({ address: CONTRACT, topics: [ETHEREUM_EVENT_TOPICS.Transfer, topicAddress(ZERO), topicAddress(WALLET), topicNumber(id)],
          data: '0x', blockNumber: '0x64', blockHash: blockHash(100), transactionHash: HASH, logIndex: ethereumHexQuantity(id) });
      }
      f.state.alchemyNfts = ids.map(tokenId => ({ tokenId, contract: { address: CONTRACT } }));
      f.state.afterRpc = async call => { if (call.method === 'eth_call') f.state.head = 103; };
      const result = await f.request<{ items: { tokenId: string }[]; observedBlock: number }>(`${paths.inventory}?owner=${WALLET}`);
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      assert.deepEqual(result.body.items.map(item => item.tokenId), ids);
      assert.equal(result.body.observedBlock, 102);
      const reads = f.state.calls.filter(call => call.method === 'eth_call');
      assert.equal(reads.length, 2);
      assert.ok(reads.every(call => call.params[1] === blockHash(102)));
      assert.ok(f.state.calls.filter(call => call.method === 'eth_getLogs').every(call => (call.params[0] as { toBlock: string }).toBlock === '0x66'));
    } finally { f.close(); }
  });
}

for (const path of [paths.inventory, paths.transactionsConfirm]) {
  test(`${path} rejects a head reorg during metadata reads without returning a partial inventory`, async () => {
    const f = fixture();
    try {
      f.env.ETHEREUM_111K_CHAIN_ID = '11155111';
      f.state.alchemyNfts = [{ tokenId: '111112', contract: { address: CONTRACT } }];
      f.setReceipt(HASH, [{ address: CONTRACT,
        topics: [ETHEREUM_EVENT_TOPICS.Transfer, topicAddress(ZERO), topicAddress(WALLET), topicNumber('111112')],
        data: '0x', blockNumber: '0x64', blockHash: blockHash(100), transactionHash: HASH, logIndex: '0x0' }]);
      f.state.afterRpc = async call => {
        if (call.method === 'eth_call' && (call.params[0] as { data: string }).data.startsWith(functionSelector('previewTokenURIs(uint8[],uint256[])'))) {
          f.state.canonical.set(102, blockHash(999));
        }
      };
      const result = await f.request(path === paths.inventory ? `${path}?owner=${WALLET}` : path,
        path === paths.transactionsConfirm ? { transactionHash: HASH } : undefined);
      assert.equal(result.response.status, 503);
      assert.equal(result.body.items, undefined);
      assert.equal(result.body.status, undefined);
    } finally { f.close(); }
  });
}

test('inventory metadata remains coherent when an RPC pool serves another fork at the same block height', async () => {
  const f = fixture();
  try {
    f.env.ETHEREUM_111K_CHAIN_ID = '11155111';
    f.state.tokens.clear();
    const ids = Array.from({ length: 31 }, (_, index) => String(index + 1));
    for (const id of ids) f.state.tokens.set(id, { kind: 1, displayId: Number(id), owner: WALLET });
    f.state.alchemyNfts = ids.slice(0, 30).map(tokenId => ({ tokenId, contract: { address: CONTRACT } }));
    const providerFetch: typeof fetch = async (input, init) => {
      const response = await f.providerFetch(input, init);
      if (!init?.body) return response;
      const payload = JSON.parse(String(init.body)) as Rpc | Rpc[];
      if (!Array.isArray(payload)) return response;
      const body = await response.json() as { id: number; result: string }[];
      for (const result of body) {
        const call = payload.find(entry => entry.id === result.id)!;
        const data = (call.params[0] as { data: string }).data;
        if (!data.startsWith(functionSelector('previewTokenURIs(uint8[],uint256[])'))) continue;
        const [, displayIds] = decodeReturn(['uint8[]', 'uint256[]'], `0x${data.slice(10)}`) as [bigint[], bigint[]];
        if (displayIds[0] !== 31n || call.params[1] === blockHash(102)) continue;
        const [uris] = decodeReturn(['string[]'], result.result) as [string[]];
        result.result = encodeAbi(['string[]'], [[uris[0].replace('/31.json', '/32.json')]]);
      }
      return Response.json(body);
    };
    const result = await f.request<{ items: EthereumInventoryItem[]; observedBlock: number }>(
      `${paths.inventory}?owner=${WALLET}&expectedTokenIds=31`, undefined, undefined, { fetch: providerFetch });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.observedBlock, 102);
    assert.deepEqual(result.body.items.map(item => item.displayId), ids.map(Number));
    const reads = f.state.calls.filter(call => call.method === 'eth_call');
    assert.equal(reads.length, 3);
    assert.ok(reads.every(call => call.params[1] === blockHash(102)));
    assert.equal(f.state.calls.filter(call => call.method === 'eth_getBlockByNumber' && call.params[0] === '0x66').length, 1);
  } finally { f.close(); }
});

test('public transaction confirmation rechecks its receipt block after reading current metadata', async () => {
  const f = fixture();
  try {
    f.setReceipt(HASH, [{ address: CONTRACT,
      topics: [ETHEREUM_EVENT_TOPICS.Transfer, topicAddress(ZERO), topicAddress(WALLET), topicNumber('111112')],
      data: '0x', blockNumber: '0x64', blockHash: blockHash(100), transactionHash: HASH, logIndex: '0x0' }]);
    f.state.afterRpc = async call => {
      if (call.method === 'eth_call' && (call.params[0] as { data: string }).data.startsWith(functionSelector('previewTokenURIs(uint8[],uint256[])'))) {
        f.state.canonical.set(100, blockHash(999));
      }
    };
    const result = await f.request(paths.transactionsConfirm, { transactionHash: HASH });
    assert.equal(result.response.status, 503);
    assert.equal(result.body.items, undefined);
    assert.equal(f.state.calls.filter(call => call.method === 'eth_getBlockByNumber' && call.params[0] === '0x64').length, 2);
  } finally { f.close(); }
});

for (const count of [311, 620]) {
  test(`public transaction confirmation keeps all ${count} minted items across bounded contract reads`, async () => {
    const f = fixture();
    try {
      f.state.tokens.clear();
      const ids = Array.from({ length: count }, (_, index) => String(index + 1));
      const logs = ids.map((id, index): EthereumLog => {
        f.state.tokens.set(id, { kind: 1, displayId: index + 1, owner: WALLET });
        return { address: CONTRACT,
          topics: [ETHEREUM_EVENT_TOPICS.Transfer, topicAddress(ZERO), topicAddress(WALLET), topicNumber(id)],
          data: '0x', blockNumber: '0x64', blockHash: blockHash(100), transactionHash: HASH, logIndex: ethereumHexQuantity(index) };
      });
      f.setReceipt(HASH, logs);
      const result = await f.request<{ status: string; items: EthereumInventoryItem[] }>(paths.transactionsConfirm, { transactionHash: HASH });
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.status, 'confirmed');
      assert.deepEqual(result.body.items.map(item => item.tokenId), ids);
      assert.deepEqual(result.body.items.map(item => item.displayId), ids.map(Number));
      const reads = f.state.calls.filter(call => call.method === 'eth_call');
      assert.equal(reads.length, Math.ceil(count / 150) + Math.ceil(count / 30));
      assert.ok(reads.every(call => call.params[1] === blockHash(102)));
      assert.ok(f.state.batchSizes.every(size => size <= 4));
    } finally { f.close(); }
  });
}

test('bundled transactions confirm more than 150 minted items with complete metadata', async () => {
  const f = fixture();
  try {
    const minted = Array.from({ length: 165 }, (_, index) => String(111112 + index));
    const burned = Array.from({ length: 15 }, (_, index) => String(116667 + index));
    f.state.tokens.clear();
    minted.forEach((tokenId, index) => f.state.tokens.set(tokenId, { kind: 2, displayId: index + 1, owner: WALLET }));
    const logs = [...burned, ...minted].map((tokenId, index): EthereumLog => ({
      address: CONTRACT,
      topics: [ETHEREUM_EVENT_TOPICS.Transfer, topicAddress(index < burned.length ? WALLET : ZERO),
        topicAddress(index < burned.length ? ZERO : WALLET), topicNumber(tokenId)],
      data: '0x', blockNumber: '0x64', blockHash: blockHash(100), transactionHash: HASH,
      logIndex: ethereumHexQuantity(index),
    }));
    f.setReceipt(HASH, logs);
    const result = await f.request<{ status: string; items: EthereumInventoryItem[]; burnedTokenIds: string[] }>(
      paths.transactionsConfirm, { transactionHash: HASH });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.status, 'confirmed');
    assert.deepEqual(result.body.items.map(item => item.tokenId), minted);
    assert.deepEqual(result.body.items.map(item => item.displayId), minted.map((_tokenId, index) => index + 1));
    assert.ok(result.body.items.every(item => item.owner === WALLET && item.kind === 'crate' &&
      item.image.startsWith('data:image/svg+xml;base64,')));
    assert.deepEqual(result.body.burnedTokenIds, burned);
    assert.deepEqual(f.state.batchSizes, [2, 4, 2]);
  } finally { f.close(); }
});

test('local inventory recovers expected IDs at its captured hash when log discovery briefly sees another fork', async () => {
  const f = fixture();
  try {
    f.state.tokens.clear();
    const discovered = Array.from({ length: 31 }, (_, index) => String(index + 1));
    const all = [...discovered, '40', '41', '42'];
    for (const id of all) {
      if (id !== '42') f.state.tokens.set(id, { kind: 1, displayId: Number(id), owner: id === '41' ? OTHER_WALLET : WALLET });
      f.state.logs.push({ address: CONTRACT,
        topics: [ETHEREUM_EVENT_TOPICS.Transfer, topicAddress(ZERO), topicAddress(WALLET), topicNumber(id)],
        data: '0x', blockNumber: discovered.includes(id) ? '0x64' : '0x66',
        blockHash: blockHash(discovered.includes(id) ? 100 : 102), transactionHash: HASH, logIndex: ethereumHexQuantity(id) });
    }
    let omitted = false;
    const providerFetch: typeof fetch = async (input, init) => {
      if (!init?.body) return f.providerFetch(input, init);
      const payload = JSON.parse(String(init?.body)) as Rpc | Rpc[];
      if (!Array.isArray(payload) && payload.method === 'eth_getLogs' && !omitted) {
        omitted = true;
        f.state.canonical.set(102, blockHash(999));
        const response = await f.providerFetch(input, init);
        const body = await response.json() as { result: EthereumLog[] };
        body.result = body.result.filter(log => BigInt(log.topics[3]) <= 31n);
        f.state.canonical.set(102, blockHash(102));
        return Response.json(body);
      }
      return f.providerFetch(input, init);
    };
    type Page = { items: EthereumInventoryItem[]; nextCursor: string | null; observedBlock: number };
    const first = await f.request<Page>(`${paths.inventory}?owner=${WALLET}&expectedTokenIds=1,31,40,41,42,40`,
      undefined, undefined, { fetch: providerFetch });
    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    assert.equal(omitted, true);
    assert.deepEqual(first.body.items.map(item => item.tokenId), [...discovered, '40']);
    assert.ok(first.body.items.every(item => item.owner === WALLET));
    assert.equal(new Set(first.body.items.map(item => item.tokenId)).size, first.body.items.length);
    assert.equal(first.body.nextCursor, '30');
    assert.equal(first.body.observedBlock, 102);
    const reads = f.state.calls.filter(call => call.method === 'eth_call');
    const infoReads = reads.filter(call => (call.params[0] as { data: string }).data.startsWith(functionSelector('getTokenInfos(uint256[])')));
    assert.deepEqual(infoReads.map(call => (decodeReturn(['uint256[]'], `0x${(call.params[0] as { data: string }).data.slice(10)}`)[0] as bigint[]).map(String)),
      [discovered, ['40', '41', '42']]);
    assert.ok(reads.every(call => call.params[1] === blockHash(102)));
    const next = await f.request<Page>(`${paths.inventory}?owner=${WALLET}&cursor=30`, undefined, undefined, { fetch: providerFetch });
    assert.equal(next.response.status, 200, JSON.stringify(next.body));
    assert.deepEqual(next.body.items.map(item => item.tokenId), ['31', '40']);
    assert.equal(next.body.nextCursor, null);
  } finally { f.close(); }
});

test('local inventory reuses discovered expected IDs without extra ownership calls or changing pagination', async () => {
  const f = fixture();
  try {
    f.state.tokens.clear();
    const ids = Array.from({ length: 35 }, (_, index) => String(index + 1));
    for (const id of ids) {
      f.state.tokens.set(id, { kind: 1, displayId: Number(id), owner: WALLET });
      f.state.logs.push({ address: CONTRACT,
        topics: [ETHEREUM_EVENT_TOPICS.Transfer, topicAddress(ZERO), topicAddress(WALLET), topicNumber(id)],
        data: '0x', blockNumber: '0x64', blockHash: blockHash(100), transactionHash: HASH, logIndex: ethereumHexQuantity(id) });
    }
    type Page = { items: EthereumInventoryItem[]; nextCursor: string | null };
    const first = await f.request<Page>(`${paths.inventory}?owner=${WALLET}&expectedTokenIds=31,1,31`);
    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.items.map(item => item.tokenId), ids.slice(0, 31));
    assert.equal(first.body.nextCursor, '30');
    const infoReads = () => f.state.calls.filter(call => call.method === 'eth_call' &&
      (call.params[0] as { data: string }).data.startsWith(functionSelector('getTokenInfos(uint256[])')));
    assert.equal(infoReads().length, 1);
    assert.deepEqual((decodeReturn(['uint256[]'], `0x${(infoReads()[0].params[0] as { data: string }).data.slice(10)}`)[0] as bigint[]).map(String), ids);
    const next = await f.request<Page>(`${paths.inventory}?owner=${WALLET}&cursor=30&expectedTokenIds=1`);
    assert.equal(next.response.status, 200, JSON.stringify(next.body));
    assert.deepEqual(next.body.items.map(item => item.tokenId), ids.slice(30));
    assert.equal(next.body.nextCursor, null);
    assert.equal(infoReads().length, 2);
  } finally { f.close(); }
});

test('local inventory paginates current holdings after burned and transferred tokens, including histories over 150 tokens', async () => {
  for (const [burned, transferred, owned] of [[30, 0, 10], [151, 5, 35]]) {
    const f = fixture();
    try {
      f.state.tokens.clear();
      for (let id = 1; id <= burned + transferred + owned; id++) {
        f.state.logs.push({ address: CONTRACT, topics: [
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          topicAddress(ZERO), topicAddress(WALLET), topicNumber(id),
        ], data: '0x', blockNumber: '0x64', blockHash: blockHash(100), transactionHash: HASH, logIndex: ethereumHexQuantity(id) });
        if (id > burned) f.state.tokens.set(String(id), { kind: 1, displayId: id,
          owner: id <= burned + transferred ? OTHER_WALLET : WALLET });
      }
      const expected = Array.from({ length: owned }, (_, index) => String(burned + transferred + index + 1));
      type Page = { items: { tokenId: string; owner: string }[]; nextCursor: string | null };
      const first = await f.request<Page>(`${paths.inventory}?owner=${WALLET}`);
      assert.equal(first.response.status, 200, JSON.stringify(first.body));
      assert.deepEqual(first.body.items.map(item => item.tokenId), expected.slice(0, 30));
      assert.ok(first.body.items.every(item => item.owner === WALLET));
      assert.equal(first.body.nextCursor, owned > 30 ? '30' : null);
      if (first.body.nextCursor) {
        const next = await f.request<Page>(`${paths.inventory}?owner=${WALLET}&cursor=${first.body.nextCursor}`);
        assert.equal(next.response.status, 200, JSON.stringify(next.body));
        assert.deepEqual(next.body.items.map(item => item.tokenId), expected.slice(30));
        assert.equal(next.body.nextCursor, null);
      }
    } finally { f.close(); }
  }
});

test('Sepolia inventory is contract scoped and verifies current ownership, including recent IDs and delayed indexers', async () => {
  const f = fixture();
  try {
    f.env.ETHEREUM_111K_CHAIN_ID = '11155111';
    f.state.alchemyNfts = [{ tokenId: '111112', contract: { address: CONTRACT } }, { tokenId: '111113', contract: { address: CONTRACT } }];
    f.state.tokens.get('111113')!.owner = OTHER_WALLET;
    const result = await f.request<{ items: { tokenId: string; owner: string; contractAddress: string }[] }>(
      `${paths.inventory}?owner=${WALLET}&expectedTokenIds=7`);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.items.map(item => item.tokenId), ['111112', '7']);
    assert.ok(result.body.items.every(item => item.owner === WALLET && item.contractAddress === CONTRACT));
    const url = new URL(f.state.urls.find(value => value.includes('/getNFTsForOwner'))!);
    assert.equal(url.searchParams.get('contractAddresses[]'), CONTRACT);
    assert.equal(url.searchParams.get('owner'), WALLET);
    f.state.alchemyNfts = [{ tokenId: '111112', contract: { address: OTHER_CONTRACT } }];
    assert.equal((await f.request(`${paths.inventory}?owner=${WALLET}`)).response.status, 503);
    f.state.alchemyNfts = [];
    f.state.alchemyCursor = 'same';
    assert.equal((await f.request(`${paths.inventory}?owner=${WALLET}&cursor=same`)).response.status, 503);
  } finally { f.close(); }
});

test('RPC network mismatches fail closed before contract reads or authorization preparation', async () => {
  const f = fixture();
  try {
    const session = await f.session();
    await f.saveAddress(session.token);
    f.state.rpcChainId = 1;
    const stats = await f.request(paths.stats);
    assert.equal(stats.response.status, 503);
    assert.deepEqual(f.state.calls.map(call => call.method), ['eth_chainId']);
    const prepared = await f.request(paths.deliveryPrepare,
      { tokenIds: ['111112'], addressId: ADDRESS_ID, requestId: REQUEST_ID }, session.token);
    assert.equal(prepared.response.status, 503);
    assert.equal(prepared.body.signature, undefined);
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_delivery_quotes').get()!.n, 0);
  } finally { f.close(); }
});

test('parallel receipt reads cannot confirm a delivery from the wrong network', async () => {
  const f = fixture();
  try {
    const { authentication, prepared } = await f.prepared();
    const original = f.quoteRow(prepared.orderId);
    f.setReceipt(HASH, [f.deliveryLog(prepared)]);
    f.state.rpcChainId = 1;
    f.state.calls.length = 0;
    const result = await f.request(paths.deliveryConfirm,
      { orderId: prepared.orderId, transactionHash: HASH }, authentication.token);
    assert.equal(result.response.status, 503);
    assert.deepEqual(f.state.calls.map(call => call.method).sort(), ['eth_chainId', 'eth_getTransactionReceipt']);
    assert.deepEqual(f.quoteRow(prepared.orderId), original);
    assert.equal(f.order(prepared.orderId), null);
  } finally { f.close(); }
});

test('physical crate 5555 requires all 31 receipt identities and never exposes its code in customer shipment summaries', async () => {
  const f = fixture();
  try {
    f.state.tokens.set('116666', { kind: 2, displayId: 5555, owner: WALLET });
    const { authentication, prepared: delivery } = await f.prepared(['116666']);
    f.setReceipt(HASH, [f.deliveryLog(delivery, ['116666'], ['2005555'])]);
    const confirmed = await f.request(paths.deliveryConfirm,
      { orderId: delivery.orderId, transactionHash: HASH }, authentication.token);
    assert.equal(confirmed.response.status, 200);
    f.state.tokens.set('2005555', { kind: 5, displayId: 5555, owner: WALLET });
    const code = String(f.claimRow('2005555').code);
    const shipments = await f.request(paths.shipments, undefined, authentication.token);
    assert.equal(shipments.response.status, 200);
    assert.ok(!JSON.stringify(shipments.body).includes(code));
    const prepared = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare,
      { receiptId: '2005555', code }, authentication.token);
    assert.equal(prepared.response.status, 200);
    const receiptIds = physicalCrateArtworkIds(5555).map(id => String(1_000_000 + id));
    assert.equal(receiptIds.length, 31);
    const input = { claimId: prepared.body.claimId, transactionHash: CLAIM_HASH };
    f.setReceipt(CLAIM_HASH, [f.claimLog(prepared.body, receiptIds.slice(0, 20))]);
    assert.equal((await f.request(paths.claimConfirm, input, authentication.token)).response.status, 403);
    assert.equal(f.claimRow('2005555').status, 'available');
    f.setReceipt(CLAIM_HASH, [f.claimLog(prepared.body, receiptIds)]);
    assert.equal((await f.request(paths.claimConfirm, input, authentication.token)).body.status, 'confirmed');
    assert.equal(f.claimRow('2005555').status, 'claimed');
    assert.deepEqual((f.order(delivery.orderId)!.irlClaims as Record<string, unknown>[])[0].dudeIds, physicalCrateArtworkIds(5555));
  } finally { f.close(); }
});

test('Ethereum test deliveries cannot create paid shipping labels or buyer and shipper email jobs', async () => {
  const f = fixture();
  try {
    const { prepared } = await f.confirmed();
    const order = f.order(prepared.orderId)!;
    assert.throws(() => requireShipStationEnabled('111k_devnet'), /disabled/i);
    assert.doesNotThrow(() => requireShipStationEnabled('card_nft_2'));
    assert.deepEqual(planReadyToShipNotifications({ before: { status: 'processing' }, after: order,
      deliveryId: prepared.orderId, dropId: '111k_devnet', nowMs: NOW }), []);
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM commerce_notification_outbox').get()!.n, 0);
  } finally { f.close(); }
});

async function orphanClaimWithRecentDeliveries(f: ReturnType<typeof fixture>, count: number) {
  const claimed = await confirmedCrateClaim(f);
  f.state.receipts.delete(CLAIM_HASH);
  f.state.canonical.set(200, blockHash(10200));
  f.state.logs = f.state.logs.filter(log => log.transactionHash !== CLAIM_HASH);
  f.state.head = 203;
  f.commerce.database.prepare('UPDATE ethereum_delivery_quotes SET verified_at_block = 1000').run();
  f.state.tokens.set('2000001', { kind: 5, displayId: 1, owner: WALLET });
  const deliveries: string[] = [];
  for (let index = 0; index < count; index++) {
    const tokenId = String(500 + index);
    f.state.tokens.set(tokenId, { kind: 1, displayId: 500 + index, owner: WALLET });
    const delivery = await f.prepared([tokenId], crypto.randomUUID());
    const hash = blockHash(50000 + index);
    const log = { ...f.deliveryLog(delivery.prepared, [tokenId], [String(1000500 + index)], hash),
      blockNumber: '0xc9', blockHash: blockHash(201), logIndex: ethereumHexQuantity(index + 1) };
    f.setReceipt(hash, [log], 201);
    f.state.logs.push(log);
    assert.equal((await f.request(paths.deliveryConfirm,
      { orderId: delivery.prepared.orderId, transactionHash: hash }, delivery.authentication.token)).body.status, 'confirmed');
    deliveries.push(hash);
  }
  return { claimed, deliveries };
}

test('slow delivery backlogs leave time for orphaned claims and event discovery', async context => {
  const f = fixture();
  try {
    const { claimed, deliveries } = await orphanClaimWithRecentDeliveries(f, 6);
    context.mock.timers.enable({ apis: ['setTimeout'] });
    f.state.afterRpc = async rpc => {
      if (rpc.method === 'eth_getTransactionReceipt' && deliveries.includes(String(rpc.params[0]))) context.mock.timers.tick(8000);
    };
    for (let run = 0; run < 3; run++) {
      f.state.calls.length = 0;
      f.databaseCalls.statements = 0;
      const result = await reconcileEthereum111k(f.env, new AbortController().signal, { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.equal(f.claimRow().status, 'available');
      assert.equal((f.order(claimed.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'available');
      assert.equal(result.failed, 0);
      assert.ok(f.state.calls.some(rpc => rpc.method === 'eth_getLogs'));
      assert.ok(f.databaseCalls.statements <= 400);
      f.state.now += 300000;
      f.state.head += 25;
    }
    assert.equal((await f.request(paths.claimPrepare,
      { receiptId: '2000001', code: f.claimRow().code }, claimed.authentication.token)).response.status, 200);
  } finally { f.close(); }
});

for (const oldReceipt of ['missing', 'reverted', 'noncanonical'] as const) test(`both recent phases finish with ${oldReceipt} claim receipts when each RPC takes eight seconds`, async context => {
  const f = fixture();
  const parent = new AbortController();
  try {
    const { claimed } = await orphanClaimWithRecentDeliveries(f, 1);
    if (oldReceipt === 'reverted') {
      f.setReceipt(CLAIM_HASH, [], 201);
      f.state.receipts.get(CLAIM_HASH)!.status = '0x0';
    } else if (oldReceipt === 'noncanonical') {
      f.setReceipt(CLAIM_HASH, [claimed.log], 200);
    }
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const slowFetch: typeof fetch = async (input, init) => {
      const signal = init?.signal;
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 8000);
        const abort = () => { clearTimeout(timer); reject(signal?.reason); };
        signal?.addEventListener('abort', abort, { once: true });
      });
      return f.providerFetch(input, init);
    };
    let settled = false;
    const completion = reconcileEthereum111k(f.env, parent.signal, { fetch: slowFetch, nowMs: () => f.state.now })
      .then(result => ({ result }), error => ({ error })).finally(() => { settled = true; });
    for (let step = 0; step < 7 && !settled; step++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      context.mock.timers.tick(8000);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (!settled) parent.abort(new Error('Reconciliation exceeded the scheduled deadline'));
    const outcome = await completion;
    if ('error' in outcome) throw outcome.error;
    assert.equal(outcome.result.failed, 0);
    assert.equal(outcome.result.deferred, 0);
    assert.equal(outcome.result.stopReason, undefined);
    assert.equal(f.claimRow().status, 'available');
    assert.equal((f.order(claimed.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'available');
    assert.ok(f.state.calls.some(rpc => rpc.method === 'eth_getLogs'));
    assert.equal((await f.request(paths.claimPrepare,
      { receiptId: '2000001', code: f.claimRow().code }, claimed.authentication.token)).response.status, 200);
  } finally { parent.abort(); f.close(); }
});

test('recent delivery and claim reconciliation reuse their verified receipts', async () => {
  const f = fixture();
  try {
    const delivery = await f.confirmed();
    const prepared = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare,
      { receiptId: '2000001', code: f.claimRow().code }, delivery.authentication.token);
    assert.equal(prepared.response.status, 200);
    const log = f.claimLog(prepared.body);
    f.setReceipt(CLAIM_HASH, [log]);
    f.state.logs.push(log);
    assert.equal((await f.request(paths.claimConfirm,
      { claimId: prepared.body.claimId, transactionHash: CLAIM_HASH }, delivery.authentication.token)).body.status, 'confirmed');
    f.state.calls.length = 0;
    let recentCalls: typeof f.state.calls = [];
    f.state.afterRpc = async rpc => {
      if (rpc.method === 'eth_getLogs') recentCalls = [...f.state.calls];
    };
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    for (const hash of [HASH, CLAIM_HASH]) {
      assert.equal(recentCalls.filter(call => call.method === 'eth_getTransactionReceipt' && call.params[0] === hash).length, 1);
    }
    assert.equal(recentCalls.filter(call => call.method === 'eth_blockNumber').length, 3);
    assert.equal(recentCalls.filter(call => call.method === 'eth_getBlockByNumber').length, 2);
    assert.equal(f.quoteRow(delivery.prepared.orderId).verified_at_block, f.state.head);
    assert.equal(f.claimRow().verified_at_block, f.state.head);
  } finally { f.close(); }
});

for (const slowMethod of ['eth_blockNumber', 'eth_getTransactionReceipt']) {
  test(`recent reconciliation timing out during ${slowMethod} leaves discovery active`, async (context) => {
    const f = fixture();
    try {
      await f.confirmed();
      const next = await f.prepared(['7'], '10000000-0000-4000-8000-000000000002');
      const nextHash = `0x${'cc'.repeat(32)}`;
      const log = { ...f.deliveryLog(next.prepared, ['7'], ['1000007'], nextHash), logIndex: '0x1' };
      f.setReceipt(nextHash, [log]);
      f.state.logs.push(log);
      const parent = new AbortController();
      context.mock.timers.enable({ apis: ['setTimeout'] });
      f.state.afterRpc = async (rpc) => {
        if (rpc.method !== slowMethod) return;
        f.state.afterRpc = null;
        context.mock.timers.tick(30_000);
      };
      f.state.calls.length = 0;
      const result = await reconcileEthereum111k(f.env, parent.signal, { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.equal(parent.signal.aborted, false);
      assert.equal(result.stopReason, 'time-limit');
      assert.equal(result.hasMore, true);
      assert.equal(result.failed, 0);
      assert.equal(result.deferred, 1);
      assert.equal(f.state.calls.filter(call => call.method === 'eth_getLogs').length, 1);
      assert.equal(f.order(next.prepared.orderId)!.status, 'ready_to_ship');
      assert.equal(f.commerce.database.prepare('SELECT next_block FROM ethereum_reconciliation_cursor').get()!.next_block, f.state.head + 1);
    } finally { f.close(); }
  });
}

for (const kind of ['delivery', 'claim']) {
  test(`reused ${kind} receipts cannot overwrite a newer canonical confirmation`, async () => {
    const f = fixture();
    try {
      const delivery = await f.confirmed();
      let path: string = paths.deliveryConfirm;
      let input: { transactionHash: string; orderId?: number; claimId?: string } = {
        orderId: delivery.prepared.orderId, transactionHash: HASH,
      };
      if (kind === 'claim') {
        const prepared = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare,
          { receiptId: '2000001', code: f.claimRow().code }, delivery.authentication.token);
        assert.equal(prepared.response.status, 200);
        f.setReceipt(CLAIM_HASH, [f.claimLog(prepared.body)]);
        path = paths.claimConfirm;
        input = { claimId: prepared.body.claimId, transactionHash: CLAIM_HASH };
        assert.equal((await f.request(path, input, delivery.authentication.token)).body.status, 'confirmed');
        f.commerce.database.prepare('UPDATE ethereum_delivery_quotes SET verified_at_block = 1000').run();
      }
      const barrier = pauseRpc(f, rpc => rpc.method === 'eth_getBlockByNumber' && rpc.params[0] === '0x64');
      const pending = reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      await barrier.paused;
      const log = { ...f.state.receipts.get(input.transactionHash)!.logs[0], blockNumber: '0x65', blockHash: blockHash(101) };
      f.setReceipt(input.transactionHash, [log], 101);
      f.state.canonical.set(100, blockHash(999));
      f.state.head = 103;
      f.state.logs = [];
      assert.equal((await f.request(path, input, delivery.authentication.token)).body.status, 'confirmed');
      const current = kind === 'delivery' ? f.quoteRow(delivery.prepared.orderId) : f.claimRow();
      barrier.resume();
      await pending;
      assert.deepEqual(kind === 'delivery' ? f.quoteRow(delivery.prepared.orderId) : f.claimRow(), current);
    } finally { f.close(); }
  });
}
