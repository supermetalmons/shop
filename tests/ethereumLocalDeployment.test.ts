import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseProceedsConfig } from '../onchain/ethereum/scripts/proceeds-config.mjs';

test('the local API rejects old deployment manifests before connecting to Anvil', () => {
  const directory = mkdtempSync(join(tmpdir(), '111k-deployment-test-'));
  const deploymentFile = join(directory, 'deployment.json');
  const start = (manifest: object) => {
    writeFileSync(deploymentFile, JSON.stringify(manifest));
    return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/ethereum111k-dev-api.ts'], {
      encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, ETHEREUM_111K_LOCAL_DEPLOYMENT: deploymentFile },
    });
  };
  try {
    for (const protocolVersion of [undefined, 1, 2, 3, 4, 5]) {
      const result = start({ protocolVersion });
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /The local deployment does not support the current proceeds contract interface\./);
      assert.match(result.stderr, /Restart Anvil and run npm --prefix onchain\/ethereum run deploy:local again\./);
    }
    const current = start({ protocolVersion: 6, chainId: 1, rpcUrl: 'http://127.0.0.1:8545' });
    assert.ifError(current.error);
    assert.equal(current.status, 1);
    assert.match(current.stderr, /The local API accepts only an Anvil deployment on an HTTP loopback URL, chain ID 31337\./);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('proceeds configuration accepts two through eight recipients and the committed configuration', () => {
  const config = JSON.parse(readFileSync('onchain/ethereum/config/proceeds.json', 'utf8'));
  assert.deepEqual(parseProceedsConfig(config), {
    mintRecipients: config.mintRecipients.map((address: string) => address.toLowerCase()),
    mintSharesBps: config.mintSharesBps,
    deliveryPaymentReceiver: config.deliveryPaymentReceiver.toLowerCase(),
  });
  for (let count = 2; count <= 8; count++) {
    const mintRecipients = Array.from({ length: count }, (_, index) => `0x${String(index + 1).repeat(40)}`);
    const mintSharesBps = Array.from({ length: count }, (_, index) => index === 0 ? 10_000 - count + 1 : 1);
    assert.equal(parseProceedsConfig({ mintRecipients, mintSharesBps, deliveryPaymentReceiver: `0x${'9'.repeat(40)}` }).mintRecipients.length, count);
  }
});

test('proceeds configuration normalizes checksummed payees including an Anvil buyer', () => {
  const mintRecipients = ['0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', `0x${'9'.repeat(40)}`];
  const deliveryPaymentReceiver = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const config = { mintRecipients, mintSharesBps: [5000, 5000], deliveryPaymentReceiver };
  assert.deepEqual(parseProceedsConfig(config), {
    mintRecipients: mintRecipients.map(address => address.toLowerCase()),
    mintSharesBps: [5000, 5000],
    deliveryPaymentReceiver: deliveryPaymentReceiver.toLowerCase(),
  });
});

test('proceeds preflight rejects malformed splits and invalid or overlapping receiver addresses', () => {
  const first = `0x${'a'.repeat(40)}`;
  const second = `0x${'b'.repeat(40)}`;
  const delivery = `0x${'c'.repeat(40)}`;
  const valid = { mintRecipients: [first, second], mintSharesBps: [5000, 5000], deliveryPaymentReceiver: delivery };
  for (const invalid of [
    null, {}, { ...valid, mintRecipients: [first] },
    { ...valid, mintRecipients: Array(9).fill(first), mintSharesBps: Array(9).fill(1) },
    { ...valid, mintSharesBps: [10_000] }, { ...valid, mintSharesBps: [0, 10_000] },
    { ...valid, mintSharesBps: [-1, 10_001] }, { ...valid, mintSharesBps: [5000.5, 4999.5] },
    { ...valid, mintSharesBps: ['5000', 5000] }, { ...valid, mintSharesBps: [4999, 5000] },
    { ...valid, mintRecipients: [first, first.toUpperCase().replace('0X', '0x')] },
    ...[null, 1, '0x123', `0x${'0'.repeat(40)}`, `0x${'g'.repeat(40)}`].flatMap(address => [
      { ...valid, mintRecipients: [first, address] }, { ...valid, deliveryPaymentReceiver: address },
    ]),
    { ...valid, deliveryPaymentReceiver: first.toUpperCase().replace('0X', '0x') },
  ]) assert.throws(() => parseProceedsConfig(invalid));
  assert.throws(() => parseProceedsConfig(valid, first));
  assert.throws(() => parseProceedsConfig(valid, delivery));
});

test('a rotated delivery receiver remains valid without changing the deployment mint configuration', () => {
  const original = parseProceedsConfig(JSON.parse(readFileSync('onchain/ethereum/config/proceeds.json', 'utf8')));
  const occupied = new Set([...original.mintRecipients, original.deliveryPaymentReceiver]);
  let receiver = 1n;
  while (occupied.has(`0x${receiver.toString(16).padStart(40, '0')}`)) receiver++;
  const rotated = parseProceedsConfig({ ...original, deliveryPaymentReceiver: `0x${receiver.toString(16).padStart(40, '0')}` });
  assert.deepEqual(rotated.mintRecipients, original.mintRecipients);
  assert.deepEqual(rotated.mintSharesBps, original.mintSharesBps);
  assert.notEqual(rotated.deliveryPaymentReceiver, original.deliveryPaymentReceiver);
});
