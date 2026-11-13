import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { applyRevealAttributePayload, fetchRevealAttributes, InvalidRevealAttributes, MAX_REVEAL_METADATA_BYTES,
  RevealAttributeSourceUnavailable } from '../src/ethereumRevealAttributes.ts';

const base = { name: '42', attributes: [{ trait_type: 'type', value: 'painting' }], image: 'https://example.test/5.png',
  revealStatus: 'revealed', aspectRatio: { width: 3, height: 2 } };
const signal = new AbortController().signal;
const body = JSON.stringify(base);
const trait = { trait_type: 'Mark', value: 12, display_type: 'number' };

test('enrichment keeps exactly one leading collection block and preserves every other duplicate source trait', () => {
  const block = { trait_type: 'collection block', value: 'little swag' };
  const frozen = JSON.stringify({ ...base, attributes: [block, ...base.attributes, block] });
  const payload = JSON.stringify([block, trait, block, trait]);
  assert.deepEqual(JSON.parse(applyRevealAttributePayload(frozen, payload).metadataJson).attributes,
    [block, ...base.attributes, trait, trait]);
  assert.equal(applyRevealAttributePayload(body, JSON.stringify([block, trait, trait])).metadataJson,
    applyRevealAttributePayload(frozen, payload).metadataJson);
});

test('enrichment retries source blocks that disagree with the frozen authoritative block', () => {
  const block = { trait_type: 'collection block', value: 'little swag' };
  const frozen = JSON.stringify({ ...base, attributes: [block, ...base.attributes] });
  const mismatch = (error: unknown) => error instanceof RevealAttributeSourceUnavailable && error.reason === 'collection-block-mismatch';
  assert.throws(() => applyRevealAttributePayload(frozen,
    JSON.stringify([{ ...block, value: 'different block' }, trait])), mismatch);
  assert.throws(() => applyRevealAttributePayload(frozen,
    JSON.stringify([block, trait, { ...block, value: 'different block' }])), mismatch);
});

test('legacy metadata without an authoritative block preserves historical duplicate source blocks byte for byte', () => {
  const first = { trait_type: 'collection block', value: 'historical label' };
  const duplicate = { trait_type: 'collection block', value: 'historical source trait' };
  const payload = [first, trait, duplicate, trait];
  const expected = JSON.stringify({ ...base, attributes: [first, ...base.attributes, trait, duplicate, trait] }) + '\n';
  assert.equal(applyRevealAttributePayload(body, JSON.stringify(payload)).metadataJson, expected);
});

test('fetches the assigned asset and preserves the base, source order, duplicates, numbers and additional fields', async () => {
  const result = await fetchRevealAttributes('painting', 5, body, signal, async (url, options) => {
    assert.equal(url, 'https://cdn.lil.org/nft/111k/paintings/json/v0/5.json');
    assert.equal(options?.redirect, 'manual');
    return Response.json({ 'collection block': 'My Block', attributes: [trait, trait, { trait_type: 'Mark', value: '0012' }] });
  });
  assert.deepEqual(JSON.parse(result.metadataJson), { ...base, attributes: [
    { trait_type: 'collection block', value: 'My Block' }, ...base.attributes, trait, trait, { trait_type: 'Mark', value: '0012' },
  ] });
  assert.equal(result.metadataSha256, createHash('sha256').update(result.metadataJson).digest('hex'));
});

for (const [category, family] of [['video', 'videos'], ['3d', '3d'], ['animated', 'animated']] as const) {
  test(`enriches ${category} with only a collection block when its source array is empty`, async () => {
    const result = await fetchRevealAttributes(category, 1, body, signal, async url => {
      assert.equal(url, `https://cdn.lil.org/nft/111k/${family}/json/v0/1.json`);
      return Response.json({ 'collection block': 'Block', attributes: [] });
    });
    assert.deepEqual(JSON.parse(result.metadataJson).attributes, [{ trait_type: 'collection block', value: 'Block' }, ...base.attributes]);
  });
}

test('preserves exact numeric literals in attributes, extra fields, and frozen metadata', async () => {
  const source = '{"collection block":"Block","attributes":[{"trait_type":"seed","value":9007199254740993,"weight":1.234567890123456789},{"trait_type":"tiny","value":4e-310}]}';
  const frozen = '{"name":"42","attributes":[{"trait_type":"existing","value":-9007199254740995}],"aspectRatio":{"width":1,"height":1}}';
  const { metadataJson, metadataSha256 } = await fetchRevealAttributes('painting', 5, frozen, signal,
    async () => new Response(source, { headers: { 'content-type': 'application/json' } }));
  assert.equal(metadataJson, '{"name":"42","attributes":[{"trait_type":"collection block","value":"Block"},' +
    '{"trait_type":"existing","value":-9007199254740995},{"trait_type":"seed","value":9007199254740993,"weight":1.234567890123456789},' +
    '{"trait_type":"tiny","value":4e-310}],"aspectRatio":{"width":1,"height":1}}\n');
  assert.equal(metadataSha256, createHash('sha256').update(metadataJson).digest('hex'));
});

test('rejects ineligible identities before requesting traits', async () => {
  let requests = 0;
  for (const [category, id] of [['egg', 1], ['painting', 0], ['video', 100_000]] as const) {
    await assert.rejects(fetchRevealAttributes(category, id, body, signal, async () => { requests++; return Response.json({}); }),
      InvalidRevealAttributes);
  }
  assert.equal(requests, 0);
});

test('validates source shape, response and final UTF-8 sizes', async () => {
  const invalid = [null, { attributes: [] }, { 'collection block': '  ', attributes: [] }, { 'collection block': 'Block' },
    { 'collection block': 'Block', attributes: [{ trait_type: 'Shape', value: null }] },
    { 'collection block': 'Block', attributes: [{ trait_type: 'Seed', value: { rawJSON: '1' } }] },
    { 'collection block': 'Block', attributes: [Array(2)] }];
  for (const source of invalid) {
    await assert.rejects(fetchRevealAttributes('painting', 1, body, signal, async () => Response.json(source)), RevealAttributeSourceUnavailable);
  }
  await assert.rejects(fetchRevealAttributes('painting', 1, body, signal, async () =>
    new Response('{"collection block":"Block","attributes":[{"trait_type":"count","value":1e999}]}',
      { headers: { 'Content-Type': 'application/json' } })), RevealAttributeSourceUnavailable);
  const fetchLargeSource = async () => Response.json({ 'collection block': 'B'.repeat(MAX_REVEAL_METADATA_BYTES), attributes: [] });
  await assert.rejects(fetchRevealAttributes('video', 1, body, signal, fetchLargeSource), /too-large/);
  const largeBase = JSON.stringify({ ...base, name: 'é'.repeat(MAX_REVEAL_METADATA_BYTES / 4) });
  await assert.rejects(fetchRevealAttributes('video', 1, largeBase, signal, async () =>
    Response.json({ 'collection block': 'b'.repeat(MAX_REVEAL_METADATA_BYTES / 2), attributes: [] })),
    error => error instanceof RevealAttributeSourceUnavailable && error.reason === 'too-large');
});

test('large trait collections remain intact within the bounded metadata limit', async () => {
  const attributes = Array.from({ length: 2792 }, (_, index) => ({ trait_type: `Trait ${index}`, value: 'v'.repeat(20) }));
  const source = JSON.stringify({ 'collection block': 'backrooms 2', attributes }, null, 2);
  assert.ok(Buffer.byteLength(source) > 128 * 1024);
  assert.ok(Buffer.byteLength(source) < MAX_REVEAL_METADATA_BYTES);
  const result = await fetchRevealAttributes('painting', 64946, body, signal,
    async () => new Response(source, { headers: { 'Content-Type': 'application/json' } }));
  assert.deepEqual(JSON.parse(result.metadataJson).attributes, [
    { trait_type: 'collection block', value: 'backrooms 2' }, ...base.attributes, ...attributes,
  ]);
  assert.ok(Buffer.byteLength(result.metadataJson) > 128 * 1024);
  assert.ok(Buffer.byteLength(result.metadataJson) < MAX_REVEAL_METADATA_BYTES);
});

test('the final metadata UTF-8 limit accepts its exact boundary and rejects one extra byte', async () => {
  const fetchWith = (value: string) => fetchRevealAttributes('painting', 1, body, signal,
    async () => Response.json({ 'collection block': 'Block', attributes: [{ trait_type: 'Text', value }] }));
  const overhead = Buffer.byteLength((await fetchWith('')).metadataJson);
  const room = MAX_REVEAL_METADATA_BYTES - overhead;
  const value = 'é'.repeat(Math.floor(room / 2)) + 'x'.repeat(room % 2);
  const result = await fetchWith(value);
  assert.equal(Buffer.byteLength(result.metadataJson), MAX_REVEAL_METADATA_BYTES);
  assert.equal(JSON.parse(result.metadataJson).attributes.at(-1).value, value);
  await assert.rejects(fetchWith(value + 'x'), error => error instanceof RevealAttributeSourceUnavailable && error.reason === 'too-large');
});

test('keeps every unsuccessful source response retryable', async () => {
  for (const status of [204, 301, 400, 401, 403, 404, 408, 410, 425, 429, 500, 503]) {
    await assert.rejects(fetchRevealAttributes('painting', 1, body, signal, async () => new Response(null, { status })),
      error => error instanceof RevealAttributeSourceUnavailable && error.reason === `http-${status}`);
  }
  const response = new Response('broken', { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(fetchRevealAttributes('painting', 1, body, signal, async () => response),
    error => error instanceof RevealAttributeSourceUnavailable && error.reason === 'invalid-json');
});

test('source network failures, HTML responses, broken streams and invalid encoding remain retryable', async () => {
  const failures: Array<[string, () => Promise<Response>]> = [
    ['request-failed', async () => { throw new Error('upstream connection lost'); }],
    ['unexpected-content-type', async () => new Response('<html>Temporary denial</html>', { headers: { 'Content-Type': 'text/html' } })],
    ['stream-failed', async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream lost')); } }),
      { headers: { 'Content-Type': 'application/json' } })],
    ['invalid-encoding', async () => new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } })],
  ];
  for (const [reason, source] of failures) {
    await assert.rejects(fetchRevealAttributes('painting', 1, body, signal, source),
      error => error instanceof RevealAttributeSourceUnavailable && error.reason === reason);
  }
});

test('oversized source streams are cancelled and remain eligible for a corrected source', async () => {
  let cancelled = false;
  const source = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_REVEAL_METADATA_BYTES + 1)); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(fetchRevealAttributes('painting', 1, body, signal, async () => source),
    error => error instanceof RevealAttributeSourceUnavailable && error.reason === 'too-large');
  assert.equal(cancelled, true);
});

test('a source whose transformed attribute payload exceeds the limit remains retryable', async () => {
  const source = (value: string) => JSON.stringify({ 'collection block': 'plane of existence', attributes: [{ trait_type: 'blob', value }] });
  const json = source('x'.repeat(MAX_REVEAL_METADATA_BYTES - Buffer.byteLength(source(''))));
  assert.equal(Buffer.byteLength(json), MAX_REVEAL_METADATA_BYTES);
  await assert.rejects(fetchRevealAttributes('painting', 1, body, signal,
    async () => new Response(json, { headers: { 'Content-Type': 'application/json' } })),
  error => error instanceof RevealAttributeSourceUnavailable && error.reason === 'too-large');
});
