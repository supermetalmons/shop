import { createHash } from 'node:crypto';
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { MAX_REVEAL_METADATA_BYTES } from '../../cloud/workers/api/src/ethereumRevealAttributes.ts';
import type { MetadataWriteFence } from '../ethereum-metadata/publicationLease.ts';

const ACCOUNT = 'e25f90fc073ea309b54b8b5144bf28e0';
const BUCKET = 'cdn-mons-shop';

export type MetadataCleanupPolicy = {
  deletePrefixes: readonly string[];
  hasPrefix(prefix: string): boolean;
  mayDeletePrefix(prefix: string): boolean;
  files(prefix: string): ReadonlySet<string>;
  allowsFile?(prefix: string, file: string): boolean;
  requiresCompleteCoverage(prefix: string): boolean;
  allowsNestedPrefix(prefix: string, nested: string): boolean;
  mayReadKey(key: string): boolean;
};
export type CleanupObject = { key: string; bytes: number; etag: string };
export type CleanupPage = { objects: CleanupObject[]; prefixes: string[]; cursor?: string };
export type CleanupStorage = {
  list(prefix: string, cursor?: string, startAfter?: string): Promise<CleanupPage>;
  get(key: string): Promise<Uint8Array>;
  delete(keys: string[], fence?: MetadataWriteFence): Promise<{ deleted: string[]; errors: Array<{ key: string; code: string }> }>;
  close(): void;
};
export type CleanupInventory = { objectCount: number; totalBytes: number; sha256: string };

function allowsFile(policy: MetadataCleanupPolicy, prefix: string, file: string): boolean {
  return policy.allowsFile ? policy.allowsFile(prefix, file) : policy.files(prefix).has(file);
}

export function validateCleanupObject(policy: MetadataCleanupPolicy, prefix: string, object: CleanupObject): void {
  const file = object.key?.slice(prefix.length);
  if (!policy.hasPrefix(prefix) || !object.key?.startsWith(prefix) || !allowsFile(policy, prefix, file)
    || !Number.isSafeInteger(object.bytes) || object.bytes < 0 || typeof object.etag !== 'string'
    || !/^"[a-f0-9]{32}"$/.test(object.etag)) throw new Error(`Unexpected metadata object in cleanup scope: ${object.key}`);
}

function validatePrefixes(policy: MetadataCleanupPolicy, prefix: string, page: CleanupPage): void {
  if (page.prefixes.some(nested => !policy.allowsNestedPrefix(prefix, nested))) {
    throw new Error(`Unexpected nested metadata namespace under ${prefix}.`);
  }
}

export async function inventoryCleanupPrefix(policy: MetadataCleanupPolicy, storage: CleanupStorage, prefix: string,
  progress: (message: string) => void = () => {}): Promise<CleanupInventory> {
  let cursor: string | undefined;
  let previous = '';
  let objectCount = 0;
  let totalBytes = 0;
  const hash = createHash('sha256');
  const remaining = policy.requiresCompleteCoverage(prefix) ? new Set(policy.files(prefix)) : undefined;
  const cursors = new Set<string>();
  do {
    const page = await storage.list(prefix, cursor);
    validatePrefixes(policy, prefix, page);
    for (const object of page.objects) {
      validateCleanupObject(policy, prefix, object);
      if (object.key <= previous) throw new Error(`Duplicate or unordered R2 listing under ${prefix}.`);
      previous = object.key;
      remaining?.delete(object.key.slice(prefix.length));
      hash.update(`${object.key}\t${object.bytes}\t${object.etag}\n`);
      totalBytes += object.bytes;
      objectCount++;
      if (objectCount % 100_000 === 0) progress(`Inventoried ${objectCount} objects under ${prefix}`);
    }
    if (page.cursor && cursors.has(page.cursor)) throw new Error('Repeated R2 continuation cursor.');
    cursor = page.cursor;
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (remaining?.size || remaining && objectCount !== policy.files(prefix).size) throw new Error('Current collection coverage is incomplete.');
  progress(`Inventoried ${objectCount} objects under ${prefix}`);
  return { objectCount, totalBytes, sha256: hash.digest('hex') };
}

export async function deleteCleanupPrefix(policy: MetadataCleanupPolicy, storage: CleanupStorage, prefix: string, maximum: number,
  progress: (message: string) => void = () => {}, fence?: MetadataWriteFence, options: { concurrency?: number } = {}): Promise<number> {
  if (!policy.mayDeletePrefix(prefix) || !Number.isSafeInteger(maximum) || maximum < 0) throw new Error('Unapproved deletion prefix or count.');
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Cleanup batch concurrency must be between one and eight.');
  let deleted = 0;
  let lastProgress = 0;
  let startAfter: string | undefined;
  while (true) {
    let previous = startAfter ?? '';
    const batches: string[][] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let count = 0;
    for (let index = 0; index < concurrency; index++) {
      const page = await storage.list(prefix, cursor, cursor === undefined ? startAfter : undefined);
      validatePrefixes(policy, prefix, page);
      const keys = page.objects.map(object => {
        validateCleanupObject(policy, prefix, object);
        if (object.key <= previous) throw new Error(`Duplicate, unordered or non-advancing deletion page under ${prefix}.`);
        previous = object.key;
        return object.key;
      });
      if (!keys.length && page.cursor) throw new Error('Empty deletion page with continuation cannot establish completion.');
      count += keys.length;
      if (keys.length > 1000 || deleted + count > maximum) throw new Error(`Deletion inventory changed under ${prefix}.`);
      if (keys.length) batches.push(keys);
      if (page.cursor && cursors.has(page.cursor)) throw new Error('Repeated R2 deletion continuation cursor.');
      cursor = page.cursor;
      if (!cursor) break;
      cursors.add(cursor);
    }
    if (!batches.length) break;
    const outcomes = await Promise.allSettled(batches.map(async keys => {
      fence?.assertWritable();
      const result = await storage.delete(keys, fence);
      const acknowledged = new Set(result.deleted);
      if (result.errors.length || acknowledged.size !== keys.length || result.deleted.length !== keys.length
        || keys.some(key => !acknowledged.has(key))) {
        const failures = result.errors.map(error => `${error.key}:${error.code}`).join(', ');
        throw new Error(`R2 deletion was incomplete under ${prefix}; rerun apply to reconcile remaining keys. ${failures}`);
      }
    }));
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    deleted += count;
    startAfter = previous;
    if (deleted - lastProgress >= 100_000) { progress(`Deleted ${deleted} objects under ${prefix}`); lastProgress = deleted; }
    if (!cursor) break;
  }
  const remaining = await storage.list(prefix);
  validatePrefixes(policy, prefix, remaining);
  for (const object of remaining.objects) validateCleanupObject(policy, prefix, object);
  if (remaining.objects.length || remaining.cursor) throw new Error(`Retired metadata remains under ${prefix}; rerun apply from a fresh inventory.`);
  progress(`Deleted ${deleted} objects under ${prefix}`);
  return deleted;
}

export async function createCleanupStorage(policy: MetadataCleanupPolicy, env: NodeJS.ProcessEnv = process.env): Promise<CleanupStorage> {
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) throw new Error('Existing CLOUDFLARE_API_TOKEN is required for R2 cleanup.');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/tokens/verify`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  const verification = await response.json() as { success?: boolean; result?: { id?: string; status?: string } };
  if (!response.ok || verification.success !== true || verification.result?.status !== 'active'
    || !/^[a-f0-9]{32}$/.test(verification.result.id ?? '')) throw new Error('Could not verify existing Cloudflare account credentials.');
  const client = new S3Client({ region: 'auto', endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: verification.result.id!, secretAccessKey: createHash('sha256').update(token).digest('hex') },
    maxAttempts: 3, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  return {
    async list(prefix, cursor, startAfter) {
      if (!policy.hasPrefix(prefix)) throw new Error('Unapproved inventory prefix.');
      if (startAfter !== undefined && (cursor !== undefined || !startAfter.startsWith(prefix)
        || !allowsFile(policy, prefix, startAfter.slice(prefix.length)))) throw new Error('Invalid R2 listing start-after key.');
      const page = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, Delimiter: '/', MaxKeys: 1000,
        ...(cursor ? { ContinuationToken: cursor } : {}), ...(startAfter !== undefined ? { StartAfter: startAfter } : {}) }),
        { abortSignal: AbortSignal.timeout(30_000) });
      if (page.IsTruncated && (!page.NextContinuationToken || page.NextContinuationToken === cursor)) throw new Error('Invalid R2 continuation cursor.');
      return { objects: (page.Contents ?? []).map(object => ({ key: object.Key!, bytes: object.Size!, etag: object.ETag! })),
        prefixes: (page.CommonPrefixes ?? []).map(prefix => prefix.Prefix!), cursor: page.IsTruncated ? page.NextContinuationToken : undefined };
    },
    async get(key) {
      if (!policy.mayReadKey(key)) throw new Error('Unapproved metadata snapshot key.');
      const object = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }), { abortSignal: AbortSignal.timeout(30_000) });
      if (!object.Body || !Number.isSafeInteger(object.ContentLength) || object.ContentLength! > MAX_REVEAL_METADATA_BYTES) throw new Error('Invalid current metadata response.');
      const bytes = await object.Body.transformToByteArray();
      if (bytes.length !== object.ContentLength) throw new Error('Incomplete current metadata response.');
      return bytes;
    },
    async delete(keys, fence) {
      if (!keys.length || keys.length > 1000 || keys.some(key => !policy.deletePrefixes.some(prefix => key.startsWith(prefix)
        && allowsFile(policy, prefix, key.slice(prefix.length))))) throw new Error('Unapproved R2 delete batch.');
      const command = new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys.map(Key => ({ Key })), Quiet: false } });
      if (fence) command.middlewareStack.add(next => async args => { fence.assertWritable(); return next(args); },
        { step: 'finalizeRequest', priority: 'low', name: 'cleanupPreviewLeaseFence' });
      const timeout = AbortSignal.timeout(30_000);
      const result = await client.send(command, { abortSignal: fence ? AbortSignal.any([timeout, fence.signal]) : timeout });
      return { deleted: (result.Deleted ?? []).map(object => object.Key!),
        errors: (result.Errors ?? []).map(error => ({ key: error.Key ?? '(unknown)', code: error.Code ?? 'unknown' })) };
    },
    close: () => client.destroy(),
  };
}
