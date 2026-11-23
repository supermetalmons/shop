import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TAROT_MAX_CARDS, TAROT_METADATA_BASE_URI, tarotReceiptTokenId } from '../../shared/ethereum/tarot.ts';
import { metadataMd5, uploadWithConcurrency, type MetadataStorage } from '../ethereum-metadata/storage.ts';

export const TAROT_METADATA_PREFIX = new URL(TAROT_METADATA_BASE_URI).pathname.slice(1);

export function tarotMetadataObjects(): Map<string, Buffer> {
  const objects = new Map<string, Buffer>();
  const add = (name: string, value: object) => objects.set(name, Buffer.from(JSON.stringify(value, null, 2) + '\n'));
  for (let tokenId = 1; tokenId <= TAROT_MAX_CARDS; tokenId++) {
    for (const receipt of [false, true]) {
      add(`${receipt ? tarotReceiptTokenId(tokenId) : tokenId}.json`, {
        name: `${receipt ? 'Tarot Card Receipt' : 'Tarot Card'} #${tokenId}`,
        description: receipt ? 'Proves the authenticity of the physical Tarot card you scanned.' : 'A mutating Tarot card. Initial base artwork.',
        image: `https://wip.lil.org/tarot/${receipt ? 'receipts' : 'bases'}/${tokenId}.webp`,
        attributes: [{ trait_type: 'Kind', value: receipt ? 'NFC Card Receipt' : 'Mutating Card' },
          { trait_type: 'Card ID', value: tokenId }],
      });
    }
  }
  add('collection.json', { name: 'Tarot Cards', description: '777 Tarot cards and their paired NFC receipts.',
    image: 'https://wip.lil.org/tarot/bases/1.webp', external_link: 'https://mons.shop' });
  return objects;
}

function catalogReport(objects: Map<string, Buffer>) {
  const hash = createHash('sha256');
  for (const [name, body] of [...objects].sort(([a], [b]) => a.localeCompare(b))) hash.update(name).update('\0').update(body);
  return { metadataBaseUri: TAROT_METADATA_BASE_URI, cards: TAROT_MAX_CARDS, receipts: TAROT_MAX_CARDS,
    objectCount: objects.size, catalogSha256: hash.digest('hex') };
}

export function generateTarotMetadata(directory: string) {
  const objects = tarotMetadataObjects();
  mkdirSync(directory, { recursive: true });
  for (const [name, body] of objects) writeFileSync(join(directory, name), body);
  return catalogReport(objects);
}

export async function publishTarotMetadata(storage: MetadataStorage) {
  const objects = tarotMetadataObjects();
  const existing = new Map<string, { bytes: number; md5: string }>();
  for await (const object of storage.list(TAROT_METADATA_PREFIX)) {
    const name = object.key.slice(TAROT_METADATA_PREFIX.length);
    const body = objects.get(name);
    if (!body || object.bytes !== body.length || object.md5 !== metadataMd5(body)) {
      throw new Error('Existing Tarot metadata conflicts with this release; refusing to overwrite it.');
    }
    existing.set(name, object);
  }
  await uploadWithConcurrency(objects, 16, async ([name, body]) => {
    if (!existing.has(name)) await storage.put(TAROT_METADATA_PREFIX + name, body, null);
    if (!(await storage.get(TAROT_METADATA_PREFIX + name)).equals(body)) throw new Error('Tarot metadata readback mismatch.');
  });
  return { ...catalogReport(objects), verified: true, uploaded: objects.size - existing.size };
}

export async function verifyTarotMedia(fetcher: typeof fetch = fetch) {
  const urls = Array.from({ length: TAROT_MAX_CARDS }, (_, index) => index + 1)
    .flatMap(id => ['bases', 'receipts'].map(kind => `https://wip.lil.org/tarot/${kind}/${id}.webp`));
  await uploadWithConcurrency(urls, 8, async url => {
    const response = await fetcher(url, { method: 'HEAD', signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'image/webp' ||
      !/^[1-9][0-9]*$/.test(response.headers.get('content-length') || '')) throw new Error(`Tarot media unavailable: ${url}`);
  });
  return { verified: true, artworkCount: urls.length };
}

export async function verifyPublicTarotMetadata(fetcher: typeof fetch = fetch) {
  const objects = tarotMetadataObjects();
  await uploadWithConcurrency(objects, 12, async ([name, expected]) => {
    const response = await fetcher(TAROT_METADATA_BASE_URI + name,
      { signal: AbortSignal.timeout(30_000), redirect: 'error', cache: 'no-store' });
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'application/json' ||
      Number(response.headers.get('content-length')) > 16_384) throw new Error('Public Tarot metadata unavailable.');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing public Tarot metadata.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16_384) throw new Error('Public Tarot metadata exceeds its limit.');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    if (!Buffer.concat(chunks).equals(expected)) throw new Error('Public Tarot metadata mismatch.');
  });
  return { ...catalogReport(objects), verified: true };
}
