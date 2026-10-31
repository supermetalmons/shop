import { createHash } from 'node:crypto';
import { Agent } from 'node:https';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { MetadataWriteFence } from './publicationLease.ts';

export type MetadataNetwork = 'sepolia' | 'mainnet';
export type MetadataNetworkSelection = MetadataNetwork | 'all';
export type RemoteObject = { key: string; bytes: number; md5: string };
export type UploadDestination = { endpoint: string; bucket: string };
export type MetadataListRange = { startAfter?: string; endAt?: string };
export interface MetadataStorage {
  destination: UploadDestination;
  list(prefix: string, range?: MetadataListRange): AsyncIterable<RemoteObject>;
  get(key: string): Promise<Buffer>;
  put(key: string, body: Buffer, expectedEtag?: string | null, fence?: MetadataWriteFence): Promise<void>;
  close(): void;
}

export interface MetadataNamespaceStorage extends MetadataStorage {
  prefixes(root: string): AsyncIterable<string>;
}

export function metadataPrefix(network: MetadataNetwork, prefix?: string): string {
  const root = network === 'sepolia' ? '111k-sepolia/' : network === 'mainnet' ? '111k/' : '';
  if (!root) throw new Error('Network must be sepolia or mainnet');
  if (prefix === undefined || prefix === root) return root;
  if (!new RegExp(`^${root}[a-z0-9][a-z0-9-]{0,63}/$`).test(prefix)) throw new Error('Invalid deployment metadata prefix');
  return prefix;
}

export function metadataNetworks(network: MetadataNetworkSelection): MetadataNetwork[] {
  if (network === 'all') return ['sepolia', 'mainnet'];
  metadataPrefix(network);
  return [network];
}

export function metadataUploadConcurrency(value = 32): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 256) throw new Error('Concurrency must be between 1 and 256');
  return value;
}

export async function uploadWithConcurrency<T>(items: Iterable<T> | AsyncIterable<T>, concurrency: number,
  work: (item: T) => Promise<void>): Promise<void> {
  metadataUploadConcurrency(concurrency);
  const iterator = (items as AsyncIterable<T>)[Symbol.asyncIterator]?.() ?? (items as Iterable<T>)[Symbol.iterator]();
  let failure: { error: unknown } | undefined;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    try {
      while (!failure) {
        const next = await iterator.next();
        if (next.done || failure) return;
        await work(next.value);
      }
    } catch (error) { failure ??= { error }; }
  }));
  try { await iterator.return?.(); } catch (error) { failure ??= { error }; }
  if (failure) throw failure.error;
}

export function metadataMd5(body: Uint8Array): string {
  return createHash('md5').update(body).digest('hex');
}

export class S3MetadataStorage implements MetadataNamespaceStorage {
  constructor(readonly destination: UploadDestination, private readonly client: S3Client) {}

  async *prefixes(root: string): AsyncGenerator<string> {
    if (!['111k/', '111k-sepolia/'].includes(root)) throw new Error('Invalid metadata namespace root');
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.destination.bucket,
        Prefix: root, Delimiter: '/', MaxKeys: 1000, ...(cursor ? { ContinuationToken: cursor } : {}),
      }), { abortSignal: AbortSignal.timeout(30_000) });
      for (const namespace of page.CommonPrefixes ?? []) {
        const prefix = namespace.Prefix;
        if (!prefix?.startsWith(root) || !/^[a-z0-9][a-z0-9-]{0,63}\/$/.test(prefix.slice(root.length))) {
          throw new Error(`Invalid nested metadata namespace: ${prefix ?? '(missing prefix)'}`);
        }
        if (!seen.has(prefix)) { seen.add(prefix); yield prefix; }
      }
      if (!page.IsTruncated) break;
      if (!page.NextContinuationToken || page.NextContinuationToken === cursor) throw new Error('Invalid R2 listing continuation');
      cursor = page.NextContinuationToken;
    } while (true);
  }

  async *list(prefix: string, range: MetadataListRange = {}): AsyncGenerator<RemoteObject> {
    if ((range.startAfter !== undefined && !range.startAfter.startsWith(prefix)) ||
      (range.endAt !== undefined && !range.endAt.startsWith(prefix)) ||
      (range.startAfter !== undefined && range.endAt !== undefined && range.startAfter >= range.endAt)) {
      throw new Error('Invalid R2 listing range');
    }
    let cursor: string | undefined;
    let previous = range.startAfter;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.destination.bucket,
        Prefix: prefix, Delimiter: '/', MaxKeys: 1000, ...(cursor ? { ContinuationToken: cursor } : { StartAfter: range.startAfter }),
      }), { abortSignal: AbortSignal.timeout(30_000) });
      for (const namespace of page.CommonPrefixes ?? []) {
        if (!namespace.Prefix?.startsWith(prefix) || !/^[a-z0-9][a-z0-9-]{0,63}\/$/.test(namespace.Prefix.slice(prefix.length))) {
          throw new Error(`Invalid nested metadata namespace: ${namespace.Prefix ?? '(missing prefix)'}`);
        }
      }
      for (const object of page.Contents ?? []) {
        if (!object.Key?.startsWith(prefix) || (previous !== undefined && object.Key <= previous)) {
          throw new Error(`Invalid remote metadata key order: ${object.Key ?? '(missing key)'}`);
        }
        previous = object.Key;
        if (range.endAt !== undefined && object.Key > range.endAt) return;
        if (!Number.isSafeInteger(object.Size) || object.Size! < 0 || !/^"[^"]+"$/.test(object.ETag ?? '')) {
          throw new Error(`Invalid remote metadata object: ${object.Key ?? '(missing key)'}`);
        }
        yield { key: object.Key, bytes: object.Size!, md5: object.ETag!.slice(1, -1) };
        if (object.Key === range.endAt) return;
      }
      if (!page.IsTruncated) break;
      if (!page.NextContinuationToken || page.NextContinuationToken === cursor) throw new Error('Invalid R2 listing continuation');
      cursor = page.NextContinuationToken;
    } while (true);
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.destination.bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(30_000) });
    if (!response.Body || !Number.isSafeInteger(response.ContentLength) || response.ContentLength! > 128 * 1024) {
      throw new Error(`Invalid R2 metadata response: ${key}`);
    }
    const body = Buffer.from(await response.Body.transformToByteArray());
    if (body.length !== response.ContentLength) throw new Error(`Incomplete R2 metadata response: ${key}`);
    return body;
  }

  async put(key: string, body: Buffer, expectedEtag?: string | null, fence?: MetadataWriteFence): Promise<void> {
    const md5 = metadataMd5(body);
    const command = new PutObjectCommand({ Bucket: this.destination.bucket, Key: key, Body: body,
      ContentLength: body.length, ContentType: 'application/json; charset=utf-8', CacheControl: 'no-store',
      ContentMD5: Buffer.from(md5, 'hex').toString('base64'),
      ...(expectedEtag === null ? { IfNoneMatch: '*' } : expectedEtag !== undefined ? { IfMatch: expectedEtag } : {}),
      Metadata: { sha256: createHash('sha256').update(body).digest('hex') },
    });
    if (fence) command.middlewareStack.add(next => async args => { fence.assertWritable(); return next(args); },
      { step: 'finalizeRequest', priority: 'low', name: 'metadataPublicationFence' });
    const timeout = AbortSignal.timeout(30_000);
    fence?.assertWritable();
    const response = await this.client.send(command, { abortSignal: fence ? AbortSignal.any([timeout, fence.signal]) : timeout });
    if (response.ETag !== `"${md5}"`) throw new Error(`Uploaded object checksum mismatch: ${key}`);
  }

  close(): void { this.client.destroy(); }
}

export function environmentStorage(concurrency: number): MetadataNamespaceStorage {
  metadataUploadConcurrency(concurrency);
  const endpoint = process.env.R2_ENDPOINT || (process.env.CLOUDFLARE_ACCOUNT_ID
    ? `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
  const bucket = process.env.R2_BUCKET || 'cdn-mons-shop';
  const accessKeyId = process.env.R2_ACCESS_KEY_ID || process.env.CLOUDFLARE_API_TOKEN_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || (process.env.CLOUDFLARE_API_TOKEN
    ? createHash('sha256').update(process.env.CLOUDFLARE_API_TOKEN).digest('hex') : '');
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('Set R2_ENDPOINT (or CLOUDFLARE_ACCOUNT_ID), R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY (or CLOUDFLARE_API_TOKEN)');
  }
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || url.pathname !== '/' ||
    !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname)) throw new Error('R2_ENDPOINT must be an HTTPS Cloudflare R2 account endpoint');
  if (bucket !== 'cdn-mons-shop') throw new Error('111K metadata may only be published to cdn-mons-shop');
  return new S3MetadataStorage({ endpoint: url.origin, bucket }, new S3Client({ region: 'auto', endpoint: url.origin,
    credentials: { accessKeyId, secretAccessKey, sessionToken: process.env.R2_SESSION_TOKEN || undefined },
    requestHandler: { httpsAgent: new Agent({ keepAlive: true, maxSockets: concurrency }) }, maxAttempts: 5,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  }));
}
