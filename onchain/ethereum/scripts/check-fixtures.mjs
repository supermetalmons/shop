import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

const fixturePath = new URL('../fixtures/', import.meta.url);
const fixtures = JSON.parse(await readFile(new URL('metadata.json', fixturePath), 'utf8'));
const types = ['', 'Artwork', 'Crate', 'Warehouse', 'Artwork Receipt', 'Crate Receipt'];
const previewDirectory = new URL('../out/media-previews/', import.meta.url);
await mkdir(previewDirectory, { recursive: true });
for (const fixture of fixtures) {
  assert.ok(fixture.tokenURI.startsWith('data:application/json;base64,'));
  const metadata = JSON.parse(Buffer.from(fixture.tokenURI.split(',')[1], 'base64').toString());
  assert.equal(metadata.name, `111K ${types[fixture.kind]} #${fixture.displayId}`);
  assert.ok(metadata.description.startsWith('111K test collection.'));
  assert.equal(metadata.attributes.find(attribute => attribute.trait_type === 'Item number').value, fixture.displayId);
  assert.ok(metadata.image.startsWith('data:image/svg+xml;base64,'));
  const svg = Buffer.from(metadata.image.split(',')[1], 'base64').toString();
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.endsWith('</svg>'));
  const svgTag = svg.match(/^<svg\b[^>]*>/)[0];
  assert.match(svgTag, /\bwidth="720"/);
  assert.match(svgTag, /\bheight="720"/);
  assert.match(svgTag, /\bviewBox="0 0 720 720"/);
  const text = Array.from(svg.matchAll(/<text\b[^>]*>(.*?)<\/text>/gs), match => match[1]).sort();
  const expectedText = fixture.kind === 1 || fixture.kind === 4 ? [] : [String(fixture.displayId)];
  if (fixture.kind >= 4) expectedText.push('REDEEMED');
  assert.deepEqual(text, expectedText.sort());
  assert.ok(!/<script|<foreignObject|href=/.test(svg));
  await writeFile(new URL(`${fixture.kind}-${fixture.displayId}.svg`, previewDirectory), svg);
}
const eip712 = JSON.parse(await readFile(new URL('eip712.json', fixturePath), 'utf8'));
assert.equal(eip712.domainName, '111K');
assert.equal(eip712.domainVersion, '2');
assert.equal(eip712.delivery.receiptIds.length, eip712.delivery.tokenIds.length);
assert.match(eip712.delivery.receiptIdsHash, /^0x[0-9a-f]{64}$/);
assert.equal(eip712.delivery.signature.length, 132);
assert.equal(eip712.claim.signature.length, 132);
process.stdout.write(`Validated ${fixtures.length} onchain SVG/JSON fixtures and authorization fixtures.\n`);
