import { Buffer } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';
import media from '../../releases/111k-mainnet-duplicate-correction-2026-11-19/eligible-egg-media.json';
import type { DuplicateCorrectionDefinition } from '../../shared/ethereum/duplicateCorrection.ts';
import { checkRevealMedia } from '../../shared/ethereum/revealMediaPreflight.ts';
import { mixedAllocationHash } from '../../shared/ethereum/revealMixedAllocation.ts';
import { inBatches } from './catalog.ts';

async function checkObject(url: string, format: 'png' | 'webp', md5: string, bytes: number, fetchSource: typeof fetch) {
  await checkRevealMedia(url, [`image/${format}`], async (input, init) => {
    const response = await fetchSource(input, init);
    try {
      if (response.status !== 206 || response.headers.get('etag') !== `"${md5}"` ||
        response.headers.get('content-range') !== `bytes 0-32/${bytes}`) {
        throw new Error('Replacement egg checksum, byte range or object size changed.');
      }
      const header = Buffer.from(await response.arrayBuffer());
      const valid = format === 'png'
        ? header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && header.toString('ascii', 12, 16) === 'IHDR' &&
          header.readUInt32BE(16) === 1024 && header.readUInt32BE(20) === 1024
        : header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
      if (header.length !== 33 || !valid) throw new Error('Invalid replacement egg media header.');
      return new Response(header, { status: response.status, headers: response.headers });
    } finally { await response.body?.cancel().catch(() => undefined); }
  });
}

export async function duplicateCorrectionMediaPreflight(definition: DuplicateCorrectionDefinition, fetchSource: typeof fetch = fetch) {
  if (media.length !== definition.eggCandidates.length) throw new Error('Replacement egg media inventory changed.');
  await inBatches(media.entries(), 24, async ([index, row]) => {
    const [id, pngMd5, pngBytes, webpMd5, webpBytes] = row;
    if (id !== definition.eggCandidates[index] || typeof pngMd5 !== 'string' || typeof webpMd5 !== 'string' ||
      typeof pngBytes !== 'number' || typeof webpBytes !== 'number') throw new Error('Invalid replacement egg media inventory.');
    const root = `https://cdn.lil.org/nft/111k/eggs/${id}`;
    for (const [format, md5, bytes] of [['png', pngMd5, pngBytes], ['webp', webpMd5, webpBytes]] as const) {
      for (let attempt = 1; ; attempt++) {
        try { await checkObject(`${root}.${format}`, format, md5, bytes, fetchSource); break; }
        catch (error) { if (attempt >= 3) throw error; await delay(attempt * 500); }
      }
    }
  });
  return { verifiedAt: new Date().toISOString(), definitionSha256: mixedAllocationHash(definition),
    mediaSha256: mixedAllocationHash(media), objects: media.length * 2 };
}
