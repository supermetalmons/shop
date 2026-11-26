import { TAROT_MAX_CARDS } from '../../shared/ethereum/tarot.ts';
import { uploadWithConcurrency } from '../ethereum-metadata/storage.ts';

export async function verifyTarotMedia(fetcher: typeof fetch = fetch) {
  const media = ([
    ['cards', 'png', TAROT_MAX_CARDS],
    ['receipts', 'png', TAROT_MAX_CARDS],
    ['receipts', 'webp', TAROT_MAX_CARDS],
    ['clean', 'webp', TAROT_MAX_CARDS],
    ['layers', 'webp', 10],
  ] as const).flatMap(([kind, format, count]) => Array.from({ length: count }, (_, index) => ({
    url: `https://cdn.lil.org/nft/dmx/${kind}/${index + 1}.${format}`,
    contentType: `image/${format}`,
  })));
  await uploadWithConcurrency(media, 8, async ({ url, contentType }) => {
    const response = await fetcher(url, { method: 'HEAD', signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== contentType ||
      !/^[1-9][0-9]*$/.test(response.headers.get('content-length') || '')) throw new Error(`Tarot media unavailable: ${url}`);
  });
  return { verified: true, artworkCount: media.length };
}
