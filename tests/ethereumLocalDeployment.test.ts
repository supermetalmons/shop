import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseProceedsConfig } from '../onchain/ethereum/scripts/proceeds-config.mjs';
import { ethereumMetadataBaseUri } from '../shared/ethereum/config.ts';
import { encodeAbi, encodeCall } from '../shared/ethereum/abi.ts';

test('the local deployment launcher validates canonical collection namespaces before any RPC', () => {
  const preload = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => { throw new Error("LOCAL_RPC_REACHED"); };')}`;
  const start = (metadataBaseURI: string) => spawnSync(process.execPath, ['--import', preload, 'onchain/ethereum/scripts/deploy-local.mjs'], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, ETHEREUM_111K_LOCAL_METADATA_BASE_URI: metadataBaseURI,
      ETHEREUM_111K_LOCAL_RPC_URL: 'http://127.0.0.1:8545' },
  });
  for (const root of ['111k', '111k-sepolia']) {
    const base = `https://cdn.mons.shop/${root}/`;
    for (const suffix of ['', 'a/', 'test-2/', `${'a'.repeat(64)}/`]) {
      const uri = base + suffix;
      assert.equal(ethereumMetadataBaseUri(uri, 31337), uri);
      const result = start(uri);
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /LOCAL_RPC_REACHED/, uri);
    }
    for (const uri of [
      ...['../other/', 'a/../', '%61/', 'UPPER/', '-test/', 'a/b/', 'a//', 'test', `${'a'.repeat(65)}/`, '?q=1', '#hash'].map(suffix => base + suffix),
      base.replace('https:', 'http:'), base.replace('cdn.mons.shop', 'example.com'),
      base.replace('cdn.mons.shop', 'cdn.mons.shop.evil.example'), base.replace('cdn.mons.shop', 'user@cdn.mons.shop'),
      base.replace('cdn.mons.shop', 'cdn.mons.shop:443'),
    ]) {
      assert.throws(() => ethereumMetadataBaseUri(uri, 31337), undefined, uri);
      const result = start(uri);
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Local metadata must use a canonical/, uri);
      assert.doesNotMatch(result.stderr, /LOCAL_RPC_REACHED/, uri);
    }
  }
});

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
    for (const protocolVersion of [undefined, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const result = start({ protocolVersion });
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /The local deployment does not support monuments in the collection contract\./);
      assert.match(result.stderr, /Restart Anvil and run npm --prefix onchain\/ethereum run deploy:local again\./);
    }
    const current = start({ protocolVersion: 10, chainId: 1, rpcUrl: 'http://127.0.0.1:8545' });
    assert.ifError(current.error);
    assert.equal(current.status, 1);
    assert.match(current.stderr, /The local API accepts only an Anvil deployment on an HTTP loopback URL, chain ID 31337\./);
    for (const metadataBaseURI of ['http://127.0.0.1:8789/111k-sepolia/', 'http://localhost:8789/111k/',
      'http://[::1]:8789/111k-sepolia/', 'https://example.com/111k-sepolia/']) {
      const local = start({ protocolVersion: 10, chainId: 31337, rpcUrl: 'http://127.0.0.1:8545', metadataBaseURI });
      assert.ifError(local.error);
      assert.equal(local.status, 1);
      assert.match(local.stderr, /Local metadata must use the collection CDN\./);
      assert.match(local.stderr, /Restart Anvil and run npm --prefix onchain\/ethereum run deploy:local again\./);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('the local API probes monument constants and the extended stats before initializing its runtime', () => {
  const directory = mkdtempSync(join(tmpdir(), '111k-monument-probe-'));
  const deploymentFile = join(directory, 'deployment.json');
  const fixture = JSON.parse(readFileSync('onchain/ethereum/fixtures/eip712.json', 'utf8'));
  const proceeds = JSON.parse(readFileSync('onchain/ethereum/config/proceeds.json', 'utf8'));
  const metadataBaseURI = 'https://cdn.mons.shop/111k-sepolia/probe/';
  writeFileSync(deploymentFile, JSON.stringify({ ...proceeds, protocolVersion: 10, chainId: 31337,
    rpcUrl: 'http://127.0.0.1:8545', contractAddress: `0x${'7'.repeat(40)}`, deploymentBlock: 0,
    quoteSigner: fixture.signer, metadataBaseURI }));
  const types = ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32',
    'uint256', 'uint256', 'uint256', 'uint256', 'uint256'];
  const stats = [111n, 0n, 0n, 100n, 1100n, true, `0x${'0'.repeat(64)}`, 50n, 1n, 0n, 1n, 17n];
  try {
    for (const scenario of [
      { name: 'legacy stats', values: stats.slice(0, 10), limit: 18, crates: 111, valid: false },
      { name: 'wrong cap', values: stats, limit: 30, crates: 111, valid: false },
      { name: 'old reservation', values: stats, limit: 18, crates: 88, valid: false },
      { name: 'cap exceeded', values: [...stats.slice(0, 10), 19n, 17n], limit: 18, crates: 111, valid: false },
      { name: 'unreserved monument', values: [110n, ...stats.slice(1)], limit: 18, crates: 111, valid: false },
      { name: 'current interface', values: stats, limit: 18, crates: 111, valid: true },
    ]) {
      const responses = {
        [encodeCall('quoteSigner()', [], [])]: encodeAbi(['address'], [fixture.signer]),
        [encodeCall('MAX_UNBOX_QUANTITY()', [], [])]: encodeAbi(['uint256'], [15]),
        [encodeCall('getTokenInfos(uint256[])', ['uint256[]'], [[]])]: encodeAbi(['(uint8,uint256,address)[]'], [[]]),
        [encodeCall('previewTokenURIs(uint8[],uint256[])', ['uint8[]', 'uint256[]'], [[], []])]: encodeAbi(['string[]'], [[]]),
        [encodeCall('stats(address)', ['address'], [`0x${'0'.repeat(40)}`])]: encodeAbi(types.slice(0, scenario.values.length), scenario.values),
        [encodeCall('baseURI()', [], [])]: encodeAbi(['string'], [metadataBaseURI]),
        [encodeCall('MAX_MONUMENTS()', [], [])]: encodeAbi(['uint256'], [scenario.limit]),
        [encodeCall('CRATES_PER_MONUMENT()', [], [])]: encodeAbi(['uint256'], [scenario.crates]),
      };
      const preload = `data:text/javascript,${encodeURIComponent(`
        const responses = ${JSON.stringify(responses)};
        globalThis.fetch = async (_url, options) => {
          const { method, params } = JSON.parse(options.body);
          const result = method === 'eth_chainId' ? '0x7a69' : method === 'web3_clientVersion' ? 'anvil/test'
            : method === 'eth_getCode' ? '0x1234' : responses[params[0].data];
          if (result === undefined) throw new Error('MONUMENT_PROBE_ACCEPTED');
          return new Response(JSON.stringify({ result }));
        };
      `)}`;
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--import', preload, 'scripts/ethereum111k-dev-api.ts'], {
        encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, ETHEREUM_111K_LOCAL_DEPLOYMENT: deploymentFile },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1, scenario.name);
      assert.match(result.stderr, scenario.valid ? /MONUMENT_PROBE_ACCEPTED/ : /current discount and monument interface/, scenario.name);
    }
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
