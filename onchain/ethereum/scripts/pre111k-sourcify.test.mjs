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

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pre111k-sourcify-test-'));
  const input = { sources: {} };
  const artifact = { metadata: { compiler: { version: compilerVersion } } };
  const write = (name, value) => fs.writeFileSync(path.join(directory, name), json(value));
  write('manifest.json', { contractAddress: address, standardInputSha256: sha256(json(input)), artifactSha256: sha256(json(artifact)) });
  write('deployment.json', { chainId: 11155111, contractAddress: address, transactionHash, confirmations: 3 });
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
