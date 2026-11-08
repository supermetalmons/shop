import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decode } from '@metamask/abi-utils';
import {
  NFT111K_SEPOLIA, confirm111kTransaction, nft111kAction, nft111kDeploymentGas,
  parse111kDeploymentArgs, resolve111kPredecessor, run111kDeployment, run111kReplacementFinalization, validateSigned111kTransaction,
} from './111k-deployment.mjs';
import { load111kVerification, verify111kDeployment } from './111k-verification.mjs';
import { record111kReleaseLocation } from '../../../scripts/shared/ethereum111kReleaseLocations.ts';

const reservationArgs = ['--reserved-relics', '18', '--relic-reservation-value-wei', '18000000000000000'];

const project = fileURLToPath(new URL('../', import.meta.url));
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const hex = value => `0x${BigInt(value).toString(16)}`;
const cast = args => {
  try { return execFileSync('cast', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) { throw new Error(`Cast ${args[0]}: ${String(error.stderr).trim()}`); }
};
const transactionHash = `0x${'11'.repeat(32)}`;
const blockHash = `0x${'22'.repeat(32)}`;
const configuration = () => ({ ...NFT111K_SEPOLIA, contractAddress: `0x${'ab'.repeat(20)}`, creationCode: '0x60006000f3' });

function signedFixture(action = 'reserve') {
  const manifest = configuration();
  const record = { action, chainId: 11155111, from: manifest.deployer, ...nft111kAction(manifest, action),
    nonce: '7', gasEstimate: '100000', gasLimit: '200000', gasPrice: '1000', maximumFeeWei: '200000000',
    hash: transactionHash, raw: '0x01', signedAt: '2026-11-07T00:00:00.000Z' };
  const transaction = { signer: manifest.deployer, from: manifest.deployer, type: '0x0', chainId: hex(11155111),
    nonce: hex(record.nonce), gas: hex(record.gasLimit), gasPrice: hex(record.gasPrice), to: record.to,
    value: hex(record.valueWei), input: record.data, hash: record.hash };
  const receipt = { transactionHash, blockNumber: '0x64', blockHash, status: '0x1', from: record.from,
    to: record.to, contractAddress: action === 'deploy' ? manifest.contractAddress : null, logs: [] };
  return { manifest, record, transaction, receipt };
}

test('the deployment runner admits only explicit Sepolia operations', () => {
  assert.equal(NFT111K_SEPOLIA.chainId, 11155111);
  assert.equal(NFT111K_SEPOLIA.previousContract, '0xe665d1043f72886f49894006ea196450b33f0f89');
  assert.throws(() => parse111kDeploymentArgs(['prepare']), /explicit fresh --deployment-id/);
  assert.equal(parse111kDeploymentArgs(['prepare', ...reservationArgs, '--deployment-id', 'v99']).directory, path.join(project, '.local', '111k-sepolia-v99'));
  assert.ok(parse111kDeploymentArgs(['prepare', ...reservationArgs, '--network', 'sepolia', '--deployment-id', 'runner-test', '--directory', '/tmp/runner-test']));
  assert.equal(parse111kDeploymentArgs(['finalize', '--directory', '/tmp/runner-test']).command, 'finalize');
  for (const argv of [
    ['prepare', ...reservationArgs, '--network', 'mainnet'], ['prepare', ...reservationArgs, '--network', '1'], ['refund'], ['withdraw'], ['release-all'],
    ['prepare', ...reservationArgs, '--deployment-id', '../escape'], ['prepare', '--unknown'],
    ['verify', '--previous-directory', '/tmp/old-release'],
  ]) assert.throws(() => parse111kDeploymentArgs(argv));
});

test('new releases require explicit bounded reservation settings only during prepare', () => {
  assert.throws(() => parse111kDeploymentArgs(['prepare', '--deployment-id', 'new']), /explicit --reserved-relics/);
  const args = ['prepare', '--deployment-id', 'new', '--reserved-relics', '3', '--relic-reservation-value-wei', '101'];
  assert.deepEqual(parse111kDeploymentArgs(args).relicReservation, { quantity: 3, valueWei: '101' });
  assert.deepEqual(parse111kDeploymentArgs(['prepare', '--deployment-id', 'new', '--reserved-relics', '0', '--relic-reservation-value-wei', '0']).relicReservation,
    { quantity: 0, valueWei: '0' });
  for (const invalid of [
    ['prepare', '--deployment-id', 'new', '--reserved-relics', '19', '--relic-reservation-value-wei', '0'],
    ['prepare', '--deployment-id', 'new', '--reserved-relics', '0', '--relic-reservation-value-wei', '1'],
    ['prepare', '--deployment-id', 'new', '--reserved-relics', '1'],
    ['open', ...reservationArgs],
  ]) assert.throws(() => parse111kDeploymentArgs(invalid));
});

test('the predecessor resolver matches live and repository identity even while the storefront is paused', async () => {
  const configured = { chainId: '11155111', contractAddress: `0x${'98'.repeat(20)}`,
    metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/v98/' };
  const readConfiguration = async () => configured;
  const resolved = await resolve111kPredecessor({ readConfiguration,
    readLiveConfiguration: async () => ({ ...configured, chainId: 11155111, enabled: false }) });
  assert.deepEqual(resolved, { ...configured, chainId: 11155111, deploymentId: 'v98' });
  for (const change of [{ chainId: 1 }, { contractAddress: `0x${'97'.repeat(20)}` },
    { metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/v97/' }]) {
    await assert.rejects(resolve111kPredecessor({ readConfiguration, readLiveConfiguration: async () => ({ ...configured, ...change }) }));
  }
});

test('preparation refuses a directory containing signing material or unrelated files', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '111k-occupied-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const wallet = path.join(directory, 'wallet.json');
  fs.writeFileSync(wallet, JSON.stringify({ crypto: { ciphertext: 'protected' } }));
  await assert.rejects(run111kDeployment(['prepare', ...reservationArgs, '--deployment-id', 'new-release', '--directory', directory], {
    rpc: async method => { assert.equal(method, 'eth_chainId'); return '0xaa36a7'; },
    resolvePredecessor: async () => { throw new Error('Must reject occupied directory before resolving ownership'); },
  }), /fresh release directory/);
  assert.equal(JSON.parse(fs.readFileSync(wallet, 'utf8')).crypto.ciphertext, 'protected');
  assert.equal(fs.existsSync(path.join(directory, 'manifest.json')), false);
});

test('replacement finalization reads its bound completion journal instead of subprocess output', t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), '111k-finalization-result-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifest = { chainId: 11155111, deploymentId: 'next', contractAddress: `0x${'33'.repeat(20)}`,
    previousContract: `0x${'22'.repeat(20)}`, metadataBaseURI: 'https://cdn.mons.shop/111k-sepolia/next/' };
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(directory, 'manifest.json'), body);
  const journalPath = path.join(directory, 'cleanup-finalization.json');
  const journal = { version: 2, kind: '111k-replacement-cleanup', complete: true,
    release: { ...manifest, releaseDirectory: directory, metadataBaseUri: manifest.metadataBaseURI,
      manifestSha256: createHash('sha256').update(body).digest('hex') },
    oldDeployment: { deploymentId: 'old', contractAddress: manifest.previousContract },
    newDeployment: { contractAddress: manifest.contractAddress }, artifacts: { report: { complete: true } },
    metadataDeletedAtMs: 1_000, verifiedAtMs: 301_000 };
  const save = value => fs.writeFileSync(journalPath, JSON.stringify(value));
  save(journal);
  const execute = (file, args, options) => {
    assert.equal(file, process.execPath);
    assert.deepEqual(args, ['--import', 'tsx', 'scripts/ops/cleanupEthereum111k.ts', 'finalize', '--release-directory', directory, '--write']);
    assert.deepEqual(options.stdio, ['ignore', 'ignore', 'inherit']);
    return '⎔ Establishing remote connection...\n{"complete":true}\n';
  };
  assert.equal(run111kReplacementFinalization({ releaseDirectory: directory }, execute).complete, true);
  for (const change of [{ complete: false }, { kind: 'other' }, { version: 1 }, { verifiedAtMs: 300_000 },
    { release: { ...journal.release, manifestSha256: '0'.repeat(64) } },
    { release: { ...journal.release, previousContract: manifest.contractAddress } },
    { artifacts: { report: { complete: false } } }]) {
    save({ ...journal, ...change });
    assert.throws(() => run111kReplacementFinalization({ releaseDirectory: directory }, execute));
  }
  save(journal);
  assert.throws(() => run111kReplacementFinalization({ releaseDirectory: directory }, () => { throw new Error('Child failed'); }), /Child failed/);
});

test('the npm deployment command cannot invoke the reservation deployment as a prehook', t => {
  const scripts = json(path.join(project, 'package.json')).scripts;
  assert.equal(scripts['nft111k:deploy'], 'node scripts/111k-deployment.mjs');
  assert.equal(scripts['pre111k:deploy'], 'node scripts/pre111k-deployment.mjs');
  assert.equal(scripts['111k:deploy'], undefined);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '111k-command-route-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ private: true,
    scripts: Object.fromEntries(Object.keys(scripts).map(name => [name, 'node route.mjs'])) }));
  fs.writeFileSync(path.join(directory, 'route.mjs'), "process.stdout.write(process.env.npm_lifecycle_event + '\\n');\n");
  const output = execFileSync('npm', ['run', '--silent', 'nft111k:deploy'], { cwd: directory, encoding: 'utf8' });
  assert.equal(output.trim(), 'nft111k:deploy');
});

test('action payloads fix the reservation deposit and separate old and new collection targets', () => {
  const manifest = configuration();
  assert.deepEqual(nft111kAction(manifest, 'deploy'), { to: null, data: manifest.creationCode, valueWei: '0' });
  assert.deepEqual(nft111kAction(manifest, 'reserve'), {
    to: manifest.contractAddress, data: cast(['calldata', 'allocateRelics(uint256)', '18']), valueWei: '18000000000000000',
  });
  assert.deepEqual(nft111kAction(manifest, 'pause-old-sale'), {
    to: manifest.previousContract, data: cast(['calldata', 'setSaleActive(bool)', 'false']), valueWei: '0',
  });
  assert.deepEqual(nft111kAction(manifest, 'pause-old-redemptions'), {
    to: manifest.previousContract, data: cast(['calldata', 'setRedemptionsPaused(bool)', 'true']), valueWei: '0',
  });
  assert.deepEqual(nft111kAction(manifest, 'open'), {
    to: manifest.contractAddress, data: cast(['calldata', 'setSaleActive(bool)', 'true']), valueWei: '0',
  });
  assert.deepEqual(nft111kAction(manifest, 'mint-qa'), {
    to: manifest.contractAddress, data: cast(['calldata', 'mintCrates(uint256)', '1']), valueWei: '100000000000000',
  });
  for (const action of ['refund', 'withdraw', 'releaseAllMint', 'mainnet']) assert.throws(() => nft111kAction(manifest, action));
  assert.throws(() => nft111kAction(manifest, 'unpack-qa'), /mint|receipt/i);
});

test('reservation transactions use frozen quantities and values without altering legacy interpretation', () => {
  const manifest = { ...configuration(), relicReservation: { quantity: 7, valueWei: '123' } };
  assert.deepEqual(nft111kAction(manifest, 'reserve'), {
    to: manifest.contractAddress, data: cast(['calldata', 'allocateRelics(uint256)', '7']), valueWei: '123',
  });
  manifest.relicReservation = { quantity: 0, valueWei: '0' };
  assert.throws(() => nft111kAction(manifest, 'reserve'), /verified skip/);
  delete manifest.relicReservation;
  assert.equal(nft111kAction(manifest, 'reserve').valueWei, '18000000000000000');
});

test('QA unpack derives its one crate from the matching paid mint event', () => {
  const manifest = configuration();
  const event = { address: manifest.contractAddress,
    topics: [cast(['keccak', 'CratesPurchased(address,uint256,uint256,uint256)']), `0x${manifest.deployer.slice(2).padStart(64, '0')}`],
    data: cast(['abi-encode', 'f(uint256,uint256,uint256)', '113110', '1', '100000000000000']) };
  const receipt = { status: '0x1', from: manifest.deployer, to: manifest.contractAddress, logs: [event] };
  assert.deepEqual(nft111kAction(manifest, 'unpack-qa', receipt), {
    to: manifest.contractAddress, data: cast(['calldata', 'unboxCrate(uint256)', '113110']), valueWei: '0',
  });
  for (const invalid of [
    { ...receipt, status: '0x0' }, { ...receipt, from: `0x${'77'.repeat(20)}` },
    { ...receipt, to: manifest.previousContract }, { ...receipt, logs: [] }, { ...receipt, logs: [event, event] },
    { ...receipt, logs: [{ ...event, address: manifest.previousContract }] },
    { ...receipt, logs: [{ ...event, topics: [event.topics[0], `0x${'77'.repeat(32)}`] }] },
    ...[['111111', '1', '100000000000000'], ['116667', '1', '100000000000000'],
      ['113110', '2', '100000000000000'], ['113110', '1', '0']].map(values => ({
      ...receipt, logs: [{ ...event, data: cast(['abi-encode', 'f(uint256,uint256,uint256)', ...values]) }],
    })),
  ]) assert.throws(() => nft111kAction(manifest, 'unpack-qa', invalid));
});

test('gas budgets include a margin and reject fees beyond the Sepolia ceiling', () => {
  const gas = nft111kDeploymentGas('100001', '1000');
  assert.ok(BigInt(gas.gasLimit) > 100001n);
  assert.ok(BigInt(gas.gasPrice) >= 1000n);
  assert.equal(BigInt(gas.maximumFeeWei), BigInt(gas.gasLimit) * BigInt(gas.gasPrice));
  assert.throws(() => nft111kDeploymentGas('10000000', '1000000000000000'), /fee|ceiling/i);
  assert.throws(() => nft111kDeploymentGas('0', '1'));
  assert.throws(() => nft111kDeploymentGas('1', '0'));
});

for (const action of ['deploy', 'reserve', 'pause-old-sale', 'pause-old-redemptions', 'open', 'mint-qa']) {
  test(`signed ${action} cannot change signer, chain, nonce, target, value, calldata or fee`, () => {
    const { manifest, record, transaction } = signedFixture(action);
    validateSigned111kTransaction(transaction, manifest, record, record.hash);
    const mutations = {
      signer: `0x${'77'.repeat(20)}`, type: '0x2', chainId: '0x1', nonce: '0x8',
      gas: hex(BigInt(record.gasLimit) + 1n), gasPrice: hex(BigInt(record.gasPrice) + 1n),
      to: action === 'deploy' ? manifest.contractAddress : `0x${'88'.repeat(20)}`,
      value: hex(BigInt(record.valueWei) + 1n), input: `${record.data}00`, hash: `0x${'99'.repeat(32)}`,
    };
    for (const [field, value] of Object.entries(mutations)) {
      assert.throws(() => validateSigned111kTransaction({ ...transaction, [field]: value }, manifest, record, record.hash), field);
    }
    const redirected = { ...record, to: `0x${'88'.repeat(20)}`, data: '0x', valueWei: '1' };
    assert.throws(() => validateSigned111kTransaction({ ...transaction, to: redirected.to, input: redirected.data, value: '0x1' },
      manifest, redirected, record.hash));
  });
}

function confirmationFixture(action = 'reserve') {
  const f = signedFixture(action);
  const state = { receipt: f.receipt, transaction: f.transaction, latest: '0x66', canonical: blockHash };
  const requests = [];
  const rpc = async (method, params = []) => {
    requests.push({ method, params });
    if (method === 'eth_chainId') return hex(11155111);
    if (method === 'eth_getTransactionReceipt') return state.receipt;
    if (method === 'eth_getTransactionByHash') return state.transaction;
    if (method === 'eth_getBlockByNumber') return params[0] === 'latest' ? { number: state.latest, hash: `0x${'66'.repeat(32)}` }
      : { number: '0x64', hash: state.canonical };
    assert.fail(`Unexpected confirmation RPC ${method}`);
  };
  return { ...f, state, requests, rpc };
}

test('confirmation requires three blocks and a matching canonical receipt', async () => {
  const f = confirmationFixture();
  assert.deepEqual(await confirm111kTransaction(f.rpc, f.record, { sleep: async () => {}, maxReceiptPolls: 1 }), f.receipt);
  f.state.latest = '0x65';
  await assert.rejects(confirm111kTransaction(f.rpc, f.record, { sleep: async () => {}, maxReceiptPolls: 1 }), /confirm|wait|pending/i);
  f.state.latest = '0x66';
  f.state.canonical = `0x${'77'.repeat(32)}`;
  await assert.rejects(confirm111kTransaction(f.rpc, f.record, { sleep: async () => {}, maxReceiptPolls: 1 }), /canonical|reorg/i);
});

test('confirmation rejects reverted receipts and transactions outside the journaled scope', async () => {
  const receiptMutations = { status: '0x0', transactionHash: `0x${'77'.repeat(32)}`,
    from: `0x${'77'.repeat(20)}`, to: `0x${'88'.repeat(20)}` };
  for (const [field, value] of Object.entries(receiptMutations)) {
    const f = confirmationFixture();
    f.state.receipt = { ...f.receipt, [field]: value };
    await assert.rejects(confirm111kTransaction(f.rpc, f.record, { sleep: async () => {}, maxReceiptPolls: 1 }), undefined, field);
  }
  for (const [field, value] of Object.entries({ chainId: '0x1', nonce: '0x8', value: '0x0', input: '0x', to: `0x${'88'.repeat(20)}` })) {
    const f = confirmationFixture();
    f.state.transaction = { ...f.transaction, [field]: value };
    await assert.rejects(confirm111kTransaction(f.rpc, f.record, { sleep: async () => {}, maxReceiptPolls: 1 }), undefined, field);
  }
  const deployment = confirmationFixture('deploy');
  deployment.record.contractAddress = deployment.manifest.contractAddress;
  deployment.state.receipt = { ...deployment.receipt, contractAddress: `0x${'88'.repeat(20)}` };
  await assert.rejects(confirm111kTransaction(deployment.rpc, deployment.record, { sleep: async () => {}, maxReceiptPolls: 1 }), /deployed contract/);
});

test('preparation rejects the wrong RPC chain before creating deployment artifacts', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '111k-wrong-chain-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const chainId of ['0x1', '0x7a69', null, true, 11155111]) {
    const requests = [];
    await assert.rejects(run111kDeployment(['prepare', ...reservationArgs, '--network', 'sepolia', '--deployment-id', 'runner-wrong-chain', '--directory', directory], {
      rpc: async method => { requests.push(method); return chainId; },
    }), /chain|Sepolia|network/i);
    assert.deepEqual(requests, ['eth_chainId']);
    assert.deepEqual(fs.readdirSync(directory), []);
  }
});

async function anvilFixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), '111k-runner-test-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const port = await new Promise((done, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('No local Anvil port')); return; }
      server.close(error => error ? reject(error) : done(address.port));
    });
  });
  const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '11155111',
    '--hardfork', 'prague', '--base-fee', '0', '--gas-price', '1000', '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let failure = '';
  anvil.stderr.on('data', data => { failure += String(data); });
  anvil.on('error', error => { failure += error.message; });
  t.after(async () => {
    if (anvil.exitCode === null && anvil.pid) {
      const stopped = once(anvil, 'exit');
      anvil.kill('SIGTERM');
      await stopped;
    }
  });
  let requestId = 0;
  const rpc = async (method, params = []) => {
    const response = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }), signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error(body.error?.message || `RPC HTTP ${response.status}`);
    return body.result;
  };
  for (let attempt = 0; ; attempt++) {
    try { await rpc('eth_chainId'); break; }
    catch {
      if (attempt > 100 || anvil.exitCode !== null || failure) throw new Error(`Anvil failed: ${failure}`);
      await new Promise(done => setTimeout(done, 20));
    }
  }
  const [owner] = await rpc('eth_accounts');
  const privateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const signingCast = args => {
    if (args[0] === 'wallet' && args[1] === 'address') return owner;
    if (args[0] !== 'mktx') return cast(args);
    const filtered = args.filter((value, index) => !['--keystore', '--password-file'].includes(value)
      && !['--keystore', '--password-file'].includes(args[index - 1]));
    return cast([filtered[0], '--private-key', privateKey, ...filtered.slice(1)]);
  };
  return { directory, rpc, owner, cast: signingCast };
}

test('the journaled Sepolia lifecycle resumes interruptions and rejects stale unpack retries on Anvil', { timeout: 120_000 }, async t => {
  const f = await anvilFixture(t);
  t.mock.method(console, 'log', () => {});
  const proceeds = json(path.join(project, 'config/proceeds.json'));
  const artifact = json(path.join(project, 'out/NFT111K.sol/NFT111K.json'));
  const constructorTypes = ['address', 'address', 'address', 'string', 'bytes32', 'address[]', 'uint256[]',
    '(address,uint16,uint16,uint16)[]', 'uint256'];
  const initialReceiver = '0x5555555555555555555555555555555555555555';
  const oldArguments = cast(['abi-encode', `constructor(${constructorTypes.join(',')})`, f.owner,
    NFT111K_SEPOLIA.quoteSigner, initialReceiver, 'https://cdn.mons.shop/111k-sepolia/v98/', `0x${'0'.repeat(64)}`,
    `[${proceeds.mintRecipients.join(',')}]`, `[${proceeds.mintSharesBps.join(',')}]`, '[]', '5555']);
  const send = async (to, data, value = '0x0', from = f.owner) => {
    const transaction = { from, ...(to ? { to } : {}), data, value };
    const hash = await f.rpc('eth_sendTransaction', [{ ...transaction, gas: await f.rpc('eth_estimateGas', [transaction]) }]);
    let receipt;
    for (let attempt = 0; attempt < 200; attempt++) {
      receipt = await f.rpc('eth_getTransactionReceipt', [hash]);
      if (receipt) break;
      await new Promise(done => setTimeout(done, 25));
    }
    assert.ok(receipt, 'The local Anvil transaction receipt did not arrive');
    assert.equal(receipt.status, '0x1');
    return receipt;
  };
  const old = await send(null, artifact.bytecode.object + oldArguments.slice(2));
  await send(old.contractAddress, cast(['calldata', 'setSaleActive(bool)', 'true']));
  const oldDirectory = path.join(f.directory, 'custom-old-release');
  fs.mkdirSync(oldDirectory, { mode: 0o700 });
  fs.writeFileSync(path.join(oldDirectory, 'manifest.json'), JSON.stringify({ version: 1, network: 'sepolia',
    chainId: 11155111, deploymentId: 'v98', contractAddress: old.contractAddress,
    metadataBaseURI: 'https://cdn.mons.shop/111k-sepolia/v98/' }));
  const releaseLocationOptions = { registryDirectory: path.join(f.directory, 'locations') };
  const oldLocation = await record111kReleaseLocation(oldDirectory, { chainId: 11155111, deploymentId: 'v98',
    contractAddress: old.contractAddress, metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/v98/' }, releaseLocationOptions);
  const releaseDirectory = path.join(f.directory, 'release');
  const alias = path.join(f.directory, 'root-alias');
  fs.symlinkSync(f.directory, alias, 'dir');
  const manifestPath = path.join(releaseDirectory, 'manifest.json');
  const journalPath = path.join(releaseDirectory, 'transactions.private.json');
  const baseArgs = ['--network', 'sepolia', '--directory', path.join(alias, 'release')];
  let sends = 0;
  const cleanupCalls = [];
  let cleanupOutcome = 'failure';
  let loseResponse = true;
  let interruptBeforeBroadcast = false;
  const injectedRpc = async (method, params = []) => {
    if (method === 'eth_gasPrice') return '0x3e8';
    if (method !== 'eth_sendRawTransaction') return f.rpc(method, params);
    const journal = json(journalPath);
    assert.ok(Object.values(journal.actions).some(record => record.raw === params[0] && record.hash),
      'The complete signed transaction must be durable before broadcasting');
    if (interruptBeforeBroadcast) {
      interruptBeforeBroadcast = false;
      throw new Error('Simulated interruption before broadcast');
    }
    sends++;
    const hash = await f.rpc(method, params);
    await f.rpc('anvil_mine', [2]);
    if (loseResponse) { loseResponse = false; throw new Error('Simulated lost broadcast response'); }
    return hash;
  };
  const overrides = { configuration: { deployer: f.owner, owner: f.owner }, releaseLocationOptions,
    rpc: injectedRpc, cast: f.cast, sleep: async () => {}, maxReceiptPolls: 2,
    resolvePredecessor: async () => ({ chainId: 11155111, contractAddress: old.contractAddress,
      metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/v98/' }),
    cleanupReplacement: async options => {
      assert.deepEqual(options, { releaseDirectory });
      assert.ok(json(journalPath).actions.open?.receipt, 'Opening must be journaled before cleanup');
      cleanupCalls.push(options);
      if (cleanupOutcome === 'failure') throw new Error('Fixture cleanup interruption');
      return { complete: cleanupOutcome === 'complete' };
    } };
  const invoke = action => run111kDeployment([action, ...baseArgs, '--keystore', 'fixture-keystore', '--password-file', 'fixture-password'], overrides);
  const startingNonce = BigInt(await f.rpc('eth_getTransactionCount', [f.owner, 'latest']));
  await assert.rejects(run111kDeployment(['prepare', ...reservationArgs, ...baseArgs, '--deployment-id', 'v99',
    '--previous-contract', NFT111K_SEPOLIA.previousContract], overrides), /Explicit predecessor/);
  await assert.rejects(run111kDeployment(['prepare', ...reservationArgs, ...baseArgs, '--deployment-id', 'v98'], overrides), /must differ/);
  await run111kDeployment(['prepare', ...reservationArgs, ...baseArgs, '--deployment-id', 'v99'], overrides);
  overrides.resolvePredecessor = async () => { throw new Error('Frozen release resumes must not resolve current predecessor'); };
  const manifest = json(manifestPath);
  assert.equal(manifest.previousContract, old.contractAddress);
  assert.equal(manifest.previousReleaseDirectory, oldLocation.directory);
  assert.equal(manifest.previousReleaseManifestSha256, oldLocation.manifestSha256);
  assert.equal(json(path.join(releaseLocationOptions.registryDirectory, 'v99.json')).directory, releaseDirectory);
  const args = decode(constructorTypes, manifest.constructorArgs);
  assert.equal(args[0], f.owner.toLowerCase());
  assert.equal(args[1], NFT111K_SEPOLIA.quoteSigner);
  assert.equal(args[2], initialReceiver);
  assert.equal(args[3], 'https://cdn.mons.shop/111k-sepolia/v99/');
  assert.deepEqual(args[5], proceeds.mintRecipients.map(address => address.toLowerCase()));
  assert.equal(args[5].length, 14);
  assert.deepEqual(args[6], [2750n, 2600n, 500n, 500n, 500n, 500n, 100n, 100n, 100n, 100n, 500n, 583n, 583n, 584n]);
  assert.deepEqual(args[7], [
    ['0xe26067c76fdbe877f48b0a8400cf5db8b47af0fe', 0n, 0n, 3n],
    ['0xe4790dd79c334e3f848904975272ec17f9f70366', 0n, 0n, 3n],
    ['0xe938ebb66b92692ab01f76c99cfac1928482e7b9', 0n, 0n, 3n],
    ['0x29f7a2cfe212492ddb343035479d062112284ddf', 0n, 0n, 3n],
    ['0x31cd63c73e74808793f134f8146a1e3aa1637b5d', 0n, 0n, 2n],
    ['0xf743b8e23d3ffcbde398aba9b9f83a98f56845f4', 0n, 0n, 2n],
    ['0x336c8e2add19149bfc934fb2557c6bdeffa8009b', 0n, 0n, 2n],
  ]);
  assert.equal(args[8], 5555n);
  assert.equal(BigInt(manifest.nonce), startingNonce);
  const beforeNonceAdvance = await f.rpc('evm_snapshot');
  await send(f.owner, '0x');
  await assert.rejects(invoke('deploy'), /nonce/i);
  assert.equal(sends, 0);
  assert.equal(await f.rpc('evm_revert', [beforeNonceAdvance]), true);
  try { await invoke('deploy'); }
  catch (error) { assert.match(error.message, /Simulated lost broadcast response/); }
  const signed = json(journalPath).actions.deploy;
  assert.ok(signed.raw && signed.hash);
  await invoke('deploy');
  await invoke('deploy');
  assert.equal(sends, 1);
  assert.equal(BigInt(await f.rpc('eth_getTransactionCount', [f.owner, 'latest'])), startingNonce + 1n);
  assert.equal(json(journalPath).actions.deploy.hash, signed.hash);
  const read = async (address, signature, types = ['uint256'], values = []) => {
    const encoded = await f.rpc('eth_call', [{ to: address, data: cast(['calldata', signature, ...values]) }, 'latest']);
    return decode(types, encoded);
  };
  const token = manifest.contractAddress;
  const verifiedStages = [];
  const verifyStage = async stage => {
    const context = await load111kVerification(releaseDirectory);
    const report = await verify111kDeployment(context, f.rpc, stage);
    assert.equal(report.stage, stage);
    assert.equal(report.runtimeAndImmutablesMatch, true);
    assert.equal(report.runtimeBytes, (artifact.deployedBytecode.object.length - 2) / 2);
    assert.equal(report.mintRecipients.length, 14);
    assert.equal(report.freeMintAllowances.length, 7);
    verifiedStages.push(stage);
    return report;
  };
  assert.deepEqual(await read(token, 'saleActive()', ['bool']), [false]);
  assert.deepEqual(await read(token, 'totalSupply()'), [0n]);
  const closed = await verifyStage('closed');
  assert.equal(closed.totalSupply, 0n);
  assert.equal(closed.totalMintReceived, 0n);
  await invoke('reserve');
  await invoke('reserve');
  assert.equal(sends, 2);
  assert.deepEqual(await read(token, 'relicsAllocated()'), [18n]);
  assert.deepEqual(await read(token, 'relicsMinted()'), [0n]);
  assert.deepEqual(await read(token, 'totalMintReceived()'), [18000000000000000n]);
  assert.deepEqual(await read(token, 'remainingCrates()'), [3557n]);
  const [, otherBuyer] = await f.rpc('eth_accounts');
  const recipientBalances = await Promise.all(args[5].map(recipient => f.rpc('eth_getBalance', [recipient, 'latest'])));
  await send(token, cast(['calldata', 'releaseAllMint()']), '0x0', otherBuyer);
  let released = 0n;
  for (const [index, recipient] of args[5].entries()) {
    const entitlement = 18000000000000000n * args[6][index] / 10000n;
    assert.equal(BigInt(await f.rpc('eth_getBalance', [recipient, 'latest'])) - BigInt(recipientBalances[index]), entitlement);
    assert.deepEqual(await read(token, 'mintReleased(address)', ['uint256'], [recipient]), [entitlement]);
    assert.deepEqual(await read(token, 'releasableMint(address)', ['uint256'], [recipient]), [0n]);
    released += entitlement;
  }
  assert.equal(released, 18000000000000000n);
  assert.deepEqual(await read(token, 'totalMintReceived()'), [18000000000000000n]);
  assert.deepEqual(await read(token, 'totalMintReleased()'), [released]);
  assert.deepEqual(await read(token, 'totalSupply()'), [0n]);
  assert.deepEqual(await read(token, 'relicsAllocated()'), [18n]);
  assert.deepEqual(await read(token, 'getRelicClaimedMask()'), [0n]);
  assert.equal(BigInt(await f.rpc('eth_getBalance', [token, 'latest'])), 0n);
  const reserved = await verifyStage('reserved');
  assert.equal(reserved.totalSupply, 0n);
  assert.equal(reserved.totalMintReceived, 18000000000000000n);
  assert.equal(reserved.totalMintReleased, released);
  assert.equal(reserved.contractBalanceWei, 0n);
  assert.equal(reserved.mintRecipients.reduce((sum, recipient) => sum + recipient.released, 0n), released);
  await assert.rejects(invoke('finalize'), /Confirm sale opening/);
  assert.equal(cleanupCalls.length, 0);
  await assert.rejects(invoke('open'), /previous|old|pause/i);
  await invoke('pause-old');
  await invoke('pause-old');
  assert.equal(sends, 4);
  assert.deepEqual(await read(old.contractAddress, 'saleActive()', ['bool']), [false]);
  assert.deepEqual(await read(old.contractAddress, 'redemptionsPaused()', ['bool']), [true]);
  await assert.rejects(invoke('open'), /Replacement cleanup is incomplete/);
  const durableOpen = structuredClone(json(journalPath).actions.open);
  assert.ok(durableOpen.receipt);
  assert.equal(sends, 5);
  cleanupOutcome = 'incomplete';
  await assert.rejects(invoke('finalize'), /Replacement cleanup is incomplete/);
  assert.equal(sends, 5);
  cleanupOutcome = 'complete';
  const replayedOpen = await invoke('open');
  assert.equal(replayedOpen.cleanup.complete, true);
  assert.equal(replayedOpen.transactions[0].alreadySatisfied, true);
  assert.equal(json(journalPath).actions.open.raw, durableOpen.raw);
  assert.equal(json(journalPath).actions.open.hash, durableOpen.hash);
  await assert.rejects(run111kDeployment(['finalize', ...baseArgs, '--previous-directory', releaseDirectory], overrides),
    /Previous release directory belongs to another contract/);
  fs.unlinkSync(path.join(releaseLocationOptions.registryDirectory, 'v98.json'));
  const finalized = await run111kDeployment(['finalize', ...baseArgs, '--previous-directory', oldDirectory], overrides);
  assert.equal(json(path.join(releaseLocationOptions.registryDirectory, 'v98.json')).directory, oldDirectory);
  assert.deepEqual(finalized.transactions, []);
  assert.equal(finalized.cleanup.complete, true);
  assert.equal(cleanupCalls.length, 4);
  assert.equal(sends, 5);
  const opened = await verifyStage('open');
  assert.equal(opened.totalMintReleased, released);
  assert.equal(opened.contractBalanceWei, 0n);
  const otherMint = await send(token, cast(['calldata', 'mintCrates(uint256)', '1']), hex(100000000000000n), otherBuyer);
  const purchaseTopic = cast(['keccak', 'CratesPurchased(address,uint256,uint256,uint256)']);
  const purchase = otherMint.logs.find(log => log.address === token && log.topics[0] === purchaseTopic);
  assert.ok(purchase);
  const [otherCrate] = decode(['uint256', 'uint256', 'uint256'], purchase.data);
  await send(token, cast(['calldata', 'unboxCrate(uint256)', otherCrate.toString()]), '0x0', otherBuyer);
  const beforeQaMint = await f.rpc('evm_snapshot');
  await invoke('mint-qa');
  const minted = await verifyStage('mint-qa');
  assert.notEqual(minted.qa.crateTokenId, otherCrate);
  assert.equal(minted.totalSupply, 21n);
  interruptBeforeBroadcast = true;
  await assert.rejects(invoke('unpack-qa'), /Simulated interruption before broadcast/);
  const interruptedJournal = fs.readFileSync(journalPath);
  const interruptedUnpack = json(journalPath).actions['unpack-qa'];
  assert.equal(sends, 6);
  assert.equal(await f.rpc('eth_getTransactionByHash', [interruptedUnpack.hash]), null);
  await invoke('unpack-qa');
  assert.equal(json(journalPath).actions['unpack-qa'].hash, interruptedUnpack.hash);
  assert.equal(json(journalPath).actions['unpack-qa'].raw, interruptedUnpack.raw);
  const unpacked = await verifyStage('unpack-qa');
  assert.equal(unpacked.qa.crateTokenId, minted.qa.crateTokenId);
  assert.equal(unpacked.qa.firstArtwork, 21n);
  assert.equal(unpacked.qa.artworkCount, 20);
  assert.equal(unpacked.totalSupply, 40n);
  assert.deepEqual(verifiedStages, ['closed', 'reserved', 'open', 'mint-qa', 'unpack-qa']);
  await invoke('mint-qa');
  await invoke('unpack-qa');
  assert.equal(sends, 7);
  assert.deepEqual(await read(token, 'saleActive()', ['bool']), [true]);
  assert.deepEqual(await read(token, 'totalSupply()'), [40n]);
  assert.deepEqual(await read(token, 'allocatedCrates()'), [2000n]);
  assert.deepEqual(await read(token, 'getRelicClaimedMask()'), [0n]);
  assert.deepEqual(await read(token, 'totalMintReceived()'), [18200000000000000n]);
  for (const allowance of args[7]) {
    assert.deepEqual(await read(token, 'freeMintAllowances(address)', Array(6).fill('uint16'), [allowance[0]]),
      [0n, 0n, allowance[3], 0n, 0n, 0n]);
  }
  assert.equal(BigInt(await f.rpc('eth_getTransactionCount', [f.owner, 'latest'])), startingNonce + 7n);
  for (const record of Object.values(json(journalPath).actions)) {
    assert.equal(record.receipt.status, '0x1');
    assert.ok(BigInt(await f.rpc('eth_blockNumber')) - BigInt(record.receipt.blockNumber) + 1n >= 3n);
  }
  assert.equal(fs.statSync(journalPath).mode & 0o077, 0);
  const recordedLocation = path.join(releaseLocationOptions.registryDirectory, 'v99.json');
  fs.unlinkSync(recordedLocation);
  const verified = await run111kDeployment(['verify', ...baseArgs], overrides);
  assert.equal(verified.verified, true);
  assert.equal(verified.transactions.length, 7);
  assert.equal(verified.state.artworksMinted, '40');
  assert.equal(verified.state.totalMintReceived, '18200000000000000');
  assert.equal(cleanupCalls.length, 4, 'Verification must not invoke cleanup');
  assert.equal(fs.existsSync(recordedLocation), false, 'Verification must not write release-location metadata');
  const verifiedJournal = fs.readFileSync(journalPath, 'utf8');
  for (const mutate of [
    journal => { journal.actions.deploy.raw = '0x01'; },
    journal => { journal.actions.deploy.action = 'open'; },
    journal => { journal.actions.deploy.from = old.contractAddress; },
    journal => { journal.actions.deploy.contractAddress = old.contractAddress; },
    journal => { journal.actions.deploy.data = '0x00'; },
    journal => { journal.actions.deploy.valueWei = '1'; },
    journal => { journal.actions.deploy.nonce = (BigInt(journal.actions.deploy.nonce) + 1n).toString(); },
    journal => { delete journal.actions.deploy.raw; },
    journal => { journal.actions.unknown = journal.actions.deploy; },
  ]) {
    const changed = JSON.parse(verifiedJournal);
    mutate(changed);
    const content = JSON.stringify(changed);
    fs.writeFileSync(journalPath, content);
    await assert.rejects(run111kDeployment(['verify', ...baseArgs], overrides), /journal|nonce/i);
    assert.equal(fs.readFileSync(journalPath, 'utf8'), content, 'Verification must not rewrite signed evidence');
  }
  const withoutQa = JSON.parse(verifiedJournal);
  delete withoutQa.actions['mint-qa'];
  delete withoutQa.actions['unpack-qa'];
  fs.writeFileSync(journalPath, JSON.stringify(withoutQa));
  assert.equal((await run111kDeployment(['verify', ...baseArgs], overrides)).transactions.length, 5);
  fs.writeFileSync(journalPath, verifiedJournal);
  assert.equal(sends, 7, 'Verification must not broadcast transactions');
  assert.equal(cleanupCalls.length, 4, 'Verification must not run retirement');
  await assert.rejects(run111kDeployment(['verify', ...baseArgs, '--previous-contract', `0x${'77'.repeat(20)}`], overrides), /previousContract/);
  assert.equal(await f.rpc('evm_revert', [beforeQaMint]), true);
  fs.writeFileSync(journalPath, interruptedJournal);
  await send(token, cast(['calldata', 'mintCrates(uint256)', '1']), hex(100000000000000n), otherBuyer);
  const originalMint = json(journalPath).actions['mint-qa'];
  await injectedRpc('eth_sendRawTransaction', [originalMint.raw]);
  const remintedReceipt = await confirm111kTransaction(f.rpc, originalMint, { sleep: async () => {}, maxReceiptPolls: 2 });
  const remintedEvent = remintedReceipt.logs.find(log => log.address === token && log.topics[0] === purchaseTopic);
  assert.ok(remintedEvent);
  const [remintedCrate] = decode(['uint256', 'uint256', 'uint256'], remintedEvent.data);
  assert.notEqual(remintedCrate, minted.qa.crateTokenId);
  const nonceBeforeRetry = await f.rpc('eth_getTransactionCount', [f.owner, 'latest']);
  const balanceBeforeRetry = await f.rpc('eth_getBalance', [f.owner, 'latest']);
  const sendsBeforeRetry = sends;
  await assert.rejects(invoke('unpack-qa'), /Canonical prerequisite changed signed data/);
  assert.equal(sends, sendsBeforeRetry);
  assert.equal(await f.rpc('eth_getTransactionCount', [f.owner, 'latest']), nonceBeforeRetry);
  assert.equal(await f.rpc('eth_getBalance', [f.owner, 'latest']), balanceBeforeRetry);
  assert.equal(await f.rpc('eth_getTransactionByHash', [interruptedUnpack.hash]), null);
  const afterRetry = json(journalPath);
  assert.equal(afterRetry.actions['mint-qa'].receipt.blockHash, remintedReceipt.blockHash);
  assert.equal(afterRetry.actions['unpack-qa'].raw, interruptedUnpack.raw);
  assert.equal(afterRetry.actions['unpack-qa'].hash, interruptedUnpack.hash);
});

test('zero-reservation releases verify and resume without signing or consuming a reservation nonce', { timeout: 120_000 }, async t => {
  const f = await anvilFixture(t);
  const presetPath = path.join(project, 'config/free-mints.sepolia.json');
  const originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (filename, ...options) => path.resolve(String(filename)) === presetPath
    ? JSON.stringify({ chainId: 11155111, groups: [] }) : originalRead(filename, ...options));
  const proceeds = json(path.join(project, 'config/proceeds.json'));
  const artifact = json(path.join(project, 'out/NFT111K.sol/NFT111K.json'));
  const args = cast(['abi-encode', 'constructor(address,address,address,string,bytes32,address[],uint256[],(address,uint16,uint16,uint16)[],uint256)',
    f.owner, NFT111K_SEPOLIA.quoteSigner, '0x5555555555555555555555555555555555555555',
    'https://cdn.mons.shop/111k-sepolia/zero-old/', `0x${'0'.repeat(64)}`,
    `[${proceeds.mintRecipients.join(',')}]`, `[${proceeds.mintSharesBps.join(',')}]`, '[]', '5555']);
  const create = { from: f.owner, data: artifact.bytecode.object + args.slice(2) };
  const hash = await f.rpc('eth_sendTransaction', [{ ...create, gas: await f.rpc('eth_estimateGas', [create]) }]);
  await f.rpc('anvil_mine', [1]);
  const old = await f.rpc('eth_getTransactionReceipt', [hash]);
  assert.equal(old.status, '0x1');
  const oldDirectory = path.join(f.directory, 'old');
  fs.mkdirSync(oldDirectory, { mode: 0o700 });
  fs.writeFileSync(path.join(oldDirectory, 'manifest.json'), JSON.stringify({ version: 1, network: 'sepolia', chainId: 11155111,
    deploymentId: 'zero-old', contractAddress: old.contractAddress, metadataBaseURI: 'https://cdn.mons.shop/111k-sepolia/zero-old/' }));
  const releaseLocationOptions = { registryDirectory: path.join(f.directory, 'locations') };
  await record111kReleaseLocation(oldDirectory, { chainId: 11155111, deploymentId: 'zero-old',
    contractAddress: old.contractAddress, metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/zero-old/' }, releaseLocationOptions);
  const directory = path.join(f.directory, 'replacement');
  const rpc = async (method, params = []) => {
    if (method === 'eth_gasPrice') return '0x3e8';
    const result = await f.rpc(method, params);
    if (method === 'eth_sendRawTransaction') await f.rpc('anvil_mine', [2]);
    return result;
  };
  let cleaned = false;
  const overrides = { configuration: { deployer: f.owner, owner: f.owner }, releaseLocationOptions, rpc, cast: f.cast,
    sleep: async () => {}, maxReceiptPolls: 2,
    resolvePredecessor: async () => ({ chainId: 11155111, contractAddress: old.contractAddress,
      metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/zero-old/' }),
    cleanupReplacement: async () => { cleaned = true; return { complete: true }; } };
  const base = ['--directory', directory];
  const signing = ['--keystore', 'fixture', '--password-file', 'fixture'];
  await run111kDeployment(['prepare', ...base, '--deployment-id', 'zero-new', '--reserved-relics', '0',
    '--relic-reservation-value-wei', '0'], overrides);
  let beforeDeployment = await f.rpc('evm_snapshot');
  await run111kDeployment(['deploy', ...base, ...signing], overrides);
  const nonce = await f.rpc('eth_getTransactionCount', [f.owner, 'latest']);
  const skipped = await run111kDeployment(['reserve', ...base], overrides);
  assert.equal(skipped.transactions[0].skipped, true);
  assert.equal((await run111kDeployment(['reserve', ...base], overrides)).transactions[0].alreadySatisfied, true);
  assert.equal(await f.rpc('eth_getTransactionCount', [f.owner, 'latest']), nonce);
  const journalPath = path.join(directory, 'transactions.private.json');
  const entry = json(journalPath).actions.reserve;
  const deploymentReceipt = json(journalPath).actions.deploy.receipt;
  assert.equal(entry.blockNumber, deploymentReceipt.blockNumber);
  assert.equal(entry.blockHash, deploymentReceipt.blockHash);
  assert.ok(BigInt(await f.rpc('eth_blockNumber')) - BigInt(entry.blockNumber) >= 2n,
    'The zero reservation skip must use the confirmed deployment block, not the unconfirmed head');
  assert.equal(entry.raw, undefined);
  assert.equal(entry.nonce, undefined);
  assert.equal(entry.receipt, undefined);
  const reserved = await verify111kDeployment(await load111kVerification(directory), rpc, 'reserved');
  assert.equal(reserved.stats[0], 0n);
  assert.equal(reserved.stats[10], 0n);
  assert.equal(reserved.totalMintReceived, 0n);
  const reorgDeployment = async emptyBlocks => {
    const previous = json(journalPath);
    assert.equal(await f.rpc('evm_revert', [beforeDeployment]), true);
    beforeDeployment = await f.rpc('evm_snapshot');
    await f.rpc('anvil_mine', [emptyBlocks]);
    await run111kDeployment(['deploy', ...base, ...signing], overrides);
    const current = json(journalPath);
    assert.equal(current.actions.deploy.hash, previous.actions.deploy.hash);
    assert.equal(current.actions.deploy.raw, previous.actions.deploy.raw);
    assert.notEqual(current.actions.deploy.receipt.blockHash, previous.actions.deploy.receipt.blockHash);
    assert.deepEqual(current.actions.reserve, previous.actions.reserve);
    const canonical = await f.rpc('eth_getBlockByNumber', [current.actions.deploy.receipt.blockNumber, false]);
    assert.equal(canonical.hash, current.actions.deploy.receipt.blockHash);
    return current;
  };
  const assertRefreshedSkip = () => {
    const current = json(journalPath);
    assert.equal(current.actions.reserve.blockNumber, current.actions.deploy.receipt.blockNumber);
    assert.equal(current.actions.reserve.blockHash, current.actions.deploy.receipt.blockHash);
    assert.equal(current.actions.reserve.raw, undefined);
    assert.equal(current.actions.reserve.nonce, undefined);
    assert.equal(current.actions.reserve.receipt, undefined);
  };
  await t.test('reserve retries recover re-mined deployment evidence only after validating zero relic allocation', async () => {
    const reorganized = await reorgDeployment(1);
    const before = fs.readFileSync(journalPath, 'utf8');
    await assert.rejects(run111kDeployment(['verify', ...base], overrides), /canonical/);
    assert.equal(fs.readFileSync(journalPath, 'utf8'), before);
    const allocationSelector = cast(['sig', 'relicsAllocated()']);
    for (const allocated of [false, true]) {
      await assert.rejects(run111kDeployment(['reserve', ...base], { ...overrides, rpc: async (method, params) => {
        if (method === 'eth_call' && params[1]?.blockHash === reorganized.actions.deploy.receipt.blockHash
          && params[0].data === allocationSelector) {
          if (!allocated) throw new Error('Historical RPC unavailable');
          return `0x${'1'.padStart(64, '0')}`;
        }
        return rpc(method, params);
      } }), allocated ? /Zero reservation precondition changed/ : /Historical RPC unavailable/);
      assert.equal(fs.readFileSync(journalPath, 'utf8'), before);
    }
    const recovered = await run111kDeployment(['reserve', ...base], overrides);
    assert.equal(recovered.transactions[0].skipped, true);
    assert.equal(recovered.transactions[0].alreadySatisfied, true);
    assert.equal(await f.rpc('eth_getTransactionCount', [f.owner, 'latest']), nonce);
    assertRefreshedSkip();
    await run111kDeployment(['verify', ...base], overrides);
  });
  await t.test('later actions refresh a stale reservation skip before signing', async () => {
    await reorgDeployment(2);
    await run111kDeployment(['pause-old', ...base, ...signing], overrides);
    assertRefreshedSkip();
    assert.equal(json(journalPath).actions['pause-old-redemptions'].nonce, BigInt(nonce).toString());
  });
  await run111kDeployment(['open', ...base, ...signing], overrides);
  assert.equal(cleaned, true);
  cleaned = false;
  await run111kDeployment(['finalize', ...base], overrides);
  assert.equal(cleaned, true);
  const opened = await verify111kDeployment(await load111kVerification(directory), rpc, 'open');
  assert.equal(opened.stats[5], true);
  assert.equal(opened.publicRelicsMinted, 0n);
  const beforeVerify = fs.readFileSync(journalPath, 'utf8');
  const verified = await run111kDeployment(['verify', ...base], overrides);
  assert.equal(verified.transactions.find(action => action.action === 'reserve').skipped, true);
  assert.equal(fs.readFileSync(journalPath, 'utf8'), beforeVerify);
  for (const [command, publicMints] of [['reserve', false], ['finalize', true]]) {
    await t.test(`${command} recovers deployment and opening re-mined together${publicMints ? ' with paid and free public relics' : ''}`, async () => {
      const previous = json(journalPath);
      assert.equal(await f.rpc('evm_revert', [beforeDeployment]), true);
      beforeDeployment = await f.rpc('evm_snapshot');
      await f.rpc('evm_setAutomine', [false]);
      const hashes = [];
      for (const action of ['deploy', 'pause-old-sale', 'pause-old-redemptions', 'open']) {
        if (previous.actions[action]?.raw) hashes.push(await f.rpc('eth_sendRawTransaction', [previous.actions[action].raw]));
      }
      if (publicMints) {
        const contract = previous.actions.open.contractAddress;
        let publicNonce = BigInt(previous.actions.open.nonce) + 1n;
        for (const [data, value] of [
          [cast(['calldata', 'setPublicRelicSale(uint256,uint256,bool)', '2', '17', 'true']), '0'],
          [cast(['calldata', 'mintRelic(uint256)', '1']), '17'],
          [cast(['calldata', 'setPublicRelicFreeMintAllowances(address[],uint16)', `[${f.owner}]`, '1']), '0'],
          [cast(['calldata', 'mintFreeRelic(uint256)', '2']), '0'],
        ]) {
          const raw = f.cast(['mktx', '--legacy', '--chain', '11155111', '--nonce', String(publicNonce++),
            '--gas-limit', '500000', '--gas-price', '1000', '--value', value, ...signing, contract, data]);
          hashes.push(await f.rpc('eth_sendRawTransaction', [raw]));
        }
      }
      await f.rpc('anvil_mine', [3]);
      await f.rpc('evm_setAutomine', [true]);
      const receipts = await Promise.all(hashes.map(hash => f.rpc('eth_getTransactionReceipt', [hash])));
      for (const receipt of receipts) {
        assert.equal(receipt.status, '0x1');
        assert.equal(receipt.blockHash, receipts[0].blockHash);
      }
      assert.notEqual(receipts[0].blockHash, previous.actions.deploy.receipt.blockHash);
      const nonceBeforeRecovery = await f.rpc('eth_getTransactionCount', [f.owner, 'latest']);
      await run111kDeployment(['deploy', ...base], overrides);
      const staleJournal = fs.readFileSync(journalPath, 'utf8');
      await assert.rejects(run111kDeployment(['verify', ...base], overrides), /canonical/);
      await assert.rejects(verify111kDeployment(await load111kVerification(directory), rpc, 'open'), /canonical/);
      assert.equal(fs.readFileSync(journalPath, 'utf8'), staleJournal);
      cleaned = false;
      await run111kDeployment([command, ...base], overrides);
      assertRefreshedSkip();
      if (command === 'reserve') await run111kDeployment(['finalize', ...base], overrides);
      assert.equal(cleaned, true);
      assert.equal(await f.rpc('eth_getTransactionCount', [f.owner, 'latest']), nonceBeforeRecovery);
      for (const action of ['deploy', 'pause-old-sale', 'pause-old-redemptions', 'open']) {
        if (!previous.actions[action]) continue;
        assert.equal(json(journalPath).actions[action].raw, previous.actions[action].raw);
        assert.equal(json(journalPath).actions[action].hash, previous.actions[action].hash);
      }
      const recoveredJournal = fs.readFileSync(journalPath, 'utf8');
      const verified = await run111kDeployment(['verify', ...base], overrides);
      assert.equal(verified.state.saleActive, true);
      assert.equal(verified.state.relicsAllocated, '0');
      assert.equal(verified.state.publicRelicsMinted, publicMints ? '2' : '0');
      const report = await verify111kDeployment(await load111kVerification(directory), rpc, 'open');
      assert.equal(report.publicRelicsMinted, publicMints ? 2n : 0n);
      assert.equal(report.totalSupply, publicMints ? 2n : 0n);
      assert.equal(report.stats[0], publicMints ? 222n : 0n);
      assert.equal(report.totalMintReceived, publicMints ? 17n : 0n);
      assert.equal(fs.readFileSync(journalPath, 'utf8'), recoveredJournal);
    });
  }
  const altered = json(journalPath);
  altered.actions.reserve.blockHash = `0x${'99'.repeat(32)}`;
  fs.writeFileSync(journalPath, JSON.stringify(altered));
  await assert.rejects(run111kDeployment(['verify', ...base], overrides), /canonical/);
});
