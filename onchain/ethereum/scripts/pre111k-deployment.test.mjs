import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deploymentConfiguration, deploymentGas, main, matchingRuntime, PRE111K_MAINNET, PRE111K_SEPOLIA,
  validateDeploymentBalance, validateDeploymentConfiguration, validateDeploymentGasPrice, validateSignedDeployment } from './pre111k-deployment.mjs';

const mainnetSigner = '0x2222222222222222222222222222222222222222';

test('Sepolia deployment pins the approved immutable configuration', () => {
  assert.equal(PRE111K_SEPOLIA.chainId, 11155111);
  assert.equal(PRE111K_SEPOLIA.priceWei, '2300000000000000');
  assert.equal(PRE111K_SEPOLIA.treasury, '0x72d0c5623a05033f9ee4495d408bc6c05df8367d');
});

test('mainnet pins the Safe roles and price while keeping a separate funded deployer and signer', () => {
  const configuration = deploymentConfiguration('mainnet', mainnetSigner);
  assert.equal(configuration.chainId, 1);
  assert.equal(configuration.deployer, PRE111K_SEPOLIA.admin);
  assert.equal(configuration.admin, PRE111K_SEPOLIA.treasury);
  assert.equal(configuration.treasury, configuration.admin);
  assert.notEqual(configuration.deployer, configuration.admin);
  assert.equal(configuration.priceWei, '2300000000000000000');
  assert.equal(configuration.maximumFeeWei, '1000000000000000');
  assert.equal(configuration.quoteSigner, mainnetSigner);
  assert.equal(deploymentConfiguration().chainId, 11155111);
  for (const signer of [undefined, '', '0x' + '0'.repeat(40), 'not-an-address', PRE111K_SEPOLIA.quoteSigner]) {
    assert.throws(() => deploymentConfiguration('mainnet', signer), /quote.signer/);
  }
  assert.throws(() => deploymentConfiguration('other', mainnetSigner), /network/);
  assert.throws(() => deploymentConfiguration('sepolia', mainnetSigner), /Sepolia quote signer/);
});

test('frozen configuration rejects mixed networks, deployers and constructor roles and accepts legacy Sepolia', () => {
  const manifest = { network: 'mainnet', ...deploymentConfiguration('mainnet', mainnetSigner) };
  validateDeploymentConfiguration(manifest, 'mainnet');
  for (const [key, value] of Object.entries({ chainId: 11155111, network: 'sepolia', deployer: manifest.admin,
    admin: manifest.deployer, treasury: manifest.deployer, priceWei: PRE111K_SEPOLIA.priceWei, quoteSigner: PRE111K_SEPOLIA.quoteSigner })) {
    assert.throws(() => validateDeploymentConfiguration({ ...manifest, [key]: value }, 'mainnet'));
  }
  assert.throws(() => validateDeploymentConfiguration(manifest, 'sepolia'));
  const legacy = { ...PRE111K_SEPOLIA };
  delete legacy.deployer;
  assert.equal(validateDeploymentConfiguration(legacy, 'sepolia').deployer, legacy.admin);
  const missingMainnetDeployer = { ...manifest };
  delete missingMainnetDeployer.deployer;
  assert.throws(() => validateDeploymentConfiguration(missingMainnetDeployer, 'mainnet'), /deployer/);
});

test('gas allowance uses live estimates, rounds up and enforces the fee ceiling', () => {
  assert.deepEqual(deploymentGas('100001', '1000'), {
    gasEstimate: '100001', gasLimit: '180002', gasPrice: '1500', maximumFeeWei: '270003000',
  });
  assert.equal(deploymentGas('100001', '20').gasPrice, '1000');
  assert.equal(deploymentGas('100001', '1001').gasPrice, '1502');
  assert.throws(() => deploymentGas('1', '1000000000000000000'), /fee ceiling/);
  assert.throws(() => deploymentGas('0', '1'), /Invalid/);
  assert.throws(() => deploymentGas('1', '0'), /Invalid/);
});

test('deployer funding must cover the full frozen transaction allowance', () => {
  const maximumFeeWei = 1000000000000000n;
  validateDeploymentBalance('0x' + maximumFeeWei.toString(16), maximumFeeWei);
  assert.throws(() => validateDeploymentBalance('0x' + (maximumFeeWei - 1n).toString(16), maximumFeeWei), /Insufficient deployer funds/);
  assert.throws(() => validateDeploymentBalance('0x0', maximumFeeWei), /Insufficient deployer funds/);
  for (const balance of [true, null, 'not-a-balance']) assert.throws(() => validateDeploymentBalance(balance, maximumFeeWei), /Invalid deployer balance/);
});

test('runtime comparison masks only declared immutable slots', () => {
  const references = { '1': [{ start: 2, length: 2 }] };
  assert.equal(matchingRuntime('0x112200005566', '0x1122aabb5566', references), true);
  assert.equal(matchingRuntime('0x112200005566', '0xff22aabb5566', references), false);
  assert.equal(matchingRuntime('0x112200005566', '0x1122aabb55', references), false);
  assert.equal(matchingRuntime('0x112200005566', '0x', references), false);
  assert.throws(() => matchingRuntime('0x1122', '0x1122', { '1': [{ start: 2, length: 1 }] }));
});

test('signing rejects a frozen offer below the current suggestion or either base fee', () => {
  const prepared = deploymentGas('6000000', '100000000');
  assert.equal(prepared.gasPrice, '150000000');
  assert.throws(() => validateDeploymentGasPrice(prepared.gasPrice, '200000000', '190000000', '190000000'), /before signing/);
  assert.throws(() => validateDeploymentGasPrice(prepared.gasPrice, '150000001', '100000000', '100000000'), /before signing/);
  assert.throws(() => validateDeploymentGasPrice(prepared.gasPrice, '100000000', '150000001', '100000000'), /before signing/);
  assert.throws(() => validateDeploymentGasPrice(prepared.gasPrice, '100000000', '100000000', '150000001'), /before signing/);
  validateDeploymentGasPrice(prepared.gasPrice, '150000000', '150000000', '150000000');
  validateDeploymentGasPrice(prepared.gasPrice, '0x5f5e100', '0x5f5e100', '0x5f5e100');
  assert.throws(() => validateDeploymentGasPrice(prepared.gasPrice, '100000000', null, '100000000'), /fee data/);
  assert.throws(() => validateDeploymentGasPrice(prepared.gasPrice, '100000000', '100000000', undefined), /fee data/);
});

test('signed deployment cannot change network, recipient, payment, input or fee', () => {
  const manifest = { ...PRE111K_SEPOLIA, nonce: '57', gasPrice: '20', gasLimit: '7827455', creationCode: '0x60006000f3' };
  delete manifest.deployer;
  const transaction = { signer: manifest.admin, type: '0x0', chainId: '0xaa36a7', nonce: '0x39', gasPrice: '0x14',
    gas: '0x776fff', to: null, value: '0x0', input: manifest.creationCode, hash: '0x1234' };
  transaction.gas = '0x' + BigInt(manifest.gasLimit).toString(16);
  validateSignedDeployment(transaction, manifest, transaction.hash);
  for (const [key, value] of Object.entries({ signer: manifest.treasury, chainId: '0x1', nonce: '0x3a', gasPrice: '0x15',
    gas: '0x1000000', to: manifest.treasury, value: '0x1', input: '0x', hash: '0xffff' })) {
    assert.throws(() => validateSignedDeployment({ ...transaction, [key]: value }, manifest, transaction.hash));
  }
});

test('mainnet signed deployment uses the deployer and enforces chain 1 and the independent fee ceiling', () => {
  const manifest = { ...deploymentConfiguration('mainnet', mainnetSigner), nonce: '0', gasPrice: '1000000000',
    gasLimit: '1000000', creationCode: '0x60006000f3' };
  const transaction = { signer: manifest.deployer, type: '0x0', chainId: '0x1', nonce: '0x0', gasPrice: '0x3b9aca00',
    gas: '0xf4240', to: null, value: '0x0', input: manifest.creationCode, hash: '0x1234' };
  validateSignedDeployment(transaction, manifest, transaction.hash);
  assert.throws(() => validateSignedDeployment({ ...transaction, signer: manifest.admin }, manifest, transaction.hash), /signer/);
  assert.throws(() => validateSignedDeployment({ ...transaction, chainId: '0xaa36a7' }, manifest, transaction.hash), /chain/);
  assert.throws(() => validateSignedDeployment({ ...transaction, gasPrice: '0x3b9aca01' },
    { ...manifest, gasPrice: '1000000001', maximumFeeWei: PRE111K_SEPOLIA.maximumFeeWei }, transaction.hash), /fee ceiling/);
  assert.throws(() => deploymentGas('1000000', '1000000000', PRE111K_MAINNET.maximumFeeWei), /fee ceiling/);
});

function prepareFixture(t, chainId = '0x1') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pre111k-deployment-test-'));
  const previousRpc = process.env.ETHEREUM_PRE111K_RPC_URL;
  process.env.ETHEREUM_PRE111K_RPC_URL = 'https://pre111k-rpc.invalid';
  const artifact = { metadata: { compiler: { version: '0.8.38+commit.1835d247' }, sources: {}, settings: {
    optimizer: { enabled: true, runs: 500 }, evmVersion: 'prague', compilationTarget: { 'src/Pre111K.sol': 'Pre111K' },
  } }, bytecode: { object: '0x60006000f3' } };
  const readFile = fs.readFileSync.bind(fs);
  t.mock.method(fs, 'readFileSync', (filename, ...args) => String(filename).endsWith('/out/Pre111K.sol/Pre111K.json')
    ? JSON.stringify(artifact) : readFile(filename, ...args));
  t.mock.method(console, 'log', () => {});
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    const results = { eth_chainId: chainId, eth_getTransactionCount: '0x0', eth_getCode: '0x',
      eth_estimateGas: '0xd7f83', eth_gasPrice: '0x5f5e100', eth_getBalance: '0x38d7ea4c68000' };
    assert.ok(Object.hasOwn(results, request.method), 'Unexpected RPC operation ' + request.method);
    return Response.json({ jsonrpc: '2.0', id: 1, result: results[request.method] });
  });
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    if (previousRpc === undefined) delete process.env.ETHEREUM_PRE111K_RPC_URL;
    else process.env.ETHEREUM_PRE111K_RPC_URL = previousRpc;
  });
  return { directory, requests, read: () => JSON.parse(readFile(path.join(directory, 'manifest.json'), 'utf8')) };
}

test('mainnet preparation freezes Safe constructor values and reads only the deployer nonce and funds', async t => {
  const f = prepareFixture(t);
  await main(['prepare', '--network', 'mainnet', '--quote-signer', mainnetSigner, '--directory', f.directory]);
  const manifest = f.read();
  assert.equal(manifest.network, 'mainnet');
  assert.equal(manifest.chainId, 1);
  assert.equal(manifest.deployer, PRE111K_MAINNET.deployer);
  assert.equal(manifest.admin, PRE111K_MAINNET.treasury);
  assert.equal(manifest.quoteSigner, mainnetSigner);
  const words = manifest.constructorArgs.slice(2).match(/.{64}/g);
  assert.deepEqual(words.slice(0, 3).map(word => '0x' + word.slice(24)), [manifest.admin, manifest.treasury, mainnetSigner]);
  assert.equal(BigInt('0x' + words[3]).toString(), '2300000000000000000');
  for (const request of f.requests.filter(request => ['eth_getTransactionCount', 'eth_getBalance'].includes(request.method))) {
    assert.equal(request.params[0], manifest.deployer);
  }
  const estimation = f.requests.find(request => request.method === 'eth_estimateGas').params[0];
  assert.equal(estimation.from, manifest.deployer);
  assert.equal(estimation.value, '0x0');
  assert.equal(estimation.data, manifest.creationCode);
  assert.ok(BigInt(manifest.maximumFeeWei) <= BigInt(PRE111K_MAINNET.maximumFeeWei));
  manifest.constructorArgs = '0x' + manifest.deployer.slice(2).padStart(64, '0') + manifest.constructorArgs.slice(66);
  fs.writeFileSync(path.join(f.directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(main(['verify', '--network', 'mainnet', '--directory', f.directory]), /Constructor configuration changed/);
});

for (const chainId of ['0xaa36a7', true, 1, null]) {
  test(`mainnet preparation rejects wrong or malformed RPC chain ${JSON.stringify(chainId)} before preparing files`, async t => {
    const f = prepareFixture(t, chainId);
    await assert.rejects(main(['prepare', '--network', 'mainnet', '--quote-signer', mainnetSigner, '--directory', f.directory]), /selected deployment network|Invalid RPC chain ID/);
    assert.deepEqual(f.requests.map(request => request.method), ['eth_chainId']);
    assert.deepEqual(fs.readdirSync(f.directory), []);
  });
}
