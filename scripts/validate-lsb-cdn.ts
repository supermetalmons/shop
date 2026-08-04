const BASE = 'https://cdn.lil.org/nft/little_swag_boxes';
const CONCURRENCY = Math.max(1, Math.min(64, Number(process.env.LSB_VALIDATION_CONCURRENCY || 24)));
const REQUEST_TIMEOUT_MS = 20_000;
const RETRIES = 3;

type MetadataRow = {
  url: string;
  json: Record<string, unknown>;
};

function metadataUrls() {
  const urls = [`${BASE}/collection.json`];
  for (let id = 1; id <= 333; id += 1) urls.push(`${BASE}/json/boxes/${id}.json`);
  for (let id = 1; id <= 999; id += 1) urls.push(`${BASE}/json/figures/${id}.json`);
  for (let id = 1; id <= 333; id += 1) urls.push(`${BASE}/json/receipts/boxes/${id}.json`);
  for (let id = 1; id <= 999; id += 1) urls.push(`${BASE}/json/receipts/figures/${id}.json`);
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
const metadata = await mapConcurrent(urls, async (url): Promise<MetadataRow> => {
  const response = await fetchRetry(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('json')) throw new Error(`${url}: expected JSON content type, got ${contentType}`);
  const json = await response.json();
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`${url}: expected a JSON object`);
  return { url, json: json as Record<string, unknown> };
});

const referencedMedia = [...new Set(metadata.flatMap((row) => [...mediaUrls(row.json)]))].sort();
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
  boxFiles: 333,
  figureFiles: 999,
  receiptBoxFiles: 333,
  receiptFigureFiles: 999,
}, null, 2)}\n`);

export {};
