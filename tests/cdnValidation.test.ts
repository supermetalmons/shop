import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCdnMetadataTargets,
  CDN_VALIDATION_SPECS,
  validateCdn,
  type CdnValidationSpec,
} from '../scripts/shared/cdnValidation.ts';

const SPEC: CdnValidationSpec = {
  base: 'https://cdn.example.test/drop',
  pathFormat: 'legacy',
  boxFiles: 0,
  figureFiles: 0,
  concurrencyEnv: 'VALIDATION_CONCURRENCY',
  defaultConcurrency: 1,
  maxConcurrency: 8,
};

function fakeTimers() {
  let sequence = 0;
  const pending = new Map<number, { delay: number; callback: () => void }>();
  const delays: number[] = [];
  const timers = {
    setTimeout: ((callback: () => void, delay: number) => {
      const id = ++sequence;
      delays.push(delay);
      pending.set(id, { delay, callback });
      if (delay !== 20_000) {
        queueMicrotask(() => {
          if (!pending.delete(id)) return;
          callback();
        });
      }
      return id;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number) => { pending.delete(id); }) as unknown as typeof clearTimeout,
  };
  return {
    timers,
    delays,
    pending,
    fireRequestTimeout() {
      const entry = [...pending].find(([, value]) => value.delay === 20_000);
      assert.ok(entry, 'a request timeout must be scheduled');
      pending.delete(entry[0]);
      entry[1].callback();
    },
  };
}

function jsonResponse(value: unknown = {}) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

function legacyInventory(base: string, boxes: number, figures: number) {
  return [
    { url: `${base}/collection.json` },
    ...['boxes', 'figures', 'receipts/boxes', 'receipts/figures'].flatMap((group, index) =>
      Array.from({ length: index % 2 ? figures : boxes }, (_, id) => ({ url: `${base}/json/${group}/${id + 1}.json` })),
    ),
  ];
}

test('LSB and Poncho inventories retain every legacy metadata path and count', () => {
  assert.deepEqual(
    buildCdnMetadataTargets(CDN_VALIDATION_SPECS.littleSwagBoxes),
    legacyInventory('https://cdn.lil.org/nft/little_swag_boxes', 333, 999),
  );
  assert.deepEqual(
    buildCdnMetadataTargets(CDN_VALIDATION_SPECS.ponchoDrifella),
    legacyInventory('https://cdn.lil.org/nft/poncho_drifella', 207, 207),
  );
  assert.equal(buildCdnMetadataTargets(CDN_VALIDATION_SPECS.littleSwagBoxes).length, 2_665);
  assert.equal(CDN_VALIDATION_SPECS.ponchoDrifella.expectedMetadataFiles, 829);
  assert.equal(CDN_VALIDATION_SPECS.ponchoDrifella.expectedMediaFiles, 830);
  assert.equal(CDN_VALIDATION_SPECS.ponchoDrifella.mediaRoot, 'https://cdn.lil.org/nft/poncho_drifella');
});

test('Card NFT 2 inventory retains every compact path and exact asset name', () => {
  const base = 'https://cdn.lil.org/nft/card_nft_2/json';
  const expected = [{ url: `${base}/collection.json`, expectedName: 'Card NFT 2' }];
  for (let id = 1; id <= 3_711; id += 1) expected.push({ url: `${base}/b${id}.json`, expectedName: `Pack #${id}` });
  for (let id = 1; id <= 11_133; id += 1) expected.push({ url: `${base}/f${id}.json`, expectedName: `Card #${id}` });
  for (let id = 1; id <= 3_711; id += 1) expected.push({ url: `${base}/rb${id}.json`, expectedName: `Pack #${id} Receipt` });
  for (let id = 1; id <= 11_133; id += 1) expected.push({ url: `${base}/rf${id}.json`, expectedName: `Card #${id} Receipt` });
  assert.deepEqual(buildCdnMetadataTargets(CDN_VALIDATION_SPECS.cardNft2), expected);
  assert.equal(CDN_VALIDATION_SPECS.cardNft2.expectedMetadataFiles, 29_689);
  assert.equal(CDN_VALIDATION_SPECS.cardNft2.mediaRoot, 'https://cdn.lil.org/nft/card_nft_2');
  assert.equal(CDN_VALIDATION_SPECS.cardNft2.requireMedia, true);
});

test('each validator retains its environment variable, default, and concurrency limits', async () => {
  const cases = [
    [CDN_VALIDATION_SPECS.littleSwagBoxes, 'LSB_VALIDATION_CONCURRENCY', 24, 64],
    [CDN_VALIDATION_SPECS.ponchoDrifella, 'PONCHO_VALIDATION_CONCURRENCY', 16, 32],
    [CDN_VALIDATION_SPECS.cardNft2, 'CARD_NFT_2_VALIDATION_CONCURRENCY', 16, 32],
  ] as const;
  for (const [original, variable, defaultValue, maximum] of cases) {
    const spec: CdnValidationSpec = {
      ...original,
      boxFiles: 0,
      figureFiles: 0,
      expectedMetadataFiles: 1,
      expectedMediaFiles: undefined,
      requireMedia: false,
      names: undefined,
    };
    for (const [env, expected] of [
      [{}, defaultValue],
      [{ [variable]: '' }, defaultValue],
      [{ [variable]: '2' }, 2],
      [{ [variable]: '100' }, maximum],
      [{ [variable]: '0' }, 1],
      [{ [variable]: '-1' }, 1],
    ] as const) {
      const clock = fakeTimers();
      const report = await validateCdn(spec, { fetch: async () => jsonResponse(), env, ...clock.timers });
      assert.equal(report.concurrency, expected);
      assert.equal(clock.pending.size, 0);
    }
  }
});

test('metadata requests and media requests obey the same concurrency bound', async () => {
  const spec = { ...SPEC, boxFiles: 3 };
  const active = { metadata: 0, media: 0 };
  const maximum = { metadata: 0, media: 0 };
  const visited: string[] = [];
  const clock = fakeTimers();
  const report = await validateCdn(spec, {
    env: { VALIDATION_CONCURRENCY: '2' },
    ...clock.timers,
    fetch: async (input, init) => {
      const kind = init?.method === 'HEAD' ? 'media' : 'metadata';
      const url = String(input);
      visited.push(url);
      active[kind] += 1;
      maximum[kind] = Math.max(maximum[kind], active[kind]);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      active[kind] -= 1;
      return kind === 'metadata' ? jsonResponse({ image: `${url}.webp` }) : new Response(null);
    },
  });
  assert.deepEqual(maximum, { metadata: 2, media: 2 });
  assert.equal(new Set(visited).size, 14);
  assert.deepEqual(report, {
    base: SPEC.base,
    concurrency: 2,
    metadataFiles: 7,
    referencedMedia: 7,
    collectionFiles: 1,
    boxFiles: 3,
    figureFiles: 0,
    receiptBoxFiles: 3,
    receiptFigureFiles: 0,
  });
  assert.equal(clock.pending.size, 0);
});

test('HTTP 429, server errors, and network failures retry with the existing backoff', async () => {
  let calls = 0;
  const clock = fakeTimers();
  const report = await validateCdn(SPEC, {
    ...clock.timers,
    fetch: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('accept'), 'application/json');
      calls += 1;
      if (calls === 1) return new Response(null, { status: 429 });
      if (calls === 2) return new Response(null, { status: 503 });
      if (calls === 3) throw new Error('connection reset');
      return jsonResponse();
    },
  });
  assert.equal(report.metadataFiles, 1);
  assert.equal(calls, 4);
  assert.deepEqual(clock.delays, [20_000, 250, 20_000, 500, 20_000, 1_000, 20_000]);
  assert.equal(clock.pending.size, 0);
});

test('retry exhaustion reports the URL and last HTTP error after four attempts', async () => {
  let calls = 0;
  const clock = fakeTimers();
  await assert.rejects(validateCdn(SPEC, {
    ...clock.timers,
    fetch: async () => {
      calls += 1;
      return new Response(null, { status: 503, statusText: 'Unavailable' });
    },
  }), /https:\/\/cdn\.example\.test\/drop\/collection\.json: 503 Unavailable/);
  assert.equal(calls, 4);
  assert.equal(clock.pending.size, 0);
});

test('nonretryable HTTP errors fail immediately', async () => {
  let calls = 0;
  const clock = fakeTimers();
  await assert.rejects(validateCdn(SPEC, {
    ...clock.timers,
    fetch: async () => {
      calls += 1;
      return new Response(null, { status: 404, statusText: 'Not Found' });
    },
  }), /collection\.json: 404 Not Found/);
  assert.equal(calls, 1);
  assert.deepEqual(clock.delays, [20_000]);
  assert.equal(clock.pending.size, 0);
});

test('requests abort at 20 seconds and retry with fresh signals', async () => {
  const signals = new Set<AbortSignal>();
  const clock = fakeTimers();
  await assert.rejects(validateCdn(SPEC, {
    ...clock.timers,
    fetch: async (_input, init) => {
      const signal = init?.signal;
      assert.ok(signal);
      assert.equal(signal.aborted, false);
      signals.add(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('request timed out')), { once: true });
        queueMicrotask(() => clock.fireRequestTimeout());
      });
    },
  }), /collection\.json: request timed out/);
  assert.equal(signals.size, 4);
  assert.ok([...signals].every((signal) => signal.aborted));
  assert.deepEqual(clock.delays, [20_000, 250, 20_000, 500, 20_000, 1_000, 20_000]);
  assert.equal(clock.pending.size, 0);
});

test('all HTTPS media fields are deduplicated and checked in sorted order', async () => {
  const mediaCalls: string[] = [];
  const clock = fakeTimers();
  const report = await validateCdn(SPEC, {
    ...clock.timers,
    fetch: async (input, init) => {
      if (init?.method === 'HEAD') {
        mediaCalls.push(String(input));
        return new Response(null);
      }
      return jsonResponse({
        image: 'https://media.example.test/z.webp',
        animation_url: 'https://media.example.test/a.mov',
        properties: {
          files: [
            'https://media.example.test/z.webp',
            { uri: 'https://media.example.test/m.mp4' },
            { uri: 'http://media.example.test/insecure.png' },
            { uri: 'ipfs://example' },
            null,
            {},
            7,
          ],
        },
      });
    },
  });
  assert.deepEqual(mediaCalls, [
    'https://media.example.test/a.mov',
    'https://media.example.test/m.mp4',
    'https://media.example.test/z.webp',
  ]);
  assert.equal(report.referencedMedia, 3);
});

test('HEAD 405 falls back to a one-byte ranged GET', async () => {
  const calls: Array<{ url: string; method: string; range: string | null }> = [];
  const image = `${SPEC.base}/image.webp`;
  const clock = fakeTimers();
  await validateCdn(SPEC, {
    ...clock.timers,
    fetch: async (input, init) => {
      calls.push({ url: String(input), method: init?.method || 'GET', range: new Headers(init?.headers).get('range') });
      if (String(input).endsWith('.json')) return jsonResponse({ image });
      return new Response(null, { status: init?.method === 'HEAD' ? 405 : 206 });
    },
  });
  assert.deepEqual(calls, [
    { url: `${SPEC.base}/collection.json`, method: 'GET', range: null },
    { url: image, method: 'HEAD', range: null },
    { url: image, method: 'GET', range: 'bytes=0-0' },
  ]);
});

test('HEAD 501 preserves server-error retries and fails before any ranged GET', async () => {
  let headCalls = 0;
  const clock = fakeTimers();
  await assert.rejects(validateCdn(SPEC, {
    ...clock.timers,
    fetch: async (input, init) => {
      if (String(input).endsWith('.json')) return jsonResponse({ image: `${SPEC.base}/image.webp` });
      assert.equal(init?.method, 'HEAD');
      headCalls += 1;
      return new Response(null, { status: 501, statusText: 'Not Implemented' });
    },
  }), /image\.webp: 501 Not Implemented/);
  assert.equal(headCalls, 4);
  assert.deepEqual(clock.delays.filter((delay) => delay !== 20_000), [250, 500, 1_000]);
});

test('failed HEAD and fallback GET responses reject the media URL', async () => {
  for (const fallback of [false, true]) {
    const clock = fakeTimers();
    await assert.rejects(validateCdn(SPEC, {
      ...clock.timers,
      fetch: async (input, init) => {
        if (String(input).endsWith('.json')) return jsonResponse({ image: `${SPEC.base}/image.webp` });
        const status = fallback && init?.method === 'HEAD' ? 405 : 404;
        return new Response(null, { status });
      },
    }), /image\.webp: 404/);
  }
});

test('invalid JSON, content types, and non-object metadata fail before media requests', async () => {
  const cases = [
    [() => new Response('{}', { headers: { 'content-type': 'text/html' } }), /expected JSON content type, got text\/html/],
    [() => new Response('{', { headers: { 'content-type': 'application/json' } }), /JSON|property name/i],
    [() => jsonResponse(null), /expected a JSON object/],
    [() => jsonResponse([]), /expected a JSON object/],
    [() => jsonResponse('metadata'), /expected a JSON object/],
    [() => jsonResponse(42), /expected a JSON object/],
  ] as const;
  for (const [response, error] of cases) {
    let calls = 0;
    const clock = fakeTimers();
    await assert.rejects(validateCdn(SPEC, {
      ...clock.timers,
      fetch: async () => { calls += 1; return response(); },
    }), error);
    assert.equal(calls, 1);
  }
});

test('Card NFT 2 exact names are validated before media requests', async () => {
  const clock = fakeTimers();
  await assert.rejects(validateCdn({ ...SPEC, names: CDN_VALIDATION_SPECS.cardNft2.names }, {
    ...clock.timers,
    fetch: async () => jsonResponse({ name: 'Card NFT 1' }),
  }), /expected name "Card NFT 2", got "Card NFT 1"/);
});

test('metadata counts, media counts, and required media remain enforced', async () => {
  for (const [changes, error] of [
    [{ expectedMetadataFiles: 2 }, /Expected 2 metadata files, found 1/],
    [{ expectedMediaFiles: 2 }, /Expected 2 referenced media objects, found 0/],
    [{ requireMedia: true }, /No referenced media objects were found/],
  ] as const) {
    const clock = fakeTimers();
    await assert.rejects(validateCdn({ ...SPEC, ...changes }, {
      ...clock.timers,
      fetch: async () => jsonResponse(),
    }), error);
  }
});

test('canonical media roots reject other hosts and sibling prefixes before HEAD requests', async () => {
  for (const image of ['https://elsewhere.example.test/a.webp', `${SPEC.base}-other/a.webp`, SPEC.base]) {
    let calls = 0;
    const clock = fakeTimers();
    await assert.rejects(validateCdn({ ...SPEC, mediaRoot: SPEC.base }, {
      ...clock.timers,
      fetch: async () => { calls += 1; return jsonResponse({ image }); },
    }), /Metadata references a non-canonical media URL/);
    assert.equal(calls, 1);
  }
});

test('canonical media subdirectories and exact metadata/media counts pass', async () => {
  const clock = fakeTimers();
  const report = await validateCdn({ ...SPEC, mediaRoot: SPEC.base, expectedMetadataFiles: 1, expectedMediaFiles: 1 }, {
    ...clock.timers,
    fetch: async (_input, init) => init?.method === 'HEAD'
      ? new Response(null)
      : jsonResponse({ image: `${SPEC.base}/images/a.webp` }),
  });
  assert.equal(report.referencedMedia, 1);
});
