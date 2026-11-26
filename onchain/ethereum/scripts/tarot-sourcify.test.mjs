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

function fixture(t, chainId = 11155111, contractName = 'TarotCards') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tarot-sourcify-test-'));
  const input = { sources: { ['src/' + contractName + '.sol']: { content: 'pragma solidity 0.8.38; contract ' + contractName + ' {}' } },
    settings: { metadata: { bytecodeHash: 'none' } } };
  const artifact = { metadata: { compiler: { version: compilerVersion } }, bytecode: { object: '0x60016002' },
    deployedBytecode: { object: '0x60016003', immutableReferences: {} } };
  const write = (name, value) => fs.writeFileSync(path.join(directory, name), json(value));
  const constructorArgs = contractName === 'TarotCards' ? '0x0001' : '0x';
  write('manifest.json', { releaseVersion: 2, contractName, chainId, contractAddress: address, standardInputSha256: sha256(json(input)), artifactSha256: sha256(json(artifact)),
    creationCode: artifact.bytecode.object + constructorArgs.slice(2), constructorArgs });
  write('deployment.json', { chainId, contractAddress: address, transactionHash, confirmations: 3,
    runtimeBytes: 4, runtimeKeccak256: '0x' + 'b'.repeat(64) });
  write(contractName + '.standard-input.json', input);
  write(contractName + '.artifact.json', artifact);
  const output = [];
  t.mock.method(console, 'log', value => output.push(JSON.parse(value)));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, write, output, read: name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')),
    async run(mode) {
      const previous = process.argv;
      process.argv = ['node', 'tarot-sourcify.mjs', mode, directory];
      try { await import(new URL('./tarot-sourcify.mjs', import.meta.url).href + '?test=' + ++invocation); }
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
  assert.equal(fs.existsSync(path.join(f.directory, 'TarotCards.sourcify-submission.json')), false);
  await f.run('status');
  assert.deepEqual(requests, [contractUrl, contractUrl]);
  assert.deepEqual(f.output[1], published);
  assert.deepEqual(f.read('TarotCards.sourcify-job.json'), published);
});

for (const creationMatch of [null, undefined]) {
  test(`submit retries runtime-only verification with ${creationMatch === null ? 'null' : 'missing'} creation match`, async t => {
    const f = fixture(t);
    const published = { address, chainId: '11155111', match: 'match', runtimeMatch: 'match', creationMatch };
    const expected = { stdJsonInput: f.read('TarotCards.standard-input.json'), compilerVersion,
      contractIdentifier: 'src/TarotCards.sol:TarotCards', creationTransactionHash: transactionHash };
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
    assert.deepEqual(f.read('TarotCards.sourcify-request.json'), expected);
    assert.deepEqual(f.read('TarotCards.sourcify-submission.json'), { status: 202, value: submission });
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
  assert.equal(fs.existsSync(path.join(f.directory, 'TarotCards.sourcify-request.json')), false);
});

test('status recovers publication when the local submission receipt is absent or lacks a job ID', async t => {
  const f = fixture(t);
  const published = { address, chainId: '11155111', match: 'exact_match', creationMatch: 'exact_match', runtimeMatch: 'exact_match' };
  t.mock.method(globalThis, 'fetch', async url => { assert.equal(url, contractUrl); return Response.json(published); });
  await f.run('status');
  assert.deepEqual(f.read('TarotCards.sourcify-job.json'), published);
  f.write('TarotCards.sourcify-submission.json', { status: 500, value: { message: 'Response interrupted' } });
  await f.run('status');
  assert.deepEqual(f.read('TarotCards.sourcify-job.json'), published);
});

test('status retains pending verification job polling when a receipt is present', async t => {
  const f = fixture(t);
  const pending = { verificationId: 'job/123', isJobCompleted: false };
  f.write('TarotCards.sourcify-submission.json', { status: 202, value: { verificationId: pending.verificationId } });
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'https://sourcify.dev/server/v2/verify/job%2F123');
    return Response.json(pending);
  });
  await f.run('status');
  assert.deepEqual(f.output[0], pending);
  assert.deepEqual(f.read('TarotCards.sourcify-job.json'), pending);
});

test('status reports that submission is needed when neither a job nor publication exists', async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async url => { assert.equal(url, contractUrl); return Response.json({}, { status: 404 }); });
  await assert.rejects(f.run('status'), /run submit first/);
  assert.equal(fs.existsSync(path.join(f.directory, 'TarotCards.sourcify-job.json')), false);
});

for (const chainId of [1, 11155111]) {
  test(`verification records the selected chain ${chainId} and its source URLs`, async t => {
    const f = fixture(t, chainId);
    const manifest = f.read('manifest.json');
    const input = f.read('TarotCards.standard-input.json');
    const artifact = f.read('TarotCards.artifact.json');
    const published = { address, chainId: String(chainId), match: 'match', creationMatch: 'match', runtimeMatch: 'match',
      deployment: { transactionHash }, compilation: { compilerVersion, fullyQualifiedName: 'src/TarotCards.sol:TarotCards' },
      sources: input.sources, verifiedAt: '2026-11-02T10:00:00.000Z',
      creationBytecode: { onchainBytecode: manifest.creationCode, recompiledBytecode: artifact.bytecode.object,
        transformationValues: { constructorArguments: manifest.constructorArgs } },
      runtimeBytecode: { onchainBytecode: artifact.deployedBytecode.object, recompiledBytecode: artifact.deployedBytecode.object } };
    let requestUrl;
    t.mock.method(globalThis, 'fetch', async url => { requestUrl = url; return Response.json(published); });
    await f.run('verify');
    const report = f.read('TarotCards.sourcify-verification.json');
    assert.equal(new URL(requestUrl).pathname, '/server/v2/contract/' + chainId + '/' + address);
    assert.ok(new URL(requestUrl).searchParams.get('fields').includes('creationBytecode.onchainBytecode'));
    assert.equal(report.chainId, chainId);
    assert.equal(report.url, 'https://repo.sourcify.dev/' + chainId + '/' + address);
    assert.equal(report.apiUrl, requestUrl);
    assert.equal(report.frozenSourcesMatch, true);
    assert.equal(report.creationBytecodeMatch, true);
    assert.equal(report.runtimeBytecodeMatch, true);
    assert.deepEqual(report.sourceSha256, { 'src/TarotCards.sol': sha256(input.sources['src/TarotCards.sol'].content) });
    assert.deepEqual(f.read('TarotCards.sourcify-published.json'), published);
    assert.deepEqual(f.read('source-manifest.json').sources, report.sourceSha256);
  });

  test(`verification rejects a published chain different from ${chainId}`, async t => {
    const f = fixture(t, chainId);
    t.mock.method(globalThis, 'fetch', async () => Response.json({ chainId: chainId === 1 ? '11155111' : '1' }));
    await assert.rejects(f.run('verify'), /Published chain does not match release/);
    assert.equal(fs.existsSync(path.join(f.directory, 'TarotCards.sourcify-verification.json')), false);
  });
}

for (const releaseVersion of [undefined, 1, '2', 3]) {
  test(`rejects release version ${releaseVersion} before source requests or evidence writes`, async t => {
    const f = fixture(t);
    f.write('manifest.json', { ...f.read('manifest.json'), releaseVersion });
    const files = fs.readdirSync(f.directory).sort();
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
    for (const mode of ['submit', 'status', 'verify']) {
      await assert.rejects(f.run(mode), /requires a version 2 DMX release/);
    }
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.deepEqual(fs.readdirSync(f.directory).sort(), files);
  });
}

for (const contractName of [undefined, null, '', 'LegacyTarotCards']) {
  test(`rejects missing or unsupported contract name ${contractName} before source requests or evidence writes`, async t => {
    const f = fixture(t);
    f.write('manifest.json', { ...f.read('manifest.json'), contractName });
    const files = fs.readdirSync(f.directory).sort();
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
    for (const mode of ['submit', 'status', 'verify']) {
      await assert.rejects(f.run(mode), /Unsupported source verification contract/);
    }
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.deepEqual(fs.readdirSync(f.directory).sort(), files);
  });
}

for (const [manifestChain, deploymentChain] of [[1, 11155111], [1, '1'], [11155111, 1], [11155111, '11155111'], [11155111, undefined]]) {
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

for (const chainId of [10, '1', '11155111', undefined]) {
  test(`rejects unsupported or malformed manifest chain ${chainId} before requests`, async t => {
    const f = fixture(t);
    f.write('manifest.json', { ...f.read('manifest.json'), chainId });
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
    for (const mode of ['submit', 'status', 'verify']) {
      await assert.rejects(f.run(mode), /Tarot source verification supports Sepolia or Ethereum mainnet only/);
    }
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}

for (const [chainId, network] of [[1, 'sepolia'], [11155111, 'mainnet']]) {
  test(`source verification rejects network ${network} on chain ${chainId}`, async t => {
    const f = fixture(t, chainId);
    f.write('manifest.json', { ...f.read('manifest.json'), network });
    const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
    for (const mode of ['submit', 'status', 'verify']) await assert.rejects(f.run(mode), /network does not match chain/);
    assert.equal(request.mock.callCount(), 0);
  });
}

test('mainnet source submission targets chain one for collection and renderer', async t => {
  for (const contractName of ['TarotCards', 'DMXWebpRenderer', 'DMXOffchainRenderer']) {
    const f = fixture(t, 1, contractName);
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      requests.push(url);
      if (!init.method) return Response.json({}, { status: 404 });
      assert.equal(JSON.parse(init.body).contractIdentifier, 'src/' + contractName + '.sol:' + contractName);
      return Response.json({ verificationId: 'mainnet-job' }, { status: 202 });
    });
    await f.run('submit');
    assert.deepEqual(requests, ['https://sourcify.dev/server/v2/contract/1/' + address,
      'https://sourcify.dev/server/v2/verify/1/' + address]);
  }
});


test('renderer source verification submits and verifies the renderer target independently', async t => {
  const f = fixture(t, 11155111, 'DMXWebpRenderer');
  const input = f.read('DMXWebpRenderer.standard-input.json');
  const artifact = f.read('DMXWebpRenderer.artifact.json');
  const manifest = f.read('manifest.json');
  const published = { address, chainId: '11155111', match: 'match', creationMatch: 'match', runtimeMatch: 'match',
    deployment: { transactionHash }, compilation: { compilerVersion, fullyQualifiedName: 'src/DMXWebpRenderer.sol:DMXWebpRenderer' },
    sources: input.sources, verifiedAt: '2026-11-24T10:00:00.000Z',
    creationBytecode: { onchainBytecode: manifest.creationCode, recompiledBytecode: artifact.bytecode.object,
      transformationValues: {} },
    runtimeBytecode: { onchainBytecode: artifact.deployedBytecode.object, recompiledBytecode: artifact.deployedBytecode.object } };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === contractUrl) return Response.json({}, { status: 404 });
    if (init.method === 'POST') {
      assert.equal(JSON.parse(init.body).contractIdentifier, 'src/DMXWebpRenderer.sol:DMXWebpRenderer');
      return Response.json({ verificationId: 'renderer-job' }, { status: 202 });
    }
    return Response.json(published);
  });
  await f.run('submit');
  assert.equal(f.read('DMXWebpRenderer.sourcify-submission.json').value.verificationId, 'renderer-job');
  await f.run('verify');
  assert.equal(f.read('DMXWebpRenderer.sourcify-verification.json').frozenSourcesMatch, true);
  assert.equal(f.read('source-manifest.json').fullyQualifiedName, 'src/DMXWebpRenderer.sol:DMXWebpRenderer');
  assert.equal(fs.existsSync(path.join(f.directory, 'TarotCards.sourcify-verification.json')), false);
});


function publishedRelease(f, contractName) {
  const manifest = f.read('manifest.json');
  const artifact = f.read(contractName + '.artifact.json');
  const input = f.read(contractName + '.standard-input.json');
  return { address, chainId: '11155111', match: 'match', creationMatch: 'match', runtimeMatch: 'match',
    deployment: { transactionHash }, compilation: { compilerVersion, fullyQualifiedName: 'src/' + contractName + '.sol:' + contractName },
    sources: input.sources, verifiedAt: '2026-11-24T10:00:00.000Z',
    creationBytecode: { onchainBytecode: manifest.creationCode, recompiledBytecode: artifact.bytecode.object },
    runtimeBytecode: { onchainBytecode: artifact.deployedBytecode.object, recompiledBytecode: artifact.deployedBytecode.object } };
}

test('offchain renderer source verification preserves the independent no-argument target', async t => {
  const name = 'DMXOffchainRenderer';
  const f = fixture(t, 11155111, name);
  const published = publishedRelease(f, name);
  published.creationBytecode.transformationValues = { constructorArguments: '0x' };
  t.mock.method(globalThis, 'fetch', async () => Response.json(published));
  await f.run('verify');
  assert.equal(f.read(name + '.sourcify-verification.json').creationBytecodeMatch, true);
  assert.equal(f.read('source-manifest.json').fullyQualifiedName, 'src/' + name + '.sol:' + name);
});

for (const values of [undefined, null, {}, { constructorArguments: null }, { constructorArguments: '0x' }]) {
  test(`renderer verification accepts empty constructor representation ${JSON.stringify(values)}`, async t => {
    const f = fixture(t, 11155111, 'DMXWebpRenderer');
    const published = publishedRelease(f, 'DMXWebpRenderer');
    published.creationBytecode.transformationValues = values;
    t.mock.method(globalThis, 'fetch', async () => Response.json(published));
    await f.run('verify');
    assert.equal(f.read('DMXWebpRenderer.sourcify-verification.json').creationBytecodeMatch, true);
    assert.equal(f.read('source-manifest.json').constructorArgs, '0x');
  });
}

for (const [contractName, args] of [['TarotCards', undefined], ['TarotCards', null], ['TarotCards', '0x'],
  ['DMXWebpRenderer', '0x0001'], ['DMXWebpRenderer', '']]) {
  test(`${contractName} verification rejects incorrect constructor representation ${JSON.stringify(args)}`, async t => {
    const f = fixture(t, 11155111, contractName);
    const published = publishedRelease(f, contractName);
    published.creationBytecode.transformationValues = { constructorArguments: args };
    t.mock.method(globalThis, 'fetch', async () => Response.json(published));
    await assert.rejects(f.run('verify'), /Published constructor arguments differ/);
    assert.equal(fs.existsSync(path.join(f.directory, contractName + '.sourcify-verification.json')), false);
  });
}

test('empty renderer constructor cannot hide extra creation bytes', async t => {
  const f = fixture(t, 11155111, 'DMXWebpRenderer');
  f.write('manifest.json', { ...f.read('manifest.json'), creationCode: f.read('manifest.json').creationCode + '0001' });
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
  await assert.rejects(f.run('verify'), /Frozen constructor arguments do not match/);
  assert.equal(request.mock.callCount(), 0);
});
