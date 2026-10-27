import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isEthereumMetadataImage } from '../../shared/ethereum/metadataImage.ts';
import {
  ETHEREUM_ITEM_KINDS, ethereumItemDisplayIdMaximum, ethereumMetadataTokenId,
  type EthereumItemKind, type EthereumMetadata,
} from '../../shared/ethereum/protocol.ts';

export interface MetadataIdentity {
  tokenId: string;
  kind: EthereumItemKind;
  displayId: number;
  file: string;
}

export interface MetadataObject extends MetadataIdentity {
  bytes: number;
  sha256: string;
  md5: string;
}

export interface MetadataManifest {
  version: 1;
  objectCount: number;
  totalBytes: number;
  counts: Record<EthereumItemKind, number>;
  objectsFile: 'objects.jsonl';
  objectsSha256: string;
  templateSha256: Record<EthereumItemKind, string>;
  sourceSha256: Record<string, string>;
}

export type MetadataTemplates = Record<EthereumItemKind, Required<EthereumMetadata>>;

const DEFAULT_TEMPLATES_DIRECTORY = fileURLToPath(new URL('./templates/', import.meta.url));
const SHA256 = /^[a-f0-9]{64}$/;
const MD5 = /^[a-f0-9]{32}$/;
const MAX_METADATA_BYTES = 128 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function metadataShape(value: unknown): value is Required<EthereumMetadata> {
  if (!record(value) || typeof value.name !== 'string' || !value.name || typeof value.description !== 'string' ||
    typeof value.image !== 'string' || !Array.isArray(value.attributes)) return false;
  return value.attributes.every(attribute => record(attribute) && typeof attribute.trait_type === 'string' &&
    attribute.trait_type.length > 0 && (typeof attribute.value === 'string' ||
      typeof attribute.value === 'number' && Number.isFinite(attribute.value)));
}

function requireTemplate(value: unknown, kind: EthereumItemKind): Required<EthereumMetadata> {
  if (!metadataShape(value)) throw new Error(`Invalid metadata template: ${kind}`);
  const body = JSON.stringify(value).replaceAll('{{tokenId}}', '1').replaceAll('{{displayId}}', '1');
  if (/\{\{|\}\}/.test(body)) throw new Error(`Unresolved metadata template placeholder: ${kind}`);
  const image = value.image.replaceAll('{{tokenId}}', '1').replaceAll('{{displayId}}', '1');
  if (!/^https:\/\//i.test(image) || !isEthereumMetadataImage(image)) throw new Error(`Metadata image must be a public HTTPS URL: ${kind}`);
  return value;
}

export async function loadMetadataTemplates(directory = DEFAULT_TEMPLATES_DIRECTORY): Promise<{
  templates: MetadataTemplates;
  sources: Record<EthereumItemKind, string>;
  hashes: Record<EthereumItemKind, string>;
}> {
  const rows = await Promise.all(ETHEREUM_ITEM_KINDS.map(async kind => {
    const source = await readFile(join(directory, `${kind}.json`), 'utf8');
    return { kind, source, template: requireTemplate(JSON.parse(source), kind), hash: sha256(source) };
  }));
  return {
    templates: Object.fromEntries(rows.map(row => [row.kind, row.template])) as MetadataTemplates,
    sources: Object.fromEntries(rows.map(row => [row.kind, row.source])) as Record<EthereumItemKind, string>,
    hashes: Object.fromEntries(rows.map(row => [row.kind, row.hash])) as Record<EthereumItemKind, string>,
  };
}

export function renderMetadata(kind: EthereumItemKind, displayId: number, templates: MetadataTemplates): Required<EthereumMetadata> {
  const tokenId = ethereumMetadataTokenId(kind, displayId);
  const value = requireTemplate(templates[kind], kind);
  const body = JSON.stringify(value).replaceAll('{{tokenId}}', tokenId).replaceAll('{{displayId}}', String(displayId));
  if (/\{\{|\}\}/.test(body)) throw new Error(`Unresolved metadata template placeholder: ${kind}`);
  return requireTemplate(JSON.parse(body), kind);
}

export function metadataBody(identity: MetadataIdentity, templates: MetadataTemplates): string {
  const body = `${JSON.stringify(renderMetadata(identity.kind, identity.displayId, templates), null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_METADATA_BYTES) throw new Error(`Metadata exceeds 128 KiB: ${identity.file}`);
  return body;
}

export function metadataCounts(): Record<EthereumItemKind, number> {
  return Object.fromEntries(ETHEREUM_ITEM_KINDS.map(kind => [kind, ethereumItemDisplayIdMaximum(kind)])) as Record<EthereumItemKind, number>;
}

export function* metadataIdentities(): Generator<MetadataIdentity> {
  for (const kind of ETHEREUM_ITEM_KINDS) {
    for (let displayId = 1; displayId <= ethereumItemDisplayIdMaximum(kind); displayId++) {
      const tokenId = ethereumMetadataTokenId(kind, displayId);
      yield { tokenId, kind, displayId, file: `${tokenId}.json` };
    }
  }
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function md5(value: string | Uint8Array): string {
  return createHash('md5').update(value).digest('hex');
}

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function metadataSources(): Promise<Record<string, string>> {
  const paths = ['../../shared/ethereum/protocol.ts', '../../shared/ethereum/metadataImage.ts', './catalog.ts', './generate.ts'];
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, sha256(await readFile(new URL(path, import.meta.url)))])));
}

export async function readMetadataManifest(directory: string): Promise<MetadataManifest> {
  const manifest: unknown = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const counts = metadataCounts();
  if (!record(manifest) || manifest.version !== 1 || manifest.objectsFile !== 'objects.jsonl' ||
    manifest.objectCount !== Object.values(counts).reduce((sum, count) => sum + count, 0) ||
    !Number.isSafeInteger(manifest.totalBytes) || Number(manifest.totalBytes) < 1 ||
    !record(manifest.counts) || Object.keys(manifest.counts).length !== ETHEREUM_ITEM_KINDS.length ||
    !ETHEREUM_ITEM_KINDS.every(kind => (manifest.counts as Record<string, unknown>)[kind] === counts[kind]) ||
    typeof manifest.objectsSha256 !== 'string' || !SHA256.test(manifest.objectsSha256) ||
    !record(manifest.templateSha256) || Object.keys(manifest.templateSha256).length !== ETHEREUM_ITEM_KINDS.length ||
    !ETHEREUM_ITEM_KINDS.every(kind => typeof (manifest.templateSha256 as Record<string, unknown>)[kind] === 'string' &&
      SHA256.test((manifest.templateSha256 as Record<string, string>)[kind])) ||
    !record(manifest.sourceSha256) || Object.keys(manifest.sourceSha256).length === 0 ||
    !Object.values(manifest.sourceSha256).every(hash => typeof hash === 'string' && SHA256.test(hash))) {
    throw new Error('Metadata manifest does not describe the complete collection');
  }
  if (await fileSha256(join(directory, manifest.objectsFile)) !== manifest.objectsSha256) {
    throw new Error('Metadata object manifest checksum mismatch');
  }
  const { hashes } = await loadMetadataTemplates(join(directory, 'templates'));
  for (const kind of ETHEREUM_ITEM_KINDS) {
    if (hashes[kind] !== manifest.templateSha256[kind]) throw new Error(`Metadata template checksum mismatch: ${kind}`);
  }
  return manifest as unknown as MetadataManifest;
}

export async function* metadataObjects(directory: string): AsyncGenerator<MetadataObject> {
  const expected = metadataIdentities();
  const input = createReadStream(join(directory, 'objects.jsonl'));
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const object: unknown = JSON.parse(line);
      const identity = expected.next().value;
      if (!record(object) || !identity || object.tokenId !== identity.tokenId || object.kind !== identity.kind ||
        object.displayId !== identity.displayId || object.file !== identity.file ||
        typeof object.sha256 !== 'string' || !SHA256.test(object.sha256) ||
        typeof object.md5 !== 'string' || !MD5.test(object.md5) ||
        !Number.isSafeInteger(object.bytes) || Number(object.bytes) < 1 || Number(object.bytes) > MAX_METADATA_BYTES) {
        throw new Error('Metadata object manifest has invalid, duplicated, or out-of-order coverage');
      }
      yield object as unknown as MetadataObject;
    }
    if (!expected.next().done) throw new Error('Metadata object manifest is incomplete');
  } finally {
    lines.close();
    input.destroy();
  }
}

export async function inBatches<T>(items: Iterable<T> | AsyncIterable<T>, concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 128) throw new Error('Concurrency must be between 1 and 128');
  let batch: T[] = [];
  const flush = async () => {
    const results = await Promise.allSettled(batch.map(work));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    batch = [];
  };
  for await (const item of items) {
    batch.push(item);
    if (batch.length === concurrency) await flush();
  }
  if (batch.length) await flush();
}
