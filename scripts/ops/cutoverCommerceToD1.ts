import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import {
  commerceDocumentIdentity,
} from '../../cloud/workers/api/src/commerceDocumentStore.ts';
import {
  FIRESTORE_DOCUMENT_NAME_PREFIX,
  FIRESTORE_DOCUMENTS_BASE_URL,
  authenticatedFirestoreRequest,
  createGoogleAccessTokenProvider,
  decodeFirestoreFields,
  isRecord,
} from '../../cloud/workers/api/src/firestoreRest.ts';
import {
  firestoreReaderServiceAccountEmail,
  readCloudflareFirestoreKeychainCredential,
} from '../cloudflare-firestore-keychain.ts';
import {
  executeRemoteCommerceD1File,
  queryRemoteCommerceD1,
  safeInteger,
  sqlString,
  uploadPrivateCommerceArchiveObject,
} from '../shared/commerceD1Maintenance.ts';

type Args = {
  expectedRevision?: number;
  firestoreServiceAccountFile?: string;
  write: boolean;
};

type SnapshotDocument = {
  createTime: string;
  documentId: string;
  dropId: string | null;
  fields: Record<string, unknown>;
  kind: NonNullable<ReturnType<typeof commerceDocumentIdentity>>['kind'];
  path: string;
  updateTime: string;
};

type ManifestDocument = {
  chunk: string;
  path: string;
  sha256: string;
};

const COLLECTIONS = [
  'adminIrlRedeemPackMarkers',
  'adminIrlRedeemReceiptMarkers',
  'adminIrlRedeemRequests',
  'boxAssignments',
  'claimCodes',
  'deliveryOrders',
  'dudeAssignments',
  'meta',
  'offchainOrders',
  'stripeCheckouts',
] as const;
const PAGE_SIZE = 250;
const CHUNK_SIZE = 250;
const IMPORT_BATCH_SIZE = 150;

function fail(message: string): never {
  throw new Error(message);
}

export function parseCommerceCutoverArgs(argv: string[]): Args {
  let expectedRevision: number | undefined;
  let firestoreServiceAccountFile: string | undefined;
  let write = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write') {
      write = true;
      continue;
    }
    if (arg === '--expected-revision') {
      const value = Number(argv[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1) fail('Expected revision must be a positive integer.');
      expectedRevision = value;
      index += 1;
      continue;
    }
    if (arg === '--firestore-service-account-file') {
      const value = argv[index + 1];
      if (!value) fail('--firestore-service-account-file requires a path.');
      firestoreServiceAccountFile = resolve(value);
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }
  if (write && expectedRevision === undefined) fail('--write requires --expected-revision.');
  if (!write && expectedRevision !== undefined) fail('--expected-revision is only valid with --write.');
  return { expectedRevision, firestoreServiceAccountFile, write };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function credential(args: Args): string {
  return args.firestoreServiceAccountFile
    ? readFileSync(args.firestoreServiceAccountFile, 'utf8').trim()
    : readCloudflareFirestoreKeychainCredential(firestoreReaderServiceAccountEmail);
}

function parseSourceDocument(value: unknown): SnapshotDocument | null {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    !value.name.startsWith(FIRESTORE_DOCUMENT_NAME_PREFIX) ||
    !isRecord(value.fields) ||
    typeof value.createTime !== 'string' ||
    typeof value.updateTime !== 'string'
  ) fail('Firestore returned an invalid commerce document.');
  const path = value.name.slice(FIRESTORE_DOCUMENT_NAME_PREFIX.length);
  const identity = commerceDocumentIdentity(path);
  if (!identity) {
    if (/^drops\/[^/]+\/meta\/[^/]+$/.test(path)) return null;
    return fail('Firestore returned an unexpected commerce document path.');
  }
  if (!decodeFirestoreFields(value.fields)) fail('Firestore returned invalid commerce fields.');
  return {
    path,
    kind: identity.kind,
    dropId: identity.dropId,
    documentId: identity.documentId,
    fields: value.fields,
    createTime: value.createTime,
    updateTime: value.updateTime,
  };
}

async function scanCollection(collectionId: string, serviceAccountJson: string): Promise<SnapshotDocument[]> {
  const accessTokenProvider = createGoogleAccessTokenProvider();
  const documents: SnapshotDocument[] = [];
  let cursorPath: string | null = null;
  for (;;) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException('Firestore commerce export timed out', 'TimeoutError')),
      60_000,
    );
    let payload: unknown;
    try {
      payload = await authenticatedFirestoreRequest({
        accessTokenProvider,
        body: JSON.stringify({ structuredQuery: {
          from: [{ collectionId, allDescendants: true }],
          orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
          ...(cursorPath ? { startAt: {
            before: false,
            values: [{ referenceValue: `${FIRESTORE_DOCUMENT_NAME_PREFIX}${cursorPath}` }],
          } } : {}),
          limit: PAGE_SIZE,
        } }),
        method: 'POST',
        nowMs: Date.now(),
        providerFetch: (input, init) => fetch(input, init),
        serviceAccountJson,
        signal: controller.signal,
        url: `${FIRESTORE_DOCUMENTS_BASE_URL}:runQuery`,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!Array.isArray(payload)) fail('Firestore returned an invalid commerce export response.');
    const page = payload.flatMap((entry) => {
      if (!isRecord(entry) || entry.document === undefined) return [];
      const document = parseSourceDocument(entry.document);
      return document ? [document] : [];
    });
    documents.push(...page);
    const sourcePageCount = payload.filter((entry) => isRecord(entry) && entry.document !== undefined).length;
    if (sourcePageCount < PAGE_SIZE) return documents;
    const lastEntry = [...payload].reverse().find((entry) => isRecord(entry) && isRecord(entry.document));
    const name = isRecord(lastEntry) && isRecord(lastEntry.document) ? lastEntry.document.name : null;
    if (typeof name !== 'string' || !name.startsWith(FIRESTORE_DOCUMENT_NAME_PREFIX)) {
      fail('Firestore commerce export cursor is invalid.');
    }
    const nextCursor = name.slice(FIRESTORE_DOCUMENT_NAME_PREFIX.length);
    if (nextCursor === cursorPath) fail('Firestore commerce export did not advance.');
    cursorPath = nextCursor;
  }
}

async function sourceDocuments(serviceAccountJson: string): Promise<SnapshotDocument[]> {
  const pages = await Promise.all(COLLECTIONS.map((collection) => scanCollection(collection, serviceAccountJson)));
  const byPath = new Map<string, SnapshotDocument>();
  for (const document of pages.flat()) {
    if (byPath.has(document.path)) fail('Firestore commerce export returned a duplicate path.');
    byPath.set(document.path, document);
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function documentHash(document: SnapshotDocument): string {
  return sha256(canonicalJson(document));
}

function validateDomainInvariants(documents: readonly SnapshotDocument[]): void {
  const paths = new Set<string>();
  const claimCodes = new Set<string>();
  for (const document of documents) {
    if (paths.has(document.path)) fail('Commerce snapshot contains duplicate document paths.');
    paths.add(document.path);
    const identity = commerceDocumentIdentity(document.path);
    if (
      !identity ||
      identity.kind !== document.kind ||
      identity.dropId !== document.dropId ||
      identity.documentId !== document.documentId
    ) fail('Commerce snapshot contains an invalid document identity.');
    if (!decodeFirestoreFields(document.fields)) fail('Commerce snapshot contains invalid Firestore fields.');
    if (document.kind === 'claim_code') {
      if (claimCodes.has(document.documentId)) fail('Commerce snapshot contains duplicate claim codes.');
      claimCodes.add(document.documentId);
    }
  }
}

function writeArchive(directory: string, documents: readonly SnapshotDocument[], createdAtMs: number) {
  const prefix = `cutovers/${new Date(createdAtMs).toISOString().replaceAll(':', '-').replace('.000Z', 'Z')}`;
  const manifestDocuments: ManifestDocument[] = [];
  const chunks: Array<{ filePath: string; key: string; sha256: string }> = [];
  for (let offset = 0; offset < documents.length; offset += CHUNK_SIZE) {
    const name = `documents-${String(offset / CHUNK_SIZE).padStart(4, '0')}.ndjson.gz`;
    const rows = documents.slice(offset, offset + CHUNK_SIZE);
    const bytes = gzipSync(`${rows.map((row) => canonicalJson(row)).join('\n')}\n`, { level: 9 });
    const filePath = join(directory, name);
    writeFileSync(filePath, bytes, { mode: 0o600 });
    chunks.push({ filePath, key: `${prefix}/${name}`, sha256: sha256(bytes) });
    for (const document of rows) manifestDocuments.push({
      chunk: name,
      path: document.path,
      sha256: documentHash(document),
    });
  }
  const kindCounts = Object.fromEntries(Array.from(new Set(documents.map((document) => document.kind))).sort()
    .map((kind) => [kind, documents.filter((document) => document.kind === kind).length]));
  const unsignedManifest = {
    version: 1,
    createdAtMs,
    documentCount: documents.length,
    kindCounts,
    chunks: chunks.map(({ key, sha256: hash }) => ({ key: key.slice(prefix.length + 1), sha256: hash })),
    documents: manifestDocuments,
  };
  const manifestSha256 = sha256(canonicalJson(unsignedManifest));
  const manifest = { ...unsignedManifest, manifestSha256 };
  const manifestFilePath = join(directory, 'manifest.json');
  writeFileSync(manifestFilePath, `${canonicalJson(manifest)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { chunks, kindCounts, manifestFilePath, manifestSha256, prefix };
}

function documentInsertSql(document: SnapshotDocument): string {
  return `INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, fields_json, document_json,
    version, create_time, update_time
  ) VALUES (
    ${sqlString(document.path)}, ${sqlString(document.kind)}, ${document.dropId ? sqlString(document.dropId) : 'NULL'},
    ${sqlString(document.documentId)}, ${sqlString(JSON.stringify(document.fields))},
    ${sqlString(JSON.stringify(decodeFirestoreFields(document.fields)))}, 1,
    ${sqlString(document.createTime)}, ${sqlString(document.updateTime)}
  );`;
}

function importDocuments(directory: string, documents: readonly SnapshotDocument[]): void {
  const clearFile = join(directory, 'import-clear.sql');
  writeFileSync(clearFile, 'DELETE FROM commerce_transaction_reads;\nDELETE FROM commerce_transactions;\nDELETE FROM commerce_documents;\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  executeRemoteCommerceD1File(clearFile);
  for (let offset = 0; offset < documents.length; offset += IMPORT_BATCH_SIZE) {
    const filePath = join(directory, `import-${String(offset / IMPORT_BATCH_SIZE).padStart(5, '0')}.sql`);
    writeFileSync(filePath, documents.slice(offset, offset + IMPORT_BATCH_SIZE).map(documentInsertSql).join('\n'), {
      encoding: 'utf8',
      mode: 0o600,
    });
    executeRemoteCommerceD1File(filePath);
  }
}

function remoteSnapshot(): SnapshotDocument[] {
  return queryRemoteCommerceD1(`SELECT document_path, document_kind, drop_id, document_id,
    fields_json, create_time, update_time FROM commerce_documents ORDER BY document_path`).map((row) => {
    let fields: unknown;
    try {
      fields = JSON.parse(String(row.fields_json));
    } catch {
      return fail('D1 contains invalid commerce document JSON.');
    }
    if (!isRecord(fields)) return fail('D1 contains invalid commerce document fields.');
    return {
      path: String(row.document_path),
      kind: String(row.document_kind) as SnapshotDocument['kind'],
      dropId: row.drop_id === null ? null : String(row.drop_id),
      documentId: String(row.document_id),
      fields,
      createTime: String(row.create_time),
      updateTime: String(row.update_time),
    };
  });
}

function verifyExactImport(source: readonly SnapshotDocument[]): void {
  const imported = remoteSnapshot();
  if (source.length !== imported.length) fail('D1 commerce import count does not match Firestore.');
  const importedByPath = new Map(imported.map((document) => [document.path, document]));
  for (const document of source) {
    const importedDocument = importedByPath.get(document.path);
    if (!importedDocument || documentHash(document) !== documentHash(importedDocument)) {
      fail('D1 commerce import hash verification failed.');
    }
  }
}

function rehearseLocalImport(documents: readonly SnapshotDocument[]): void {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync('cloud/workers/api/commerce-migrations').sort()) {
    database.exec(readFileSync(`cloud/workers/api/commerce-migrations/${file}`, 'utf8'));
  }
  database.exec(`UPDATE commerce_authority_control SET
    authority_state = 'paused', revision = 2, paused_at_ms = 1, updated_at_ms = 1
    WHERE singleton = 1`);
  const insert = database.prepare(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, fields_json, document_json,
    version, create_time, update_time
  ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`);
  database.exec('BEGIN');
  try {
    for (const document of documents) insert.run(
      document.path,
      document.kind,
      document.dropId,
      document.documentId,
      JSON.stringify(document.fields),
      JSON.stringify(decodeFirestoreFields(document.fields)),
      document.createTime,
      document.updateTime,
    );
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  const rows = database.prepare(`SELECT document_path, document_kind, drop_id, document_id,
    fields_json, create_time, update_time FROM commerce_documents ORDER BY document_path`).all();
  if (rows.length !== documents.length) fail('Local D1 rehearsal count does not match Firestore.');
  const importedByPath = new Map(rows.map((row) => {
    const imported: SnapshotDocument = {
      path: String(row.document_path),
      kind: String(row.document_kind) as SnapshotDocument['kind'],
      dropId: row.drop_id === null ? null : String(row.drop_id),
      documentId: String(row.document_id),
      fields: JSON.parse(String(row.fields_json)) as Record<string, unknown>,
      createTime: String(row.create_time),
      updateTime: String(row.update_time),
    };
    return [imported.path, imported] as const;
  }));
  for (const document of documents) {
    const imported = importedByPath.get(document.path);
    if (!imported || documentHash(imported) !== documentHash(document)) fail('Local D1 rehearsal hash mismatch.');
  }
  if (database.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') fail('Local D1 rehearsal quick check failed.');
  if (database.prepare('PRAGMA foreign_key_check').all().length) fail('Local D1 rehearsal foreign-key check failed.');
  database.close();
}

function recordVerifiedImport(
  directory: string,
  expectedRevision: number,
  archivePrefix: string,
  manifestSha256: string,
  documents: readonly SnapshotDocument[],
  kindCounts: Record<string, number>,
  importedAtMs: number,
): void {
  const filePath = join(directory, 'record-import.sql');
  writeFileSync(filePath, `INSERT INTO commerce_import_manifests (
    manifest_sha256, document_count, kind_counts_json, source_updated_at_ms, imported_at_ms, archive_object_prefix
  ) VALUES (
    ${sqlString(manifestSha256)}, ${documents.length}, ${sqlString(JSON.stringify(kindCounts))},
    ${importedAtMs}, ${importedAtMs}, ${sqlString(archivePrefix)}
  ) ON CONFLICT(manifest_sha256) DO NOTHING;
  UPDATE commerce_authority_control
  SET import_manifest_sha256 = ${sqlString(manifestSha256)}, updated_at_ms = ${importedAtMs}
  WHERE singleton = 1 AND authority_state = 'paused' AND revision = ${expectedRevision};\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  executeRemoteCommerceD1File(filePath);
  const control = queryRemoteCommerceD1(`SELECT authority_state, revision, import_manifest_sha256
    FROM commerce_authority_control WHERE singleton = 1`)[0];
  if (
    control?.authority_state !== 'paused' ||
    safeInteger(control.revision, 'Commerce authority revision') !== expectedRevision ||
    control.import_manifest_sha256 !== manifestSha256
  ) fail('Commerce authority changed while recording the verified import.');
}

export async function cutoverCommerceToD1(args: Args): Promise<Record<string, unknown>> {
  const createdAtMs = Date.now();
  const documents = await sourceDocuments(credential(args));
  validateDomainInvariants(documents);
  rehearseLocalImport(documents);
  const directory = mkdtempSync(join(tmpdir(), 'mons-shop-commerce-cutover-'));
  try {
    const archive = writeArchive(directory, documents, createdAtMs);
    if (args.write) {
      const control = queryRemoteCommerceD1(`SELECT authority_state, revision
        FROM commerce_authority_control WHERE singleton = 1`)[0];
      if (
        control?.authority_state !== 'paused' ||
        safeInteger(control.revision, 'Commerce authority revision') !== args.expectedRevision
      ) fail('Commerce authority must be paused at the expected revision.');
      for (const chunk of archive.chunks) uploadPrivateCommerceArchiveObject(chunk.filePath, chunk.key);
      uploadPrivateCommerceArchiveObject(archive.manifestFilePath, `${archive.prefix}/manifest.json`);
      importDocuments(directory, documents);
      verifyExactImport(documents);
      recordVerifiedImport(
        directory,
        args.expectedRevision!,
        archive.prefix,
        archive.manifestSha256,
        documents,
        archive.kindCounts,
        createdAtMs,
      );
    }
    return {
      mode: args.write ? 'write' : 'dry-run',
      documentCount: documents.length,
      kindCounts: archive.kindCounts,
      manifestSha256: archive.manifestSha256,
      archivePrefix: archive.prefix,
      verified: args.write,
      rehearsed: true,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log(JSON.stringify(await cutoverCommerceToD1(parseCommerceCutoverArgs(process.argv.slice(2))), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
