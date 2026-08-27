import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCanonicalCommerceIdentity } from '../scripts/shared/commerceIdentityValidation.ts';

const wallet = '11111111111111111111111111111111';

test('commerce identity validation accepts current anonymous and wallet shapes', () => {
  assert.doesNotThrow(() => assertCanonicalCommerceIdentity({}));
  assert.doesNotThrow(() => assertCanonicalCommerceIdentity({
    authSubject: 'anon:one',
    owner: 'anonymous:anon:one',
    ownerKind: 'anonymous',
  }));
  assert.doesNotThrow(() => assertCanonicalCommerceIdentity({
    owner: wallet,
    ownerKind: 'wallet',
  }));
  assert.doesNotThrow(() => assertCanonicalCommerceIdentity({
    mergedAuthSubject: 'anon:one',
    owner: wallet,
    ownerKind: 'wallet',
    previousOwner: 'anonymous:anon:one',
  }));
  assert.doesNotThrow(() => assertCanonicalCommerceIdentity({
    snapshot: { uid: 'historical-subject' },
  }));
});

test('commerce identity validation rejects noncanonical identity shapes', () => {
  assert.throws(() => assertCanonicalCommerceIdentity({ uid: 'subject' }), /noncanonical/);
  assert.throws(() => assertCanonicalCommerceIdentity({
    authSubject: 'anon:one',
    owner: 'anonymous:anon:two',
    ownerKind: 'anonymous',
  }), /anonymous identity/);
  assert.throws(() => assertCanonicalCommerceIdentity({
    nested: { ownerKind: 'anonymous' },
  }), /nested identity/);
  assert.throws(() => assertCanonicalCommerceIdentity({
    owner: wallet,
    ownerKind: 'wallet',
    previousOwner: 'anonymous:anon:one',
  }), /merged identity/);
});
