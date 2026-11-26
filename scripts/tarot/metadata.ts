import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DMX_RECEIPT_OFFSET } from '../../shared/ethereum/dmx.ts';
import { TAROT_MAX_CARDS } from '../../shared/ethereum/tarotCard.ts';
import { withMetadataLock } from '../ethereum-metadata/lock.ts';
import cardTemplate from './metadata/card.json' with { type: 'json' };
import receiptTemplate from './metadata/receipt.json' with { type: 'json' };
import collectionTemplate from './metadata/collection.json' with { type: 'json' };

export const DMX_METADATA_BASE_URI = 'https://cdn.mons.shop/dmx/';
export const DMX_COLLECTION_METADATA_URI = `${DMX_METADATA_BASE_URI}collection.json`;
export const DMX_METADATA_PREFIX = 'dmx/';
export const DMX_METADATA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_METADATA_BYTES = 128 * 1024;

export type DmxTokenMetadata = {
  name: string; description: string; image: string;
  attributes: Array<{ trait_type: string; value: string | number }>;
};
export type DmxCollectionMetadata = typeof collectionTemplate;
export type DmxMetadataObject = { file: string; bytes: number; sha256: string };
export type DmxMetadataManifest = {
  version: 1; baseURI: typeof DMX_METADATA_BASE_URI; objectCount: number; tokenCount: number;
  totalBytes: number; objectsSha256: string; objects: DmxMetadataObject[];
};
export type DmxMetadataVerification = {
  version: 1; baseURI: typeof DMX_METADATA_BASE_URI; manifestSha256: string; objectsSha256: string;
  objectCount: number; complete: true; publicVerified: true; checkedAt: string;
};

export function dmxMetadataBody(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

export function dmxMetadataSha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

export function dmxMetadataConcurrency(value = 32): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) throw new Error('Invalid DMX metadata concurrency');
  return value;
}

export function buildDmxMetadata(tokenId: number): DmxTokenMetadata {
  const receipt = tokenId > DMX_RECEIPT_OFFSET;
  const cardId = receipt ? tokenId - DMX_RECEIPT_OFFSET : tokenId;
  if (!Number.isSafeInteger(tokenId) || cardId < 1 || cardId > TAROT_MAX_CARDS) {
    throw new Error('DMX static metadata requires an initial card or NFC receipt token ID');
  }
  const metadata: DmxTokenMetadata = JSON.parse(JSON.stringify(receipt ? receiptTemplate : cardTemplate)
    .replaceAll('{{cardId}}', String(cardId)));
  if (JSON.stringify(metadata).includes('{{')) throw new Error('Invalid DMX metadata template');
  return metadata;
}

export function buildDmxCollectionMetadata(): DmxCollectionMetadata {
  return structuredClone(collectionTemplate);
}

function expectedFiles(): string[] {
  return [
    ...Array.from({ length: TAROT_MAX_CARDS }, (_, index) => `${index + 1}.json`),
    ...Array.from({ length: TAROT_MAX_CARDS }, (_, index) => `${DMX_RECEIPT_OFFSET + index + 1}.json`),
    'collection.json',
  ];
}

export function validateDmxMetadataManifest(value: unknown): DmxMetadataManifest {
  if (!value || typeof value !== 'object') throw new Error('Invalid DMX metadata manifest');
  const manifest = value as DmxMetadataManifest;
  const files = expectedFiles();
  if (manifest.version !== 1 || manifest.baseURI !== DMX_METADATA_BASE_URI ||
    manifest.objectCount !== files.length || manifest.tokenCount !== files.length - 1 ||
    !Array.isArray(manifest.objects) || manifest.objects.length !== files.length ||
    Object.keys(manifest).sort().join(',') !== 'baseURI,objectCount,objects,objectsSha256,tokenCount,totalBytes,version') {
    throw new Error('Invalid DMX metadata manifest scope');
  }
  for (const [index, object] of manifest.objects.entries()) {
    if (!object || object.file !== files[index] || !Number.isSafeInteger(object.bytes) ||
      object.bytes < 1 || object.bytes > MAX_METADATA_BYTES || !/^[a-f0-9]{64}$/.test(object.sha256) ||
      Object.keys(object).sort().join(',') !== 'bytes,file,sha256') throw new Error('Invalid DMX metadata object');
  }
  if (manifest.totalBytes !== manifest.objects.reduce((sum, object) => sum + object.bytes, 0) ||
    manifest.objectsSha256 !== dmxMetadataSha256(dmxMetadataBody(manifest.objects))) {
    throw new Error('DMX metadata manifest checksum mismatch');
  }
  return manifest;
}

export function dmxMetadataManifestSha256(manifest: DmxMetadataManifest): string {
  return dmxMetadataSha256(dmxMetadataBody(validateDmxMetadataManifest(manifest)));
}

export async function loadDmxMetadataManifest(directory: string): Promise<DmxMetadataManifest> {
  return readDmxMetadataManifest(join(directory, 'manifest.json'));
}

export async function readDmxMetadataManifest(path: string): Promise<DmxMetadataManifest> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid DMX metadata manifest file');
  const body = await readFile(path);
  const manifest = validateDmxMetadataManifest(JSON.parse(body.toString('utf8')));
  if (!body.equals(dmxMetadataBody(manifest))) throw new Error('DMX metadata manifest is not canonical');
  return manifest;
}

export async function loadDmxMetadataBody(directory: string, file: string, manifest?: DmxMetadataManifest): Promise<Buffer> {
  const publication = manifest ?? await loadDmxMetadataManifest(directory);
  const object = publication.objects.find(row => row.file === file);
  if (!object) throw new Error('File is outside the DMX metadata manifest');
  const path = join(directory, file);
  const info = await lstat(path);
  if (!info.isFile() || info.size !== object.bytes) throw new Error(`Invalid DMX metadata file: ${file}`);
  const body = await readFile(path);
  if (dmxMetadataSha256(body) !== object.sha256) throw new Error(`DMX metadata checksum mismatch: ${file}`);
  return body;
}

export async function dmxMetadataDirectory(directory: string, root = DMX_METADATA_ROOT): Promise<string> {
  const base = resolve(root, '.cache/dmx-metadata');
  const target = resolve(directory);
  const within = relative(base, target);
  if (!within || within.startsWith(`..${sep}`) || within === '..' || resolve(base, within) !== target) {
    throw new Error('DMX metadata revisions must be beneath .cache/dmx-metadata');
  }
  await mkdir(target, { recursive: true });
  if (await realpath(root) !== resolve(root) || await realpath(target) !== target) {
    throw new Error('DMX metadata directory must not use symbolic links');
  }
  return target;
}

async function createExact(path: string, body: Buffer): Promise<void> {
  try { await writeFile(path, body, { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!(await lstat(path)).isFile() || !(await readFile(path)).equals(body)) {
      throw new Error('DMX revision already contains different metadata; use a new revision directory');
    }
  }
}

export async function generateDmxMetadata(directory: string, options: { root?: string } = {}): Promise<DmxMetadataManifest> {
  const target = await dmxMetadataDirectory(directory, options.root);
  return withMetadataLock(join(target, '.generate.lock'), async () => {
    const objects: DmxMetadataObject[] = [];
    for (const file of expectedFiles()) {
      const body = dmxMetadataBody(file === 'collection.json'
        ? buildDmxCollectionMetadata() : buildDmxMetadata(Number(file.slice(0, -5))));
      await createExact(join(target, file), body);
      objects.push({ file, bytes: body.length, sha256: dmxMetadataSha256(body) });
    }
    const manifest: DmxMetadataManifest = { version: 1, baseURI: DMX_METADATA_BASE_URI,
      objectCount: objects.length, tokenCount: objects.length - 1,
      totalBytes: objects.reduce((sum, object) => sum + object.bytes, 0),
      objectsSha256: dmxMetadataSha256(dmxMetadataBody(objects)), objects };
    await createExact(join(target, 'manifest.json'), dmxMetadataBody(manifest));
    return validateDmxMetadataManifest(manifest);
  });
}

async function readPublicBody(response: Response, maximum: number): Promise<Buffer> {
  if (!response.body) throw new Error('Missing DMX public metadata body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return Buffer.concat(chunks, bytes);
      bytes += result.value.length;
      if (bytes > maximum) throw new Error('DMX public metadata body exceeds expected size');
      chunks.push(result.value);
    }
  } finally { await reader.cancel(); }
}

export async function verifyDmxPublishedMetadata(manifest: DmxMetadataManifest,
  options: { fetcher?: typeof fetch; concurrency?: number } = {}): Promise<DmxMetadataVerification> {
  validateDmxMetadataManifest(manifest);
  const concurrency = dmxMetadataConcurrency(options.concurrency);
  const fetcher = options.fetcher ?? fetch;
  for (let index = 0; index < manifest.objects.length; index += concurrency) {
    const checks = await Promise.allSettled(manifest.objects.slice(index, index + concurrency).map(async object => {
      const response = await fetcher(`${DMX_METADATA_BASE_URI}${object.file}`, {
        headers: { Origin: 'https://mons.shop', Accept: 'application/json' }, cache: 'no-store', redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status !== 200 || response.redirected ||
        response.headers.get('content-type') !== 'application/json; charset=utf-8' ||
        response.headers.get('cache-control') !== 'no-store' || response.headers.get('access-control-allow-origin') !== '*' ||
        response.headers.get('cf-cache-status') === 'HIT') {
        await response.body?.cancel();
        throw new Error(`DMX public metadata headers failed: ${object.file}`);
      }
      const body = await readPublicBody(response, object.bytes);
      if (body.length !== object.bytes || dmxMetadataSha256(body) !== object.sha256) {
        throw new Error(`DMX public metadata content mismatch: ${object.file}`);
      }
    }));
    const failed = checks.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  return { version: 1, baseURI: DMX_METADATA_BASE_URI, manifestSha256: dmxMetadataManifestSha256(manifest),
    objectsSha256: manifest.objectsSha256, objectCount: manifest.objectCount, complete: true, publicVerified: true,
    checkedAt: new Date().toISOString() };
}
