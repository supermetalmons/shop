import { TAROT_MAX_CARDS } from '../../shared/ethereum/tarot.ts';
import { uploadWithConcurrency } from '../ethereum-metadata/storage.ts';

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
