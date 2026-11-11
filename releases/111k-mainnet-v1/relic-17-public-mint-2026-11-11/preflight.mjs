import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { verificationRpc } from '../../../onchain/ethereum/scripts/111k-verification.mjs';

const collection = '0x08cded8258730bda384ff198001e47a1b50f7f9d';
const deployer = '0xd58d143ca63d9baccc33fdf69ea203f59c58ae93';
const price = 2402000000000000000n;
const maximumFees = 3000000000000000n;
const expectedRuntime = '0xb41332e14958d030ba932e7cff8704e89f0027dc83407129a697131f1c88fc5e';
const zeroAddress = '0x' + '0'.repeat(40);
const cast = args => execFileSync('cast', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const calldata = (signature, ...args) => cast(['calldata', signature, ...args]);
const hex = value => '0x' + BigInt(value).toString(16);
const json = async name => JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'));
const words = value => {
  assert.match(value, /^0x(?:[0-9a-fA-F]{64})+$/);
  return value.slice(2).match(/.{64}/g).map(word => BigInt('0x' + word));
};
const address = value => {
  assert.match(value, /^0x0{24}[0-9a-fA-F]{40}$/);
  return '0x' + value.slice(-40).toLowerCase();
};

assert.equal(process.argv.length, 2, 'This read-only preflight accepts no arguments.');
const operation = await json('operation.json');
const specifications = [
  ['01-open-public-relic-sale.unsigned.json', 26, 60000, 0n,
    calldata('setPublicRelicSale(uint256,uint256,bool)', '2', price.toString(), 'true')],
  ['02-mint-relic-17.unsigned.json', 27, 180000, price, calldata('mintRelic(uint256)', '17')],
  ['recovery/close-public-relic-sale.unsigned.json', 28, 60000, 0n,
    calldata('setPublicRelicSale(uint256,uint256,bool)', '2', price.toString(), 'false')],
];
assert.equal(operation.chainId, 1);
assert.equal(operation.collection, collection);
assert.equal(operation.deployer, deployer);
assert.equal(operation.status, 'prepared-unsigned');
assert.deepEqual(operation.primaryTransactions, specifications.slice(0, 2).map(item => item[0]));
assert.equal(operation.recoveryTransaction, specifications[2][0]);
assert.equal(operation.maximumTotalGasFeeWei, maximumFees.toString());
for (const [file, nonce, gas, value, data] of specifications) {
  assert.deepEqual(await json(file), {
    type: '0x2', chainId: '0x1', from: deployer, to: collection, nonce: hex(nonce),
    gas: hex(gas), maxPriorityFeePerGas: hex(5000000000n), maxFeePerGas: hex(10000000000n),
    value: hex(value), data,
  }, `Unsigned transaction changed: ${file}`);
}

const upstream = verificationRpc(process.env, fetch, 1);
const permitted = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_call', 'eth_getBalance',
  'eth_getTransactionCount', 'eth_getCode']);
const rpc = async (method, params = []) => {
  assert.ok(permitted.has(method), 'Only read-only RPC methods are permitted.');
  return upstream(method, params);
};
assert.equal(BigInt(await rpc('eth_chainId')), 1n, 'RPC must be Ethereum mainnet.');
const block = await rpc('eth_getBlockByNumber', ['latest', false]);
const call = (signature, ...args) => rpc('eth_call', [{ to: collection, data: calldata(signature, ...args) }, block.number]);
const [owner, pendingOwner, saleActive, publicSale, mask, stats, remaining, target,
  allowance, revenue, balance, nonce, code] = await Promise.all([
  call('owner()'), call('pendingOwner()'), call('saleActive()'), call('publicRelicStats(address)', deployer),
  call('getRelicClaimedMask()'), call('stats(address)', deployer), call('remainingCrates()'),
  call('getTokenInfo(uint256)', '117188'), call('freeMintAllowances(address)', deployer),
  call('totalMintReceived()'), rpc('eth_getBalance', [deployer, block.number]),
  rpc('eth_getTransactionCount', [deployer, block.number]), rpc('eth_getCode', [collection, block.number]),
]);
const publicWords = words(publicSale);
const statsWords = words(stats);
const allowanceWords = words(allowance);
assert.equal(address(owner), deployer, 'Owner changed.');
assert.equal(address(pendingOwner), zeroAddress, 'Pending ownership transfer requires review.');
assert.equal(cast(['keccak', code]), expectedRuntime, 'Collection runtime changed.');
assert.equal(words(saleActive)[0], 1n, 'Global sale must already be active.');
assert.deepEqual(publicWords, [1n, 1n, 2300000000000000000n, 0n, 0n, 0n, 0n], 'Public sale state changed; re-prepare.');
assert.equal(words(mask)[0] & (1n << 16n), 0n, 'Relic 17 has already been issued.');
assert.deepEqual(words(target), [0n, 0n, 0n], 'Target token already exists.');
assert.ok(words(remaining)[0] >= 111n, 'Insufficient remaining crate capacity.');
assert.equal(statsWords[10], 12n, 'Reserved allocation changed.');
assert.ok(2n <= 18n - statsWords[10], 'Public limit exceeds unreserved relic capacity.');
assert.deepEqual(allowanceWords, [0n, 0n, 2n, 0n, 0n, 2n], 'Deployer reserved allowance changed.');
assert.equal(BigInt(nonce), 26n, 'Prepared nonce is stale.');
assert.ok(BigInt(balance) >= price + maximumFees, 'Insufficient purchase and gas funds.');
assert.ok(BigInt(block.baseFeePerGas) + 5000000000n <= 10000000000n, 'Refresh the selected gas fees.');
const [latestNonce, pendingNonce, canonical] = await Promise.all([
  rpc('eth_getTransactionCount', [deployer, 'latest']),
  rpc('eth_getTransactionCount', [deployer, 'pending']),
  rpc('eth_getBlockByNumber', [block.number, false]),
]);
assert.equal(BigInt(latestNonce), 26n, 'Deployer nonce advanced while checking.');
assert.equal(BigInt(pendingNonce), 26n, 'Deployer has a pending transaction or a changed nonce.');
assert.equal(canonical.hash, block.hash, 'Snapshot block was reorganized.');

console.log(JSON.stringify({
  status: 'passed', checkedAt: new Date().toISOString(), readOnly: true, chainId: 1,
  collection, deployer, blockNumber: Number(BigInt(block.number)), blockHash: block.hash,
  blockTimestamp: Number(BigInt(block.timestamp)), runtimeKeccak256: expectedRuntime,
  owner: address(owner), pendingOwner: address(pendingOwner), saleActive: true,
  publicSale: Object.fromEntries(['limit', 'minted', 'priceWei', 'active', 'mintable', 'freeLimit', 'freeUsed']
    .map((key, index) => [key, publicWords[index].toString()])),
  target: { relicId: 17, tokenId: 117188, unissued: true }, claimedRelicMask: words(mask)[0].toString(),
  allocatedCrates: statsWords[0].toString(), remainingCrates: words(remaining)[0].toString(),
  reservedRelicsAllocated: statsWords[10].toString(), reservedRelicsMinted: statsWords[11].toString(),
  deployerAllowance: allowanceWords.map(String), totalMintReceivedWei: words(revenue)[0].toString(),
  balanceWei: BigInt(balance).toString(), latestNonce: '26', pendingNonce: '26',
  baseFeePerGasWei: BigInt(block.baseFeePerGas).toString(),
  maximumPrimaryGasFeeWei: '2400000000000000', maximumTotalGasFeeWei: maximumFees.toString(),
  minimumRequiredBalanceWei: (price + maximumFees).toString(),
  warning: 'This snapshot is not a reservation. Re-run immediately before signing; no signing or broadcasting is performed.',
}, null, 2));
