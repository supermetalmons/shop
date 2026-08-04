const ROOT = 'https://cdn.lil.org/nft/card_nft_2';
const BASE = `${ROOT}/json`;
const MAX_BOX_ID = 3_711;
const MAX_CARD_ID = 11_133;
const CONCURRENCY = Math.max(1, Math.min(32, Number(process.env.CARD_NFT_2_VALIDATION_CONCURRENCY || 16)));
const REQUEST_TIMEOUT_MS = 20_000;
const RETRIES = 3;

type MetadataRow = {
  url: string;
  json: Record<string, unknown>;
};

function metadataUrls() {
  const urls = [{ url: `${BASE}/collection.json`, expectedName: 'Card NFT 2' }];
  for (let id = 1; id <= MAX_BOX_ID; id += 1) urls.push({ url: `${BASE}/b${id}.json`, expectedName: `Pack #${id}` });
  for (let id = 1; id <= MAX_CARD_ID; id += 1) urls.push({ url: `${BASE}/f${id}.json`, expectedName: `Card #${id}` });
  for (let id = 1; id <= MAX_BOX_ID; id += 1) urls.push({ url: `${BASE}/rb${id}.json`, expectedName: `Pack #${id} Receipt` });
  for (let id = 1; id <= MAX_CARD_ID; id += 1) urls.push({ url: `${BASE}/rf${id}.json`, expectedName: `Card #${id} Receipt` });
  return urls;
}

async function fetchRetry(url: string, init?: RequestInit) {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.ok || (response.status < 500 && response.status !== 429)) return response;
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < RETRIES) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
  throw new Error(`${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function mapConcurrent<Input, Output>(
  inputs: readonly Input[],
  mapper: (input: Input, index: number) => Promise<Output>,
) {
  const outputs = new Array<Output>(inputs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, inputs.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= inputs.length) return;
      outputs[index] = await mapper(inputs[index], index);
    }
  }));
  return outputs;
}

function mediaUrls(metadata: Record<string, unknown>) {
  const urls = new Set<string>();
  for (const field of ['image', 'animation_url']) {
    const value = metadata[field];
    if (typeof value === 'string' && /^https:\/\//.test(value)) urls.add(value);
  }
  const properties = metadata.properties;
  if (properties && typeof properties === 'object' && Array.isArray((properties as Record<string, unknown>).files)) {
    for (const file of (properties as { files: unknown[] }).files) {
      const value = typeof file === 'string'
        ? file
        : file && typeof file === 'object'
          ? (file as Record<string, unknown>).uri
          : null;
      if (typeof value === 'string' && /^https:\/\//.test(value)) urls.add(value);
    }
  }
  return urls;
}

const urls = metadataUrls();
const metadata = await mapConcurrent(urls, async ({ url, expectedName }): Promise<MetadataRow> => {
  const response = await fetchRetry(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('json')) throw new Error(`${url}: expected JSON content type, got ${contentType}`);
  const json = await response.json();
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`${url}: expected a JSON object`);
  if ((json as Record<string, unknown>).name !== expectedName) {
    throw new Error(`${url}: expected name ${JSON.stringify(expectedName)}, got ${JSON.stringify((json as Record<string, unknown>).name)}`);
  }
  return { url, json: json as Record<string, unknown> };
});

const referencedMedia = [...new Set(metadata.flatMap((row) => [...mediaUrls(row.json)]))].sort();
if (metadata.length !== 29_689) throw new Error(`Expected 29689 metadata files, found ${metadata.length}`);
if (!referencedMedia.length) throw new Error('No referenced media objects were found');
for (const url of referencedMedia) {
  if (!url.startsWith(`${ROOT}/`)) throw new Error(`Metadata references a non-canonical media URL: ${url}`);
}
await mapConcurrent(referencedMedia, async (url) => {
  let response = await fetchRetry(url, { method: 'HEAD' });
  if (response.status === 405 || response.status === 501) {
    response = await fetchRetry(url, { headers: { range: 'bytes=0-0' } });
  }
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return url;
});

process.stdout.write(`${JSON.stringify({
  base: BASE,
  concurrency: CONCURRENCY,
  metadataFiles: metadata.length,
  referencedMedia: referencedMedia.length,
  collectionFiles: 1,
  boxFiles: MAX_BOX_ID,
  figureFiles: MAX_CARD_ID,
  receiptBoxFiles: MAX_BOX_ID,
  receiptFigureFiles: MAX_CARD_ID,
}, null, 2)}\n`);

export {};
