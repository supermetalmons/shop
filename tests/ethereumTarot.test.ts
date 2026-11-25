import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeTarotClaim, encodeTarotClaimTo, resolveTarotConfig, tarotCodeHashInput, tarotReceiptTokenId,
  TAROT_CHAIN_ID, TAROT_MAX_CARDS, tarotChainId,
} from '../shared/ethereum/tarot.ts';
import { isTarotTokenId } from '../shared/ethereum/tarotCard.ts';
import { dmxMintDigest, dmxRedemptionDigest, tarotClaimDigest, TAROT_CLAIMED_TOPIC } from '../shared/ethereum/tarotCrypto.ts';
import { DMX_MAX_CARDS, dmxRedemptionReceiptTokenId, encodeDmxMintTo,
  encodeDmxMintToAuthorized, encodeDmxRedeem } from '../shared/ethereum/dmx.ts';
import { ethereumSignerAddress, recoverEthereumAddress, signDigest } from '../shared/ethereum/crypto.ts';
import { decodeReturn } from '../shared/ethereum/abi.ts';

const contractAddress = '0x3333333333333333333333333333333333333333';
const wallet = '0x1111111111111111111111111111111111111111';
const code = '70664cea-b3ab-4004-9a34-5527b5380ad2';

test('Tarot defaults to mainnet, keeps Sepolia explicit, and requires enablement', () => {
  const mainnet = resolveTarotConfig({ contractAddress, deploymentBlock: '123', enabled: true });
  assert.equal(mainnet.chainId, 1);
  assert.equal(mainnet.testnet, false);
  assert.equal(mainnet.chainName, 'Ethereum');
  assert.equal(mainnet.explorerUrl, 'https://etherscan.io');
  assert.equal(mainnet.walletRpcUrl, 'https://ethereum-rpc.publicnode.com');
  assert.equal(mainnet.enabled, true);
  assert.equal(tarotChainId(false), 1);
  assert.equal(tarotChainId(true), 11155111);
  const config = resolveTarotConfig({ contractAddress, deploymentBlock: '123', enabled: true, testnet: true });
  assert.equal(config.chainId, 11155111);
  assert.equal(config.testnet, true);
  assert.equal(config.enabled, true);
  assert.equal(config.confirmationBlocks, 3);
  assert.equal(config.maxCards, 777);
  assert.equal(config.deploymentBlock, 123);
  assert.equal(resolveTarotConfig({ enabled: true }).enabled, false);
  assert.equal(resolveTarotConfig({ contractAddress }).enabled, false);
  for (const contractAddress of ['wrong', '0x' + '0'.repeat(40)]) assert.throws(() => resolveTarotConfig({ contractAddress }));
  for (const deploymentBlock of [-1, 1.5, 'broken', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => resolveTarotConfig({ deploymentBlock }));
  }
});

test('all Tarot IDs have unique matching receipt IDs and other values are rejected', () => {
  const receipts = new Set<number>();
  for (let id = 1; id <= TAROT_MAX_CARDS; ++id) {
    assert.equal(isTarotTokenId(id), true);
    assert.equal(tarotReceiptTokenId(id), id + 999_999);
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
  assert.equal(tarotCodeHashInput({ ...args, chainId: 1 }), `mons:tarot:claim:v1:1:${contractAddress}:1:${code}`);
  assert.notEqual(tarotCodeHashInput({ ...args, chainId: 1 }), tarotCodeHashInput(args));
  for (const invalid of [{ ...args, chainId: 10 }, { ...args, contractAddress: '0x' + '0'.repeat(40) },
    { ...args, tokenId: 778 }, { ...args, code: 'secret-do-not-log' }, { ...args, code: code.replace('-4004-', '-3004-') }]) {
    assert.throws(() => tarotCodeHashInput(invalid), /^Error: Invalid Tarot claim code scope$/);
  }
});

test('Tarot signing matches the Solidity fixture and binds every authorization field', () => {
  const claim = { chainId: 11155111, contractAddress, wallet, tokenId: 777, deadline: 2_000_000_600 };
  const digest = tarotClaimDigest(claim);
  assert.equal(digest, '0x3cf218cb14c4ea887ffc71cc80a644337a7f98abb9a8600bb8de08288d460b7c');
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

test('DMX receipt ranges are disjoint from all cards and each other', () => {
  assert.equal(DMX_MAX_CARDS, 999_999);
  assert.equal(tarotReceiptTokenId(1), 1_000_000);
  assert.equal(tarotReceiptTokenId(777), 1_000_776);
  assert.equal(dmxRedemptionReceiptTokenId(1), 1_000_777n);
  assert.equal(dmxRedemptionReceiptTokenId(DMX_MAX_CARDS), 2_000_775n);
  for (const id of [0, 1_000_000, -1, 1.5, NaN, Infinity]) assert.throws(() => dmxRedemptionReceiptTokenId(id));
});

test('DMX recipient mint signatures match Solidity and bind the ordered card IDs and authorization', () => {
  const quote = { chainId: 11155111, contractAddress, recipient: wallet, cardIds: [778, 999999],
    authorizationId: '0x' + '1'.padStart(64, '0'), deadline: 2_000_000_600 };
  const digest = dmxMintDigest(quote);
  assert.equal(digest, '0xd473708e2bbd82df5176afdac0b559eb722fb3d3873d6d77eff482fc3e497312');
  for (const modified of [{ ...quote, chainId: 1 }, { ...quote, contractAddress: wallet },
    { ...quote, recipient: contractAddress }, { ...quote, cardIds: [999999, 778] }, { ...quote, cardIds: [778] },
    { ...quote, authorizationId: '0x' + '2'.padStart(64, '0') }, { ...quote, deadline: quote.deadline + 1 }]) {
    assert.notEqual(dmxMintDigest(modified), digest);
  }
});

test('DMX redemption signatures match Solidity and bind every term and ordered input/output list', () => {
  const quote = { chainId: 11155111, contractAddress, wallet, recipient: '0x2222222222222222222222222222222222222222',
    inputCardIds: [1, 778], outputCardIds: [779, 780], orderId: 7, fee: 123456789, deadline: 2_000_000_600, configId: 2 };
  const digest = dmxRedemptionDigest(quote);
  assert.equal(digest, '0x9bb9dc12e7d0cd784083141a4550dca3758e5552bc137a1c44cb8afcdf74b5a9');
  for (const modified of [{ ...quote, chainId: 1 }, { ...quote, contractAddress: wallet },
    { ...quote, wallet: contractAddress }, { ...quote, recipient: wallet }, { ...quote, inputCardIds: [778, 1] },
    { ...quote, inputCardIds: [1] }, { ...quote, outputCardIds: [780, 779] }, { ...quote, outputCardIds: [] },
    { ...quote, orderId: 8 }, { ...quote, fee: 123456788 }, { ...quote, deadline: quote.deadline + 1 },
    { ...quote, configId: 1 }]) assert.notEqual(dmxRedemptionDigest(modified), digest);
});

test('DMX calldata preserves recipients, signed terms and optional redemption outputs', () => {
  const signature = '0x' + 'ab'.repeat(65);
  const claimTo = encodeTarotClaimTo(wallet, 777, 2_000_000_600, signature);
  assert.deepEqual(decodeReturn(['address', 'uint256', 'uint256', 'bytes'], `0x${claimTo.slice(10)}`),
    [wallet, 777n, 2_000_000_600n, signature]);
  const mint = { authorizationId: '0x' + '1'.padStart(64, '0'), recipient: wallet, deadline: 2_000_000_600 };
  const authorized = encodeDmxMintToAuthorized([778, 999999], mint, signature);
  assert.deepEqual(decodeReturn(['uint256[]', '(bytes32,address,uint256)', 'bytes'], `0x${authorized.slice(10)}`),
    [[778n, 999999n], [mint.authorizationId, wallet, 2_000_000_600n], signature]);
  const direct = encodeDmxMintTo(wallet, [1, 999999]);
  assert.deepEqual(decodeReturn(['address', 'uint256[]'], `0x${direct.slice(10)}`), [wallet, [1n, 999999n]]);
  const quote = { orderId: 7, wallet, recipient: contractAddress, fee: 0, deadline: 2_000_000_600, configId: 0 };
  const redemption = encodeDmxRedeem([1, 778], [], quote, signature);
  assert.deepEqual(decodeReturn(['uint256[]', 'uint256[]', '(uint256,address,address,uint256,uint256,uint256)', 'bytes'],
    `0x${redemption.slice(10)}`), [[1n, 778n], [], [7n, wallet, contractAddress, 0n, 2_000_000_600n, 0n], signature]);
  for (const ids of [[], [0], [1_000_000], [1, 1], [1, 1n], Array.from({ length: 51 }, (_, id) => id + 1)]) {
    assert.throws(() => encodeDmxMintTo(wallet, ids));
    assert.throws(() => encodeDmxMintToAuthorized(ids, mint, signature));
    assert.throws(() => encodeDmxRedeem(ids, [], quote, signature));
  }
  for (const outputs of [[1], [777], [1_000_000], [778, 778]]) {
    assert.throws(() => encodeDmxRedeem([1], outputs, quote, signature));
  }
});
