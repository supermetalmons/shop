import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decode, encode } from '@metamask/abi-utils';
import { keccak_256 } from '@noble/hashes/sha3';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';

const fixtures = new URL('../fixtures/discounts/', import.meta.url);
const sourcePath = new URL('source.json', fixtures);
const holdersPath = new URL('holders.csv', fixtures);
const proofPath = new URL('proof.json', fixtures);
const browserPath = new URL('../../../src/ethereum/discounts/111k.json', import.meta.url);
const ownershipChunkSize = 100;

function encodeCall(signature, types, args) {
  const selector = Buffer.from(keccak_256(signature)).subarray(0, 4).toString('hex');
  return `0x${selector}${Buffer.from(encode(types, args)).toString('hex')}`;
}

export function canonicalAddresses(values) {
  return [...new Set(values.map(value => {
    const address = value.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error('Invalid Ethereum address');
    if (address === '0x0000000000000000000000000000000000000000') throw new Error('Zero address cannot receive a discount');
    return address;
  }))].sort();
}

export function addressListText(addresses) {
  return `${addresses.join('\n')}\n`;
}

export function buildDiscountArtifact(source, holderAddresses) {
  const holders = canonicalAddresses(holderAddresses);
  assert.equal(holders.length, source.holderCount, 'Snapshot holder count changed');
  const addresses = canonicalAddresses([...holders, ...source.additionalAddresses]);
  assert.equal(addresses.length, source.addressCount, 'Discount address count changed');
  assert.equal(createHash('sha256').update(addressListText(addresses)).digest('hex'), source.addressesSha256,
    'Discount address digest changed');
  const tree = StandardMerkleTree.of(addresses.map(address => [address]), ['address']);
  const proofs = Object.fromEntries(addresses.map(address => [address, tree.getProof([address])]));
  for (const [address, proof] of Object.entries(proofs)) {
    assert.ok(StandardMerkleTree.verify(tree.root, ['address'], [address], proof), `Invalid generated proof for ${address}`);
  }
  const [wallet] = canonicalAddresses([source.additionalAddresses[0]]);
  return { artifact: { root: tree.root, proofs }, fixture: { root: tree.root, wallet, proof: proofs[wallet] } };
}

export async function snapshotHolders(source, rpc) {
  assert.equal(Number(BigInt(await rpc('eth_chainId', []))), source.chainId, 'Snapshot RPC chain does not match source');
  const blockTag = `0x${source.blockNumber.toString(16)}`;
  const checkBlock = async () => {
    const block = await rpc('eth_getBlockByNumber', [blockTag, false]);
    assert.equal(block?.hash?.toLowerCase(), source.blockHash, 'Snapshot block hash changed');
    assert.equal(new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(), source.blockTimestamp,
      'Snapshot block timestamp changed');
  };
  await checkBlock();
  const call = async (signature, types = [], args = []) =>
    rpc('eth_call', [{ to: source.collection, data: encodeCall(signature, types, args) }, blockTag]);
  const [supply] = decode(['uint256'], await call('totalSupply()'));
  assert.equal(supply, BigInt(source.totalSupply), 'Snapshot supply changed');
  const owners = [];
  for (let first = source.firstTokenId; first <= source.lastTokenId; first += ownershipChunkSize) {
    const tokenIds = Array.from({ length: Math.min(ownershipChunkSize, source.lastTokenId - first + 1) },
      (_, index) => first + index);
    const [ownerships] = decode(['(address,uint64,bool,uint24)[]'],
      await call('explicitOwnershipsOf(uint256[])', ['uint256[]'], [tokenIds]));
    assert.equal(ownerships.length, tokenIds.length, 'Snapshot ownership response is incomplete');
    for (const [address, , burned] of ownerships) {
      assert.equal(burned, false, 'Snapshot contains a burned token');
      assert.notEqual(address, '0x0000000000000000000000000000000000000000', 'Snapshot contains an unminted token');
      owners.push(address);
    }
  }
  assert.equal(owners.length, source.totalSupply, 'Snapshot token range does not cover the full live supply');
  await checkBlock();
  const holders = canonicalAddresses(owners);
  buildDiscountArtifact(source, holders);
  return holders;
}

function rpcClient(url) {
  return async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`Snapshot RPC returned HTTP ${response.status}`);
        const body = await response.json();
        if (body.error || !Object.hasOwn(body, 'result')) throw new Error(`Snapshot RPC failed for ${method}`);
        return body.result;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
  };
}

async function writeOrCheck(target, expected, check) {
  if (check) assert.equal(await readFile(target, 'utf8'), expected, `Generated discount file is stale: ${fileURLToPath(target)}`);
  else {
    await mkdir(dirname(fileURLToPath(target)), { recursive: true });
    await writeFile(target, expected);
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => !['--check', '--snapshot'].includes(arg)) || args.includes('--check') && args.includes('--snapshot')) {
    throw new Error('Use no arguments to generate offline, --check to verify offline, or --snapshot to regenerate the pinned snapshot');
  }
  const source = JSON.parse(await readFile(sourcePath, 'utf8'));
  const holders = args.includes('--snapshot')
    ? await snapshotHolders(source, rpcClient(process.env.ETHEREUM_DISCOUNT_SNAPSHOT_RPC_URL || 'https://eth.drpc.org'))
    : canonicalAddresses((await readFile(holdersPath, 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  const { artifact, fixture } = buildDiscountArtifact(source, holders);
  if (args.includes('--snapshot')) await writeOrCheck(holdersPath, addressListText(holders), false);
  await writeOrCheck(browserPath, `${JSON.stringify(artifact, null, 2)}\n`, args.includes('--check'));
  await writeOrCheck(proofPath, `${JSON.stringify(fixture, null, 2)}\n`, args.includes('--check'));
  process.stdout.write(`Verified ${holders.length} snapshot holders and ${source.addressCount} discount wallets; root ${artifact.root}.\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
