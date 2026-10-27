import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import {
  ETHEREUM_ITEM_KINDS, ethereumItemDisplayIdMaximum, ethereumItemKindNumber, ethereumMetadataTokenId,
} from '../../shared/ethereum/protocol.ts';
import type { EthereumMetadataNetwork } from '../../shared/ethereum/placeholderMetadata.ts';

export interface MetadataIdentity {
  tokenId: string;
  kind: number;
  displayId: number;
  file: string;
}

export interface MetadataObject extends MetadataIdentity {
  sha256: string;
  bytes: number;
}

export interface MetadataManifest {
  version: 1;
  network: EthereumMetadataNetwork;
  prefix: string;
  objectCount: number;
  totalBytes: number;
  counts: Record<string, number>;
  objectsFile: 'objects.jsonl';
  objectsSha256: string;
  sourceSha256: Record<string, string>;
}

export function metadataPrefix(network: EthereumMetadataNetwork): string {
  return network === 'sepolia' ? '111k-sepolia/' : '111k/';
}

export function metadataCounts(): Record<string, number> {
  return Object.fromEntries(ETHEREUM_ITEM_KINDS.map(kind => [kind, ethereumItemDisplayIdMaximum(kind)]));
}

export function* metadataIdentities(): Generator<MetadataIdentity> {
  for (const itemKind of ETHEREUM_ITEM_KINDS) {
    for (let displayId = 1; displayId <= ethereumItemDisplayIdMaximum(itemKind); displayId++) {
      const tokenId = ethereumMetadataTokenId(itemKind, displayId);
      yield { tokenId, kind: ethereumItemKindNumber(itemKind), displayId, file: `${tokenId}.json` };
    }
  }
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function metadataSources(): Promise<Record<string, string>> {
  const sources = [
    '../../shared/ethereum/placeholderMetadata.ts', '../../shared/ethereum/protocol.ts',
    './catalog.ts', './generate.ts',
  ];
  return Object.fromEntries(await Promise.all(sources.map(async path => [path, sha256(await readFile(new URL(path, import.meta.url)))])));
}

export async function readMetadataManifest(directory: string, network: EthereumMetadataNetwork): Promise<MetadataManifest> {
  const manifest: MetadataManifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const counts = metadataCounts();
  if (manifest.version !== 1 || manifest.network !== network || manifest.prefix !== metadataPrefix(network) ||
    manifest.objectsFile !== 'objects.jsonl' || manifest.objectCount !== Object.values(counts).reduce((a, b) => a + b, 0) ||
    JSON.stringify(manifest.counts) !== JSON.stringify(counts) || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 1 ||
    !/^[a-f0-9]{64}$/.test(manifest.objectsSha256) ||
    JSON.stringify(manifest.sourceSha256) !== JSON.stringify(await metadataSources())) {
    throw new Error('Metadata manifest does not match the current generator, network, or complete collection');
  }
  if (await fileSha256(join(directory, manifest.objectsFile)) !== manifest.objectsSha256) throw new Error('Metadata object manifest checksum mismatch');
  return manifest;
}

export async function* metadataObjects(directory: string): AsyncGenerator<MetadataObject> {
  const expected = metadataIdentities();
  const lines = createInterface({ input: createReadStream(join(directory, 'objects.jsonl')), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const object: MetadataObject = JSON.parse(line);
      const identity = expected.next().value;
      if (!identity || object.tokenId !== identity.tokenId || object.kind !== identity.kind || object.displayId !== identity.displayId ||
        object.file !== identity.file || !/^[a-f0-9]{64}$/.test(object.sha256) || !Number.isSafeInteger(object.bytes) || object.bytes < 1) {
        throw new Error('Metadata object manifest has invalid, duplicated, or out-of-order coverage');
      }
      yield object;
    }
    if (!expected.next().done) throw new Error('Metadata object manifest is incomplete');
  } finally {
    lines.close();
  }
}

export async function inBatches<T>(items: Iterable<T> | AsyncIterable<T>, concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 128) throw new Error('Concurrency must be between 1 and 128');
  let batch: T[] = [];
  for await (const item of items) {
    batch.push(item);
    if (batch.length === concurrency) {
      const results = await Promise.allSettled(batch.map(work));
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
      batch = [];
    }
  }
  const results = await Promise.allSettled(batch.map(work));
  const rejected = results.find(result => result.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
}
