import assert from 'node:assert/strict';
import test from 'node:test';
import { appendTwinTrait } from '../shared/ethereum/twinMetadataTrait.ts';

test('appending a boolean twin trait preserves every byte outside the insertion', () => {
  const before = String.raw`{ "nested":{"attributes":["]"]}, "attrib\u0075tes" : [ {"trait_type":"precise","value":90071992547409931030.00e-1}  ], "name" : "\u0061" }` + '\n';
  const good = appendTwinTrait(before, 'good twin');
  assert.equal(good, before.replace('}  ]', '},{"trait_type":"good twin","value":true}  ]'));
  assert.deepEqual(JSON.parse(good).attributes.at(-1), { trait_type: 'good twin', value: true });
  assert.equal(appendTwinTrait('{"attributes":[ ]}', 'evil twin'), '{"attributes":[{"trait_type":"evil twin","value":true} ]}');
  assert.throws(() => appendTwinTrait(good, 'good twin'), /existing twin trait/);
  assert.throws(() => appendTwinTrait(good, 'evil twin'), /existing twin trait/);
  assert.throws(() => appendTwinTrait('{"attributes":[],"attributes":[]}', 'evil twin'), /duplicate metadata property/);
});
