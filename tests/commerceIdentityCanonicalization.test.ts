import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  buildCommerceIdentityManifest,
  canonicalizeCommerceIdentity,
  type CommerceIdentityDocument,
} from '../scripts/shared/commerceIdentityCanonicalization.ts';

const migrationDirectory = 'cloud/workers/api/commerce-migrations';

function migrationDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(migrationDirectory).filter((name) => name < '0008').sort()) {
    database.exec(readFileSync(`${migrationDirectory}/${file}`, 'utf8'));
  }
  database.exec(`UPDATE commerce_authority_control SET
    authority_state = 'paused', revision = 2, paused_at_ms = 1, updated_at_ms = 1
    WHERE singleton = 1`);
  database.prepare(`INSERT INTO commerce_import_manifests (
    manifest_sha256, document_count, kind_counts_json, source_updated_at_ms, imported_at_ms, archive_object_prefix
  ) VALUES (?, 0, '{}', 1, 1, 'test')`).run('a'.repeat(64));
  database.prepare(`UPDATE commerce_authority_control SET
    authority_state = 'd1', revision = 3, cutover_at_ms = 2,
    import_manifest_sha256 = ?, updated_at_ms = 2 WHERE singleton = 1`).run('a'.repeat(64));
  return database;
}

function insertDocument(
  database: DatabaseSync,
  documentId: string,
  data: Record<string, unknown>,
  version: number,
): void {
  const path = `drops/drop/stripeCheckouts/${documentId}`;
  database.prepare(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, fields_json, document_json,
    version, create_time, update_time
  ) VALUES (?, 'stripe_checkout', 'drop', ?, ?, ?, ?, ?, ?)`).run(
    path,
    documentId,
    JSON.stringify({ compatibility: { stringValue: documentId }, firebaseUid: { stringValue: data.firebaseUid || '' } }),
    JSON.stringify(data),
    version,
    `2026-08-0${version}T00:00:00.000Z`,
    `2026-08-1${version}T00:00:00.00000000${version}Z`,
  );
}

function identityDocuments(database: DatabaseSync): CommerceIdentityDocument[] {
  return database.prepare(`SELECT document_path, document_kind, document_json,
    version, create_time, update_time FROM commerce_documents ORDER BY document_path`).all().map((row) => ({
    createTime: String(row.create_time),
    data: JSON.parse(String(row.document_json)) as Record<string, unknown>,
    kind: String(row.document_kind),
    path: String(row.document_path),
    updateTime: String(row.update_time),
    version: Number(row.version),
  }));
}

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
  assert.throws(() => canonicalizeCommerceIdentity({
    firebaseUid: 'anon:one',
    metadata: { authSubject: 'anon:one' },
    owner: 'firebase:anon:one',
    ownerKind: 'firebase',
  }), /ambiguous/);
  assert.throws(() => canonicalizeCommerceIdentity({
    firebaseUid: 'anon:one',
    mergedFirebaseUid: 'anon:one',
    owner: '',
    ownerKind: 'firebase',
    previousOwner: 'firebase:anon:one',
  }), /Merged wallet owner/);
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

test('commerce migration canonicalizes exact legacy shapes and preserves row metadata', () => {
  const database = migrationDatabase();
  try {
    insertDocument(database, 'canonical', {
      owner: 'wallet-canonical',
      ownerKind: 'wallet',
      uid: 'wallet-canonical',
    }, 1);
    insertDocument(database, 'legacy', {
      firebaseUid: 'subject-one',
      owner: 'firebase:subject-one',
      ownerKind: 'firebase',
      uid: 'subject-one',
    }, 2);
    insertDocument(database, 'merged', {
      firebaseUid: 'subject-two',
      mergedFirebaseUid: 'subject-two',
      owner: 'wallet-merged',
      ownerKind: 'firebase',
      previousOwner: 'firebase:subject-two',
      uid: 'subject-two',
    }, 3);
    const beforeRows = database.prepare(`SELECT document_path, fields_json, version, create_time, update_time
      FROM commerce_documents ORDER BY document_path`).all().map((row) => ({ ...row }));
    const beforeManifest = buildCommerceIdentityManifest(identityDocuments(database));

    database.exec(readFileSync(`${migrationDirectory}/0008_canonicalize_identity_documents.sql`, 'utf8'));

    assert.deepEqual(identityDocuments(database).map((document) => [document.path, document.data]), [
      ['drops/drop/stripeCheckouts/canonical', {
        owner: 'wallet-canonical', ownerKind: 'wallet', uid: 'wallet-canonical',
      }],
      ['drops/drop/stripeCheckouts/legacy', {
        authSubject: 'subject-one', owner: 'anonymous:subject-one', ownerKind: 'anonymous', uid: 'subject-one',
      }],
      ['drops/drop/stripeCheckouts/merged', {
        mergedAuthSubject: 'subject-two', owner: 'wallet-merged', ownerKind: 'wallet',
        previousOwner: 'anonymous:subject-two', uid: 'subject-two',
      }],
    ]);
    const afterRows = database.prepare(`SELECT document_path, fields_json, version, create_time, update_time
      FROM commerce_documents ORDER BY document_path`).all().map((row) => ({ ...row }));
    assert.deepEqual(afterRows, beforeRows);
    const afterManifest = buildCommerceIdentityManifest(identityDocuments(database));
    assert.equal(beforeManifest.changedDocuments, 2);
    assert.equal(afterManifest.changedDocuments, 0);
    assert.equal(afterManifest.beforeSha256, beforeManifest.expectedAfterSha256);
  } finally {
    database.close();
  }
});

test('commerce migration rejects mixed, nested, and unknown legacy shapes before rewriting', () => {
  const fixtures = [
    {
      firebaseUid: 'subject-one',
      authSubject: 'subject-one',
      owner: 'firebase:subject-one',
      ownerKind: 'firebase',
    },
    {
      firebaseUid: 'subject-one',
      metadata: { owner: 'firebase:subject-one' },
      owner: 'firebase:subject-one',
      ownerKind: 'firebase',
    },
    { metadata: { ownerKind: 'firebase' } },
    {
      firebaseUid: 'subject-three',
      mergedFirebaseUid: 'subject-three',
      owner: '',
      ownerKind: 'firebase',
      previousOwner: 'firebase:subject-three',
    },
  ];
  for (const [index, fixture] of fixtures.entries()) {
    const database = migrationDatabase();
    try {
      insertDocument(database, 'valid', {
        firebaseUid: 'valid-subject',
        owner: 'firebase:valid-subject',
        ownerKind: 'firebase',
      }, 1);
      insertDocument(database, `invalid-${index}`, fixture, 2);
      assert.throws(
        () => database.exec(readFileSync(`${migrationDirectory}/0008_canonicalize_identity_documents.sql`, 'utf8')),
        /malformed JSON/,
      );
      assert.equal(
        (identityDocuments(database).find((document) => document.path.endsWith('/valid'))?.data).owner,
        'firebase:valid-subject',
      );
    } finally {
      database.close();
    }
  }
});
