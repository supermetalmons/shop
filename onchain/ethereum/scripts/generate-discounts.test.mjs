import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { encode } from '@metamask/abi-utils';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { addressListText, buildDiscountArtifact, canonicalAddresses, snapshotHolders } from './generate-discounts.mjs';

const encodeAbi = (types, args) => `0x${Buffer.from(encode(types, args)).toString('hex')}`;
const totalSupplyCall = '0x18160ddd';
const ownersCall = `0x5bbb2177${['20', '2', '1', '2'].map(word => word.padStart(64, '0')).join('')}`;
const fixtures = new URL('../fixtures/discounts/', import.meta.url);
const source = JSON.parse(await readFile(new URL('source.json', fixtures), 'utf8'));
const holders = (await readFile(new URL('holders.csv', fixtures), 'utf8')).trim().split('\n');
const browserArtifact = JSON.parse(await readFile(new URL('../../../src/ethereum/discounts/111k.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(await readFile(new URL('proof.json', fixtures), 'utf8'));
const outsider = '0x0000000000000000000000000000000000000001';

test('offline generator runs without repository-root sources or dependencies', async t => {
  const directory = await mkdtemp(join(tmpdir(), '111k-discounts-isolated-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packageDirectory = join(directory, 'onchain/ethereum');
  const artifactDirectory = join(directory, 'src/ethereum/discounts');
  await mkdir(join(packageDirectory, 'scripts'), { recursive: true });
  await mkdir(artifactDirectory, { recursive: true });
  await cp(new URL('generate-discounts.mjs', import.meta.url), join(packageDirectory, 'scripts/generate-discounts.mjs'));
  await cp(fixtures, join(packageDirectory, 'fixtures/discounts'), { recursive: true });
  await cp(new URL('../../../src/ethereum/discounts/111k.json', import.meta.url), join(artifactDirectory, '111k.json'));
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(packageDirectory, 'node_modules'), 'dir');
  const result = spawnSync(process.execPath, ['scripts/generate-discounts.mjs', '--check'], {
    cwd: packageDirectory, encoding: 'utf8', timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified 317 snapshot holders and 318 discount wallets/);
});

test('pinned draft preserves all 317 owners and the explicit additional wallet', () => {
  const generated = buildDiscountArtifact(source, holders);
  assert.deepEqual(generated.artifact, browserArtifact);
  assert.deepEqual(generated.fixture, fixture);
  assert.equal(holders.length, 317);
  assert.equal(Object.keys(browserArtifact.proofs).length, 318);
  assert.equal(holders.includes(source.additionalAddresses[0]), false);
  assert.ok(browserArtifact.proofs[source.additionalAddresses[0]]);
  assert.deepEqual(holders, canonicalAddresses(holders));
  assert.throws(() => buildDiscountArtifact(source, holders.slice(1)), /holder count changed/);
  assert.throws(() => buildDiscountArtifact(source, [...holders.slice(1), outsider]), /digest changed/);
});

test('OpenZeppelin verifies every committed proof', () => {
  for (const [address, proof] of Object.entries(browserArtifact.proofs)) {
    assert.equal(StandardMerkleTree.verify(browserArtifact.root, ['address'], [address], proof), true);
    assert.equal(StandardMerkleTree.verify(browserArtifact.root, ['address'], [outsider], proof), false);
  }
});

test('input normalization deduplicates address casing and rejects invalid recipients', () => {
  assert.deepEqual(canonicalAddresses([fixture.wallet, fixture.wallet.toUpperCase().replace('0X', '0x')]), [fixture.wallet]);
  assert.throws(() => canonicalAddresses(['0x0000000000000000000000000000000000000000']), /Zero address/);
  assert.throws(() => canonicalAddresses(['solana-address']), /Invalid Ethereum address/);
});

function mockSnapshot(change) {
  const wallets = [outsider, '0x0000000000000000000000000000000000000002'];
  const input = { ...source, firstTokenId: 1, lastTokenId: 2, totalSupply: 2, holderCount: 2,
    additionalAddresses: [fixture.wallet], addressCount: 3,
    addressesSha256: createHash('sha256').update(addressListText(canonicalAddresses([...wallets, fixture.wallet]))).digest('hex') };
  const blockTag = `0x${source.blockNumber.toString(16)}`;
  const calls = [];
  const rpc = async (method, params) => {
    calls.push([method, params]);
    let result;
    if (method === 'eth_chainId') result = '0x1';
    else if (method === 'eth_getBlockByNumber') {
      assert.deepEqual(params, [blockTag, false]);
      result = { hash: source.blockHash, timestamp: `0x${(Date.parse(source.blockTimestamp) / 1000).toString(16)}` };
    } else {
      assert.equal(method, 'eth_call');
      assert.equal(params[0].to, source.collection);
      assert.equal(params[1], blockTag);
      if (params[0].data === totalSupplyCall) result = encodeAbi(['uint256'], [2]);
      else {
        assert.equal(params[0].data, ownersCall);
        result = encodeAbi(['(address,uint64,bool,uint24)[]'], [wallets.map(wallet => [wallet, 1, false, 0])]);
      }
    }
    return change ? change(method, params, result) : result;
  };
  return { input, rpc, calls, wallets };
}

test('snapshot reads all owners at the pinned block without filtering contract wallets', async () => {
  const mock = mockSnapshot();
  assert.deepEqual(await snapshotHolders(mock.input, mock.rpc), mock.wallets);
  assert.equal(mock.calls.filter(([method]) => method === 'eth_getBlockByNumber').length, 2);
  assert.equal(mock.calls.some(([method]) => method === 'eth_getCode'), false);
});

test('snapshot rejects wrong chains, wrong blocks, and incomplete or burned ownerships', async () => {
  for (const change of [
    (method, _, result) => method === 'eth_chainId' ? '0xaa36a7' : result,
    (method, _, result) => method === 'eth_getBlockByNumber' ? { ...result, hash: `0x${'00'.repeat(32)}` } : result,
    (method, params, result) => method === 'eth_call' && params[0].data !== totalSupplyCall
      ? encodeAbi(['(address,uint64,bool,uint24)[]'], [[[outsider, 1, false, 0]]]) : result,
    (method, params, result) => method === 'eth_call' && params[0].data !== totalSupplyCall
      ? encodeAbi(['(address,uint64,bool,uint24)[]'], [[[outsider, 1, true, 0], [fixture.wallet, 1, false, 0]]]) : result,
  ]) {
    const mock = mockSnapshot(change);
    await assert.rejects(snapshotHolders(mock.input, mock.rpc));
  }
});
