import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decode } from '@metamask/abi-utils';
import { parsePublicRelicConfig, parsePublicRelicConfigJson, publicRelicOwnerCalls } from './public-relic-config.mjs';

const address = value => `0x${value.toString(16).padStart(40, '0')}`;
const fixture = () => ({ chainId: 11155111, sale: { limit: 2, priceWei: '15000000000000000', active: true },
  groups: [{ name: 'A', limit: 1, wallets: [address(1), address(2)] }, { name: 'revoke', limit: 0, wallets: [address(3)] }] });

test('public relic configuration preserves cumulative supply, exact wei and allowance revocations', () => {
  const config = fixture();
  const before = structuredClone(config);
  assert.deepEqual(parsePublicRelicConfig(config, undefined, 11155111), config);
  assert.deepEqual(config, before);
  const calls = publicRelicOwnerCalls(config, address(99), 11155111);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.name), ['sale', 'A', 'revoke']);
  assert.ok(calls.every(call => call.value === '0' && call.to === address(99) && call.chainId === 11155111));
  assert.deepEqual(decode(['uint256', 'uint256', 'bool'], '0x' + calls[0].data.slice(10)), [2n, 15000000000000000n, true]);
  assert.deepEqual(decode(['address[]', 'uint16'], '0x' + calls[1].data.slice(10)), [[address(1), address(2)], 1n]);
  assert.deepEqual(decode(['address[]', 'uint16'], '0x' + calls[2].data.slice(10)), [[address(3)], 0n]);
  for (const [index, signature] of [[0, 'setPublicRelicSale(uint256,uint256,bool)'], [1, 'setPublicRelicFreeMintAllowances(address[],uint16)']]) {
    assert.equal(calls[index].data.slice(0, 10), execFileSync('cast', ['sig', signature], { encoding: 'utf8' }).trim());
  }
});

test('sale and allowances can be managed independently without generating unrelated updates', () => {
  const config = fixture();
  assert.equal(publicRelicOwnerCalls({ chainId: 1, sale: { limit: 0, priceWei: '0', active: false } }, address(99), 1).length, 1);
  assert.equal(publicRelicOwnerCalls({ chainId: 31337, groups: config.groups }, address(99), 31337).length, 2);
  assert.deepEqual(publicRelicOwnerCalls({ chainId: 1, groups: [{ name: 'empty', limit: 18, wallets: [] }] }, address(99), 1), []);
  assert.equal(parsePublicRelicConfig({ chainId: 1, sale: { limit: 18, priceWei: ((1n << 256n) - 1n).toString(), active: true } }, undefined, 1).sale.limit, 18);
});

test('public relic configuration requires an explicit matching chain and bounded integer values', () => {
  for (const chainId of [undefined, 1, 31337, '11155111']) {
    assert.throws(() => parsePublicRelicConfig(fixture(), undefined, chainId), /matching chain ID/);
  }
  for (const value of [null, {}, [], { chainId: 1 }, { ...fixture(), other: true }]) {
    assert.throws(() => parsePublicRelicConfig(value, undefined, 11155111), /configuration/);
  }
  for (const value of [-1, 19, 1.5, '1', null, true]) {
    const config = fixture(); config.sale.limit = value;
    assert.throws(() => parsePublicRelicConfig(config, undefined, 11155111), /limit/);
    config.sale.limit = 1; config.groups[0].limit = value;
    assert.throws(() => parsePublicRelicConfig(config, undefined, 11155111), /limit/);
  }
  for (const priceWei of ['-1', '01', '1.0', '1e18', '', 1, null, (1n << 256n).toString()]) {
    const config = fixture(); config.sale.priceWei = priceWei;
    assert.throws(() => parsePublicRelicConfig(config, undefined, 11155111), /sale configuration/);
  }
  for (const literal of ['1e1', '1.0', '-0']) {
    assert.throws(() => parsePublicRelicConfigJson(JSON.stringify(fixture()).replace('"limit":2', `"limit":${literal}`), undefined, 11155111), /decimal integer/);
  }
});

test('public relic batches reject duplicates, invalid recipients and oversized groups', () => {
  for (const wallet of [address(0), address(99), '0x123', null]) {
    const config = fixture(); config.groups[0].wallets = [wallet];
    assert.throws(() => publicRelicOwnerCalls(config, address(99), 11155111), /wallet address/);
  }
  const config = fixture();
  config.groups[1].wallets = [address(1)];
  assert.throws(() => parsePublicRelicConfig(config, undefined, 11155111), /distinct/);
  config.groups[1].wallets = [address(3)]; config.groups[1].name = 'A';
  assert.throws(() => parsePublicRelicConfig(config, undefined, 11155111), /unique names/);
  config.groups = [{ name: 'A', limit: 18, wallets: Array.from({ length: 32 }, (_, index) => address(index + 1)) }];
  assert.equal(parsePublicRelicConfig(config, undefined, 11155111).groups[0].wallets.length, 32);
  config.groups[0].wallets.push(address(33));
  assert.throws(() => parsePublicRelicConfig(config, undefined, 11155111), /at most 32/);
});

test('public relic CLI checks explicit files and emits unsigned owner calls without RPC', t => {
  const directory = mkdtempSync(join(tmpdir(), 'public-relic-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'public-relics.json');
  writeFileSync(filename, JSON.stringify(fixture()));
  const cli = new URL('./public-relics.mjs', import.meta.url).pathname;
  const run = args => JSON.parse(execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' }));
  assert.deepEqual(run(['check', filename, '--chain-id', '11155111']), fixture());
  assert.deepEqual(run(['calldata', address(99), filename, '--chain-id', '11155111']), publicRelicOwnerCalls(fixture(), address(99), 11155111));
  for (const args of [['check', filename], ['calldata', address(99), filename, '--chain-id', '1'], ['check', filename, '--chain-id', '1', '--chain-id', '1']]) {
    assert.notEqual(spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' }).status, 0);
  }
});
