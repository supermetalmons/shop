import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { encodeAbi, decodeReturn, encodeCall, decodeEventLogs, ETHEREUM_EVENT_TOPICS } from '../shared/ethereum/abi.ts';
import { crateClaimDigest, deliveryDigest, ethereumReceiptIdsHash, ethereumTokenIdsHash, ethereumSignerAddress, personalMessageHash, recoverEthereumAddress, signDigest } from '../shared/ethereum/crypto.ts';
import { physicalCrateArtworkIds, ethereumAssetId, ethereumReceiptTokenId, ethereumMetadataTokenId,
  ethereumItemDisplayIdMaximum, formatEtherAmount } from '../shared/ethereum/protocol.ts';
import { ethereumMetadataBaseUri, resolveEthereum111kConfig } from '../shared/ethereum/config.ts';
import { nft111KAbi, nft111KRendererAbi } from '../shared/ethereum/abi.generated.ts';
import { ETHEREUM_FUNCTIONS } from '../shared/ethereum/protocol.ts';

test('generated contract ABI covers every client call and metadata renderer', () => {
  type Input = { type: string; components?: readonly Input[] };
  const typeName = (input: Input): string => input.type.startsWith('tuple')
    ? `(${input.components!.map(typeName).join(',')})${input.type.slice(5)}` : input.type;
  const signatures = new Set(nft111KAbi.filter(entry => entry.type === 'function')
    .map(entry => `${entry.name}(${entry.inputs.map(typeName).join(',')})`));
  for (const signature of Object.values(ETHEREUM_FUNCTIONS)) assert.ok(signatures.has(signature), signature);
  assert.ok(nft111KRendererAbi.some(entry => entry.type === 'function' && entry.name === 'tokenURI'));
});

const WALLET = '0x1111111111111111111111111111111111111111';
const CONTRACT = '0x2222222222222222222222222222222222222222';
const CAST_RECEIPTS_HASH = '0x3135a7cb738129654bbf3ba3ce5d9f682fa58813bbda9dfa4e7b1e5bfc8cc71b';
const CAST_DELIVERY_VECTOR = '0x00000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000005af3107a400000000000000000000000000000000000000000000000000000000000773594003135a7cb738129654bbf3ba3ce5d9f682fa58813bbda9dfa4e7b1e5bfc8cc71b0000000000000000000000000000000000000000000000000000000000000160000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000031234560000000000000000000000000000000000000000000000000000000000';
const CAST_NESTED_VECTOR = '0x00000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000015b3000000000000000000000000000000000000000000000000000000000001b207000000000000000000000000000000000000000000000000000000000000000c3131316b2072656365697074000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000056372617465000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000977617265686f7573650000000000000000000000000000000000000000000000';

test('ABI delivery tuple and calldata match independent Foundry cast encoding', () => {
  const types = ['uint256[]', '(uint256,address,uint256,uint256,bytes32)', 'bytes'];
  const receiptIdsHash = ethereumReceiptIdsHash([1000001, 1000002, 1000020]);
  assert.equal(receiptIdsHash, CAST_RECEIPTS_HASH);
  const args = [[1n, 2n, 20n], [42n, WALLET, 100000000000000n, 2000000000n, receiptIdsHash], '0x123456'];
  assert.equal(encodeAbi(types, args), CAST_DELIVERY_VECTOR);
  assert.deepEqual(decodeReturn(types, CAST_DELIVERY_VECTOR), args);
  assert.equal(encodeCall('mintCrates(uint256)', ['uint256'], [15]), '0x38aa175c' + 'f'.padStart(64, '0'));
});

test('ABI nested dynamic arrays, strings, and fixed arrays match Foundry cast', () => {
  const types = ['string', 'string[]', 'uint24[3]'];
  const args = ['111k receipt', ['crate', 'warehouse'], [1n, 5555n, 111111n]];
  assert.equal(encodeAbi(types, args), CAST_NESTED_VECTOR);
  assert.deepEqual(decodeReturn(types, CAST_NESTED_VECTOR), args);
  const nested = ['(uint256,string)[]'];
  const values = [[[1n, 'one'], [2n, 'two']]];
  assert.deepEqual(decodeReturn(nested, encodeAbi(nested, values)), values);
});

test('batch token-info tuples and ordered crate commitments match Foundry cast', () => {
  const castInfos = '0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000003350000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000015b30000000000000000000000002222222222222222222222222222222222222222';
  const infos = [[1n, 821n, WALLET], [0n, 0n, `0x${'0'.repeat(40)}`], [5n, 5555n, CONTRACT]];
  assert.equal(encodeAbi(['(uint8,uint256,address)[]'], [infos]), castInfos);
  assert.deepEqual(decodeReturn(['(uint8,uint256,address)[]'], castInfos), [infos]);
  const ids = [111112, 116666, 111113];
  assert.equal(ethereumTokenIdsHash(ids), '0x9b86e2acc7b70d77172ef248460e61b40ff43b920fa8cb4e27fb3640849e7b3c');
  assert.notEqual(ethereumTokenIdsHash([...ids].reverse()), ethereumTokenIdsHash(ids));
  assert.notEqual(ethereumTokenIdsHash(ids.slice(0, -1)), ethereumTokenIdsHash(ids));
  assert.throws(() => decodeReturn(['(uint8,uint256,address)[]'], castInfos.slice(0, -64)));
});

test('ABI rejects unsafe inputs and malformed provider output', () => {
  assert.throws(() => encodeAbi(['uint256'], [Number.MAX_SAFE_INTEGER + 1]));
  assert.throws(() => encodeAbi(['uint8'], [256]));
  assert.throws(() => encodeAbi(['address'], ['not-a-wallet']));
  assert.throws(() => encodeAbi(['bytes32'], ['0x1234']));
  assert.throws(() => decodeReturn(['uint256'], '0x12'));
  assert.throws(() => decodeReturn(['bool'], encodeAbi(['uint256'], [2])));
  assert.throws(() => decodeReturn(['address'], encodeAbi(['uint256'], [1n << 200n])));
  assert.throws(() => decodeReturn(['bytes'], encodeAbi(['uint256'], [0])));
  assert.throws(() => decodeReturn(['bytes'], encodeAbi(['uint256'], [33])));
  assert.throws(() => decodeReturn(['bytes'], encodeAbi(['uint256', 'uint256'], [32, 1000000])));
  assert.throws(() => decodeReturn(['uint256[]'], encodeAbi(['uint256', 'uint256'], [32, 10001])));
  assert.deepEqual(decodeReturn(['int8', 'int256'], encodeAbi(['int8', 'int256'], [-128n, -1n])), [-128n, -1n]);
});

test('delivery signatures bind the exact order, wallet, tokens, artwork identities, amount, domain and expiry', () => {
  const key = '01'.padStart(64, '0');
  const args = { chainId: 31337, contractAddress: CONTRACT, wallet: WALLET, tokenIds: ['1', '2'], orderId: 42,
    fee: '100000000000000', deadline: 2000000000, receiptIdsHash: ethereumReceiptIdsHash([1000001, 1000002]) };
  const digest = deliveryDigest(args);
  const signature = signDigest(key, digest);
  const signer = ethereumSignerAddress(key);
  assert.equal(signer, '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
  assert.equal(recoverEthereumAddress(digest, signature), signer);
  for (const changed of [
    { chainId: 11155111 }, { contractAddress: WALLET }, { wallet: CONTRACT },
    { tokenIds: ['2', '1'] }, { tokenIds: ['1', '2', '3'] }, { orderId: 43 },
    { receiptIdsHash: ethereumReceiptIdsHash([1000021, 1000002]) },
    { receiptIdsHash: ethereumReceiptIdsHash([1000002, 1000001]) },
    { fee: '0' }, { deadline: 2000000001 },
  ]) assert.notEqual(recoverEthereumAddress(deliveryDigest({ ...args, ...changed }), signature), signer);
  assert.equal(recoverEthereumAddress(digest, signature.slice(0, -2) + 'ff'), null);
});

test('claim authorization is separate from delivery and signing a message is recoverable', () => {
  const key = '02'.padStart(64, '0');
  const claim = { chainId: 31337, contractAddress: CONTRACT, wallet: WALLET, receiptId: '2005555', claimId: '0x' + 'ab'.repeat(32), deadline: 2000000000 };
  const digest = crateClaimDigest(claim);
  const signature = signDigest(key, digest);
  assert.equal(recoverEthereumAddress(digest, signature), ethereumSignerAddress(key));
  assert.notEqual(crateClaimDigest({ ...claim, receiptId: '2000001' }), digest);
  assert.notEqual(crateClaimDigest({ ...claim, wallet: CONTRACT }), digest);
  const personal = personalMessageHash('Sign in to 111k');
  assert.equal(recoverEthereumAddress(personal, signDigest(key, personal)), ethereumSignerAddress(key));
});

test('delivery and claim digests and calldata match Solidity-generated fixtures', () => {
  const fixture = JSON.parse(readFileSync(new URL('../onchain/ethereum/fixtures/eip712.json', import.meta.url), 'utf8')) as {
    chainId: number; verifyingContract: string; wallet: string; signer: string;
    delivery: { tokenIds: number[]; receiptIds: number[]; receiptIdsHash: string; orderId: string; fee: string; deadline: number; digest: string; signature: string; calldata: string };
    claim: { receiptId: string; claimId: string; deadline: number; digest: string; signature: string; calldata: string };
  };
  const domain = { chainId: fixture.chainId, contractAddress: fixture.verifyingContract, wallet: fixture.wallet };
  assert.equal(ethereumReceiptIdsHash(fixture.delivery.receiptIds), fixture.delivery.receiptIdsHash);
  assert.equal(deliveryDigest({ ...domain, ...fixture.delivery }), fixture.delivery.digest);
  assert.equal(crateClaimDigest({ ...domain, ...fixture.claim }), fixture.claim.digest);
  assert.equal(recoverEthereumAddress(fixture.delivery.digest, fixture.delivery.signature), fixture.signer);
  assert.equal(recoverEthereumAddress(fixture.claim.digest, fixture.claim.signature), fixture.signer);
  assert.equal(encodeCall(ETHEREUM_FUNCTIONS.redeemForDelivery,
    ['uint256[]', '(uint256,address,uint256,uint256,bytes32)', 'bytes'],
    [fixture.delivery.tokenIds, [fixture.delivery.orderId, fixture.wallet, fixture.delivery.fee, fixture.delivery.deadline, fixture.delivery.receiptIdsHash], fixture.delivery.signature]), fixture.delivery.calldata);
  assert.equal(encodeCall('claimCrateReceipt(uint256,bytes32,uint256,bytes)', ['uint256', 'bytes32', 'uint256', 'bytes'],
    [fixture.claim.receiptId, fixture.claim.claimId, fixture.claim.deadline, fixture.claim.signature]), fixture.claim.calldata);
});

test('batch calldata and ordered crate hashes match Solidity-generated fixtures', () => {
  const fixture = JSON.parse(readFileSync(new URL('../onchain/ethereum/fixtures/eip712.json', import.meta.url), 'utf8')) as {
    calls: { unboxCratesUnsorted: string; getTokenInfos: string; previewTokenURIs: string };
    batchUnbox: { tokenIds: number[]; artworkCount: number; tokenIdsHash: string };
  };
  assert.equal(encodeCall(ETHEREUM_FUNCTIONS.unboxCrates, ['uint256[]'], [fixture.batchUnbox.tokenIds]), fixture.calls.unboxCratesUnsorted);
  assert.equal(ethereumTokenIdsHash(fixture.batchUnbox.tokenIds), fixture.batchUnbox.tokenIdsHash);
  assert.equal(fixture.batchUnbox.tokenIds.flatMap(id => physicalCrateArtworkIds(id - 111111)).length, fixture.batchUnbox.artworkCount);
  assert.equal(encodeCall(ETHEREUM_FUNCTIONS.tokenInfos, ['uint256[]'], [[1, 0, 111112]]), fixture.calls.getTokenInfos);
  assert.equal(encodeCall(ETHEREUM_FUNCTIONS.previewTokenURIs, ['uint8[]', 'uint256[]'], [[4, 1, 5], [111111, 42, 5555]]), fixture.calls.previewTokenURIs);
});

test('events decode only the configured contract and retain exact uint256 token identities', () => {
  const logs = [{
    address: CONTRACT, topics: [ETHEREUM_EVENT_TOPICS.Transfer, encodeAbi(['address'], [WALLET]), encodeAbi(['address'], [CONTRACT]), encodeAbi(['uint256'], [2005555])], data: '0x',
  }, {
    address: CONTRACT, topics: [ETHEREUM_EVENT_TOPICS.DeliveryRedeemed, encodeAbi(['uint256'], [42]), encodeAbi(['address'], [WALLET])],
    data: encodeAbi(['uint256', 'uint256[]', 'uint256[]'], [0, [111112n, 1n], [2000001n, 1000001n]]),
  }];
  const events = decodeEventLogs(logs, CONTRACT);
  assert.equal(events.length, 2);
  assert.equal(events[0].name, 'Transfer');
  assert.equal(events[1].name, 'DeliveryRedeemed');
  if (events[1].name === 'DeliveryRedeemed') assert.deepEqual(events[1].receiptIds, ['2000001', '1000001']);
  assert.equal(decodeEventLogs(logs, WALLET).length, 0);
  assert.equal(decodeEventLogs([{ ...logs[0], removed: true }], CONTRACT).length, 0);
});

test('digital and physical-only receipt identities occupy separate complete ranges', () => {
  assert.equal(ethereumReceiptTokenId('crate', 5555), '2005555');
  assert.equal(ethereumReceiptTokenId('artwork', 111111), '1111111');
  assert.throws(() => ethereumReceiptTokenId('artwork', 111112));
  assert.deepEqual(physicalCrateArtworkIds(1), Array.from({ length: 20 }, (_, i) => 111112 + i));
  assert.deepEqual(physicalCrateArtworkIds(5555), Array.from({ length: 31 }, (_, i) => 222192 + i));
  assert.equal(ethereumMetadataTokenId('artwork_receipt', 111112), '1111112');
  assert.equal(ethereumMetadataTokenId('artwork_receipt', 222222), '1222222');
  assert.equal(ethereumMetadataTokenId('warehouse', 505), '117171');
  assert.equal(ethereumItemDisplayIdMaximum('artwork'), 111111);
  assert.equal(ethereumItemDisplayIdMaximum('artwork_receipt'), 222222);
  assert.throws(() => ethereumMetadataTokenId('artwork_receipt', 222223));
  assert.throws(() => ethereumMetadataTokenId('artwork', 111112));
  assert.throws(() => physicalCrateArtworkIds(5556));
  assert.equal(ethereumAssetId(31337, CONTRACT.toUpperCase().replace('0X', '0x'), '0x1'), `eip155:31337:${CONTRACT}:1`);
  assert.equal(formatEtherAmount('1100000000000000'), '0.0011');
  assert.equal(resolveEthereum111kConfig().enabled, false);
  assert.throws(() => resolveEthereum111kConfig({ chainId: 1 }));
});

test('metadata base URIs accept only the published CDN namespaces', () => {
  assert.equal(resolveEthereum111kConfig().metadataBaseUri, 'https://cdn.mons.shop/111k-sepolia/');
  assert.equal(resolveEthereum111kConfig({ chainId: 31337, metadataBaseUri: 'https://cdn.mons.shop/111k/' }).metadataBaseUri,
    'https://cdn.mons.shop/111k/');
  assert.throws(() => resolveEthereum111kConfig({ metadataBaseUri: 'https://cdn.mons.shop/111k/' }));
  assert.equal(ethereumMetadataBaseUri('https://cdn.mons.shop/111k/', 1), 'https://cdn.mons.shop/111k/');
  assert.throws(() => ethereumMetadataBaseUri('https://cdn.mons.shop/111k-sepolia/', 1));
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const metadataBaseUri = `http://${host}:8788/111k-sepolia/`;
    assert.throws(() => resolveEthereum111kConfig({ chainId: 31337, metadataBaseUri }));
    assert.throws(() => resolveEthereum111kConfig({ metadataBaseUri }));
  }
  assert.throws(() => resolveEthereum111kConfig({ chainId: 31337, metadataBaseUri: 'http://localhost:8788/other/' }));
  assert.throws(() => resolveEthereum111kConfig({ chainId: 31337, metadataBaseUri: 'https://localhost:8788/111k-sepolia/' }));
  for (const metadataBaseUri of ['https://cdn.mons.shop.evil.test/111k-sepolia/', 'https://cdn.mons.shop/other/',
    'https://cdn.mons.shop/111k-sepolia', 'https://cdn.mons.shop/111k-sepolia/?version=1',
    'https://user@cdn.mons.shop/111k-sepolia/', 'http://cdn.mons.shop/111k-sepolia/',
    'https://cdn.mons.shop:443/111k-sepolia/', 'https://cdn.mons.shop/../111k-sepolia/']) {
    assert.throws(() => resolveEthereum111kConfig({ metadataBaseUri }), metadataBaseUri);
  }
});
