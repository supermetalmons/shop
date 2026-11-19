import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { duplicateCorrectionDefinition as definition } from '../shared/ethereum/installedDuplicateCorrection.ts';
import { duplicateCorrectionMediaPreflight } from '../scripts/ethereum-metadata/duplicateCorrectionMedia.ts';

test('correction groups match the reviewed source in resolution-first keeper order', () => {
  const csv = gunzipSync(readFileSync(new URL('../releases/111k-mainnet-duplicate-correction-2026-11-19/duplicate-painting-groups.csv.gz', import.meta.url)));
  assert.equal(createHash('sha256').update(csv).digest('hex'), '34c85b83b4e626f519ab5ee31f7cbdad80aa39bcebba109ed407c7b6ac6bf8c4');
  const expected = csv.toString('utf8').trim().split(/\r?\n/).slice(1).map(line => {
    const columns = line.split(',');
    const ids = columns.slice(2, 6).filter(Boolean).map(Number);
    const areas = columns[6].split(' / ').map(size => size.split('x').map(Number).reduce((w, h) => w * h));
    return ids.map((id, i) => ({ id, area: areas[i] })).sort((a, b) => b.area - a.area || a.id - b.id).map(item => item.id);
  });
  assert.deepEqual(definition.groups, expected);
  assert.equal(new Set(definition.groups.flat()).size, 628);
  assert.equal(definition.groups.length, 313);
  assert.equal(new Set(definition.eggCandidates).size, definition.eggCandidates.length);
  assert.ok(definition.eggCandidates.every(id => id > 55_303 && id <= 62_510));
});

test('preflight rejects a changed egg inventory before any CDN requests', async () => {
  await assert.rejects(duplicateCorrectionMediaPreflight({ ...definition, eggCandidates: [] }, () => {
    throw new Error('unexpected network request');
  }), /inventory changed/);
});
