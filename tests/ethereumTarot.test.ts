import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeTarotClaim, resolveTarotConfig, tarotCodeHashInput, tarotReceiptTokenId,
  TAROT_CHAIN_ID, TAROT_MAX_CARDS, TAROT_METADATA_BASE_URI,
} from '../shared/ethereum/tarot.ts';
import { isTarotTokenId } from '../shared/ethereum/tarotCard.ts';
import { tarotClaimDigest, TAROT_CLAIMED_TOPIC } from '../shared/ethereum/tarotCrypto.ts';
import { ethereumSignerAddress, recoverEthereumAddress, signDigest } from '../shared/ethereum/crypto.ts';
import { decodeReturn } from '../shared/ethereum/abi.ts';

const contractAddress = '0x3333333333333333333333333333333333333333';
const wallet = '0x1111111111111111111111111111111111111111';
const code = '70664cea-b3ab-4004-9a34-5527b5380ad2';

test('Tarot deployment configuration is always Sepolia and requires explicit enablement', () => {
  const config = resolveTarotConfig({ contractAddress, deploymentBlock: '123', enabled: true });
  assert.equal(config.chainId, 11155111);
  assert.equal(config.testnet, true);
  assert.equal(config.enabled, true);
  assert.equal(config.confirmationBlocks, 3);
  assert.equal(config.maxCards, 777);
  assert.equal(config.deploymentBlock, 123);
  assert.equal(resolveTarotConfig({ enabled: true }).enabled, false);
  assert.equal(resolveTarotConfig({ contractAddress }).enabled, false);
  assert.equal(TAROT_METADATA_BASE_URI, 'https://cdn.mons.shop/tarot-sepolia/v1/');
  for (const contractAddress of ['wrong', '0x' + '0'.repeat(40)]) assert.throws(() => resolveTarotConfig({ contractAddress }));
  for (const deploymentBlock of [-1, 1.5, 'broken', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => resolveTarotConfig({ deploymentBlock }));
  }
});

test('all Tarot IDs have unique matching receipt IDs and other values are rejected', () => {
  const receipts = new Set<number>();
  for (let id = 1; id <= TAROT_MAX_CARDS; ++id) {
    assert.equal(isTarotTokenId(id), true);
    assert.equal(tarotReceiptTokenId(id), id + 777);
    receipts.add(tarotReceiptTokenId(id));
  }
  assert.equal(receipts.size, 777);
  for (const id of [0, 778, -1, 1.5, NaN, Infinity, '1', null, undefined]) assert.equal(isTarotTokenId(id), false);
  for (const id of [0, 778, -1, 1.5, NaN]) assert.throws(() => tarotReceiptTokenId(id));
});

test('claim code hashing normalizes casing and binds deployment and card without exposing invalid secrets', () => {
  const args = { chainId: TAROT_CHAIN_ID, contractAddress, tokenId: 1, code };
  assert.equal(tarotCodeHashInput(args), `mons:tarot:claim:v1:11155111:${contractAddress}:1:${code}`);
  assert.equal(tarotCodeHashInput({ ...args, code: code.toUpperCase() }), tarotCodeHashInput(args));
  assert.notEqual(tarotCodeHashInput({ ...args, tokenId: 2 }), tarotCodeHashInput(args));
  assert.notEqual(tarotCodeHashInput({ ...args, contractAddress: wallet }), tarotCodeHashInput(args));
  for (const invalid of [{ ...args, chainId: 1 }, { ...args, contractAddress: '0x' + '0'.repeat(40) },
    { ...args, tokenId: 778 }, { ...args, code: 'secret-do-not-log' }, { ...args, code: code.replace('-4004-', '-3004-') }]) {
    assert.throws(() => tarotCodeHashInput(invalid), /^Error: Invalid Tarot claim code scope$/);
  }
});

test('Tarot signing matches the Solidity fixture and binds every authorization field', () => {
  const claim = { chainId: 11155111, contractAddress, wallet, tokenId: 777, deadline: 2_000_000_600 };
  const digest = tarotClaimDigest(claim);
  assert.equal(digest, '0x2000d9adbb67a0beb4cc16b29f621b369f4b6396a12308a78393169888fc261a');
  const key = '0x' + 'a11ce'.padStart(64, '0');
  assert.equal(recoverEthereumAddress(digest, signDigest(key, digest)), ethereumSignerAddress(key));
  for (const modified of [{ ...claim, chainId: 1 }, { ...claim, contractAddress: wallet },
    { ...claim, wallet: contractAddress }, { ...claim, tokenId: 1 }, { ...claim, deadline: claim.deadline + 1 }]) {
    assert.notEqual(tarotClaimDigest(modified), digest);
  }
  assert.match(TAROT_CLAIMED_TOPIC, /^0x[0-9a-f]{64}$/);
});

test('claim calldata encodes only the NFT ID, deadline and authorization', () => {
  const signature = '0x' + 'ab'.repeat(65);
  const data = encodeTarotClaim(777, 2_000_000_600, signature);
  assert.deepEqual(decodeReturn(['uint256', 'uint256', 'bytes'], `0x${data.slice(10)}`), [777n, 2_000_000_600n, signature]);
  assert.throws(() => encodeTarotClaim(778, 2_000_000_600, signature));
});
