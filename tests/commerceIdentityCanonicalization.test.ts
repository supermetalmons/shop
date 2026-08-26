import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCommerceIdentityManifest,
  canonicalizeCommerceIdentity,
} from '../scripts/shared/commerceIdentityCanonicalization.ts';

test('commerce identity canonicalization rewrites anonymous and merged wallet owners', () => {
  assert.deepEqual(canonicalizeCommerceIdentity({
    firebaseUid: 'anon:one',
    owner: 'firebase:anon:one',
    ownerKind: 'firebase',
  }), {
    changed: true,
    data: {
      authSubject: 'anon:one',
      owner: 'anonymous:anon:one',
      ownerKind: 'anonymous',
    },
  });
  assert.deepEqual(canonicalizeCommerceIdentity({
    firebaseUid: 'legacy-one',
    mergedFirebaseUid: 'legacy-one',
    owner: 'wallet-address',
    ownerKind: 'firebase',
    previousOwner: 'firebase:legacy-one',
  }), {
    changed: true,
    data: {
      mergedAuthSubject: 'legacy-one',
      owner: 'wallet-address',
      ownerKind: 'wallet',
      previousOwner: 'anonymous:legacy-one',
    },
  });
});

test('commerce identity canonicalization rejects ambiguous legacy shapes', () => {
  assert.throws(() => canonicalizeCommerceIdentity({
    authSubject: 'anon:one',
    firebaseUid: 'anon:one',
    owner: 'firebase:anon:one',
    ownerKind: 'firebase',
  }), /ambiguous/);
  assert.throws(() => canonicalizeCommerceIdentity({
    firebaseUid: 'anon:one',
    owner: 'firebase:anon:two',
    ownerKind: 'firebase',
  }), /invalid legacy owner/);
  assert.throws(() => canonicalizeCommerceIdentity({ nested: { owner: 'firebase:anon:one' } }), /Legacy identity value/);
});

test('commerce identity manifest is deterministic and preserves metadata in its hashes', () => {
  const documents = [{
    createTime: '2026-08-01T00:00:00.000Z',
    data: { firebaseUid: 'anon:one', owner: 'firebase:anon:one', ownerKind: 'firebase' },
    kind: 'stripe_checkout',
    path: 'drops/drop/stripeCheckouts/one',
    updateTime: '2026-08-02T00:00:00.000Z',
    version: 3,
  }];
  const manifest = buildCommerceIdentityManifest(documents);
  assert.equal(manifest.documentCount, 1);
  assert.equal(manifest.changedDocuments, 1);
  assert.deepEqual(manifest.kindCounts, { stripe_checkout: 1 });
  assert.deepEqual(manifest.legacy, {
    firebaseUid: 1,
    firebaseOwner: 1,
    firebaseOwnerKind: 1,
    mergedFirebaseUid: 0,
    previousFirebaseOwner: 0,
  });
  assert.match(manifest.beforeSha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.expectedAfterSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(manifest.beforeSha256, manifest.expectedAfterSha256);
  assert.deepEqual(manifest, buildCommerceIdentityManifest(documents));
});
