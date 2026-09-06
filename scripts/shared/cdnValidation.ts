type CdnMetadataTarget = {
  url: string;
  expectedName?: string;
};

export type CdnValidationSpec = {
  base: string;
  pathFormat: 'legacy' | 'compact';
  boxFiles: number;
  figureFiles: number;
  concurrencyEnv: string;
  defaultConcurrency: number;
  maxConcurrency: number;
  expectedMetadataFiles?: number;
  expectedMediaFiles?: number;
  requireMedia?: boolean;
  mediaRoot?: string;
  names?: { collection: string; box: string; figure: string };
};

export const CDN_VALIDATION_SPECS = {
  littleSwagBoxes: {
    base: 'https://cdn.lil.org/nft/little_swag_boxes',
    pathFormat: 'legacy',
    boxFiles: 333,
    figureFiles: 999,
    concurrencyEnv: 'LSB_VALIDATION_CONCURRENCY',
    defaultConcurrency: 24,
    maxConcurrency: 64,
  },
  ponchoDrifella: {
    base: 'https://cdn.lil.org/nft/poncho_drifella',
    pathFormat: 'legacy',
    boxFiles: 207,
    figureFiles: 207,
    concurrencyEnv: 'PONCHO_VALIDATION_CONCURRENCY',
    defaultConcurrency: 16,
    maxConcurrency: 32,
    expectedMetadataFiles: 829,
    expectedMediaFiles: 830,
    mediaRoot: 'https://cdn.lil.org/nft/poncho_drifella',
  },
  cardNft2: {
    base: 'https://cdn.lil.org/nft/card_nft_2/json',
    pathFormat: 'compact',
    boxFiles: 3_711,
    figureFiles: 11_133,
    concurrencyEnv: 'CARD_NFT_2_VALIDATION_CONCURRENCY',
    defaultConcurrency: 16,
    maxConcurrency: 32,
    expectedMetadataFiles: 29_689,
    requireMedia: true,
    mediaRoot: 'https://cdn.lil.org/nft/card_nft_2',
    names: { collection: 'Card NFT 2', box: 'Pack', figure: 'Card' },
  },
} satisfies Record<string, CdnValidationSpec>;

export function buildCdnMetadataTargets(spec: CdnValidationSpec): CdnMetadataTarget[] {
  const targets: CdnMetadataTarget[] = [{
    url: `${spec.base}/collection.json`,
    ...(spec.names ? { expectedName: spec.names.collection } : {}),
  }];
  const groups = [
    { count: spec.boxFiles, legacy: 'boxes/', compact: 'b', name: spec.names?.box, receipt: false },
    { count: spec.figureFiles, legacy: 'figures/', compact: 'f', name: spec.names?.figure, receipt: false },
    { count: spec.boxFiles, legacy: 'receipts/boxes/', compact: 'rb', name: spec.names?.box, receipt: true },
    { count: spec.figureFiles, legacy: 'receipts/figures/', compact: 'rf', name: spec.names?.figure, receipt: true },
  ];
  for (const group of groups) {
    const prefix = spec.pathFormat === 'legacy' ? `json/${group.legacy}` : group.compact;
    for (let id = 1; id <= group.count; id += 1) {
      targets.push({
        url: `${spec.base}/${prefix}${id}.json`,
        ...(group.name ? { expectedName: `${group.name} #${id}${group.receipt ? ' Receipt' : ''}` } : {}),
      });
    }
  }
  return targets;
}

async function mapConcurrent<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  mapper: (input: Input) => Promise<Output>,
) {
  const outputs = new Array<Output>(inputs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= inputs.length) return;
      outputs[index] = await mapper(inputs[index]);
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

export async function validateCdn(spec: CdnValidationSpec, options: {
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
} = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const schedule = options.setTimeout ?? setTimeout;
  const cancel = options.clearTimeout ?? clearTimeout;
  const env = options.env ?? process.env;
  const concurrency = Math.max(1, Math.min(spec.maxConcurrency, Number(env[spec.concurrencyEnv] || spec.defaultConcurrency)));

  async function fetchRetry(url: string, init?: RequestInit) {
    let lastError: unknown;
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = schedule(() => controller.abort(), 20_000);
      try {
        const response = await fetchImpl(url, { ...init, signal: controller.signal });
        if (response.ok || (response.status < 500 && response.status !== 429)) return response;
        lastError = new Error(`${response.status} ${response.statusText}`);
      } catch (error) {
        lastError = error;
      } finally {
        cancel(timeout);
      }
      if (attempt < 3) await new Promise<void>((resolve) => schedule(resolve, 250 * 2 ** attempt));
    }
    throw new Error(`${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  const metadata = await mapConcurrent(buildCdnMetadataTargets(spec), concurrency, async ({ url, expectedName }) => {
    const response = await fetchRetry(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('json')) throw new Error(`${url}: expected JSON content type, got ${contentType}`);
    const json = await response.json();
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`${url}: expected a JSON object`);
    if (expectedName !== undefined && json.name !== expectedName) {
      throw new Error(`${url}: expected name ${JSON.stringify(expectedName)}, got ${JSON.stringify(json.name)}`);
    }
    return json as Record<string, unknown>;
  });

  const referencedMedia = [...new Set(metadata.flatMap((row) => [...mediaUrls(row)]))].sort();
  if (spec.expectedMetadataFiles !== undefined && metadata.length !== spec.expectedMetadataFiles) {
    throw new Error(`Expected ${spec.expectedMetadataFiles} metadata files, found ${metadata.length}`);
  }
  if (spec.expectedMediaFiles !== undefined && referencedMedia.length !== spec.expectedMediaFiles) {
    throw new Error(`Expected ${spec.expectedMediaFiles} referenced media objects, found ${referencedMedia.length}`);
  }
  if (spec.requireMedia && !referencedMedia.length) throw new Error('No referenced media objects were found');
  for (const url of referencedMedia) {
    if (spec.mediaRoot && !url.startsWith(`${spec.mediaRoot}/`)) {
      throw new Error(`Metadata references a non-canonical media URL: ${url}`);
    }
  }
  await mapConcurrent(referencedMedia, concurrency, async (url) => {
    let response = await fetchRetry(url, { method: 'HEAD' });
    if (response.status === 405 || response.status === 501) {
      response = await fetchRetry(url, { headers: { range: 'bytes=0-0' } });
    }
    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  });

  return {
    base: spec.base,
    concurrency,
    metadataFiles: metadata.length,
    referencedMedia: referencedMedia.length,
    collectionFiles: 1,
    boxFiles: spec.boxFiles,
    figureFiles: spec.figureFiles,
    receiptBoxFiles: spec.boxFiles,
    receiptFigureFiles: spec.figureFiles,
  };
}
