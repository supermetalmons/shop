import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED, BOX_MINTER_CONFIG_DISCRIMINATOR } from '../../../../shared/boxMinterConfigCodec.ts';
import { MPL_CORE_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.ts';
import { commerceKeys, D1CommerceRepository } from '../src/commerceRepository.ts';
import { runtimeForDrop } from '../src/stripeReceiptClaimOnchain.ts';
import { reserveReceiptClaimWorkflow } from '../src/stripeReceiptClaimWorkflowStore.ts';
import { createCommerceD1Harness, seedCommerceDocument } from '../test/commerceD1Harness.ts';

const CODE = 'ABCDEF-1234567890';
const CLAIMED_CODE = 'ABCDEF-1234567891';
const RECIPIENT = new PublicKey(new Uint8Array(32).fill(2)).toBase58();
const ADMIN = new PublicKey(new Uint8Array(32).fill(3));
const PACK = new PublicKey(new Uint8Array(32).fill(4)).toBase58();
const HASH = bs58.encode(new Uint8Array(32).fill(5));
const FIGURES = [19, 20, 21];

function configAccounts(runtime: ReturnType<typeof runtimeForDrop>) {
  const integer = (value: number, bytes: 4 | 8) => {
    const buffer = Buffer.alloc(bytes);
    if (bytes === 4) buffer.writeUInt32LE(value);
    else buffer.writeBigUInt64LE(BigInt(value));
    return buffer;
  };
  const string = (value: string) => Buffer.concat([integer(Buffer.byteLength(value), 4), Buffer.from(value)]);
  const payload = Buffer.concat([
    Buffer.from(BOX_MINTER_CONFIG_DISCRIMINATOR), ADMIN.toBuffer(), new PublicKey(runtime.config.treasury).toBuffer(),
    runtime.collectionMint.toBuffer(), integer(1, 8), integer(1, 8), Buffer.alloc(32), integer(runtime.maxSupply, 4),
    Buffer.from([runtime.config.maxPerTx, runtime.itemsPerBox]), integer(0, 4), string(runtime.config.namePrefix),
    string(runtime.config.symbol), string(runtime.config.metadataBase), Buffer.from([1, 1, runtime.config.discountMintsPerWallet]),
    string(runtime.config.figureNamePrefix), Buffer.alloc(37),
  ]);
  const collection = Buffer.alloc(49);
  collection[0] = 5;
  return [
    { data: [collection.toString('base64'), 'base64'], owner: MPL_CORE_PROGRAM_ADDRESS, executable: false, lamports: 1, rentEpoch: 0 },
    { data: [Buffer.concat([payload, Buffer.alloc(BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED - payload.length)]).toString('base64'), 'base64'],
      owner: runtime.boxMinterProgramId.toBase58(), executable: false, lamports: 1, rentEpoch: 0 },
  ];
}

test('receipt claims use native Workerd fetch for DAS, web3 reads, and completed-claim enrichment', { timeout: 60_000 }, async (t) => {
  const require = createRequire(import.meta.url);
  const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
  const { build } = wranglerRequire('esbuild');
  const { Miniflare, Response: OutboundResponse } = wranglerRequire('miniflare');
  const runtime = runtimeForDrop('card_nft_2');
  const harness = createCommerceD1Harness();
  const nowMs = Date.now();
  const irlClaims = [{ boxId: 7, boxAssetId: PACK, dudeIds: FIGURES }];
  const claim = {
    namespace: 'stripe_receipt_v1', code: CODE, dropId: 'card_nft_2', deliveryId: 3, boxId: 7,
    status: 'processing', recipient: RECIPIENT, processingStartedAt: nowMs - 600_000, processingLeaseExpiresAt: nowMs - 500_000,
  };
  seedCommerceDocument(harness, { key: commerceKeys.claimCode(CODE), data: claim });
  seedCommerceDocument(harness, { key: commerceKeys.claimCode(CLAIMED_CODE), data: { ...claim, code: CLAIMED_CODE, status: 'claimed' } });
  seedCommerceDocument(harness, { key: commerceKeys.deliveryOrder('card_nft_2', '3'), data: {
    dropId: 'card_nft_2', deliveryId: 3, source: 'stripe_offchain', stripeReceiptClaim: claim, irlClaims,
  } });
  const reserved = await reserveReceiptClaimWorkflow({ repository: new D1CommerceRepository(harness.db), nowMs,
    signal: AbortSignal.timeout(10_000) }, CODE, RECIPIENT, nowMs);
  assert.equal(reserved.status, 'pending');
  if (reserved.status !== 'pending') throw new Error('Missing local receipt operation');
  const operationId = reserved.snapshot.operation.operationId;
  const tables = ['commerce_authority_control', 'commerce_documents', 'commerce_document_path_revisions',
    'commerce_delivery_owner_revisions', 'commerce_stripe_checkout_state', 'commerce_stripe_checkout_state_control'];
  const definitions = tables.map((name) => String(harness.database.prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?').get('table', name)?.sql));
  definitions.push(String(harness.database.prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?')
    .get('index', 'commerce_receipt_claim_workflow_operation')?.sql));
  const seededTables = tables.map((name) => ({ name, rows: harness.database.prepare(`SELECT * FROM ${name}`).all() }));
  harness.database.close();

  const calls: string[] = [];
  const providerErrors: unknown[] = [];
  let ownedByRecipient = false;
  const asset = (id: string, reference: string, owner: string) => ({
    id, grouping: [{ group_key: 'collection', group_value: runtime.collectionMint.toBase58() }],
    content: { json_uri: `${runtime.config.metadataBase}/${reference}.json` }, ownership: { owner },
    compression: { leaf_id: 4, data_hash: HASH, creator_hash: HASH },
  });
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: unknown; method: string };
      calls.push(body.method);
      assert.ok(['searchAssets', 'getMultipleAccounts', 'getAsset', 'getAssetProof'].includes(body.method), 'Only read-only RPC is permitted');
      const result = body.method === 'searchAssets'
        ? { total: ownedByRecipient ? 3 : 0, limit: 1000, page: 1, items: ownedByRecipient
          ? FIGURES.map((id) => asset(new PublicKey(new Uint8Array(32).fill(id)).toBase58(), `rf${id}`, RECIPIENT)) : [] }
        : body.method === 'getMultipleAccounts' ? { context: { slot: 1 }, value: configAccounts(runtime) }
          : body.method === 'getAsset' ? asset(PACK, 'rb7', ADMIN.toBase58())
            : { tree_id: runtime.receiptsMerkleTree.toBase58(), root: HASH, proof: [] };
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    } catch (error) {
      providerErrors.push(error);
      response.writeHead(500);
      response.end('invalid test RPC');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const providerUrl = `http://127.0.0.1:${address.port}`;
  const source = `
    import { D1CommerceRepository } from ${JSON.stringify(resolve('cloud/workers/api/src/commerceRepository.ts'))};
    import { loadReceiptClaimWorkflow } from ${JSON.stringify(resolve('cloud/workers/api/src/stripeReceiptClaimWorkflowStore.ts'))};
    import { reconcileReceiptClaimWorkflowOnchain } from ${JSON.stringify(resolve('cloud/workers/api/src/stripeReceiptClaimWorkflowOnchain.ts'))};
    import { handleStripeReceiptClaimWorkflowStart } from ${JSON.stringify(resolve('cloud/workers/api/src/stripeReceiptClaimWorkflowRoutes.ts'))};
    export default { async fetch(request, env) {
      const readEnv = { ...env, get COSIGNER_SECRET() { throw new Error('Signer access is forbidden'); } };
      if (new URL(request.url).pathname === '/claimed') {
        const result = await handleStripeReceiptClaimWorkflowStart(new Request('https://test/receipts/stripe/claim/start', {
          method: 'POST', headers: {'Content-Type':'application/json','X-Mons-Receipt-Claim-Request':crypto.randomUUID()},
          body: JSON.stringify({code:${JSON.stringify(CLAIMED_CODE)},recipient:${JSON.stringify(RECIPIENT)}})
        }), readEnv, {verifiedStaffIdentity:{kind:'staff-wallet',wallet:${JSON.stringify(RECIPIENT)}}});
        return result.response;
      }
      try {
        const signal = AbortSignal.timeout(15000);
        const snapshot = await loadReceiptClaimWorkflow({repository:new D1CommerceRepository(env.COMMERCE_DB),signal,nowMs:Date.now()}, ${JSON.stringify(operationId)});
        const result = await reconcileReceiptClaimWorkflowOnchain({env:readEnv,snapshot,signal});
        return Response.json(result);
      } catch(error) { return Response.json({name:error.name,message:error.message},{status:500}); }
    }};`;
  const bundle = await build({ stdin: { contents: source, loader: 'ts', resolveDir: resolve('.') }, bundle: true,
    write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'] });
  const worker = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-08-08', compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
    d1Databases: ['COMMERCE_DB'], bindings: { HELIUS_API_KEY: 'local-test-only', STRIPE_RECEIPT_CLAIM_ADMISSION_ENABLED: 'true' },
    outboundService: async (request: Request) => {
      assert.equal(new URL(request.url).hostname, 'mainnet.helius-rpc.com');
      const response = await fetch(providerUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() });
      return new OutboundResponse(await response.text(), { status: response.status, headers: { 'Content-Type': 'application/json' } });
    },
  });
  try {
    const db: D1Database = await worker.getD1Database('COMMERCE_DB');
    for (const definition of definitions) await db.prepare(definition).run();
    for (const table of seededTables) {
      const columns = await db.prepare(`PRAGMA table_info(${table.name})`).all<{ name: string }>();
      for (const row of table.rows) {
        const keys = columns.results.map(({ name }) => name);
        await db.prepare(`INSERT INTO ${table.name} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
          .bind(...keys.map((key) => row[key])).run();
      }
    }
    const reconciled = await worker.dispatchFetch('https://test/reconcile');
    const reconcileResult = await reconciled.json();
    assert.equal(reconciled.status, 200, JSON.stringify(reconcileResult));
    assert.deepEqual(reconcileResult, { status: 'prepare' });
    assert.deepEqual(calls, ['searchAssets', 'searchAssets', 'getMultipleAccounts', 'getAsset', 'getAssetProof']);
    ownedByRecipient = true;
    calls.length = 0;
    const claimed = await worker.dispatchFetch('https://test/claimed');
    const claimedResult = await claimed.json();
    assert.equal(claimed.status, 200, JSON.stringify(claimedResult));
    assert.equal(claimedResult.receiptKind, 'figure');
    assert.equal(claimedResult.receiptsTransferred, 3);
    assert.deepEqual(claimedResult.figureIds, FIGURES);
    assert.deepEqual(calls, ['searchAssets', 'getAssetProof', 'getAssetProof', 'getAssetProof']);
    assert.deepEqual(providerErrors, []);
  } finally {
    await worker.dispose();
  }
});
