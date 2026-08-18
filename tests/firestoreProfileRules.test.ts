import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
const firestoreEmulatorHost = String(process.env.FIRESTORE_EMULATOR_HOST || '').trim();
const requireFirestoreEmulator = process.env.REQUIRE_FIRESTORE_EMULATOR === '1';

function extractBlock(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Missing ${marker}`);
  const openingBrace = source.indexOf('{', markerIndex + marker.length);
  assert.notEqual(openingBrace, -1, `Missing opening brace for ${marker}`);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(markerIndex, index + 1);
  }
  throw new Error(`Missing closing brace for ${marker}`);
}

function compact(source: string): string {
  return source.replace(/\s+/g, ' ').trim();
}

test('Firestore profile rules encode owner-only session and profile access', () => {
  const hasSession = compact(extractBlock(rules, 'function hasSession(uid)'));
  const walletAddressShape = compact(extractBlock(rules, 'function hasWalletAddressShape(wallet)'));
  const ownerCheck = compact(extractBlock(rules, 'function canReadOwnProfile(wallet)'));
  const profile = compact(extractBlock(rules, 'match /profiles/{wallet}'));
  const profileDirect = profile.slice(0, profile.indexOf('match /addresses/{addressId}'));
  const addresses = compact(extractBlock(rules, 'match /addresses/{addressId}'));
  const sessions = compact(extractBlock(rules, 'match /authSessions/{uid}'));

  assert.match(hasSession, /exists\(\/databases\/\$\(database\)\/documents\/authSessions\/\$\(uid\)\)/);
  assert.match(walletAddressShape, /wallet is string/);
  assert.match(walletAddressShape, /wallet\.size\(\) >= 32/);
  assert.match(walletAddressShape, /wallet\.size\(\) <= 44/);
  assert.match(walletAddressShape, /wallet\.matches/);
  assert.match(ownerCheck, /request\.auth != null/);
  assert.match(ownerCheck, /hasWalletAddressShape\(wallet\)/);
  assert.match(ownerCheck, /hasSession\(request\.auth\.uid\)/);
  assert.match(ownerCheck, /\.data\.wallet == wallet/);
  assert.doesNotMatch(ownerCheck, /expiresAt/);
  assert.match(ownerCheck, /request\.auth\.uid == wallet && !hasSession\(request\.auth\.uid\)/);

  assert.match(profileDirect, /allow get: if canReadOwnProfile\(wallet\)/);
  assert.match(profileDirect, /allow list, create, update, delete: if false/);
  assert.doesNotMatch(profileDirect, /allow read/);
  assert.doesNotMatch(profile, /match \/shipments\//);
  assert.match(sessions, /allow get: if request\.auth != null && request\.auth\.uid == uid/);
  assert.match(sessions, /allow list, create, update, delete: if false/);
  assert.match(addresses, /allow read, write: if false/);
  assert.doesNotMatch(rules, /request\.auth\.token[^;\n]*admin/i);
});

test('Firestore profile rules keep sensitive and unrelated collections closed', () => {
  const claimCodes = compact(extractBlock(rules, 'match /claimCodes/{code}'));
  const deliveryOrders = compact(extractBlock(rules, 'match /deliveryOrders/{deliveryId}'));
  const catchAll = compact(extractBlock(rules, 'match /{document=**}'));
  const packStatus = compact(extractBlock(rules, 'match /meta/packStatus'));

  assert.match(claimCodes, /allow read, write: if false/);
  assert.match(deliveryOrders, /allow read, write: if false/);
  assert.match(catchAll, /allow read, write: if false/);
  assert.doesNotMatch(packStatus, /request\.auth/);
  assert.match(packStatus, /dropId == "card_nft_2"/);
  assert.match(packStatus, /dropId == "poncho_drifella"/);
  assert.match(packStatus, /dropId == "little_swag_boxes"/);
  assert.match(packStatus, /allow list, create, update, delete: if false/);
});

test(
  'Firestore profile rules enforce owner-only access and deny client writes in the emulator',
  {
    skip: firestoreEmulatorHost || requireFirestoreEmulator
      ? false
      : 'FIRESTORE_EMULATOR_HOST is not configured',
  },
  async () => {
    assert.ok(firestoreEmulatorHost, 'FIRESTORE_EMULATOR_HOST is required for semantic rules verification');
    const { assertFails, assertSucceeds, initializeTestEnvironment } = await import('@firebase/rules-unit-testing');
    const {
      collection,
      deleteDoc,
      doc,
      getDoc,
      getDocs,
      orderBy,
      query,
      setDoc,
      Timestamp,
      updateDoc,
    } = await import('firebase/firestore');
    const projectId = 'demo-mons-profile-rules';
    const environment = await initializeTestEnvironment({ projectId, firestore: { rules } });
    const activeWallet = '11111111111111111111111111111111';
    const otherWallet = 'So11111111111111111111111111111111111111112';
    const legacyWallet = 'Stake11111111111111111111111111111111111111';
    const absentLegacyWallet = 'Vote111111111111111111111111111111111111111';
    const expiredWallet = 'ComputeBudget111111111111111111111111111111';
    const blockedLegacyWallet = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const expiredLegacyWallet = 'AddressLookupTab1e1111111111111111111111111';
    const malformedLegacyWallet = 'BPFLoaderUpgradeab1e11111111111111111111111';
    const malformedWallet = 'not-a-solana-wallet';
    const oversizedBase58Wallet = 'z'.repeat(44);
    const maximumWallet = 'JEKNVnkbo3jma5nREBBJCDoXFVeKkD56V3xKrvRmWxFG';

    try {
      await environment.withSecurityRulesDisabled(async (context) => {
        const firestore = context.firestore();
        const future = Timestamp.fromMillis(Date.now() + 60_000);
        const past = Timestamp.fromMillis(Date.now() - 60_000);
        await Promise.all([
          setDoc(doc(firestore, 'authSessions', 'active-user'), { wallet: activeWallet, expiresAt: future }),
          setDoc(doc(firestore, 'authSessions', 'expired-user'), { wallet: expiredWallet, expiresAt: past }),
          setDoc(doc(firestore, 'authSessions', 'missing-wallet-user'), { expiresAt: future }),
          setDoc(doc(firestore, 'authSessions', 'malformed-wallet-user'), { wallet: malformedWallet }),
          setDoc(doc(firestore, 'authSessions', 'oversized-wallet-user'), { wallet: oversizedBase58Wallet }),
          setDoc(doc(firestore, 'authSessions', 'maximum-wallet-user'), { wallet: maximumWallet }),
          setDoc(doc(firestore, 'authSessions', 'missing-expiry-user'), { wallet: activeWallet }),
          setDoc(doc(firestore, 'authSessions', 'malformed-expiry-user'), { wallet: activeWallet, expiresAt: 'later' }),
          setDoc(doc(firestore, 'authSessions', 'mismatched-user'), { wallet: otherWallet, expiresAt: future }),
          setDoc(doc(firestore, 'authSessions', blockedLegacyWallet), { wallet: otherWallet, expiresAt: future }),
          setDoc(doc(firestore, 'authSessions', expiredLegacyWallet), { wallet: expiredLegacyWallet, expiresAt: past }),
          setDoc(doc(firestore, 'authSessions', malformedLegacyWallet), { wallet: malformedLegacyWallet, expiresAt: 'later' }),
          setDoc(doc(firestore, 'profiles', activeWallet), { wallet: activeWallet, email: 'owner@example.com' }),
          setDoc(doc(firestore, 'profiles', otherWallet), { wallet: otherWallet }),
          setDoc(doc(firestore, 'profiles', legacyWallet), { wallet: legacyWallet }),
          setDoc(doc(firestore, 'profiles', expiredWallet), { wallet: expiredWallet }),
          setDoc(doc(firestore, 'profiles', blockedLegacyWallet), { wallet: blockedLegacyWallet }),
          setDoc(doc(firestore, 'profiles', expiredLegacyWallet), { wallet: expiredLegacyWallet }),
          setDoc(doc(firestore, 'profiles', malformedLegacyWallet), { wallet: malformedLegacyWallet }),
          setDoc(doc(firestore, 'profiles', malformedWallet), { wallet: malformedWallet }),
          setDoc(doc(firestore, 'profiles', oversizedBase58Wallet), { wallet: oversizedBase58Wallet }),
          setDoc(doc(firestore, 'profiles', maximumWallet), { wallet: maximumWallet }),
          setDoc(doc(firestore, 'profiles', activeWallet, 'shipments', 'shipment-1'), { deliveryId: 1, sortAt: 1 }),
          setDoc(doc(firestore, 'profiles', otherWallet, 'shipments', 'shipment-2'), { deliveryId: 2, sortAt: 2 }),
          setDoc(doc(firestore, 'profiles', legacyWallet, 'shipments', 'shipment-3'), { deliveryId: 3, sortAt: 3 }),
          setDoc(doc(firestore, 'profiles', expiredLegacyWallet, 'shipments', 'shipment-4'), { deliveryId: 4, sortAt: 4 }),
          setDoc(doc(firestore, 'profiles', malformedLegacyWallet, 'shipments', 'shipment-5'), { deliveryId: 5, sortAt: 5 }),
          setDoc(doc(firestore, 'profiles', activeWallet, 'addresses', 'address-1'), { city: 'private' }),
          setDoc(doc(firestore, 'drops', 'card_nft_2', 'deliveryOrders', '1'), { owner: activeWallet }),
          setDoc(doc(firestore, 'claimCodes', 'secret'), { owner: activeWallet }),
          setDoc(doc(firestore, 'drops', 'card_nft_2', 'meta', 'packStatus'), { total: 1 }),
          setDoc(doc(firestore, 'drops', 'poncho_drifella', 'meta', 'packStatus'), { total: 1 }),
          setDoc(doc(firestore, 'drops', 'little_swag_boxes', 'meta', 'packStatus'), { total: 1 }),
        ]);
      });

      const active = environment.authenticatedContext('active-user').firestore();
      await assertSucceeds(getDoc(doc(active, 'authSessions', 'active-user')));
      await assertSucceeds(getDoc(doc(active, 'profiles', activeWallet)));
      await assertFails(getDoc(doc(active, 'profiles', activeWallet, 'shipments', 'shipment-1')));
      await assertFails(
        getDocs(query(collection(active, 'profiles', activeWallet, 'shipments'), orderBy('sortAt', 'desc'))),
      );
      await assertFails(getDocs(collection(active, 'profiles', activeWallet, 'shipments')));
      await assertSucceeds(getDoc(doc(active, 'drops', 'card_nft_2', 'meta', 'packStatus')));

      await assertFails(getDoc(doc(active, 'authSessions', 'expired-user')));
      await assertFails(getDocs(collection(active, 'authSessions')));
      await assertFails(getDoc(doc(active, 'profiles', otherWallet)));
      await assertFails(getDoc(doc(active, 'profiles', otherWallet, 'shipments', 'shipment-2')));
      await assertFails(getDocs(collection(active, 'profiles', otherWallet, 'shipments')));
      await assertFails(
        getDocs(query(collection(active, 'profiles', otherWallet, 'shipments'), orderBy('sortAt', 'desc'))),
      );
      await assertFails(getDocs(collection(active, 'profiles')));
      await assertFails(getDoc(doc(active, 'profiles', activeWallet, 'addresses', 'address-1')));
      await assertFails(getDocs(collection(active, 'profiles', activeWallet, 'addresses')));
      await assertFails(getDoc(doc(active, 'drops', 'card_nft_2', 'deliveryOrders', '1')));
      await assertFails(getDocs(collection(active, 'drops', 'card_nft_2', 'deliveryOrders')));
      await assertFails(getDoc(doc(active, 'claimCodes', 'secret')));
      await assertFails(getDocs(collection(active, 'claimCodes')));

      const ownSessionCreator = environment.authenticatedContext('new-session-user').firestore();
      const ownProfileCreator = environment.authenticatedContext('new-wallet').firestore();
      const deniedWrites = [
        {
          createFirestore: ownSessionCreator,
          createPath: 'authSessions/new-session-user',
          existingPath: 'authSessions/active-user',
          createData: { wallet: activeWallet },
          updateData: { wallet: otherWallet },
        },
        {
          createFirestore: ownProfileCreator,
          createPath: 'profiles/new-wallet',
          existingPath: `profiles/${activeWallet}`,
          createData: { wallet: 'new-wallet' },
          updateData: { email: 'changed@example.com' },
        },
        {
          createPath: `profiles/${activeWallet}/shipments/shipment-new`,
          existingPath: `profiles/${activeWallet}/shipments/shipment-1`,
          createData: { deliveryId: 9, sortAt: 9 },
          updateData: { sortAt: 10 },
        },
        {
          createPath: `profiles/${activeWallet}/addresses/address-new`,
          existingPath: `profiles/${activeWallet}/addresses/address-1`,
          createData: { city: 'private' },
          updateData: { city: 'changed' },
        },
        {
          createPath: 'drops/card_nft_2/deliveryOrders/2',
          existingPath: 'drops/card_nft_2/deliveryOrders/1',
          createData: { owner: activeWallet },
          updateData: { owner: otherWallet },
        },
        {
          createPath: 'claimCodes/new-secret',
          existingPath: 'claimCodes/secret',
          createData: { owner: activeWallet },
          updateData: { owner: otherWallet },
        },
        {
          createPath: 'drops/unsupported/meta/packStatus',
          existingPath: 'drops/card_nft_2/meta/packStatus',
          createData: { total: 1 },
          updateData: { total: 2 },
        },
      ];
      for (const write of deniedWrites) {
        await assertFails(setDoc(doc(write.createFirestore || active, write.createPath), write.createData));
        await assertFails(updateDoc(doc(active, write.existingPath), write.updateData));
        await assertFails(deleteDoc(doc(active, write.existingPath)));
      }

      const anonymous = environment.unauthenticatedContext().firestore();
      await assertFails(getDoc(doc(anonymous, 'profiles', activeWallet)));
      await assertFails(getDoc(doc(anonymous, 'profiles', activeWallet, 'shipments', 'shipment-1')));
      await assertFails(getDocs(collection(anonymous, 'profiles', activeWallet, 'shipments')));
      await assertFails(getDoc(doc(anonymous, 'authSessions', 'active-user')));
      await assertSucceeds(getDoc(doc(anonymous, 'drops', 'card_nft_2', 'meta', 'packStatus')));
      await assertSucceeds(getDoc(doc(anonymous, 'drops', 'poncho_drifella', 'meta', 'packStatus')));
      await assertSucceeds(getDoc(doc(anonymous, 'drops', 'little_swag_boxes', 'meta', 'packStatus')));
      await assertFails(getDoc(doc(anonymous, 'drops', 'unsupported', 'meta', 'packStatus')));
      await assertFails(getDocs(collection(anonymous, 'drops', 'card_nft_2', 'meta')));

      const unbound = environment.authenticatedContext('unbound-user').firestore();
      await assertSucceeds(getDoc(doc(unbound, 'authSessions', 'unbound-user')));
      await assertFails(getDoc(doc(unbound, 'profiles', activeWallet)));
      await assertFails(getDocs(collection(unbound, 'profiles', activeWallet, 'shipments')));

      const expired = environment.authenticatedContext('expired-user').firestore();
      await assertSucceeds(getDoc(doc(expired, 'authSessions', 'expired-user')));
      await assertSucceeds(getDoc(doc(expired, 'profiles', expiredWallet)));

      const missingWallet = environment.authenticatedContext('missing-wallet-user').firestore();
      await assertFails(getDoc(doc(missingWallet, 'profiles', activeWallet)));

      const malformedWalletUser = environment.authenticatedContext('malformed-wallet-user').firestore();
      await assertFails(getDoc(doc(malformedWalletUser, 'profiles', malformedWallet)));

      const oversizedWalletUser = environment.authenticatedContext('oversized-wallet-user').firestore();
      await assertFails(getDoc(doc(oversizedWalletUser, 'profiles', oversizedBase58Wallet)));

      const maximumWalletUser = environment.authenticatedContext('maximum-wallet-user').firestore();
      await assertSucceeds(getDoc(doc(maximumWalletUser, 'profiles', maximumWallet)));

      const missingExpiry = environment.authenticatedContext('missing-expiry-user').firestore();
      await assertSucceeds(getDoc(doc(missingExpiry, 'profiles', activeWallet)));

      const malformedExpiry = environment.authenticatedContext('malformed-expiry-user').firestore();
      await assertSucceeds(getDoc(doc(malformedExpiry, 'profiles', activeWallet)));

      const mismatched = environment.authenticatedContext('mismatched-user').firestore();
      await assertFails(getDoc(doc(mismatched, 'profiles', activeWallet)));

      const invalidShipmentReaders = [
        { firestore: missingWallet, wallet: activeWallet },
        { firestore: mismatched, wallet: activeWallet },
      ];
      for (const reader of invalidShipmentReaders) {
        await assertFails(getDocs(collection(reader.firestore, 'profiles', reader.wallet, 'shipments')));
        await assertFails(
          getDocs(query(collection(reader.firestore, 'profiles', reader.wallet, 'shipments'), orderBy('sortAt', 'desc'))),
        );
      }

      const legacy = environment.authenticatedContext(legacyWallet).firestore();
      await assertSucceeds(getDoc(doc(legacy, 'authSessions', legacyWallet)));
      await assertSucceeds(getDoc(doc(legacy, 'profiles', legacyWallet)));
      await assertFails(getDocs(collection(legacy, 'profiles', legacyWallet, 'shipments')));
      await assertFails(getDoc(doc(legacy, 'profiles', otherWallet)));

      const absentLegacy = environment.authenticatedContext(absentLegacyWallet).firestore();
      await assertSucceeds(getDoc(doc(absentLegacy, 'authSessions', absentLegacyWallet)));
      await assertSucceeds(getDoc(doc(absentLegacy, 'profiles', absentLegacyWallet)));

      const blockedLegacy = environment.authenticatedContext(blockedLegacyWallet).firestore();
      await assertFails(getDoc(doc(blockedLegacy, 'profiles', blockedLegacyWallet)));
      await assertFails(getDocs(collection(blockedLegacy, 'profiles', blockedLegacyWallet, 'shipments')));

      for (const wallet of [expiredLegacyWallet, malformedLegacyWallet]) {
        const firestore = environment.authenticatedContext(wallet).firestore();
        await assertSucceeds(getDoc(doc(firestore, 'profiles', wallet)));
        await assertFails(getDocs(collection(firestore, 'profiles', wallet, 'shipments')));
      }

      const admin = environment.authenticatedContext('admin-user', { admin: true }).firestore();
      await assertFails(getDoc(doc(admin, 'profiles', activeWallet)));
      await assertFails(getDoc(doc(admin, 'profiles', activeWallet, 'shipments', 'shipment-1')));
      await assertFails(getDocs(collection(admin, 'profiles')));
      await assertFails(getDocs(collection(admin, 'profiles', activeWallet, 'shipments')));
      await assertFails(
        getDocs(query(collection(admin, 'profiles', activeWallet, 'shipments'), orderBy('sortAt', 'desc'))),
      );
    } finally {
      await environment.cleanup();
    }
  },
);
