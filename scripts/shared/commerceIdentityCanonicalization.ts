import { createHash } from 'node:crypto';

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

export function canonicalizeCommerceIdentity(
  data: Record<string, unknown>,
): { changed: boolean; data: Record<string, unknown> } {
  const hasLegacySubject = Object.hasOwn(data, 'firebaseUid');
  const hasMergedLegacySubject = Object.hasOwn(data, 'mergedFirebaseUid');
  const hasCanonicalSubject = Object.hasOwn(data, 'authSubject') || Object.hasOwn(data, 'mergedAuthSubject');
  const hasLegacyValue = Object.values(data).some(
    (value) => typeof value === 'string' && (value === 'firebase' || value.startsWith('firebase:')),
  );
  if (!hasLegacySubject && !hasMergedLegacySubject && !hasLegacyValue) {
    assertNoLegacyValue(data);
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
    if (
      requiredString(data.mergedFirebaseUid, 'Merged legacy auth subject') !== authSubject ||
      data.previousOwner !== legacyOwner ||
      typeof data.owner !== 'string' ||
      data.owner === legacyOwner
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
  return { changed: true, data: next };
}

export function buildCommerceIdentityManifest(
  documents: readonly CommerceIdentityDocument[],
): CommerceIdentityManifest {
  const ordered = [...documents].sort((left, right) => left.path.localeCompare(right.path));
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
