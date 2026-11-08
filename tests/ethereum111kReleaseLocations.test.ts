import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspect111kReleaseLocation, read111kReleaseLocation, record111kReleaseLocation,
  resolve111kReleaseLocation, type Ethereum111kReleaseScope } from '../scripts/shared/ethereum111kReleaseLocations.ts';

const scope: Ethereum111kReleaseScope = { chainId: 11155111, deploymentId: 'v16',
  contractAddress: `0x${'16'.repeat(20)}`, metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/v16/' };

function fixture(t: { after(callback: () => void): void }) {
  const logical = fs.mkdtempSync(path.join(tmpdir(), '111k-release-location-'));
  const directory = fs.realpathSync(logical);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repositoryRoot = path.join(directory, 'repository');
  const homeRoot = path.join(directory, 'home');
  fs.mkdirSync(repositoryRoot); fs.mkdirSync(homeRoot);
  const options = { repositoryRoot, homeRoot };
  const release = (name: string, identity = scope) => {
    const location = path.join(directory, name);
    fs.mkdirSync(location, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(location, 'manifest.json'), JSON.stringify({ version: 1, network: 'sepolia', ...identity }));
    return location;
  };
  return { logical, directory, options, release };
}

test('custom release locations are scoped, canonical, and resolved without scanning home', async t => {
  const f = fixture(t);
  const directory = f.release('custom/private-release');
  await assert.rejects(resolve111kReleaseLocation(scope, f.options), /--previous-directory/);
  const logical = path.join(f.logical, 'custom/private-release');
  const recorded = await resolve111kReleaseLocation(scope, { ...f.options, directory: logical });
  assert.equal(recorded.directory, directory);
  assert.deepEqual(await resolve111kReleaseLocation(scope, f.options), recorded);
  assert.deepEqual(await record111kReleaseLocation(logical, scope, f.options), recorded);
  assert.deepEqual(read111kReleaseLocation(scope, f.options), recorded);
});

test('legacy known locations are indexed after their manifest is verified', async t => {
  const f = fixture(t);
  const directory = f.release('repository/.cache/111k-v16-release/contract');
  assert.equal((await resolve111kReleaseLocation(scope, f.options)).directory, directory);
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ ...scope, contractAddress: `0x${'17'.repeat(20)}` }));
  await assert.rejects(resolve111kReleaseLocation(scope, f.options), /does not match/);
});

test('relocation cannot silently abandon another live copy or change the frozen manifest', async t => {
  const f = fixture(t);
  const first = f.release('first'), second = f.release('second');
  const original = await record111kReleaseLocation(first, scope, f.options);
  await assert.rejects(record111kReleaseLocation(second, scope, f.options), /Another recorded release copy/);
  fs.rmSync(first, { recursive: true });
  fs.symlinkSync(path.join(f.directory, 'missing'), first);
  await assert.rejects(record111kReleaseLocation(second, scope, f.options), /Another recorded release copy/);
  fs.unlinkSync(first);
  const moved = await record111kReleaseLocation(second, scope, f.options);
  assert.equal(moved.directory, second); assert.equal(moved.manifestSha256, original.manifestSha256);
  fs.writeFileSync(path.join(second, 'manifest.json'), JSON.stringify({ version: 1, network: 'sepolia', ...scope, changed: true }));
  await assert.rejects(record111kReleaseLocation(second, scope, f.options), /Frozen release manifest changed/);
});

test('mainnet, root directories, wrong identities, and symlinked manifests are rejected', async t => {
  const f = fixture(t);
  const directory = f.release('private');
  await assert.rejects(record111kReleaseLocation(directory, { ...scope, chainId: 1 }, f.options), /Only Sepolia/);
  for (const root of [f.directory, f.options.repositoryRoot, f.options.homeRoot]) {
    assert.throws(() => inspect111kReleaseLocation(root, scope, f.options), /repository or home root/);
  }
  await assert.rejects(record111kReleaseLocation(directory, { ...scope, contractAddress: `0x${'17'.repeat(20)}` }, f.options), /does not match/);
  const manifest = path.join(directory, 'manifest.json');
  fs.renameSync(manifest, `${manifest}.real`); fs.symlinkSync(`${manifest}.real`, manifest);
  await assert.rejects(record111kReleaseLocation(directory, scope, f.options), /manifest cannot be a symlink/);
});

test('location registry records cannot be replaced through symlinks', async t => {
  const f = fixture(t);
  const directory = f.release('private');
  await record111kReleaseLocation(directory, scope, f.options);
  const filename = path.join(f.options.repositoryRoot, '.cache/111k-release-locations/v16.json');
  const before = fs.readFileSync(filename);
  fs.renameSync(filename, `${filename}.real`); fs.symlinkSync(`${filename}.real`, filename);
  await assert.rejects(record111kReleaseLocation(directory, scope, f.options), /record cannot be a symlink/);
  assert.deepEqual(fs.readFileSync(`${filename}.real`), before);
});

test('custom directories must contain only release outputs and cannot own signing material', async t => {
  const f = fixture(t);
  const directory = f.release('private');
  const unrelated = path.join(directory, 'personal-notes.txt');
  fs.writeFileSync(unrelated, 'unrelated');
  await assert.rejects(record111kReleaseLocation(directory, scope, f.options), /unrelated or unsafe/);
  fs.unlinkSync(unrelated);
  fs.writeFileSync(path.join(directory, 'deployment.json'), JSON.stringify({ version: 3, crypto: { ciphertext: 'private' } }));
  await assert.rejects(record111kReleaseLocation(directory, scope, f.options), /Signing keys and keystores/);
  assert.equal(read111kReleaseLocation(scope, f.options), null);
});
