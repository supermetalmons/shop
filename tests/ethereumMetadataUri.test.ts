import assert from 'node:assert/strict';
import test from 'node:test';
import { ethereumTokenMetadataUri } from '../shared/ethereum/metadataUri.ts';

const scopes = [
  { chainId: 11155111, metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/' },
  { chainId: 11155111, metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/replacement-2/' },
  { chainId: 1, metadataBaseUri: 'https://cdn.mons.shop/111k/mainnet-1/' },
  { chainId: 31337, metadataBaseUri: 'https://cdn.mons.shop/111k/local-1/' },
];

for (const [kind, first, last] of [
  ['artwork', '1', '111111'], ['crate', '111112', '116666'], ['warehouse', '116667', '117171'],
  ['artwork_receipt', '1000001', '1222222'], ['crate_receipt', '2000001', '2005555'],
]) test(`${kind} metadata boundaries preserve every configured deployment prefix`, () => {
  for (const scope of scopes) for (const id of [first, last]) {
    assert.equal(ethereumTokenMetadataUri(scope, id), `${scope.metadataBaseUri}${id}.json`);
  }
});

test('metadata URLs reject noncanonical and unassigned token IDs', () => {
  for (const id of ['0', '-1', '01', '0x1', '1.0', '1/../2', '1?version=2', '117172', '1000000', '1222223', '2000000', '2005556', '9'.repeat(100)]) {
    assert.throws(() => ethereumTokenMetadataUri(scopes[0], id), /Invalid Ethereum metadata token ID/);
  }
});

test('metadata URLs reject cross-chain, noncanonical and foreign base paths', () => {
  for (const metadataBaseUri of [
    'https://cdn.mons.shop/111k/', 'https://other.example/111k-sepolia/', 'http://cdn.mons.shop/111k-sepolia/',
    'https://cdn.mons.shop/111k-sepolia', 'https://cdn.mons.shop/111k-sepolia/../111k-sepolia/',
    'https://cdn.mons.shop/111k-sepolia/a/b/', 'https://cdn.mons.shop/111k-sepolia/%61/',
    'https://cdn.mons.shop/111k-sepolia/?revision=2', 'https://cdn.mons.shop/111k-sepolia/#x',
    'https://user:secret@cdn.mons.shop/111k-sepolia/',
  ]) assert.throws(() => ethereumTokenMetadataUri({ chainId: 11155111, metadataBaseUri }, '1'), /Invalid Ethereum metadata base URI/);
  assert.throws(() => ethereumTokenMetadataUri({ ...scopes[0], chainId: 1 }, '1'), /Invalid Ethereum metadata base URI/);
  assert.throws(() => ethereumTokenMetadataUri({ ...scopes[0], chainId: 10 }, '1'), /Invalid Ethereum metadata base URI/);
});
