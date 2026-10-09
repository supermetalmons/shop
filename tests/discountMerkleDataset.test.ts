import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planCanonicalDiscountMerkleDatasetRemoval,
  validateDiscountMerkleFamilyRootInvariant,
  type DiscountMerkleDatasetReference,
} from '../scripts/shared/discountMerkleDataset.ts';

const ROOT_A = '11'.repeat(32);
const ROOT_B = '22'.repeat(32);
const DISABLED_ROOT = '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925';

function ref(
  dropFamily: string,
  rootHex: string,
  source: string,
): DiscountMerkleDatasetReference {
  return { dropFamily, rootHex, source };
}

test('family/root invariant accepts duplicate references to the same pair', () => {
  const identities = validateDiscountMerkleFamilyRootInvariant([
    ref('card_nft_2', ROOT_A, 'canonical:mainnet'),
    ref('card_nft_2', ROOT_A, 'canonical:devnet'),
  ]);

  assert.deepEqual(identities, [
    {
      dropFamily: 'card_nft_2',
      rootHex: ROOT_A,
      fileName: 'card_nft_2.json',
      relativePath: 'src/drops/discountMerkles/card_nft_2.json',
    },
  ]);
});

test('family/root invariant rejects one family mapped to different roots', () => {
  assert.throws(
    () =>
      validateDiscountMerkleFamilyRootInvariant([
        ref('card_nft_2', ROOT_A, 'canonical:mainnet'),
        ref('card_nft_2', ROOT_B, 'canonical:devnet'),
      ]),
    /family card_nft_2 maps to conflicting roots/,
  );
});

test('family/root invariant rejects one root mapped to different families', () => {
  assert.throws(
    () =>
      validateDiscountMerkleFamilyRootInvariant([
        ref('card_nft_2', ROOT_A, 'canonical:cards'),
        ref('little_swag_boxes', ROOT_A, 'canonical:boxes'),
      ]),
    /root .* maps to conflicting families/,
  );
});

test('only the fixed disabled sentinel root can be shared across distinct families', () => {
  assert.deepEqual(validateDiscountMerkleFamilyRootInvariant([
    ref('card_nft_binder', DISABLED_ROOT, 'binder'), ref('mi_note_cards', DISABLED_ROOT, 'mi-note'),
  ]).map(identity => identity.dropFamily), ['card_nft_binder', 'mi_note_cards']);
  assert.throws(() => validateDiscountMerkleFamilyRootInvariant([
    ref('card_nft_binder', '0'.repeat(64), 'binder'), ref('mi_note_cards', '0'.repeat(64), 'mi-note'),
  ]), /conflicting families/);
  assert.throws(() => validateDiscountMerkleFamilyRootInvariant([
    ref('mi_note_cards', DISABLED_ROOT, 'disabled'), ref('mi_note_cards', ROOT_A, 'ordinary'),
  ]), /family mi_note_cards maps to conflicting roots/);
});

test('family/root invariant rejects non-canonical family and root values', () => {
  assert.throws(
    () => validateDiscountMerkleFamilyRootInvariant([ref('Card_Nft_2', ROOT_A, 'canonical:cards')]),
    /canonical lowercase family name/,
  );
  assert.throws(
    () =>
      validateDiscountMerkleFamilyRootInvariant([
        ref('card_nft_2', 'ab'.repeat(32).toUpperCase(), 'canonical:cards'),
      ]),
    /64 lowercase hexadecimal characters/,
  );
});

test('canonical removal preserves a family dataset while another row references its root', () => {
  const plan = planCanonicalDiscountMerkleDatasetRemoval({
    removed: ref('card_nft_2', ROOT_A, 'canonical:mainnet'),
    remaining: [ref('card_nft_2', ROOT_A, 'canonical:devnet')],
  });

  assert.deepEqual(plan, {
    dropFamily: 'card_nft_2',
    rootHex: ROOT_A,
    fileName: 'card_nft_2.json',
    relativePath: 'src/drops/discountMerkles/card_nft_2.json',
    deleteCanonicalFile: false,
    remainingRootReferences: 1,
  });
});

test('canonical removal deletes the family dataset on the final reference', () => {
  const plan = planCanonicalDiscountMerkleDatasetRemoval({
    removed: ref('card_nft_2', ROOT_A, 'canonical:mainnet'),
    remaining: [],
  });

  assert.equal(plan?.deleteCanonicalFile, true);
  assert.equal(plan?.relativePath, 'src/drops/discountMerkles/card_nft_2.json');
  assert.equal(plan?.remainingRootReferences, 0);
});

test('removing one disabled family does not retain its file for a different family sharing the sentinel', () => {
  const removed = ref('mi_note_cards', DISABLED_ROOT, 'mi-note');
  const binder = ref('card_nft_binder', DISABLED_ROOT, 'binder');
  assert.equal(planCanonicalDiscountMerkleDatasetRemoval({ removed, remaining: [binder] })?.deleteCanonicalFile, true);
  assert.equal(planCanonicalDiscountMerkleDatasetRemoval({ removed, remaining: [binder, removed] })?.deleteCanonicalFile, false);
});
