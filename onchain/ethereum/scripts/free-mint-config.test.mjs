import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decode } from '@metamask/abi-utils';
import { hexToBytes } from '@noble/hashes/utils';
import { parseFreeMintConfig, parseFreeMintConfigJson, freeMintOwnerCalls } from './free-mint-config.mjs';

const address = value => `0x${value.toString(16).padStart(40, '0')}`;
const fixture = JSON.parse(readFileSync(new URL('../fixtures/free-mints.json', import.meta.url), 'utf8'));
const group = (wallets = [], limits = {}) => ({ name: 'A', crates: 100, warehouses: 1, relics: 0, wallets, ...limits });

test('flattens the shared A/B/C fixture in input order without mutating it', () => {
  const original = structuredClone(fixture);
  const result = parseFreeMintConfig(fixture);
  assert.deepEqual(result.allocations, [
    { wallet: address(0xa110), crateLimit: 100, warehouseLimit: 1, relicLimit: 0 },
    { wallet: address(0xca10), crateLimit: 100, warehouseLimit: 1, relicLimit: 0 },
    { wallet: address(0xb0b), crateLimit: 5, warehouseLimit: 0, relicLimit: 0 },
    { wallet: address(0xd00d), crateLimit: 0, warehouseLimit: 0, relicLimit: 1 },
  ]);
  assert.deepEqual(fixture, original);
  assert.deepEqual(parseFreeMintConfig({ groups: result.groups }), result);
});

test('accepts empty templates, zero limits and 32 wallets without reserving supply', () => {
  assert.deepEqual(parseFreeMintConfig({ groups: [] }), { groups: [], allocations: [] });
  const defaults = { groups: ['A', 'B', 'C'].map(name => group([], { name, crates: 0, warehouses: 0 })) };
  assert.deepEqual(parseFreeMintConfig(defaults).allocations, []);
  const wallets = Array.from({ length: 32 }, (_, index) => address(index + 1));
  assert.equal(parseFreeMintConfig({ groups: [group(wallets, { crates: 5555, warehouses: 505, relics: 18 })] }).allocations.length, 32);
  assert.equal(parseFreeMintConfig({ groups: [group(wallets, { crates: 0, warehouses: 0, relics: 0 })] }).allocations.length, 32);
  assert.throws(() => parseFreeMintConfig({ groups: [group([...wallets, address(33)])] }), /at most 32 wallets/);
});

test('JSON files require decimal integer literals consistently with the Foundry parser', () => {
  const configuration = { groups: [group([address(1)], { name: 'Phase 1.0: "1e2"' })] };
  const json = JSON.stringify(configuration);
  assert.deepEqual(parseFreeMintConfigJson(json), parseFreeMintConfig(configuration));
  for (const literal of ['1.0', '1e2', '1E+2', '-0', '-1', '1.5']) {
    assert.throws(() => parseFreeMintConfigJson(json.replace('"crates":100', `"crates":${literal}`)), /decimal integer JSON literals/);
  }
});

test('rejects duplicate wallet membership regardless of casing and group', () => {
  const wallet = address(0xabcd);
  const upper = `0x${wallet.slice(2).toUpperCase()}`;
  assert.throws(() => parseFreeMintConfig({ groups: [group([wallet, upper])] }), /must be distinct/);
  assert.throws(() => parseFreeMintConfig({ groups: [group([wallet]), group([upper], { name: 'B' })] }), /must be distinct/);
});

test('rejects invalid, zero and collection addresses', () => {
  for (const wallet of [address(0), '0x1234', null, 123, 'invalid']) {
    assert.throws(() => parseFreeMintConfig({ groups: [group([wallet])] }), /wallet address/);
  }
  assert.throws(() => parseFreeMintConfig({ groups: [group([address(1)])] }, address(1)), /wallet address/);
});

test('rejects malformed groups and invalid per-item limits', () => {
  for (const value of [null, [], {}, ...[null, false, 0, '', {}].map(groups => ({ groups })), { groups: [], extra: true }]) {
    assert.throws(() => parseFreeMintConfig(value), /configuration/);
  }
  for (const invalid of [null, [], {}, group([], { name: '' }), group([], { name: 1 }),
    ...[null, false, 0, '', {}].map(wallets => group(wallets)), { ...group(), extra: true }]) {
    assert.throws(() => parseFreeMintConfig({ groups: [invalid] }), /group/);
  }
  assert.throws(() => parseFreeMintConfig({ groups: [group(), group()] }), /group/);
  for (const [kind, maximum] of [['crates', 5555], ['warehouses', 505], ['relics', 18]]) {
    for (const invalid of [-1, 1.5, maximum + 1, '1', true, null]) {
      assert.throws(() => parseFreeMintConfig({ groups: [group([], { [kind]: invalid })] }), /limit/);
    }
  }
});

test('hexadecimal-looking group names remain string labels', () => {
  for (const name of [address(1), `0x${'01'.repeat(32)}`]) {
    const configuration = { groups: [group([address(2)], { name })] };
    const parsed = parseFreeMintConfigJson(JSON.stringify(configuration));
    assert.equal(parsed.groups[0].name, name);
    assert.deepEqual(parsed.allocations, [{ wallet: address(2), crateLimit: 100, warehouseLimit: 1, relicLimit: 0 }]);
  }
});

test('owner calls preserve per-group zero-limit revocations and skip only empty groups', () => {
  const collection = address(0x123456);
  const calls = freeMintOwnerCalls({ groups: [group([address(1)]),
    group([address(2)], { name: 'B', crates: 0, warehouses: 0, relics: 0 }), group([], { name: 'C' })] }, collection);
  assert.equal(calls.length, 2);
  for (let index = 0; index < calls.length; index++) {
    assert.equal(calls[index].to, collection);
    assert.equal(calls[index].value, '0');
    const values = decode(['address[]', 'uint16', 'uint16', 'uint16'], hexToBytes(calls[index].data.slice(10)));
    assert.deepEqual(values, [[address(index + 1)], ...(index ? [0n, 0n, 0n] : [100n, 1n, 0n])]);
  }
  assert.equal(calls[0].data.slice(0, 10), execFileSync('cast', ['sig', 'setFreeMintAllowances(address[],uint16,uint16,uint16)'], { encoding: 'utf8' }).trim());
  assert.throws(() => freeMintOwnerCalls({ groups: [] }, address(0)), /address/);
  assert.throws(() => freeMintOwnerCalls({ groups: [group([collection])] }, collection), /address/);
});

test('CLI validates configuration and emits unsigned calls without RPC', () => {
  const cli = new URL('./free-mints.mjs', import.meta.url);
  const fixturePath = new URL('../fixtures/free-mints.json', import.meta.url);
  const checked = JSON.parse(execFileSync(process.execPath, [cli.pathname, 'check', fixturePath.pathname], { encoding: 'utf8' }));
  assert.deepEqual(checked, parseFreeMintConfig(fixture));
  const calls = JSON.parse(execFileSync(process.execPath, [cli.pathname, 'calldata', address(1), fixturePath.pathname], { encoding: 'utf8' }));
  assert.deepEqual(calls, freeMintOwnerCalls(fixture, address(1)));
  assert.notEqual(spawnSync(process.execPath, [cli.pathname, 'calldata'], { encoding: 'utf8' }).status, 0);
});

test('Sepolia relic preset requires its exact chain and leaves generic defaults empty', () => {
  const preset = JSON.parse(readFileSync(new URL('../config/free-mints.sepolia.json', import.meta.url), 'utf8'));
  const defaults = JSON.parse(readFileSync(new URL('../config/free-mints.json', import.meta.url), 'utf8'));
  assert.deepEqual(parseFreeMintConfig(defaults, undefined, 1).allocations, []);
  for (const chainId of [undefined, 1, 31337, 11155112]) {
    assert.throws(() => parseFreeMintConfig(preset, undefined, chainId), /explicit chain ID 11155111/);
    assert.throws(() => freeMintOwnerCalls(preset, address(1), chainId), /explicit chain ID 11155111/);
  }
  const parsed = parseFreeMintConfig(preset, undefined, 11155111);
  assert.equal(parsed.chainId, 11155111);
  assert.equal(parsed.allocations.length, 7);
  assert.equal(parsed.allocations.reduce((sum, item) => sum + item.relicLimit, 0), 18);
  assert.ok(parsed.allocations.every(item => item.crateLimit === 0 && item.warehouseLimit === 0));
  assert.deepEqual(parsed.allocations.map(item => [item.wallet, item.relicLimit]), [
    ['0xe26067c76fdbe877f48b0a8400cf5db8b47af0fe', 3],
    ['0xe4790dd79c334e3f848904975272ec17f9f70366', 3],
    ['0xe938ebb66b92692ab01f76c99cfac1928482e7b9', 3],
    ['0x440f0940f7fc3b5c4efd087f8b947c85ad81fde9', 3],
    ['0x31cd63c73e74808793f134f8146a1e3aa1637b5d', 2],
    ['0xf743b8e23d3ffcbde398aba9b9f83a98f56845f4', 2],
    ['0x336c8e2add19149bfc934fb2557c6bdeffa8009b', 2],
  ]);
  for (const invalid of [1, 31337, '11155111', null, true]) {
    assert.throws(() => parseFreeMintConfig({ ...preset, chainId: invalid }, undefined, 11155111), /Sepolia/);
  }
  const cli = new URL('./free-mints.mjs', import.meta.url).pathname;
  const path = new URL('../config/free-mints.sepolia.json', import.meta.url).pathname;
  for (const args of [['check', path], ['check', path, '--chain-id', '1'], ['calldata', address(1), path, '--chain-id', '1']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /explicit chain ID 11155111/);
  }
  const calls = JSON.parse(execFileSync(process.execPath, [cli, 'calldata', address(1), path, '--chain-id', '11155111'], { encoding: 'utf8' }));
  assert.deepEqual(calls, freeMintOwnerCalls(preset, address(1), 11155111));
  assert.equal(calls[0].chainId, 11155111);
  assert.equal(calls[0].value, '0');
});
