import { canonicalWalletAddress } from '../../shared/walletLifecycle.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalSubject(data: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(data, key)) return null;
  const subject = data[key];
  if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 128) {
    throw new Error(`Commerce document has an invalid ${key}.`);
  }
  return subject;
}

function assertNoNestedIdentity(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoNestedIdentity(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (path !== '$' && (
      key === 'authSubject' || key === 'mergedAuthSubject' || key === 'ownerKind' ||
      ((key === 'owner' || key === 'previousOwner') &&
        typeof entry === 'string' && entry.startsWith('anonymous:'))
    )) {
      throw new Error(`Commerce document has nested identity data at ${path}.${key}.`);
    }
    assertNoNestedIdentity(entry, `${path}.${key}`);
  }
}

export function assertCanonicalCommerceIdentity(data: Record<string, unknown>): void {
  if (Object.hasOwn(data, 'uid')) {
    throw new Error('Commerce document has a noncanonical identity subject.');
  }
  assertNoNestedIdentity(data);
  const authSubject = optionalSubject(data, 'authSubject');
  const mergedAuthSubject = optionalSubject(data, 'mergedAuthSubject');
  const ownerKind = data.ownerKind;
  const owner = typeof data.owner === 'string' ? data.owner : '';
  const previousOwner = typeof data.previousOwner === 'string' ? data.previousOwner : '';
  const hasIdentity = authSubject !== null || mergedAuthSubject !== null ||
    owner.startsWith('anonymous:') || previousOwner.startsWith('anonymous:') ||
    Object.hasOwn(data, 'ownerKind');
  if (!hasIdentity) return;
  if (ownerKind === 'anonymous') {
    if (!authSubject || mergedAuthSubject || owner !== `anonymous:${authSubject}` ||
      Object.hasOwn(data, 'previousOwner')) {
      throw new Error('Commerce document has an invalid anonymous identity.');
    }
    return;
  }
  if (ownerKind === 'wallet') {
    if (canonicalWalletAddress(owner) !== owner ||
      (authSubject && mergedAuthSubject && authSubject !== mergedAuthSubject)) {
      throw new Error('Commerce document has an invalid wallet identity.');
    }
    if (mergedAuthSubject && previousOwner !== `anonymous:${mergedAuthSubject}`) {
      throw new Error('Commerce document has an invalid merged identity.');
    }
    if (!mergedAuthSubject && Object.hasOwn(data, 'previousOwner')) {
      throw new Error('Commerce document has an invalid merged identity.');
    }
    return;
  }
  throw new Error('Commerce document has an invalid owner kind.');
}
