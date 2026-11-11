import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRelicImagePatch, parseRelicImagesRequest, prepareRelicImagePatch, relicImagePngJson,
  MAX_RELIC_METADATA_BYTES, RELIC_IMAGE_TOKEN_IDS } from '../shared/ethereum/relicImages.ts';

const scope = { deploymentId: 'mainnet-v1', chainId: 1, contractAddress: `0x${'11'.repeat(20)}`,
  metadataBaseUri: 'https://cdn.mons.shop/111k/', expectedRevision: 3 };
const body = '{\n  "name": "Relic #1", "description": "", "image": "https://cdn.lil.org/nft/111k/relics/1.webp",\n' +
  '  "attributes": [{"trait_type":"number","value":12345678901234567890}], "nested":{"image":"unchanged.webp"}\n}\n';

test('relic patches preserve all nonimage bytes, numeric precision, and existing PNG objects', () => {
  const patch = prepareRelicImagePatch('117172', body, 'original-etag');
  assert.equal(patch.afterJson, body.replace('/1.webp', '/1.png'));
  assert.notEqual(patch.beforeSha256, patch.afterSha256);
  assert.deepEqual(parseRelicImagePatch(patch), patch);
  const unchanged = prepareRelicImagePatch('117172', patch.afterJson, 'new-etag');
  assert.equal(unchanged.beforeJson, unchanged.afterJson);
  assert.equal(unchanged.beforeSha256, unchanged.afterSha256);
  assert.equal(RELIC_IMAGE_TOKEN_IDS.length, 18);
});

test('relic image transform rejects ambiguous, foreign, mismatched, and nonrelic targets', () => {
  for (const json of [body.replace('/1.webp', '/2.webp'), body.replace('cdn.lil.org', 'example.test'),
    body.replace('"image":', '"image":"https://cdn.lil.org/nft/111k/relics/1.webp", "image":'),
    body.replace('"image":', '"im\\u0061ge":"ignored", "image":'),
    body.replace('https://', 'https:\\/\\/'), '\ufeff' + body, '[]', ' '.repeat(128 * 1024) + body]) {
    assert.throws(() => relicImagePngJson('117172', json));
  }
  for (const tokenId of ['1', '111112', '116667', '117171', '117190', '3000001', '0117172', '../117172']) {
    assert.throws(() => relicImagePngJson(tokenId, body));
  }
});

test('relic requests require exact identities and deterministic image-only patches', () => {
  const patch = prepareRelicImagePatch('117172', body, 'original-etag');
  assert.deepEqual(parseRelicImagesRequest({ scope, action: 'inspect' }), { scope, action: 'inspect' });
  assert.deepEqual(parseRelicImagesRequest({ scope, action: 'apply', patch }), { scope, action: 'apply', patch });
  for (const value of [{ ...scope, chainId: 31337 }, { ...scope, chainId: '1' }, { ...scope, expectedRevision: 0 },
    { ...scope, metadataBaseUri: scope.metadataBaseUri + '../other/' }, { ...scope, contractAddress: `0x${'00'.repeat(20)}` },
    { ...scope, deploymentId: '../mainnet' }, { ...scope, arbitrary: 'field' }]) {
    assert.throws(() => parseRelicImagesRequest({ scope: value, action: 'inspect' }));
  }
  for (const changed of [{ ...patch, afterJson: patch.afterJson.replace('Relic #1', 'Changed') },
    { ...patch, beforeSha256: 'a'.repeat(64) }, { ...patch, afterSha256: 'a'.repeat(64) }, { ...patch, etag: '"quoted"' },
    { ...patch, path: 'anything' }]) assert.throws(() => parseRelicImagePatch(changed));
});

test('name patches apply all eighteen approved names without changing other bytes', () => {
  const names = ['back_crucifix', 'bloody margiela shoe', 'Card NFT 2 Booster Box', 'clogs_vase', 'cross room',
    'drif alien corpse', 'drifella armature', 'Drifella soft sculpture figure painting', 'Drifella Lower Dimension game case',
    'Drilady crucifix scarecrow soft sculpture', 'family portrait', 'glazed porcelain drifella tile', 'hanged man', 'opened',
    'reflection', 'reflections with crucifix', 'stanczyk hat', 'The Night Parade of 111,111 Demons'];
  for (const [index, tokenId] of RELIC_IMAGE_TOKEN_IDS.entries()) {
    const id = index + 1;
    const source = `{ "name":"Relic #${id}", "description":"", "image":"https://cdn.lil.org/nft/111k/relics/${id}.png",` +
      ` "attributes":[{"trait_type":"number","value":12345678901234567890}], "nested":{"name":"Relic #${id}"} }\n`;
    const patch = prepareRelicImagePatch(tokenId, source, 'original', 'name');
    assert.equal(patch.afterJson, source.replace(`"name":"Relic #${id}"`, `"name":${JSON.stringify(names[index])}`));
    assert.deepEqual(parseRelicImagePatch(patch, 'name'), patch);
    assert.deepEqual(parseRelicImagesRequest({ scope, field: 'name', action: 'apply', patch }), { scope, field: 'name', action: 'apply', patch });
    assert.equal(prepareRelicImagePatch(tokenId, patch.afterJson, 'new', 'name').afterJson, patch.afterJson);
    assert.throws(() => parseRelicImagePatch(patch), /patch content or checksum/);
  }
});

test('name patches reject foreign names, ambiguous fields, and unapproved changes', () => {
  for (const source of [body.replace('Relic #1', 'Relic #2'), body.replace('Relic #1', 'Another name'),
    body.replace('"name":', '"name":"Relic #1", "name":'), body.replace('Relic #1', 'Relic \\u00231')]) {
    assert.throws(() => prepareRelicImagePatch('117172', source, 'original', 'name'));
  }
  const patch = prepareRelicImagePatch('117172', body, 'original', 'name');
  assert.throws(() => parseRelicImagePatch({ ...patch, afterJson: patch.afterJson.replace('/1.webp', '/1.png') }, 'name'));
  for (const field of ['description', 'image', null, undefined]) {
    assert.throws(() => parseRelicImagesRequest({ scope, field, action: 'inspect' }));
  }
});

test('name expansion cannot exceed the metadata byte limit', () => {
  const base = '{"name":"Relic #18","description":"","image":"https://cdn.lil.org/nft/111k/relics/18.png","attributes":[],"padding":""}';
  const source = base.replace('"padding":""', `"padding":"${'x'.repeat(MAX_RELIC_METADATA_BYTES - Buffer.byteLength(base))}"`);
  assert.equal(Buffer.byteLength(source), MAX_RELIC_METADATA_BYTES);
  assert.throws(() => prepareRelicImagePatch('117189', source, 'original', 'name'), /metadata/);
});
