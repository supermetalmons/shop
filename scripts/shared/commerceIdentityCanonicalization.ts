import { createHash } from 'node:crypto';
import { canonicalWalletAddress } from '../../shared/walletLifecycle.ts';

export type CommerceIdentityDocument = {
  createTime: string;
  data: Record<string, unknown>;
  kind: string;
  path: string;
  updateTime: string;
  version: number;
};

export type CommerceIdentityManifest = {
  beforeSha256: string;
  changedDocuments: number;
  documentCount: number;
  expectedAfterSha256: string;
  kindCounts: Record<string, number>;
  legacy: {
    firebaseUid: number;
    firebaseOwner: number;
    firebaseOwnerKind: number;
    mergedFirebaseUid: number;
    previousFirebaseOwner: number;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is invalid.`);
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function containsKey(value: unknown, keys: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsKey(entry, keys));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) => keys.has(key) || containsKey(entry, keys));
}

function documentDigestValue(document: CommerceIdentityDocument, data: Record<string, unknown>): string {
  return canonicalJson({
    createTime: document.createTime,
    data,
    kind: document.kind,
    path: document.path,
    updateTime: document.updateTime,
    version: document.version,
  });
}

function assertNoLegacyValue(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoLegacyValue(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    if (typeof value === 'string' && (value === 'firebase' || value.startsWith('firebase:'))) {
      throw new Error(`Legacy identity value remains at ${path}.`);
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'firebaseUid' || key === 'mergedFirebaseUid') {
      throw new Error(`Legacy identity key remains at ${path}.${key}.`);
    }
    assertNoLegacyValue(entry, `${path}.${key}`);
  }
}

function optionalCanonicalSubject(data: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(data, key)) return null;
  const subject = data[key];
  if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 128) {
    throw new Error(`Commerce document has an invalid ${key}.`);
  }
  return subject;
}

function assertNoNestedCanonicalIdentity(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoNestedCanonicalIdentity(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (path !== '$' && (
      key === 'authSubject' || key === 'mergedAuthSubject' || key === 'ownerKind' ||
      ((key === 'owner' || key === 'previousOwner') &&
        typeof entry === 'string' && entry.startsWith('anonymous:'))
    )) {
      throw new Error(`Commerce document has a nested canonical identity at ${path}.${key}.`);
    }
    assertNoNestedCanonicalIdentity(entry, `${path}.${key}`);
  }
}

function assertCanonicalIdentity(data: Record<string, unknown>): void {
  assertNoNestedCanonicalIdentity(data);
  const authSubject = optionalCanonicalSubject(data, 'authSubject');
  const mergedAuthSubject = optionalCanonicalSubject(data, 'mergedAuthSubject');
  const ownerKind = data.ownerKind;
  const owner = typeof data.owner === 'string' ? data.owner : '';
  const previousOwner = typeof data.previousOwner === 'string' ? data.previousOwner : '';
  const hasIdentity = authSubject !== null || mergedAuthSubject !== null ||
    owner.startsWith('anonymous:') || previousOwner.startsWith('anonymous:') ||
    Object.hasOwn(data, 'ownerKind');
  if (!hasIdentity) return;
  if (ownerKind === 'anonymous') {
    if (!authSubject || mergedAuthSubject || owner !== `anonymous:${authSubject}` ||
      Object.hasOwn(data, 'previousOwner') ||
      (Object.hasOwn(data, 'uid') && data.uid !== authSubject)) {
      throw new Error('Commerce document has an invalid canonical anonymous identity.');
    }
    return;
  }
  if (ownerKind === 'wallet') {
    if (canonicalWalletAddress(owner) !== owner ||
      (authSubject && mergedAuthSubject && authSubject !== mergedAuthSubject)) {
      throw new Error('Commerce document has an invalid canonical wallet identity.');
    }
    if (mergedAuthSubject && previousOwner !== `anonymous:${mergedAuthSubject}`) {
      throw new Error('Commerce document has an invalid canonical merged identity.');
    }
    if (!mergedAuthSubject && Object.hasOwn(data, 'previousOwner')) {
      throw new Error('Commerce document has an invalid canonical merged identity.');
    }
    if (Object.hasOwn(data, 'uid')) {
      const uid = data.uid;
      const validUid = typeof uid === 'string' && Boolean(uid) && uid.trim() === uid && uid.length <= 128 &&
        (uid === owner || uid === authSubject || uid === mergedAuthSubject);
      if (!validUid) throw new Error('Commerce document has an invalid canonical wallet uid.');
    }
    return;
  }
  throw new Error('Commerce document has an invalid canonical owner kind.');
}

export function canonicalizeCommerceIdentity(
  data: Record<string, unknown>,
): { changed: boolean; data: Record<string, unknown> } {
  const hasLegacySubject = Object.hasOwn(data, 'firebaseUid');
  const hasMergedLegacySubject = Object.hasOwn(data, 'mergedFirebaseUid');
  const hasCanonicalSubject = containsKey(data, new Set(['authSubject', 'mergedAuthSubject']));
  const hasLegacyValue = Object.values(data).some(
    (value) => typeof value === 'string' && (value === 'firebase' || value.startsWith('firebase:')),
  );
  if (!hasLegacySubject && !hasMergedLegacySubject && !hasLegacyValue) {
    assertNoLegacyValue(data);
    assertCanonicalIdentity(data);
    return { changed: false, data };
  }
  if (!hasLegacySubject || hasCanonicalSubject || data.ownerKind !== 'firebase') {
    throw new Error('Commerce document has an ambiguous legacy identity.');
  }
  const authSubject = requiredString(data.firebaseUid, 'Legacy auth subject');
  const legacyOwner = `firebase:${authSubject}`;
  const canonicalOwner = `anonymous:${authSubject}`;
  const next = structuredClone(data);
  delete next.firebaseUid;

  if (hasMergedLegacySubject) {
    const walletOwner = requiredString(data.owner, 'Merged wallet owner');
    if (
      requiredString(data.mergedFirebaseUid, 'Merged legacy auth subject') !== authSubject ||
      data.previousOwner !== legacyOwner ||
      walletOwner === legacyOwner
    ) {
      throw new Error('Commerce document has an invalid merged legacy identity.');
    }
    delete next.mergedFirebaseUid;
    next.mergedAuthSubject = authSubject;
    next.previousOwner = canonicalOwner;
    next.ownerKind = 'wallet';
  } else {
    if (data.owner !== legacyOwner || Object.hasOwn(data, 'previousOwner')) {
      throw new Error('Commerce document has an invalid legacy owner.');
    }
    next.authSubject = authSubject;
    next.owner = canonicalOwner;
    next.ownerKind = 'anonymous';
  }

  assertNoLegacyValue(next);
  assertCanonicalIdentity(next);
  return { changed: true, data: next };
}

export function buildCommerceIdentityManifest(
  documents: readonly CommerceIdentityDocument[],
): CommerceIdentityManifest {
  const ordered = [...documents].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const before = createHash('sha256');
  const after = createHash('sha256');
  const kindCounts: Record<string, number> = {};
  const legacy = {
    firebaseUid: 0,
    firebaseOwner: 0,
    firebaseOwnerKind: 0,
    mergedFirebaseUid: 0,
    previousFirebaseOwner: 0,
  };
  let changedDocuments = 0;

  for (const document of ordered) {
    kindCounts[document.kind] = (kindCounts[document.kind] || 0) + 1;
    if (Object.hasOwn(document.data, 'firebaseUid')) legacy.firebaseUid += 1;
    if (Object.hasOwn(document.data, 'mergedFirebaseUid')) legacy.mergedFirebaseUid += 1;
    if (document.data.ownerKind === 'firebase') legacy.firebaseOwnerKind += 1;
    if (typeof document.data.owner === 'string' && document.data.owner.startsWith('firebase:')) legacy.firebaseOwner += 1;
    if (typeof document.data.previousOwner === 'string' && document.data.previousOwner.startsWith('firebase:')) {
      legacy.previousFirebaseOwner += 1;
    }
    const canonicalized = canonicalizeCommerceIdentity(document.data);
    if (canonicalized.changed) changedDocuments += 1;
    before.update(documentDigestValue(document, document.data));
    before.update('\n');
    after.update(documentDigestValue(document, canonicalized.data));
    after.update('\n');
  }

  return {
    beforeSha256: before.digest('hex'),
    changedDocuments,
    documentCount: ordered.length,
    expectedAfterSha256: after.digest('hex'),
    kindCounts,
    legacy,
  };
}
