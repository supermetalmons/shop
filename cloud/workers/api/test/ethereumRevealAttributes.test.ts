import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fetchRevealAttributes, InvalidRevealAttributes, MAX_REVEAL_METADATA_BYTES } from '../src/ethereumRevealAttributes.ts';

const base = { name: '42', attributes: [{ trait_type: 'type', value: 'painting' }], image: 'https://example.test/5.png',
  revealStatus: 'revealed', aspectRatio: { width: 3, height: 2 } };
const signal = new AbortController().signal;
const body = JSON.stringify(base);
const trait = { trait_type: 'Mark', value: 12, display_type: 'number' };

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
    await assert.rejects(fetchRevealAttributes('painting', 1, body, signal, async () => Response.json(source)), InvalidRevealAttributes);
  }
  await assert.rejects(fetchRevealAttributes('painting', 1, body, signal, async () =>
    new Response('{"collection block":"Block","attributes":[{"trait_type":"count","value":1e999}]}',
      { headers: { 'Content-Type': 'application/json' } })), InvalidRevealAttributes);
  const fetchLargeSource = async () => Response.json({ 'collection block': 'B'.repeat(MAX_REVEAL_METADATA_BYTES), attributes: [] });
  await assert.rejects(fetchRevealAttributes('video', 1, body, signal, fetchLargeSource), /too-large/);
  const largeBase = JSON.stringify({ ...base, name: 'é'.repeat(MAX_REVEAL_METADATA_BYTES / 4) });
  await assert.rejects(fetchRevealAttributes('video', 1, largeBase, signal, async () =>
    Response.json({ 'collection block': 'b'.repeat(MAX_REVEAL_METADATA_BYTES / 2), attributes: [] })), /exceeds 256 KiB/);
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
  await assert.rejects(fetchWith(value + 'x'), /exceeds 256 KiB/);
});

test('distinguishes invalid inputs from transient CDN failures', async () => {
  for (const status of [301, 404, 429, 503]) {
    await assert.rejects(fetchRevealAttributes('painting', 1, body, signal, async () => new Response(null, { status })),
      error => error instanceof Error && (error instanceof InvalidRevealAttributes) === (status === 301 || status === 404));
  }
  const response = new Response('broken', { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(fetchRevealAttributes('painting', 1, body, signal, async () => response), /invalid-json/);
});
