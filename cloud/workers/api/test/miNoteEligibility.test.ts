import assert from 'node:assert/strict';
import test from 'node:test';
import miNoteCollections from '../../../../mi_note_eth.json';
import { MI_NOTE_2_CONTRACT_ADDRESS, MI_NOTE_3_CONTRACT_ADDRESS, MI_NOTE_CONTRACT_ADDRESS } from '../../../../shared/miNoteCards.ts';
import { getPreorderConfig } from '../../../../shared/preorders.ts';
import { createRequestDeadline } from '../src/boundedRequest.ts';
import { assertMiNoteEligibility, loadMiNoteEligibility } from '../src/miNoteEligibility.ts';

const ADMIN = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
const TEST_ETHEREUM = ['0xe26067c76fdbe877f48b0a8400cf5db8b47af0fe', '0x5bfce4149f520fe0823dc8c0afaf979121e824ec'];
const tokens = (contract: string) => miNoteCollections.find((collection) => collection.contractAddress === contract)!.tokens;
const original = tokens(MI_NOTE_CONTRACT_ADDRESS);
const two = tokens(MI_NOTE_2_CONTRACT_ADDRESS);
const three = tokens(MI_NOTE_3_CONTRACT_ADDRESS);

function fixture() {
  const request = new Request('https://api.mons.shop/preorders/availability?preorderId=mi_note_cards');
  const deadline = createRequestDeadline(request, { timeoutMs: 10_000, timeoutMessage: 'test deadline' });
  const cache = new Map<string, Response>();
  const deferred: Promise<unknown>[] = [];
  let calls = 0;
  let originalIds = [original[0].id];
  let failModern = false;
  const args: Parameters<typeof loadMiNoteEligibility>[0] = {
    request, deadline, address: '0x0000000000000000000000000000000000000001', buyer: null,
    config: getPreorderConfig('mi_note_cards')!, fresh: false,
    env: { ALCHEMY_MI_NOTE_API_KEY: 'test', OPENSEA_API_KEY: 'test', PUBLIC_SHOP_RATE_LIMITER: { limit: async () => ({ success: true }) } },
    dependencies: {
      now: () => 1000, log: () => {},
      cache: {
        match: async (input) => cache.get(new Request(input).url)?.clone(),
        put: async (input, response) => { cache.set(new Request(input).url, response.clone()); },
      },
      providerFetch: async (input) => {
        calls += 1;
        const url = new URL(String(input));
        if (url.hostname === 'api.opensea.io') return Response.json({ nfts: originalIds.map((identifier) => ({
          identifier, contract: MI_NOTE_CONTRACT_ADDRESS, collection: 'minote', token_standard: 'erc1155',
        })) });
        if (failModern) throw new Error('provider unavailable');
        return Response.json({ ownedNfts: [
          { contractAddress: MI_NOTE_2_CONTRACT_ADDRESS, tokenId: two[0].id, balance: '1' },
          { contractAddress: MI_NOTE_3_CONTRACT_ADDRESS, tokenId: three[0].id, balance: '1' },
        ] });
      },
    },
    metrics: { upstreamCalls: 0, providerDurationMs: 0 },
    defer: (work) => deferred.push(work),
  };
  return { args, calls: () => calls, dispose: () => deadline.dispose(),
    originalIds: (ids: string[]) => { originalIds = ids; },
    failModern: () => { failModern = true; }, settle: () => Promise.all(deferred) };
}

test('eligibility maps contract token ownership to clean card IDs in gallery order', async (context) => {
  const h = fixture();
  context.after(h.dispose);
  const result = await loadMiNoteEligibility(h.args);
  assert.deepEqual(result.cardIds, [three[0].clean_card_id, two[0].clean_card_id, original[0].clean_card_id]);
  assert.equal(result.ownershipStatus, 'success');
  assert.equal(result.requiresAdminSignIn, false);
  assert.doesNotThrow(() => assertMiNoteEligibility(result, result.cardIds));
  assert.throws(() => assertMiNoteEligibility(result, [original[1].clean_card_id]), /only preorder cards owned/);
});

test('availability can use its ownership cache while purchase checks always fetch current holdings', async (context) => {
  const h = fixture();
  context.after(h.dispose);
  await loadMiNoteEligibility(h.args);
  await h.settle();
  h.originalIds([original[1].id]);
  const cached = await loadMiNoteEligibility(h.args);
  assert.ok(cached.cardIds.includes(original[0].clean_card_id));
  assert.equal(h.calls(), 2);
  const fresh = await loadMiNoteEligibility({ ...h.args, fresh: true });
  assert.ok(fresh.cardIds.includes(original[1].clean_card_id));
  assert.ok(!fresh.cardIds.includes(original[0].clean_card_id));
  assert.equal(h.calls(), 4);
});

test('partial provider failures retain verified cards and fail closed for unavailable collections', async (context) => {
  const h = fixture();
  context.after(h.dispose);
  h.failModern();
  const result = await loadMiNoteEligibility(h.args);
  assert.equal(result.ownershipStatus, 'partial');
  assert.deepEqual(result.cardIds, [original[0].clean_card_id]);
  assert.doesNotThrow(() => assertMiNoteEligibility(result, result.cardIds));
  assert.throws(() => assertMiNoteEligibility(result, [two[0].clean_card_id]), /Couldn’t verify ownership/);
});

test('both devnet test ranges require the exact verified ETH address and signed-in Solana admin', async (context) => {
  const h = fixture();
  context.after(h.dispose);
  for (const [index, address] of TEST_ETHEREUM.entries()) {
    const result = await loadMiNoteEligibility({ ...h.args, config: getPreorderConfig('mi_note_cards_devnet')!, address, buyer: ADMIN });
    assert.deepEqual(result.cardIds, Array.from({ length: 10 }, (_, offset) => index * 10 + offset + 1));
    assert.equal(result.requiresAdminSignIn, false);
  }
  assert.equal(h.calls(), 0);
  for (const buyer of [null, 'another-solana-wallet']) {
    const result = await loadMiNoteEligibility({ ...h.args, config: getPreorderConfig('mi_note_cards_devnet')!, address: TEST_ETHEREUM[0], buyer });
    assert.equal(result.requiresAdminSignIn, true);
    assert.deepEqual(result.cardIds, [three[0].clean_card_id, two[0].clean_card_id, original[0].clean_card_id]);
  }
  const mainnet = await loadMiNoteEligibility({ ...h.args, address: TEST_ETHEREUM[0], buyer: ADMIN });
  assert.equal(mainnet.requiresAdminSignIn, false);
  assert.deepEqual(mainnet.cardIds, [three[0].clean_card_id, two[0].clean_card_id, original[0].clean_card_id]);
});

test('provider outages preserve the devnet admin sign-in action without granting test cards', async (context) => {
  const h = fixture();
  context.after(h.dispose);
  const args = { ...h.args, address: TEST_ETHEREUM[0], env: { ...h.args.env, ALCHEMY_MI_NOTE_API_KEY: '', OPENSEA_API_KEY: '' } };
  const result = await loadMiNoteEligibility({ ...args, config: getPreorderConfig('mi_note_cards_devnet')! });
  assert.deepEqual(result.cardIds, []);
  assert.equal(result.requiresAdminSignIn, true);
  assert.equal(result.ownershipStatus, 'partial');
  assert.throws(() => assertMiNoteEligibility(result, [1]), /Couldn’t verify ownership/);
  await assert.rejects(loadMiNoteEligibility(args), /Couldn’t check your Ethereum holdings/);
});
