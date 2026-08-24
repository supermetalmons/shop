import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
const firestoreEmulatorHost = String(process.env.FIRESTORE_EMULATOR_HOST || '').trim();
const requireFirestoreEmulator = process.env.REQUIRE_FIRESTORE_EMULATOR === '1';

function compact(source: string): string {
  return source.replace(/\s+/g, ' ').trim();
}

test('Firestore client rules contain only a catch-all deny', () => {
  assert.equal(
    compact(rules),
    compact(`
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /{document=**} {
            allow read, write: if false;
          }
        }
      }
    `),
  );
});

test(
  'Firestore client rules deny authenticated and anonymous reads and writes in the emulator',
  {
    skip: firestoreEmulatorHost || requireFirestoreEmulator
      ? false
      : 'FIRESTORE_EMULATOR_HOST is not configured',
  },
  async () => {
    assert.ok(firestoreEmulatorHost, 'FIRESTORE_EMULATOR_HOST is required for semantic rules verification');
    const { assertFails, initializeTestEnvironment } = await import('@firebase/rules-unit-testing');
    const { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } = await import('firebase/firestore');
    const projectId = 'demo-mons-profile-rules';
    const environment = await initializeTestEnvironment({ projectId, firestore: { rules } });
    const collections = [
      {
        collectionPath: 'profiles',
        existingPath: 'profiles/wallet-1',
        newPath: 'profiles/wallet-2',
      },
      {
        collectionPath: 'authSessions',
        existingPath: 'authSessions/user-1',
        newPath: 'authSessions/user-2',
      },
      {
        collectionPath: 'claimCodes',
        existingPath: 'claimCodes/code-1',
        newPath: 'claimCodes/code-2',
      },
      {
        collectionPath: 'drops/card_nft_2/deliveryOrders',
        existingPath: 'drops/card_nft_2/deliveryOrders/order-1',
        newPath: 'drops/card_nft_2/deliveryOrders/order-2',
      },
    ];

    try {
      await environment.withSecurityRulesDisabled(async (context) => {
        const firestore = context.firestore();
        await Promise.all(collections.map(({ existingPath }) => setDoc(doc(firestore, existingPath), { value: 1 })));
      });

      const clients = [
        environment.authenticatedContext('user-1').firestore(),
        environment.unauthenticatedContext().firestore(),
      ];

      for (const firestore of clients) {
        for (const paths of collections) {
          await assertFails(getDoc(doc(firestore, paths.existingPath)));
          await assertFails(getDocs(collection(firestore, paths.collectionPath)));
          await assertFails(setDoc(doc(firestore, paths.newPath), { value: 2 }));
          await assertFails(updateDoc(doc(firestore, paths.existingPath), { value: 2 }));
          await assertFails(deleteDoc(doc(firestore, paths.existingPath)));
        }
      }
    } finally {
      await environment.cleanup();
    }
  },
);
