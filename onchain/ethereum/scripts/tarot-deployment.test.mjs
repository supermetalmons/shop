import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  deploymentConfiguration, deploymentConstructorArgs, deploymentGas, main, TAROT_SEPOLIA,
  validateDeploymentConfiguration, validateSignedDeployment,
} from './tarot-deployment.mjs';

const quoteSigner = '0x2222222222222222222222222222222222222222';
const configuration = () => ({ network: 'sepolia', ...deploymentConfiguration('sepolia', quoteSigner) });

test('Tarot configuration pins Sepolia and the approved admin and metadata root', () => {
  const config = deploymentConfiguration('sepolia', quoteSigner.toUpperCase().replace('0X', '0x'));
  assert.equal(config.chainId, 11155111);
  assert.equal(config.admin, TAROT_SEPOLIA.deployer);
  assert.equal(config.baseURI, 'https://cdn.mons.shop/tarot-sepolia/v1/');
  assert.equal(config.quoteSigner, quoteSigner);
  for (const network of ['mainnet', 'devnet', 'local', 'other']) {
    assert.throws(() => deploymentConfiguration(network, quoteSigner), /Sepolia only/);
  }
  for (const signer of [undefined, '', 'wrong', '0x' + '0'.repeat(40)]) {
    assert.throws(() => deploymentConfiguration('sepolia', signer), /quote-signer/);
  }
  assert.throws(() => deploymentConfiguration('sepolia', TAROT_SEPOLIA.deployer), /dedicated/);
});

test('frozen deployment identity rejects changed roles, network and metadata', () => {
  const manifest = configuration();
  assert.deepEqual(validateDeploymentConfiguration(manifest), deploymentConfiguration('sepolia', quoteSigner));
  for (const [key, value] of Object.entries({ chainId: 1, network: 'mainnet', admin: quoteSigner,
    deployer: quoteSigner, baseURI: 'https://cdn.mons.shop/111k/' })) {
    assert.throws(() => validateDeploymentConfiguration({ ...manifest, [key]: value }));
  }
});

test('constructor encoding supplies owner, independent signer and metadata URI', () => {
  const config = configuration();
  const encoded = deploymentConstructorArgs(config);
  const values = JSON.parse(execFileSync('cast', ['abi-decode', 'constructor()(address,address,string)', encoded, '--json'], { encoding: 'utf8' }));
  assert.deepEqual(values.map(value => value.startsWith('0x') ? value.toLowerCase() : value),
    [config.admin, config.quoteSigner, config.baseURI]);
});

test('journaled signed transaction cannot change chain, nonce, payment, signer, recipient or calldata', () => {
  const manifest = { ...configuration(), nonce: '2', gasPrice: '1000', gasLimit: '2000000', creationCode: '0x60006000f3' };
  const transaction = { signer: manifest.deployer, type: '0x0', chainId: '0xaa36a7', nonce: '0x2',
    gasPrice: '0x3e8', gas: '0x1e8480', to: null, value: '0x0', input: manifest.creationCode, hash: '0x1234' };
  validateSignedDeployment(transaction, manifest, transaction.hash);
  for (const [key, value] of Object.entries({ signer: quoteSigner, type: '0x2', chainId: '0x1', nonce: '0x3',
    gasPrice: '0x3e9', gas: '0x1000', to: quoteSigner, value: '0x1', input: '0x', hash: '0x5678' })) {
    assert.throws(() => validateSignedDeployment({ ...transaction, [key]: value }, manifest, transaction.hash));
  }
  const over = { ...manifest, gasPrice: '3000000000' };
  assert.throws(() => validateSignedDeployment({ ...transaction, gasPrice: '0xb2d05e00' }, over, transaction.hash), /fee ceiling/);
  assert.throws(() => deploymentGas('2000000', '3000000000', TAROT_SEPOLIA.maximumFeeWei), /fee ceiling/);
});

function fixture(t, overrides = {}, artifact) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tarot-deployment-test-'));
  const previous = process.env.ETHEREUM_TAROT_RPC_URL;
  process.env.ETHEREUM_TAROT_RPC_URL = 'https://tarot-rpc.invalid';
  const read = fs.readFileSync.bind(fs);
  if (artifact) t.mock.method(fs, 'readFileSync', (filename, ...args) => String(filename).endsWith('/out/TarotCards.sol/TarotCards.json')
    ? JSON.stringify(artifact) : read(filename, ...args));
  const logs = [];
  const requests = [];
  let beforeRequest;
  t.mock.method(console, 'log', value => logs.push(JSON.parse(value)));
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    await beforeRequest?.(request);
    const results = { eth_chainId: '0xaa36a7', eth_getTransactionCount: '0x0', eth_getCode: '0x',
      eth_estimateGas: '0x1e8480', eth_gasPrice: '0x5f5e100', eth_getBalance: '0x11c37937e08000', ...overrides };
    assert.ok(Object.hasOwn(results, request.method), 'Unexpected RPC operation ' + request.method);
    return Response.json({ jsonrpc: '2.0', id: 1, result: results[request.method] });
  });
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ETHEREUM_TAROT_RPC_URL;
    else process.env.ETHEREUM_TAROT_RPC_URL = previous;
  });
  return { directory, logs, requests,
    read: name => JSON.parse(read(path.join(directory, name), 'utf8')),
    prepare: () => main(['prepare', '--directory', directory, '--quote-signer', quoteSigner]),
    beforeRequest: callback => { beforeRequest = callback; },
  };
}

test('preparation freezes real compiler sources and artifacts and never sends a transaction', async t => {
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'tarot-build-test-'));
  t.after(() => fs.rmSync(build, { recursive: true, force: true }));
  execFileSync('forge', ['build', '--offline', 'src/TarotCards.sol', '--out', path.join(build, 'out'),
    '--cache-path', path.join(build, 'cache')], { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'pipe', timeout: 30_000 });
  const artifact = JSON.parse(fs.readFileSync(path.join(build, 'out/TarotCards.sol/TarotCards.json'), 'utf8'));
  const f = fixture(t, {}, artifact);
  await f.prepare();
  const manifest = f.read('manifest.json');
  assert.equal(manifest.chainId, 11155111);
  assert.equal(manifest.quoteSigner, quoteSigner);
  assert.equal(manifest.network, 'sepolia');
  assert.equal(manifest.creationCode, artifact.bytecode.object + manifest.constructorArgs.slice(2));
  assert.deepEqual(f.read('TarotCards.artifact.json'), artifact);
  assert.equal(f.read('TarotCards.standard-input.json').sources['src/TarotCards.sol'].content,
    fs.readFileSync(new URL('../src/TarotCards.sol', import.meta.url), 'utf8'));
  assert.equal(fs.statSync(path.join(f.directory, 'manifest.json')).mode & 0o777, 0o600);
  assert.equal(f.requests.some(request => request.method === 'eth_sendRawTransaction'), false);
  assert.equal(f.logs[0].prepared, true);
  await assert.rejects(f.prepare(), /already contains a release/);
  manifest.baseURI = 'https://cdn.mons.shop/tarot-mainnet/v1/';
  fs.writeFileSync(path.join(f.directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(main(['verify', '--directory', f.directory]), /Unexpected deployment baseURI/);
});

test('mainnet and unsafe credential arguments fail before any RPC operation', async t => {
  const f = fixture(t);
  await assert.rejects(main(['prepare', '--network', 'mainnet', '--directory', f.directory, '--quote-signer', quoteSigner]), /Sepolia only/);
  for (const option of ['--private-key', '--password', '--rpc-url']) {
    await assert.rejects(main(['sign', '--directory', f.directory, option, 'never-accepted']), /Invalid or repeated option/);
  }
  assert.equal(f.requests.length, 0);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

for (const chainId of ['0x1', true, 11155111, null]) {
  test(`wrong or malformed RPC chain ${JSON.stringify(chainId)} cannot prepare files`, async t => {
    const f = fixture(t, { eth_chainId: chainId });
    await assert.rejects(f.prepare(), /selected deployment network|Invalid RPC chain ID/);
    assert.deepEqual(f.requests.map(request => request.method), ['eth_chainId']);
    assert.deepEqual(fs.readdirSync(f.directory), []);
  });
}

test('insufficient deployment funds cannot create a frozen release', async t => {
  const f = fixture(t, { eth_getBalance: '0x0' });
  await assert.rejects(f.prepare(), /Insufficient deployer funds/);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('one preparation owns the release before RPC and excludes preparation, signing, broadcasting and verification', async t => {
  const f = fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.beforeRequest(async request => {
    if (request.method === 'eth_estimateGas') { entered.resolve(); await release.promise; }
  });
  const first = f.prepare();
  try {
    await entered.promise;
    const count = f.requests.length;
    for (const command of ['prepare', 'sign', 'broadcast', 'verify']) {
      await assert.rejects(main([command, '--directory', f.directory,
        ...(command === 'prepare' ? ['--quote-signer', '0x3333333333333333333333333333333333333333'] : [])]),
      /Another metadata operation owns/);
      assert.equal(f.requests.length, count);
      assert.deepEqual(fs.readdirSync(f.directory), ['operation.lock']);
    }
  } finally { release.resolve(); await first; }
  assert.equal(f.read('manifest.json').quoteSigner, quoteSigner);
  assert.equal(fs.existsSync(path.join(f.directory, 'operation.lock')), false);
  assert.equal(fs.readdirSync(f.directory).some(name => name.startsWith('.operation.lock-')), false);
  assert.equal(f.logs.filter(log => log.prepared).length, 1);
});

test('an existing journal prevents preparation before RPC without replacing any release evidence', async t => {
  const f = fixture(t);
  const journal = '{"existing":"journal must remain unchanged"}\n';
  const artifact = '{"existing":"artifact must remain unchanged"}\n';
  fs.writeFileSync(path.join(f.directory, 'transactions.private.json'), journal, { mode: 0o600 });
  fs.writeFileSync(path.join(f.directory, 'TarotCards.artifact.json'), artifact, { mode: 0o600 });
  await assert.rejects(f.prepare(), /already contains a release/);
  assert.equal(f.requests.length, 0);
  assert.equal(fs.readFileSync(path.join(f.directory, 'transactions.private.json'), 'utf8'), journal);
  assert.equal(fs.readFileSync(path.join(f.directory, 'TarotCards.artifact.json'), 'utf8'), artifact);
  assert.equal(fs.existsSync(path.join(f.directory, 'operation.lock')), false);
});

for (const command of ['sign', 'broadcast', 'verify']) {
  test(`${command} holds exclusive ownership before loading the rest of the release and releases it after failure`, async t => {
    const f = fixture(t);
    await f.prepare();
    const files = new Map(fs.readdirSync(f.directory).map(name => [name, fs.readFileSync(path.join(f.directory, name), 'utf8')]));
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    f.beforeRequest(async request => {
      assert.equal(request.method, 'eth_chainId');
      entered.resolve();
      await release.promise;
      throw new Error('Fixture stops inside protected operation');
    });
    const first = main([command, '--directory', f.directory]).catch(error => error);
    try {
      await entered.promise;
      const count = f.requests.length;
      for (const contender of ['sign', 'broadcast', 'verify']) {
        await assert.rejects(main([contender, '--directory', f.directory]), /Another metadata operation owns/);
        assert.equal(f.requests.length, count);
      }
    } finally { release.resolve(); }
    assert.match((await first).message, /Fixture stops inside protected operation/);
    assert.deepEqual(fs.readdirSync(f.directory).sort(), [...files.keys()].sort());
    for (const [name, content] of files) assert.equal(fs.readFileSync(path.join(f.directory, name), 'utf8'), content);
    f.beforeRequest(undefined);
    await assert.rejects(main(['sign', '--directory', f.directory]), /Signing requires/);
    assert.equal(fs.existsSync(path.join(f.directory, 'operation.lock')), false);
  });
}

function ownerLock(directory, owner) {
  const lock = path.join(directory, 'operation.lock');
  fs.mkdirSync(lock, { mode: 0o700 });
  const marker = path.join(lock, `${owner.id}.json`);
  fs.writeFileSync(marker, JSON.stringify(owner), { mode: 0o600 });
  return { lock, marker, body: fs.readFileSync(marker, 'utf8') };
}

test('a crashed local owner can be recovered without changing existing signed state', async t => {
  const f = fixture(t);
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  assert.throws(() => process.kill(exited.pid, 0), { code: 'ESRCH' });
  ownerLock(f.directory, { id: randomUUID(), pid: exited.pid, host: os.hostname() });
  const journal = '{"existing":"signed release"}\n';
  fs.writeFileSync(path.join(f.directory, 'transactions.private.json'), journal, { mode: 0o600 });
  await assert.rejects(f.prepare(), /already contains a release/);
  assert.equal(fs.readFileSync(path.join(f.directory, 'transactions.private.json'), 'utf8'), journal);
  assert.deepEqual(fs.readdirSync(f.directory), ['transactions.private.json']);
  assert.equal(f.requests.length, 0);
});

test('a crashed local preparation recovers its lock and completes using a fresh owner', async t => {
  const f = fixture(t);
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  assert.throws(() => process.kill(exited.pid, 0), { code: 'ESRCH' });
  const owner = { id: randomUUID(), pid: exited.pid, host: os.hostname() };
  const lock = ownerLock(f.directory, owner);
  f.beforeRequest(() => {
    const markers = fs.readdirSync(lock.lock);
    assert.equal(markers.length, 1);
    assert.notEqual(markers[0], `${owner.id}.json`);
    const current = JSON.parse(fs.readFileSync(path.join(lock.lock, markers[0]), 'utf8'));
    assert.equal(current.pid, process.pid);
    assert.equal(current.host, os.hostname());
  });
  await f.prepare();
  assert.equal(f.read('manifest.json').quoteSigner, quoteSigner);
  assert.equal(fs.existsSync(lock.lock), false);
});

for (const kind of ['live', 'foreign-host', 'invalid-pid', 'mismatched-marker']) {
  test(`a ${kind} release owner cannot be stolen or deleted`, async t => {
    const f = fixture(t);
    const owner = { id: randomUUID(), pid: process.pid, host: os.hostname() };
    if (kind === 'foreign-host') owner.host += '-other';
    if (kind === 'invalid-pid') owner.pid = 0;
    const lock = ownerLock(f.directory, owner);
    if (kind === 'mismatched-marker') {
      fs.writeFileSync(lock.marker, JSON.stringify({ ...owner, id: randomUUID() }));
      lock.body = fs.readFileSync(lock.marker, 'utf8');
    }
    await assert.rejects(f.prepare(), /Another metadata operation owns/);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(fs.readdirSync(f.directory), ['operation.lock']);
    assert.equal(fs.readFileSync(lock.marker, 'utf8'), lock.body);
  });
}

test('legacy or unreadable locks fail closed without deleting their contents', async t => {
  const f = fixture(t);
  const filename = path.join(f.directory, 'operation.lock');
  fs.writeFileSync(filename, 'unknown owner');
  await assert.rejects(f.prepare(), /Legacy or invalid metadata lock/);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'unknown owner');
  fs.unlinkSync(filename);
  fs.mkdirSync(filename);
  const marker = path.join(filename, `${randomUUID()}.json`);
  fs.writeFileSync(marker, '{incomplete');
  await assert.rejects(f.prepare(), /Unreadable metadata lock/);
  assert.equal(fs.readFileSync(marker, 'utf8'), '{incomplete');
  assert.equal(f.requests.length, 0);
});

test('release locks stay inside private release directories', async t => {
  const f = fixture(t);
  fs.chmodSync(f.directory, 0o755);
  await assert.rejects(f.prepare(), /Release directory must be private/);
  assert.deepEqual(fs.readdirSync(f.directory), []);
  assert.equal(f.requests.length, 0);
  const trackedDirectory = fileURLToPath(new URL('../scripts', import.meta.url));
  await assert.rejects(main(['prepare', '--directory', trackedDirectory, '--quote-signer', quoteSigner]), /private ignored directory/);
  assert.equal(fs.existsSync(path.join(trackedDirectory, 'operation.lock')), false);
});
