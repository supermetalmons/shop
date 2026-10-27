import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fixturePath = new URL('../fixtures/', import.meta.url);
const eip712 = JSON.parse(await readFile(new URL('eip712.json', fixturePath), 'utf8'));
assert.equal(eip712.domainName, '111K');
assert.equal(eip712.domainVersion, '2');
assert.equal(eip712.delivery.receiptIds.length, eip712.delivery.tokenIds.length);
assert.match(eip712.delivery.receiptIdsHash, /^0x[0-9a-f]{64}$/);
assert.equal(eip712.delivery.signature.length, 132);
assert.equal(eip712.claim.signature.length, 132);
process.stdout.write('Validated authorization fixtures.\n');
