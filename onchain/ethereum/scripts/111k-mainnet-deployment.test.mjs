import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decode } from '@metamask/abi-utils';
import { NFT111K_MAINNET, mainnet111kDeploymentGas, parse111kMainnetDeploymentArgs, run111kMainnetDeployment,
  validateSigned111kMainnetDeployment } from './111k-mainnet-deployment.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const hex = value => `0x${BigInt(value).toString(16)}`;
const cast = args => execFileSync('cast', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('mainnet runner exposes only a fixed first-deployment identity and closed actions', () => {
  assert.equal(NFT111K_MAINNET.chainId, 1);
  assert.equal(NFT111K_MAINNET.metadataBaseURI, 'https://cdn.mons.shop/111k/');
  assert.equal(NFT111K_MAINNET.maximumFeeWei, '2000000000000000');
  for (const command of ['prepare', 'broadcast', 'verify']) {
    assert.equal(parse111kMainnetDeploymentArgs([command, '--directory', '/tmp/111k-mainnet']).command, command);
  }
  for (const args of [
    ['open'], ['reserve'], ['mint-qa'], ['unpack-qa'], ['finalize'], ['pause-old'], ['deploy'], ['prepare'],
    ['prepare', '--directory', '/tmp/release', '--network', 'sepolia'],
    ['prepare', '--directory', '/tmp/release', '--deployment-id', 'mainnet-v2'],
    ['prepare', '--directory', '/tmp/release', '--reserved-relics', '0'],
    ['prepare', '--directory', '/tmp/release', '--metadata-base-uri', 'https://cdn.mons.shop/111k/other/'],
    ['broadcast', '--directory', '/tmp/release', '--keystore', '/tmp/key'],
    ['verify', '--directory', '/tmp/release', '--deployment-id', 'mainnet-v1'],
    ['sign', '--directory', '/tmp/release'],
  ]) assert.throws(() => parse111kMainnetDeploymentArgs(args));
  const scripts = readJson(path.join(project, 'package.json')).scripts;
  assert.equal(scripts['nft111k:mainnet'], 'node scripts/111k-mainnet-deployment.mjs');
  assert.equal(scripts['prenft111k:mainnet'], undefined);
  assert.equal(scripts['postnft111k:mainnet'], undefined);
});

test('mainnet gas buffers obey the approved fee ceiling and protocol transaction cap', () => {
  assert.deepEqual(mainnet111kDeploymentGas('6475624', '155824393'), {
    gasEstimate: '6475624', gasLimit: '8468312', gasPrice: '233736590', maximumFeeWei: '1979354369936080',
  });
  assert.throws(() => mainnet111kDeploymentGas('6475624', '160000000'), /fee ceiling/);
  assert.throws(() => mainnet111kDeploymentGas('16777216', '1000'), /transaction cap/);
});

test('signed deployment validation rejects value, target, chain, calldata and fee mutations', () => {
  const manifest = { ...NFT111K_MAINNET, nonce: '2', creationCode: '0x60006000f3', ...mainnet111kDeploymentGas('100000', '1000') };
  const hash = `0x${'11'.repeat(32)}`;
  const record = { action: 'deploy', chainId: 1, from: manifest.deployer, to: null, data: manifest.creationCode,
    valueWei: '0', nonce: '2', gasLimit: manifest.gasLimit, gasPrice: manifest.gasPrice, maximumFeeWei: manifest.maximumFeeWei, hash };
  const transaction = { signer: manifest.deployer, type: '0x0', chainId: '0x1', nonce: '0x2', to: null, value: '0x0',
    gas: hex(manifest.gasLimit), gasPrice: hex(manifest.gasPrice), input: manifest.creationCode, hash };
  validateSigned111kMainnetDeployment(transaction, manifest, record, hash);
  for (const change of [{ chainId: '0xaa36a7' }, { signer: `0x${'22'.repeat(20)}` }, { to: manifest.owner },
    { value: '0x1' }, { input: '0x' }, { nonce: '0x3' }, { gas: '0x1' }, { gasPrice: '0x1' }, { hash: `0x${'22'.repeat(32)}` }]) {
    assert.throws(() => validateSigned111kMainnetDeployment({ ...transaction, ...change }, manifest, record, hash));
  }
  for (const change of [{ action: 'open' }, { chainId: 11155111 }, { from: manifest.quoteSigner }, { valueWei: '1' },
    { to: manifest.owner }, { data: '0x' }, { maximumFeeWei: '1' }]) {
    assert.throws(() => validateSigned111kMainnetDeployment(transaction, manifest, { ...record, ...change }, hash));
  }
});

test('wrong-chain and occupied-directory preflight fail without preparing a manifest', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '111k-mainnet-preflight-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(run111kMainnetDeployment(['prepare', '--directory', directory], {
    rpc: async () => '0xaa36a7',
  }), /not Ethereum mainnet/);
  fs.writeFileSync(path.join(directory, 'wallet.json'), 'private signing material');
  await assert.rejects(run111kMainnetDeployment(['prepare', '--directory', directory], {
    rpc: async method => { assert.equal(method, 'eth_chainId'); return '0x1'; },
  }), /fresh release directory/);
  assert.equal(fs.existsSync(path.join(directory, 'manifest.json')), false);
  assert.equal(fs.readFileSync(path.join(directory, 'wallet.json'), 'utf8'), 'private signing material');
});

test('fresh preparation rejects either registered identity and fails closed without registry access', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '111k-mainnet-identity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec('CREATE TABLE ethereum_reveal_deployments (deployment_id TEXT, metadata_base_uri TEXT)');
  const rpc = async method => { assert.equal(method, 'eth_chainId'); return '0x1'; };
  const args = ['prepare', '--directory', directory];
  for (const row of [
    ['mainnet-v1', 'https://cdn.mons.shop/111k/other/'],
    ['another-id', 'https://cdn.mons.shop/111k/'],
  ]) {
    database.prepare('INSERT INTO ethereum_reveal_deployments VALUES (?, ?)').run(...row);
    await assert.rejects(run111kMainnetDeployment(args, { rpc, query: sql => database.prepare(sql).all() }), /already registered/);
    assert.equal(fs.existsSync(path.join(directory, 'manifest.json')), false);
    database.exec('DELETE FROM ethereum_reveal_deployments');
  }
  await assert.rejects(run111kMainnetDeployment(args, { rpc, query: async () => { throw new Error('Registry unavailable'); } }), /Registry unavailable/);
  assert.equal(fs.existsSync(path.join(directory, 'manifest.json')), false);
});

async function anvilFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '111k-mainnet-runner-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No local port'));
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
  const process = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '1',
    '--hardfork', 'prague', '--base-fee', '0', '--gas-price', '1000', '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let failure = '';
  process.stderr.on('data', data => { failure += String(data); });
  process.on('error', error => { failure += error.message; });
  t.after(async () => {
    if (process.exitCode === null && process.pid) {
      const stopped = once(process, 'exit');
      process.kill('SIGTERM');
      await stopped;
    }
  });
  const rpc = async (method, params = []) => {
    const response = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    if (result.error) throw new Error(result.error.message);
    return result.result;
  };
  for (let count = 0; ; count++) {
    try { await rpc('eth_chainId'); break; }
    catch {
      if (count > 100 || process.exitCode !== null || failure) throw new Error(`Anvil failed: ${failure}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  const [deployer] = await rpc('eth_accounts');
  const fixtureKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  let signatures = 0;
  const signingCast = args => {
    if (args[0] === 'wallet') return deployer;
    if (args[0] !== 'mktx') return cast(args);
    signatures++;
    const filtered = args.filter((arg, index) => !['--keystore', '--password-file'].includes(arg)
      && !['--keystore', '--password-file'].includes(args[index - 1]));
    return cast([filtered[0], '--private-key', fixtureKey, ...filtered.slice(1)]);
  };
  return { directory, deployer, rpc, cast: signingCast, signatures: () => signatures };
}

test('mainnet prepare/sign/broadcast resumes the identical transaction and verifies a closed empty collection locally', { timeout: 120000 }, async t => {
  const f = await anvilFixture(t);
  const release = path.join(f.directory, 'release');
  const manifestPath = path.join(release, 'manifest.json');
  const journalPath = path.join(release, 'transactions.private.json');
  let sends = 0;
  let loseResponse = true;
  let failure;
  let registered = false;
  let registerDuringPreflight = false;
  const rpc = async (method, params = []) => {
    if (registerDuringPreflight && method === 'eth_call') {
      registered = true;
      registerDuringPreflight = false;
    }
    if (failure === 'nonce' && method === 'eth_getTransactionCount') return '0x1';
    if (failure === 'balance' && method === 'eth_getBalance') return '0x0';
    if (method === 'eth_gasPrice') return failure === 'price' ? '0x1000000' : '0x3e8';
    if (method !== 'eth_sendRawTransaction') return f.rpc(method, params);
    const journal = readJson(journalPath);
    assert.equal(journal.actions.deploy.raw, params[0], 'Signed transaction must be durable before sending');
    assert.ok(journal.actions.deploy.broadcastAttemptedAt);
    assert.deepEqual(Object.keys(journal.actions), ['deploy']);
    sends++;
    const hash = await f.rpc(method, params);
    await f.rpc('anvil_mine', [2]);
    if (loseResponse) { loseResponse = false; throw new Error('Simulated lost broadcast response'); }
    return hash;
  };
  const options = { rpc, cast: f.cast, configuration: { deployer: f.deployer }, sleep: async () => {}, maxReceiptPolls: 2,
    query: async () => registered ? [{ deployment_id: 'mainnet-v1' }] : [] };
  const invoke = command => run111kMainnetDeployment([command, '--directory', release,
    ...(command === 'sign' ? ['--keystore', 'fixture', '--password-file', 'fixture'] : [])], options);
  await invoke('prepare');
  const manifest = readJson(manifestPath);
  assert.equal(manifest.chainId, 1);
  assert.equal(manifest.owner, NFT111K_MAINNET.owner);
  assert.equal(manifest.initialDeliveryReceiver, NFT111K_MAINNET.initialDeliveryReceiver);
  assert.equal(manifest.metadataBaseURI, 'https://cdn.mons.shop/111k/');
  assert.equal(manifest.maxDiscountedMints, 500);
  assert.deepEqual(manifest.freeMintAllocations, []);
  assert.deepEqual(manifest.relicReservation, { quantity: 0, valueWei: '0' });
  assert.equal(manifest.previousContract, undefined);
  assert.equal(manifest.proceeds.mintRecipients.length, 14);
  const args = decode(['address', 'address', 'address', 'string', 'bytes32', 'address[]', 'uint256[]',
    '(address,uint16,uint16,uint16)[]', 'uint256'], manifest.constructorArgs);
  assert.equal(args[0], NFT111K_MAINNET.owner);
  assert.equal(args[1], NFT111K_MAINNET.quoteSigner);
  assert.equal(args[2], NFT111K_MAINNET.initialDeliveryReceiver);
  assert.equal(args[3], NFT111K_MAINNET.metadataBaseURI);
  assert.deepEqual(args[7], []);
  assert.equal(args[8], 500n);
  registered = true;
  await assert.rejects(invoke('sign'), /already registered/);
  assert.equal(f.signatures(), 0);
  assert.equal(fs.existsSync(journalPath), false);
  registered = false;
  for (const [mode, expected] of [['nonce', /nonce/], ['balance', /funds/], ['price', /Gas price/]]) {
    failure = mode;
    await assert.rejects(invoke('sign'), expected);
    assert.equal(f.signatures(), 0);
    assert.equal(fs.existsSync(journalPath), false);
  }
  failure = undefined;
  const originalRead = fs.readFileSync;
  for (const source of ['src/NFT111K.sol', 'config/proceeds.json']) {
    t.mock.method(fs, 'readFileSync', (filename, ...args) => {
      const content = originalRead(filename, ...args);
      return path.resolve(String(filename)) === path.join(project, source) ? `${content}\n` : content;
    });
    await assert.rejects(invoke('sign'), /changed after preparation/);
    t.mock.restoreAll();
  }
  const frozenArtifact = path.join(release, 'NFT111K.artifact.json');
  const artifactBytes = fs.readFileSync(frozenArtifact);
  fs.appendFileSync(frozenArtifact, '\n');
  await assert.rejects(invoke('sign'), /Frozen artifact changed/);
  fs.writeFileSync(frozenArtifact, artifactBytes);
  await invoke('sign');
  const signed = readJson(journalPath).actions.deploy;
  assert.equal(sends, 0);
  assert.equal(f.signatures(), 1);
  await invoke('sign');
  assert.equal(f.signatures(), 1);
  assert.equal(readJson(journalPath).actions.deploy.hash, signed.hash);
  registered = true;
  await assert.rejects(invoke('broadcast'), /already registered/);
  assert.equal(sends, 0);
  registered = false;
  registerDuringPreflight = true;
  await assert.rejects(invoke('broadcast'), /already registered/);
  assert.equal(sends, 0);
  registered = false;
  failure = 'nonce';
  await assert.rejects(invoke('broadcast'), /nonce/);
  assert.equal(sends, 0);
  failure = undefined;
  await assert.rejects(invoke('broadcast'), /lost broadcast response/);
  registered = true;
  await invoke('broadcast');
  await invoke('broadcast');
  assert.equal(sends, 1);
  assert.equal(f.signatures(), 1);
  assert.equal(readJson(journalPath).actions.deploy.hash, signed.hash);
  assert.equal(BigInt(await f.rpc('eth_getTransactionCount', [f.deployer, 'latest'])), BigInt(manifest.nonce) + 1n);
  const report = await invoke('verify');
  assert.equal(report.chainId, 1);
  assert.equal(report.stage, 'closed');
  assert.equal(report.metadataBaseURI, 'https://cdn.mons.shop/111k/');
  assert.equal(report.contractURI, 'https://cdn.mons.shop/111k/collection.json');
  for (const signature of ['saleActive()', 'allocatedCrates()', 'relicsAllocated()', 'relicsMinted()', 'totalSupply()', 'totalDiscountedMints()']) {
    assert.equal(BigInt(await f.rpc('eth_call', [{ to: manifest.contractAddress, data: cast(['calldata', signature]) }, 'latest'])), 0n);
  }
  assert.deepEqual(Object.keys(readJson(journalPath).actions), ['deploy']);
  assert.equal(fs.statSync(journalPath).mode & 0o077, 0);
});
