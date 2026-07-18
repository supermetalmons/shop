import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planDiscountMerkleDatasetRemoval,
  validateDiscountMerkleFamilyRootInvariant,
  type DiscountMerkleDatasetReference,
} from '../scripts/shared/discountMerkleDataset.ts';

const ROOT_A = '11'.repeat(32);
const ROOT_B = '22'.repeat(32);

function ref(
  dropFamily: string,
  rootHex: string,
  source: string,
): DiscountMerkleDatasetReference {
  return { dropFamily, rootHex, source };
}

test('family/root invariant accepts duplicate references to the same pair', () => {
  const identities = validateDiscountMerkleFamilyRootInvariant([
    ref('card_nft_2', ROOT_A, 'frontend:mainnet'),
    ref('card_nft_2', ROOT_A, 'functions:mainnet'),
    ref('card_nft_2', ROOT_A, 'frontend:devnet'),
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
        ref('card_nft_2', ROOT_A, 'frontend:mainnet'),
        ref('card_nft_2', ROOT_B, 'functions:devnet'),
      ]),
    /family card_nft_2 maps to conflicting roots/,
  );
});

test('family/root invariant rejects one root mapped to different families', () => {
  assert.throws(
    () =>
      validateDiscountMerkleFamilyRootInvariant([
        ref('card_nft_2', ROOT_A, 'frontend:cards'),
        ref('little_swag_boxes', ROOT_A, 'functions:boxes'),
      ]),
    /root .* maps to conflicting families/,
  );
});

test('family/root invariant rejects non-canonical family and root values', () => {
  assert.throws(
    () => validateDiscountMerkleFamilyRootInvariant([ref('Card_Nft_2', ROOT_A, 'frontend:cards')]),
    /canonical lowercase family name/,
  );
  assert.throws(
    () =>
      validateDiscountMerkleFamilyRootInvariant([
        ref('card_nft_2', 'ab'.repeat(32).toUpperCase(), 'frontend:cards'),
      ]),
    /64 lowercase hexadecimal characters/,
  );
});

test('removal planner preserves a family dataset while either next registry references its root', () => {
  const plan = planDiscountMerkleDatasetRemoval({
    removedFrontend: ref('card_nft_2', ROOT_A, 'frontend:mainnet'),
    removedFunctions: ref('card_nft_2', ROOT_A, 'functions:mainnet'),
    remainingFrontend: [ref('card_nft_2', ROOT_A, 'frontend:devnet')],
    remainingFunctions: [],
  });

  assert.deepEqual(plan, {
    dropFamily: 'card_nft_2',
    rootHex: ROOT_A,
    fileName: 'card_nft_2.json',
    relativePath: 'src/drops/discountMerkles/card_nft_2.json',
    targetRegistryState: 'paired',
    deleteCanonicalFile: false,
    remainingRootReferences: 1,
  });
});

test('removal planner deletes the canonical family dataset on the final reference', () => {
  const plan = planDiscountMerkleDatasetRemoval({
    removedFrontend: ref('card_nft_2', ROOT_A, 'frontend:mainnet'),
    removedFunctions: ref('card_nft_2', ROOT_A, 'functions:mainnet'),
    remainingFrontend: [],
    remainingFunctions: [],
  });

  assert.equal(plan?.deleteCanonicalFile, true);
  assert.equal(plan?.relativePath, 'src/drops/discountMerkles/card_nft_2.json');
  assert.equal(plan?.targetRegistryState, 'paired');
  assert.equal(plan?.remainingRootReferences, 0);
});

for (const side of ['frontend', 'functions'] as const) {
  test(`removal planner accepts a ${side}-only target registry state`, () => {
    const target = ref('card_nft_2', ROOT_A, `${side}:target`);
    const plan = planDiscountMerkleDatasetRemoval({
      ...(side === 'frontend' ? { removedFrontend: target } : { removedFunctions: target }),
      remainingFrontend: [],
      remainingFunctions: [],
    });

    assert.equal(plan?.targetRegistryState, `${side}-only`);
    assert.equal(plan?.dropFamily, 'card_nft_2');
    assert.equal(plan?.rootHex, ROOT_A);
    assert.equal(plan?.deleteCanonicalFile, true);
  });
}

test('one-sided removal preserves a shared family dataset while a sibling references its root', () => {
  const plan = planDiscountMerkleDatasetRemoval({
    removedFunctions: ref('card_nft_2', ROOT_A, 'functions:target'),
    remainingFrontend: [ref('card_nft_2', ROOT_A, 'frontend:sibling')],
    remainingFunctions: [ref('card_nft_2', ROOT_A, 'functions:sibling')],
  });

  assert.equal(plan?.targetRegistryState, 'functions-only');
  assert.equal(plan?.deleteCanonicalFile, false);
  assert.equal(plan?.remainingRootReferences, 2);
});

test('removal planner rejects disagreeing frontend and Functions target references', () => {
  assert.throws(
    () =>
      planDiscountMerkleDatasetRemoval({
        removedFrontend: ref('card_nft_2', ROOT_A, 'frontend:target'),
        removedFunctions: ref('card_nft_2', ROOT_B, 'functions:target'),
        remainingFrontend: [],
        remainingFunctions: [],
      }),
    /frontend and Functions discount Merkle references disagree/,
  );
});
