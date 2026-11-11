import { setTimeout as delay } from 'node:timers/promises';
import { ethereumMetadataBaseUri } from '../../shared/ethereum/config.ts';
import { isEthereumMetadataImage } from '../../shared/ethereum/metadataImage.ts';
import { validateRevealAssetCatalog } from '../../shared/ethereum/revealAssetCatalog.ts';
import descriptor from '../../shared/ethereum/revealCatalog.json';
import catalog from '../ethereum-metadata/reveal-assets/111k_devnet/manifest.json';
import { loadMetadataTemplates, sha256 } from '../ethereum-metadata/catalog.ts';
import { cancelResponseBody, readBoundedResponseBytes } from '../../cloud/workers/api/src/boundedResponse.ts';
import { MAX_REVEAL_METADATA_BYTES } from '../../cloud/workers/api/src/ethereumRevealAttributes.ts';

type Scope = { chainId: number; metadataBaseUri: string };
type Options = { fetch?: typeof fetch; wait?: (ms: number) => Promise<void>; onVerified?: (file: string) => Promise<void> };
type Media = { url: string; kind: 'image' | 'animation' };
const ORIGIN = 'https://mons.shop';
const HASH = /^[a-f0-9]{64}$/;

class RetryablePublicRead extends Error {}

export class PublicMetadataHashMismatch extends Error {
  constructor(readonly observed: Record<string, string>) {
    super(`Public replacement metadata differs from R2: ${Object.keys(observed).join(', ')}`);
  }
}

async function mediaRoots(): Promise<URL[]> {
  validateRevealAssetCatalog(catalog, descriptor);
  const { templates } = await loadMetadataTemplates();
  const roots = [catalog.baseUrl, ...Object.values(catalog.categories).flatMap(category => 'baseUrl' in category ? [category.baseUrl as string] : []),
    ...Object.values(templates).map(template => {
      const image = new URL(template.image.replaceAll('{{tokenId}}', '1').replaceAll('{{displayId}}', '1'));
      return `${image.origin}${image.pathname.slice(0, image.pathname.lastIndexOf('/') + 1)}`;
    })];
  return [...new Set(roots)].map(root => new URL(root));
}

function mediaUrl(value: unknown, kind: Media['kind'], roots: URL[], legacyRelics: boolean): Media {
  if (!isEthereumMetadataImage(value) || !value.startsWith('https://') || /[\\%\u0000-\u0020\u007f]/.test(value)) throw new Error('Replacement metadata contains an unsafe media URL.');
  const url = new URL(value);
  const legacyRelic = legacyRelics && kind === 'image' && /^https:\/\/wip\.lil\.org\/111k\/relics\/(?:[1-9]|1[0-8])\.webp$/.test(value);
  if (url.href !== value || url.username || url.password || url.port || url.search || url.hash
    || !legacyRelic && !roots.some(root => root.origin === url.origin && url.pathname.startsWith(root.pathname))
    || !(kind === 'image' ? /\.(?:png|webp|jpe?g|gif|avif|svg)$/i : /\.(?:mp4|glb)$/i).test(url.pathname)) {
    throw new Error('Replacement metadata media must use the current approved HTTPS catalog or template roots.');
  }
  return { url: url.href, kind };
}

function metadataMedia(value: unknown, roots: URL[], legacyRelics: boolean): Media[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid public replacement metadata.');
  const row = value as Record<string, unknown>;
  if (typeof row.name !== 'string' || !row.name.trim() || row.description !== undefined && typeof row.description !== 'string'
    || !Array.isArray(row.attributes) || row.attributes.some(attribute => !attribute || typeof attribute !== 'object'
      || Array.isArray(attribute) || typeof attribute.trait_type !== 'string' || !attribute.trait_type
      || typeof attribute.value !== 'string' && (typeof attribute.value !== 'number' || !Number.isFinite(attribute.value)))) {
    throw new Error('Invalid public replacement metadata shape.');
  }
  if (row.aspectRatio !== undefined) {
    const ratio = row.aspectRatio as { width?: number; height?: number };
    if (!ratio || typeof ratio !== 'object' || !Number.isSafeInteger(ratio.width) || !Number.isSafeInteger(ratio.height)
      || ratio.width! < 1 || ratio.height! < 1) throw new Error('Invalid public replacement metadata aspect ratio.');
  }
  return [mediaUrl(row.image, 'image', roots, legacyRelics), ...(row.animation_url === undefined ? [] : [mediaUrl(row.animation_url, 'animation', roots, legacyRelics)])];
}

async function concurrent<T>(items: readonly T[], work: (value: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  let failure: unknown;
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (cursor < items.length && !failure) {
      try { await work(items[cursor++]); } catch (error) { failure = error; throw error; }
    }
  }));
  const failed = outcomes.find(outcome => outcome.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

export async function read111kReplacementPublicSamples(scope: Scope, expected: Readonly<Record<string, string>>,
  options: Options = {}): Promise<() => Promise<void>> {
  const base = ethereumMetadataBaseUri(scope.metadataBaseUri, scope.chainId);
  const entries = Object.entries(expected);
  if (!entries.length || entries.length > 64 || entries.some(([file, hash]) => !/^[1-9]\d{0,77}\.json$/.test(file) || !HASH.test(hash))) {
    throw new Error('Invalid public replacement metadata sample set.');
  }
  const fetcher = options.fetch ?? fetch;
  const wait = options.wait ?? (async ms => { await delay(ms); });
  const roots = await mediaRoots();
  const legacyRelics = scope.chainId === 11155111 && base === 'https://cdn.mons.shop/111k-sepolia/v16/';
  const media = new Map<string, Media>();
  const retry = async (operation: () => Promise<void>) => {
    for (let attempt = 0; ; attempt++) {
      try { await operation(); return; }
      catch (error) {
        if (attempt >= 1 || !(error instanceof RetryablePublicRead || error instanceof Error && error.name === 'TimeoutError')) throw error;
        await wait(250);
      }
    }
  };
  const request = async (url: string, method: 'GET' | 'HEAD', signal: AbortSignal): Promise<Response> => {
    let response: Response;
    try {
      response = await fetcher(url, { method, headers: { Origin: ORIGIN, Accept: method === 'GET' ? 'application/json' : '*/*' },
        cache: 'no-store', redirect: 'manual', signal });
    } catch { throw new RetryablePublicRead(`Public replacement ${method} request failed: ${url}`); }
    if (response.status === 429 || response.status >= 500) {
      await cancelResponseBody(response);
      throw new RetryablePublicRead(`Public replacement ${method} returned HTTP ${response.status}: ${url}`);
    }
    if (response.status !== 200 || !['*', ORIGIN].includes(response.headers.get('access-control-allow-origin') ?? '')) {
      await cancelResponseBody(response);
      throw new Error(`Public replacement ${method} verification failed: ${url}`);
    }
    return response;
  };
  const mismatches: Record<string, string> = {};
  const readMetadata = async ([file, expectedHash]: [string, string]) => {
    const url = `${base}${file}`;
    const signal = AbortSignal.timeout(15_000);
    const response = await request(url, 'GET', signal);
    if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
      || response.headers.get('cache-control') !== 'no-store' || response.headers.get('cf-cache-status') === 'HIT') {
      await cancelResponseBody(response);
      throw new Error(`Public replacement metadata headers are invalid: ${url}`);
    }
    const bytes = await readBoundedResponseBytes(response, { maxBytes: MAX_REVEAL_METADATA_BYTES, signal,
      createError: failure => failure === 'stream-failed' ? new RetryablePublicRead(`Public replacement metadata stream failed: ${url}`)
        : new Error(`Public replacement metadata response is invalid (${failure}): ${url}`) });
    const observed = sha256(bytes);
    if (observed !== expectedHash) {
      mismatches[file] = observed;
      return;
    }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error(`Public replacement metadata is not valid JSON: ${url}`); }
    for (const item of metadataMedia(value, roots, legacyRelics)) {
      const previous = media.get(item.url);
      if (previous && previous.kind !== item.kind) throw new Error('Replacement media is used with incompatible metadata kinds.');
      media.set(item.url, item);
    }
  };
  await concurrent(entries, async entry => {
    await retry(() => readMetadata(entry));
    if (!Object.hasOwn(mismatches, entry[0])) await options.onVerified?.(entry[0]);
  });
  if (Object.keys(mismatches).length) throw new PublicMetadataHashMismatch(mismatches);
  return () => concurrent([...media.values()], async item => retry(async () => {
    const response = await request(item.url, 'HEAD', AbortSignal.timeout(15_000));
    try {
      const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
      const validType = item.kind === 'image' ? type.startsWith('image/')
        : item.url.endsWith('.glb') ? ['model/gltf-binary', 'application/octet-stream'].includes(type) : type === 'video/mp4';
      const length = response.headers.get('content-length');
      if (!validType || length !== null && (!/^\d+$/.test(length) || Number(length) <= 0)) throw new Error(`Public replacement media is unavailable or has invalid headers: ${item.url}`);
    } finally { await cancelResponseBody(response); }
  }));
}

export async function verify111kReplacementPublicSamples(scope: Scope, expected: Readonly<Record<string, string>>,
  options: Options = {}): Promise<void> {
  const verifyMedia = await read111kReplacementPublicSamples(scope, expected, options);
  await verifyMedia();
}
