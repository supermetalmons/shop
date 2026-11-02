import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const address = '0x3333333333333333333333333333333333333333';
const transactionHash = '0x' + 'a'.repeat(64);
const compilerVersion = '0.8.38+commit.1835d247';
const contractUrl = 'https://sourcify.dev/server/v2/contract/11155111/' + address;
const json = value => JSON.stringify(value, null, 2) + '\n';
const sha256 = value => createHash('sha256').update(value).digest('hex');
let invocation = 0;

function fixture(t, chainId = 11155111) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pre111k-sourcify-test-'));
  const input = { sources: { 'src/Pre111K.sol': { content: 'pragma solidity 0.8.38; contract Pre111K {}' } },
    settings: { metadata: { bytecodeHash: 'none' } } };
  const artifact = { metadata: { compiler: { version: compilerVersion } }, bytecode: { object: '0x60016002' },
    deployedBytecode: { object: '0x60016003', immutableReferences: {} } };
  const write = (name, value) => fs.writeFileSync(path.join(directory, name), json(value));
  write('manifest.json', { chainId, contractAddress: address, standardInputSha256: sha256(json(input)), artifactSha256: sha256(json(artifact)),
    creationCode: artifact.bytecode.object + '0001', constructorArgs: '0x0001' });
  write('deployment.json', { chainId, contractAddress: address, transactionHash, confirmations: 3,
    runtimeBytes: 4, runtimeKeccak256: '0x' + 'b'.repeat(64) });
  write('Pre111K.standard-input.json', input);
  write('Pre111K.artifact.json', artifact);
  const output = [];
  t.mock.method(console, 'log', value => output.push(JSON.parse(value)));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, write, output, read: name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')),
    async run(mode) {
      const previous = process.argv;
      process.argv = ['node', 'pre111k-sourcify.mjs', mode, directory];
      try { await import(new URL('./pre111k-sourcify.mjs', import.meta.url).href + '?test=' + ++invocation); }
      finally { process.argv = previous; }
    } };
}

test('status works after submit finds the contract already published', async t => {
  const f = fixture(t);
  const published = { address, chainId: '11155111', match: 'match', creationMatch: 'match', runtimeMatch: 'exact_match' };
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => { requests.push(url); return Response.json(published); });
  await f.run('submit');
  assert.deepEqual(f.output[0], { alreadyPublished: true, address });
  assert.equal(fs.existsSync(path.join(f.directory, 'Pre111K.sourcify-submission.json')), false);
  await f.run('status');
  assert.deepEqual(requests, [contractUrl, contractUrl]);
  assert.deepEqual(f.output[1], published);
  assert.deepEqual(f.read('Pre111K.sourcify-job.json'), published);
});

for (const creationMatch of [null, undefined]) {
  test(`submit retries runtime-only verification with ${creationMatch === null ? 'null' : 'missing'} creation match`, async t => {
    const f = fixture(t);
    const published = { address, chainId: '11155111', match: 'match', runtimeMatch: 'match', creationMatch };
    const expected = { stdJsonInput: f.read('Pre111K.standard-input.json'), compilerVersion,
      contractIdentifier: 'src/Pre111K.sol:Pre111K', creationTransactionHash: transactionHash };
    const submission = { verificationId: 'repair-job' };
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      requests.push({ url, method: init.method || 'GET' });
      if (url === contractUrl) return Response.json(published);
      assert.equal(url, 'https://sourcify.dev/server/v2/verify/11155111/' + address);
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), expected);
      return Response.json(submission, { status: 202 });
    });
    await f.run('submit');
    assert.deepEqual(requests, [{ url: contractUrl, method: 'GET' },
      { url: 'https://sourcify.dev/server/v2/verify/11155111/' + address, method: 'POST' }]);
    assert.deepEqual(f.read('Pre111K.sourcify-request.json'), expected);
    assert.deepEqual(f.read('Pre111K.sourcify-submission.json'), { status: 202, value: submission });
    assert.deepEqual(f.output, [submission]);
  });
}

test('submit rejects unexpected lookup statuses without posting sources', async t => {
  const f = fixture(t);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    requests++;
    assert.equal(url, contractUrl);
    return Response.json({}, { status: 500 });
  });
  await assert.rejects(f.run('submit'), /Unexpected Sourcify lookup status/);
  assert.equal(requests, 1);
  assert.equal(fs.existsSync(path.join(f.directory, 'Pre111K.sourcify-request.json')), false);
});

test('status recovers publication when the local submission receipt is absent or lacks a job ID', async t => {
  const f = fixture(t);
  const published = { address, chainId: '11155111', match: 'exact_match', creationMatch: 'exact_match', runtimeMatch: 'exact_match' };
  t.mock.method(globalThis, 'fetch', async url => { assert.equal(url, contractUrl); return Response.json(published); });
  await f.run('status');
  assert.deepEqual(f.read('Pre111K.sourcify-job.json'), published);
  f.write('Pre111K.sourcify-submission.json', { status: 500, value: { message: 'Response interrupted' } });
  await f.run('status');
  assert.deepEqual(f.read('Pre111K.sourcify-job.json'), published);
});

test('status retains pending verification job polling when a receipt is present', async t => {
  const f = fixture(t);
  const pending = { verificationId: 'job/123', isJobCompleted: false };
  f.write('Pre111K.sourcify-submission.json', { status: 202, value: { verificationId: pending.verificationId } });
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'https://sourcify.dev/server/v2/verify/job%2F123');
    return Response.json(pending);
  });
  await f.run('status');
  assert.deepEqual(f.output[0], pending);
  assert.deepEqual(f.read('Pre111K.sourcify-job.json'), pending);
});

test('status reports that submission is needed when neither a job nor publication exists', async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async url => { assert.equal(url, contractUrl); return Response.json({}, { status: 404 }); });
  await assert.rejects(f.run('status'), /run submit first/);
  assert.equal(fs.existsSync(path.join(f.directory, 'Pre111K.sourcify-job.json')), false);
});

test('mainnet submission and publication status use chain one endpoints', async t => {
  const f = fixture(t, 1);
  const mainnetContractUrl = 'https://sourcify.dev/server/v2/contract/1/' + address;
  const mainnetVerifyUrl = 'https://sourcify.dev/server/v2/verify/1/' + address;
  const requests = [];
  const published = { address, chainId: '1', match: 'match', creationMatch: 'match', runtimeMatch: 'match' };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, method: init.method || 'GET' });
    if (requests.length === 1) return Response.json({}, { status: 404 });
    if (requests.length === 2) {
      assert.deepEqual(JSON.parse(init.body), { stdJsonInput: f.read('Pre111K.standard-input.json'), compilerVersion,
        contractIdentifier: 'src/Pre111K.sol:Pre111K', creationTransactionHash: transactionHash });
      return Response.json({ verificationId: 'mainnet-job' }, { status: 202 });
    }
    return Response.json(published);
  });
  await f.run('submit');
  fs.unlinkSync(path.join(f.directory, 'Pre111K.sourcify-submission.json'));
  await f.run('status');
  assert.deepEqual(requests, [{ url: mainnetContractUrl, method: 'GET' }, { url: mainnetVerifyUrl, method: 'POST' },
    { url: mainnetContractUrl, method: 'GET' }]);
  assert.deepEqual(f.read('Pre111K.sourcify-job.json'), published);
});

for (const chainId of [1, 11155111]) {
  test(`verification records the selected chain ${chainId} and its source URLs`, async t => {
    const f = fixture(t, chainId);
    const manifest = f.read('manifest.json');
    const input = f.read('Pre111K.standard-input.json');
    const artifact = f.read('Pre111K.artifact.json');
    const published = { address, chainId: String(chainId), match: 'match', creationMatch: 'match', runtimeMatch: 'match',
      deployment: { transactionHash }, compilation: { compilerVersion, fullyQualifiedName: 'src/Pre111K.sol:Pre111K' },
      sources: input.sources, verifiedAt: '2026-11-02T10:00:00.000Z',
      creationBytecode: { onchainBytecode: manifest.creationCode, recompiledBytecode: artifact.bytecode.object,
        transformationValues: { constructorArguments: manifest.constructorArgs } },
      runtimeBytecode: { onchainBytecode: artifact.deployedBytecode.object, recompiledBytecode: artifact.deployedBytecode.object } };
    let requestUrl;
    t.mock.method(globalThis, 'fetch', async url => { requestUrl = url; return Response.json(published); });
    await f.run('verify');
    const report = f.read('Pre111K.sourcify-verification.json');
    assert.equal(new URL(requestUrl).pathname, '/server/v2/contract/' + chainId + '/' + address);
    assert.ok(new URL(requestUrl).searchParams.get('fields').includes('creationBytecode.onchainBytecode'));
    assert.equal(report.chainId, chainId);
    assert.equal(report.url, 'https://repo.sourcify.dev/' + chainId + '/' + address);
    assert.equal(report.apiUrl, requestUrl);
    assert.equal(report.frozenSourcesMatch, true);
    assert.equal(report.creationBytecodeMatch, true);
    assert.equal(report.runtimeBytecodeMatch, true);
    assert.deepEqual(report.sourceSha256, { 'src/Pre111K.sol': sha256(input.sources['src/Pre111K.sol'].content) });
    assert.deepEqual(f.read('Pre111K.sourcify-published.json'), published);
    assert.deepEqual(f.read('source-manifest.json').sources, report.sourceSha256);
  });

  test(`verification rejects a published chain different from ${chainId}`, async t => {
    const f = fixture(t, chainId);
    t.mock.method(globalThis, 'fetch', async () => Response.json({ chainId: chainId === 1 ? '11155111' : '1' }));
    await assert.rejects(f.run('verify'), /Published chain does not match release/);
    assert.equal(fs.existsSync(path.join(f.directory, 'Pre111K.sourcify-verification.json')), false);
  });
}

for (const [manifestChain, deploymentChain] of [[1, 11155111], [11155111, 1], [1, '1'], [1, undefined]]) {
  test(`rejects deployment chain ${deploymentChain} against manifest chain ${manifestChain} before requests`, async t => {
    const f = fixture(t, manifestChain);
    f.write('deployment.json', { ...f.read('deployment.json'), chainId: deploymentChain });
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
    for (const mode of ['submit', 'status', 'verify']) {
      await assert.rejects(f.run(mode), /Deployment chain does not match manifest/);
    }
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}

for (const chainId of [10, '1', undefined]) {
  test(`rejects unsupported or malformed manifest chain ${chainId} before requests`, async t => {
    const f = fixture(t);
    f.write('manifest.json', { ...f.read('manifest.json'), chainId });
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
    for (const mode of ['submit', 'status', 'verify']) {
      await assert.rejects(f.run(mode), /Unsupported pre111k verification chain/);
    }
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}
