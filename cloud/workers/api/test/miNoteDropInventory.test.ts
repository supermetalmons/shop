import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { DEPLOYMENT_DROPS } from '../../../../shared/deploymentRegistry.ts';
import { getPreorderConfig, preorderMetadataUri } from '../../../../shared/preorders.ts';
import { PENDING_OPEN_BOX_DISCRIMINATOR } from '../../../../shared/pendingOpenCodec.ts';
import { miNoteDropFixture } from '../../../../tests/helpers/miNoteDropFixture.ts';
import { createCommerceD1Harness } from './commerceD1Harness.ts';
import type { ProviderFetch } from '../src/publicRouteSupport.ts';

const drop = miNoteDropFixture();
DEPLOYMENT_DROPS[drop.dropId] = drop;
const { handlePost } = await import('../src/shopInventory.ts');
const { defaultDependencies } = await import('../src/publicRouteSupport.ts');
const preorder = getPreorderConfig(drop.dropId)!;
const key = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed));
const owner = key(41).toBase58();
const pack = key(42);
const preorderAsset = key(43).toBase58();
const ordinary = [
  { id: pack.toBase58(), interface: 'MplCoreAsset', burnt: false, ownership: { owner },
    grouping: [{ group_key: 'collection', group_value: drop.collectionMint }],
    content: { json_uri: `${drop.metadataBase}/b704.json` } },
  { id: key(44).toBase58(), interface: 'MplCoreAsset', burnt: false, ownership: { owner },
    grouping: [{ group_key: 'collection', group_value: drop.collectionMint }],
    content: { json_uri: `${drop.metadataBase}/f1430.json` } },
];
const preserved = {
  id: preorderAsset, interface: 'MplCoreAsset', burnt: false, ownership: { owner },
  grouping: [{ group_key: 'collection', group_value: drop.collectionMint }],
  content: { json_uri: preorderMetadataUri(preorder, 1) },
};
const mainnet = {
  ...ordinary[0], id: key(45).toBase58(),
  grouping: [{ group_key: 'collection', group_value: DEPLOYMENT_DROPS.card_nft_2.collectionMint }],
  content: { json_uri: `${DEPLOYMENT_DROPS.card_nft_2.metadataBase}/b1.json` },
};

async function requestInventory(includeDevnet: boolean, providerFetch: ProviderFetch, extra: Record<string, unknown> = {}) {
  const commerce = createCommerceD1Harness();
  try {
    const request = new Request('https://api.mons.shop/inventory', {
      method: 'POST', headers: { Origin: 'https://mons.shop', 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner, includeDevnet, ...extra }),
    });
    return await handlePost(request, {
      HELIUS_API_KEY: 'fixture-key', COMMERCE_DB: commerce.db,
      PUBLIC_SHOP_RATE_LIMITER: { limit: async () => ({ success: true }) },
    }, '/inventory', {
      ...defaultDependencies, providerFetch, log: () => {}, sleep: async () => {}, randomUint32: () => 0,
    }, { upstreamCalls: 0, providerDurationMs: 0, expectedAssetIds: 0, expectedAssetRecoveryFailures: 0, expectedAssetResolved: 0 });
  } finally {
    commerce.database.close();
  }
}

function provider(failDevnet = false): ProviderFetch {
  return async (input, init) => {
    const body = JSON.parse(String(init?.body));
    if (failDevnet && new URL(String(input)).hostname === 'devnet.helius-rpc.com') return new Response('', { status: 503 });
    if (body.method === 'getAssetBatch') return Response.json({ jsonrpc: '2.0', id: body.id, result: ordinary });
    assert.equal(body.method, 'searchAssets');
    const collection = body.params.grouping?.[1];
    const items = body.params.cursor ? [] : collection === drop.collectionMint ? [preserved, ...ordinary]
      : collection === DEPLOYMENT_DROPS.card_nft_2.collectionMint ? [mainnet] : [];
    return Response.json({ jsonrpc: '2.0', id: body.id, result: {
      limit: body.params.limit, items, ...(items.length ? { cursor: collection } : {}),
    } });
  };
}

test('public requests retain preorders while filtering regular assets from their shared devnet collection', async () => {
  const { response } = await requestInventory(false, provider(), {
    includePreorderResolutions: true, expectedAssetIds: { devnet: [pack.toBase58()] },
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { items: { id: string; kind: string }[] };
  assert.deepEqual(new Set(body.items.map(item => item.id)), new Set([mainnet.id, preserved.id]));
  assert.equal(body.items.find(item => item.id === preorderAsset)?.kind, 'preorder');
});

test('explicit devnet requests include the pack and high-ID card alongside unchanged preorders', async () => {
  const { response } = await requestInventory(true, provider());
  assert.equal(response.status, 200);
  const body = await response.json() as { items: { id: string; kind: string; name: string; dudeId?: number }[] };
  assert.deepEqual(new Set(body.items.map(item => item.id)), new Set([mainnet.id, preserved.id, ...ordinary.map(item => item.id)]));
  assert.equal(body.items.find(item => item.id === pack.toBase58())?.name, 'Pack #704');
  assert.equal(body.items.find(item => item.id === ordinary[1].id)?.dudeId, 1430);
});

test('a registered Mi Note devnet outage remains optional for public inventory and required for explicit devnet requests', async () => {
  const publicResult = await requestInventory(false, provider(true));
  assert.equal(publicResult.response.status, 200);
  assert.deepEqual((await publicResult.response.json() as { items: { id: string }[] }).items.map(item => item.id), [mainnet.id]);
  const explicitResult = await requestInventory(true, provider(true));
  assert.equal(explicitResult.response.status, 502);
});

test('pending-open API resolves operations config B for any requested devnet owner', async (t) => {
  const commerce = createCommerceD1Harness();
  t.after(() => commerce.database.close());
  const program = new PublicKey(drop.boxMinterProgramId);
  const pending = PublicKey.findProgramAddressSync([Buffer.from('open'), pack.toBuffer()], program)[0];
  const count = Buffer.alloc(4); count.writeUInt32LE(2);
  const slot = Buffer.alloc(8); slot.writeBigUInt64LE(100n);
  const data = Buffer.concat([
    Buffer.from(PENDING_OPEN_BOX_DISCRIMINATOR), new PublicKey(owner).toBuffer(), pack.toBuffer(), count,
    key(46).toBuffer(), key(47).toBuffer(), slot, Buffer.from([1]), new PublicKey(drop.operationsConfig!.boxMinterConfigPda).toBuffer(),
  ]);
  for (const includeDevnet of [false, true]) {
    let readOperationsProgram = false;
    const { response } = await handlePost(new Request('https://api.mons.shop/pending-open-boxes', {
      method: 'POST', headers: { Origin: 'https://mons.shop', 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner, includeDevnet }),
    }), {
      HELIUS_API_KEY: 'fixture-key', COMMERCE_DB: commerce.db,
      PUBLIC_SHOP_RATE_LIMITER: { limit: async () => ({ success: true }) },
    }, '/pending-open-boxes', {
      ...defaultDependencies, log: () => {},
      providerFetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.method, 'getProgramAccounts');
        const matches = body.params[0] === drop.boxMinterProgramId;
        readOperationsProgram ||= matches;
        return Response.json({ jsonrpc: '2.0', id: body.id, result: matches ? [{
          pubkey: pending.toBase58(), account: { owner: program.toBase58(), data: [data.toString('base64'), 'base64'] },
        }] : [] });
      },
    }, { upstreamCalls: 0, providerDurationMs: 0, expectedAssetIds: 0, expectedAssetRecoveryFailures: 0, expectedAssetResolved: 0 });
    assert.equal(response.status, 200);
    const body = await response.json() as { items: { dropId: string; boxAssetId: string }[] };
    assert.equal(readOperationsProgram, includeDevnet);
    assert.deepEqual(body.items.map(item => [item.dropId, item.boxAssetId]), includeDevnet ? [[drop.dropId, pack.toBase58()]] : []);
  }
});
