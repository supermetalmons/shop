import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Agent } from 'node:https';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { EthereumMetadataNetwork } from '../../shared/ethereum/placeholderMetadata.ts';
import { fileSha256, metadataIdentities, metadataObjects, readMetadataManifest, sha256, type MetadataObject } from './catalog.ts';

interface UploadDestination {
  endpoint: string;
  bucket: string;
  prefix: string;
}

export function metadataUploadConcurrency(concurrency: number): number {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 512) throw new Error('Concurrency must be between 1 and 512');
  return concurrency;
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
    } catch (error) {
      failure ??= { error };
    }
  }));
  try { await iterator.return?.(); } catch (error) { failure ??= { error }; }
  if (failure) throw failure.error;
}

export async function uploadMetadataObject(client: Pick<S3Client, 'send'>, destination: UploadDestination, object: MetadataObject, body: Buffer): Promise<void> {
  if (body.length !== object.bytes || sha256(body) !== object.sha256) throw new Error(`Local checksum mismatch: ${object.file}`);
  const key = destination.prefix + object.file;
  const md5 = createHash('md5').update(body).digest();
  const expectedEtag = `"${md5.toString('hex')}"`;
  const requestOptions = { abortSignal: AbortSignal.timeout(30_000) };
  try {
    const response = await client.send(new PutObjectCommand({
      Bucket: destination.bucket, Key: key, Body: body, ContentLength: body.length,
      ContentType: 'application/json; charset=utf-8', CacheControl: 'no-store',
      ContentMD5: md5.toString('base64'), Metadata: { sha256: object.sha256 }, IfNoneMatch: '*',
    }), requestOptions);
    if (response.ETag !== expectedEtag) throw new Error(`Uploaded object checksum mismatch: ${key}`);
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412) throw error;
    const existing = await client.send(new HeadObjectCommand({ Bucket: destination.bucket, Key: key }), requestOptions);
    if (existing.ContentLength !== body.length || existing.ETag !== expectedEtag || existing.Metadata?.sha256 !== object.sha256) {
      throw new Error(`Destination already contains different metadata: ${key}`);
    }
  }
}

function environmentDestination(prefix: string, concurrency: number): { destination: UploadDestination; client: S3Client } {
  const endpoint = process.env.R2_ENDPOINT || (process.env.CLOUDFLARE_ACCOUNT_ID ? `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('Set R2_ENDPOINT (or CLOUDFLARE_ACCOUNT_ID), R2_BUCKET, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY');
  }
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    !/^[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/.test(url.hostname)) throw new Error('R2_ENDPOINT must be an HTTPS Cloudflare R2 account endpoint');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Invalid R2_BUCKET');
  return {
    destination: { endpoint: url.origin, bucket, prefix },
    client: new S3Client({
      region: 'auto', endpoint: url.origin, credentials: { accessKeyId, secretAccessKey, sessionToken: process.env.R2_SESSION_TOKEN || undefined },
      requestHandler: { httpsAgent: new Agent({ keepAlive: true, maxSockets: concurrency }) },
      maxAttempts: 5, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    }),
  };
}

export async function uploadMetadata(directory: string, network: EthereumMetadataNetwork, options: {
  concurrency?: number;
  journal?: string;
  tokenIds?: string[];
  progress?: (counts: { uploaded: number; skipped: number; total: number }) => void;
} = {}) {
  const selected = options.tokenIds ? new Set(options.tokenIds) : undefined;
  if (selected) {
    const unknown = new Set(selected);
    for (const identity of metadataIdentities()) unknown.delete(identity.tokenId);
    if (!selected.size || unknown.size) throw new Error('Requested metadata token IDs are outside the collection');
  }
  const concurrency = metadataUploadConcurrency(options.concurrency ?? 16);
  const manifest = await readMetadataManifest(directory, network);
  const validation = JSON.parse(await readFile(join(directory, 'validation.json'), 'utf8'));
  if (validation.manifestSha256 !== await fileSha256(join(directory, 'manifest.json')) ||
    validation.objectsSha256 !== manifest.objectsSha256 || validation.objectCount !== manifest.objectCount ||
    validation.totalBytes !== manifest.totalBytes || validation.artworkGeometryCount !== 222222 || validation.digitalReceiptMatches !== 111111) {
    throw new Error('Run validate successfully before uploading this manifest');
  }
  const { destination, client } = environmentDestination(manifest.prefix, concurrency);
  const journalPath = options.journal ?? join(directory, 'upload-journal.jsonl');
  await mkdir(dirname(journalPath), { recursive: true });
  const lock = await open(`${journalPath}.lock`, 'wx');
  let journal: Awaited<ReturnType<typeof open>> | undefined;
  const header = { version: 1, ...destination, network, objectsSha256: manifest.objectsSha256 };
  try {
    const done = new Map<string, string>();
    try {
      const bytes = await readFile(journalPath, 'utf8');
      const complete = bytes.slice(0, bytes.lastIndexOf('\n') + 1);
      const rows = complete.trimEnd().split('\n');
      if (rows[0] !== JSON.stringify(header)) throw new Error('Upload journal belongs to a different destination or manifest');
      for (const line of rows.slice(1)) {
        const row: { tokenId: string; sha256: string } = JSON.parse(line);
        if (!/^[1-9]\d*$/.test(row.tokenId) || !/^[a-f0-9]{64}$/.test(row.sha256) || (done.has(row.tokenId) && done.get(row.tokenId) !== row.sha256)) {
          throw new Error('Upload journal contains an invalid completion record');
        }
        done.set(row.tokenId, row.sha256);
      }
      if (complete !== bytes) await writeFile(journalPath, complete);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeFile(journalPath, JSON.stringify(header) + '\n', { flag: 'wx' });
    }
    journal = await open(journalPath, 'a');
    let journalTail: Promise<unknown> = Promise.resolve();
    let uploaded = 0;
    let skipped = 0;
    let visited = 0;
    const remaining = selected ? new Set(selected) : undefined;
    await uploadWithConcurrency(metadataObjects(directory), concurrency, async object => {
      visited++;
      if (selected && !selected.has(object.tokenId)) return;
      remaining?.delete(object.tokenId);
      const completedHash = done.get(object.tokenId);
      if (completedHash) {
        if (completedHash !== object.sha256) throw new Error(`Upload journal checksum mismatch: ${object.file}`);
        skipped++;
      } else {
        const body = await readFile(join(directory, object.file));
        await uploadMetadataObject(client, destination, object, body);
        journalTail = journalTail.then(() => journal!.write(JSON.stringify({ tokenId: object.tokenId, sha256: object.sha256 }) + '\n'));
        await journalTail;
        uploaded++;
      }
      if ((uploaded + skipped) % 1000 === 0) options.progress?.({ uploaded, skipped, total: selected?.size ?? manifest.objectCount });
    });
    if (visited !== manifest.objectCount || remaining?.size) throw new Error('Requested metadata token IDs are outside the collection');
    await journal.sync();
    const report = { network, bucket: destination.bucket, prefix: destination.prefix, objectsSha256: manifest.objectsSha256,
      uploaded, skipped, complete: !selected && uploaded + skipped === manifest.objectCount };
    options.progress?.({ uploaded, skipped, total: selected?.size ?? manifest.objectCount });
    await writeFile(join(directory, selected ? 'upload-sample.json' : 'upload.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally {
    await journal?.close();
    await lock.close();
    await rm(`${journalPath}.lock`, { force: true });
    client.destroy();
  }
}
