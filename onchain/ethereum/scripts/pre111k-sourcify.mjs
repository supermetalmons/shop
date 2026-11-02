import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { matchingRuntime } from './pre111k-deployment.mjs';

const [mode, directoryArg] = process.argv.slice(2);
assert.ok(['submit', 'status', 'verify'].includes(mode) && directoryArg, 'Use submit|status|verify DEPLOYMENT_DIRECTORY');
const directory = path.resolve(directoryArg);
const json = value => JSON.stringify(value, null, 2) + '\n';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
const save = (name, value) => fs.writeFileSync(path.join(directory, name), json(value), { mode: 0o600 });
const manifest = read('manifest.json');
const deployment = read('deployment.json');
const input = read('Pre111K.standard-input.json');
const artifact = read('Pre111K.artifact.json');
const chainId = manifest.chainId;
assert.ok([1, 11155111].includes(chainId), 'Unsupported pre111k verification chain');
assert.equal(deployment.chainId, chainId, 'Deployment chain does not match manifest');
assert.equal(deployment.contractAddress, manifest.contractAddress);
assert.equal(sha256(json(input)), manifest.standardInputSha256);
assert.equal(sha256(json(artifact)), manifest.artifactSha256);
assert.ok(deployment.confirmations >= 3);
const base = 'https://sourcify.dev/server/v2';
const contractUrl = base + '/contract/' + chainId + '/' + deployment.contractAddress;
const request = async (url, init = {}) => {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  return { status: response.status, value: await response.json() };
};

if (mode === 'submit') {
  const lookup = await request(contractUrl);
  if (lookup.status === 200 && ['creationMatch', 'runtimeMatch'].every(field => ['match', 'exact_match'].includes(lookup.value[field]))) {
    console.log(json({ alreadyPublished: true, address: deployment.contractAddress }));
  } else {
    assert.ok(lookup.status === 200 || lookup.status === 404, 'Unexpected Sourcify lookup status');
    const body = { stdJsonInput: input, compilerVersion: artifact.metadata.compiler.version,
      contractIdentifier: 'src/Pre111K.sol:Pre111K', creationTransactionHash: deployment.transactionHash };
    save('Pre111K.sourcify-request.json', body);
    const result = await request(base + '/verify/' + chainId + '/' + deployment.contractAddress, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    save('Pre111K.sourcify-submission.json', result);
    assert.ok(result.status === 200 || result.status === 202, 'Sourcify submission failed');
    console.log(json(result.value));
  }
} else if (mode === 'status') {
  const submission = fs.existsSync(path.join(directory, 'Pre111K.sourcify-submission.json'))
    ? read('Pre111K.sourcify-submission.json') : null;
  const verificationId = submission?.value?.verificationId;
  const result = await request(verificationId ? base + '/verify/' + encodeURIComponent(verificationId) : contractUrl);
  assert.equal(result.status, 200, !verificationId && result.status === 404
    ? 'No local verification job or published contract; run submit first' : 'Sourcify status unavailable');
  save('Pre111K.sourcify-job.json', result.value);
  console.log(json(result.value));
} else {
  const fields = ['sources', 'compilation', 'deployment', 'creationBytecode.onchainBytecode',
    'creationBytecode.recompiledBytecode', 'creationBytecode.transformationValues',
    'runtimeBytecode.onchainBytecode', 'runtimeBytecode.recompiledBytecode'].join(',');
  const apiUrl = contractUrl + '?fields=' + encodeURIComponent(fields);
  const result = await request(apiUrl);
  assert.equal(result.status, 200, 'Verified sources not published yet');
  const published = result.value;
  assert.equal(published.chainId, String(chainId), 'Published chain does not match release');
  assert.equal(published.address.toLowerCase(), deployment.contractAddress);
  for (const field of ['match', 'creationMatch', 'runtimeMatch']) {
    assert.ok(['match', 'exact_match'].includes(published[field]), 'Source verification incomplete: ' + field);
  }
  assert.equal(published.deployment.transactionHash.toLowerCase(), deployment.transactionHash);
  assert.equal(published.compilation.compilerVersion.replace(/^v/, ''), artifact.metadata.compiler.version);
  assert.equal(published.compilation.fullyQualifiedName, 'src/Pre111K.sol:Pre111K');
  assert.deepEqual(Object.keys(published.sources).sort(), Object.keys(input.sources).sort());
  const sourceSha256 = {};
  for (const [name, source] of Object.entries(published.sources)) {
    assert.equal(source.content, input.sources[name].content, 'Published source differs: ' + name);
    sourceSha256[name] = sha256(source.content);
  }
  assert.equal(published.creationBytecode.onchainBytecode, manifest.creationCode);
  assert.equal(published.creationBytecode.recompiledBytecode, artifact.bytecode.object);
  assert.equal(published.creationBytecode.transformationValues.constructorArguments, manifest.constructorArgs);
  for (const code of [published.runtimeBytecode.onchainBytecode, published.runtimeBytecode.recompiledBytecode]) {
    assert.ok(matchingRuntime(artifact.deployedBytecode.object, code, artifact.deployedBytecode.immutableReferences));
  }
  save('Pre111K.sourcify-published.json', published);
  const report = { chainId, contractAddress: deployment.contractAddress, transactionHash: deployment.transactionHash,
    match: published.match, creationMatch: published.creationMatch, runtimeMatch: published.runtimeMatch,
    compilerVersion: artifact.metadata.compiler.version, metadataHash: input.settings.metadata.bytecodeHash,
    verifiedAt: published.verifiedAt, checkedAt: new Date().toISOString(), sourceSha256,
    creationBytecodeMatch: true, runtimeBytecodeMatch: true, frozenSourcesMatch: true,
    url: 'https://repo.sourcify.dev/' + chainId + '/' + deployment.contractAddress, apiUrl };
  save('Pre111K.sourcify-verification.json', report);
  save('source-manifest.json', { compilerVersion: artifact.metadata.compiler.version, settings: input.settings,
    fullyQualifiedName: 'src/Pre111K.sol:Pre111K', sources: sourceSha256,
    artifactSha256: manifest.artifactSha256, standardInputSha256: manifest.standardInputSha256,
    constructorArgs: manifest.constructorArgs, runtimeBytes: deployment.runtimeBytes, runtimeKeccak256: deployment.runtimeKeccak256 });
  console.log(json(report));
}
