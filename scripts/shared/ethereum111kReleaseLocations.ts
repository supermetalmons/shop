import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withMetadataLock } from '../ethereum-metadata/lock.ts';

export type Ethereum111kReleaseScope = { chainId: number; deploymentId: string; contractAddress: string; metadataBaseUri: string };
export type Ethereum111kReleaseLocation = Ethereum111kReleaseScope & { version: 1; directory: string; manifestSha256: string };
type Options = { repositoryRoot?: string; homeRoot?: string; registryDirectory?: string };
const repository = fileURLToPath(new URL('../../', import.meta.url));
const serialized = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const inside = (file: string, directory: string) => file === directory || file.startsWith(`${directory}${path.sep}`);
const releaseFiles = new Set(['manifest.json', 'transactions.private.json', 'deployment.json', 'config.snapshot.json', 'reveal-manifest.json',
  'cleanup-finalization.json', 'cleanup-artifacts.json', 'cleanup-artifacts-progress.json',
  ...['artifact', 'standard-input', 'compiler-output', 'sourcify-request', 'sourcify-submission', 'sourcify-job',
    'sourcify-published', 'sourcify-verification', 'etherscan-request', 'etherscan-submission-response',
    'etherscan-submission', 'etherscan-status', 'etherscan-verification'].map(name => `NFT111K.${name}.json`),
  ...['closed', 'reserved', 'open', 'mint-qa', 'unpack-qa'].map(name => `deployment-${name}.json`)]);

function requireDedicatedContents(directory: string): void {
  for (const name of fs.readdirSync(directory)) {
    const filename = path.join(directory, name);
    const stat = fs.lstatSync(filename);
    if (['operation.lock', 'cleanup-finalization.lock', 'cleanup-artifacts.lock'].includes(name)
      || /^\.(?:operation|cleanup-finalization|cleanup-artifacts)\.lock-[a-zA-Z0-9]+$/.test(name)) {
      assert.ok(stat.isDirectory(), 'Custom release operation lock must be a directory');
      const owners = fs.readdirSync(filename);
      assert.ok(owners.length === 1 && /^[a-f0-9-]{36}\.json$/.test(owners[0]), 'Custom release operation lock is not recognized');
      assert.ok(fs.lstatSync(path.join(filename, owners[0])).isFile(), 'Custom release lock owner cannot be a symlink');
      const owner = JSON.parse(fs.readFileSync(path.join(filename, owners[0]), 'utf8'));
      assert.ok(Object.keys(owner).sort().join(',') === 'host,id,pid' && `${owner.id}.json` === owners[0]
        && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.host === 'string',
        'Custom release operation lock is not recognized');
      continue;
    }
    const original = name.replace(/\.[a-f0-9-]{36}\.tmp$/, '').replace(/^(cleanup-finalization\.json)\.tmp$/, '$1');
    assert.ok(stat.isFile() && (releaseFiles.has(original) || /^cleanup-artifacts-[a-f0-9]{16}\.jsonl$/.test(original)),
      `Custom release directory contains unrelated or unsafe contents: ${name}`);
    if (name.endsWith('.json')) {
      const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
      assert.ok(value && typeof value === 'object' && !Array.isArray(value), `Invalid release output: ${name}`);
      assert.ok(!value.crypto && !value.Crypto && !value.privateKey && !value.private_key,
        `Signing keys and keystores must remain outside disposable release directories: ${name}`);
    }
  }
}

function roots(options: Options) {
  return { repository: fs.realpathSync(options.repositoryRoot ?? repository), home: fs.realpathSync(options.homeRoot ?? homedir()) };
}

function requireScope(value: Ethereum111kReleaseScope): Ethereum111kReleaseScope {
  assert.equal(value.chainId, 11155111, 'Only Sepolia release locations can be recorded');
  assert.match(value.deploymentId, /^[a-z0-9][a-z0-9-]{0,63}$/);
  assert.match(value.contractAddress, /^0x[0-9a-f]{40}$/);
  assert.notEqual(value.contractAddress, `0x${'0'.repeat(40)}`);
  assert.equal(value.metadataBaseUri, `https://cdn.mons.shop/111k-sepolia/${value.deploymentId}/`);
  return { chainId: value.chainId, deploymentId: value.deploymentId, contractAddress: value.contractAddress, metadataBaseUri: value.metadataBaseUri };
}

export function inspect111kReleaseLocation(directory: string, expected: Ethereum111kReleaseScope,
  options: Options = {}): Ethereum111kReleaseLocation {
  const scope = requireScope(expected);
  const canonical = fs.realpathSync(directory);
  requireLocationPath(canonical, options);
  const stat = fs.lstatSync(canonical);
  assert.ok(stat.isDirectory() && (stat.mode & 0o077) === 0, 'Release locations must be private directories (mode 0700)');
  const manifestPath = path.join(canonical, 'manifest.json');
  assert.ok(fs.lstatSync(manifestPath).isFile(), 'Release location manifest cannot be a symlink');
  const root = roots(options).repository;
  if (![path.join(root, `.cache/111k-${scope.deploymentId}-release/contract`), path.join(root, `.cache/111k-${scope.deploymentId}-release`),
    path.join(root, `onchain/ethereum/.local/111k-sepolia-${scope.deploymentId}`)].includes(canonical)) requireDedicatedContents(canonical);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const [key, value] of Object.entries(scope)) {
    assert.equal(key === 'metadataBaseUri' ? manifest.metadataBaseUri ?? manifest.metadataBaseURI : manifest[key], value,
      `Release location ${key} does not match the deployment`);
  }
  return { version: 1, ...scope, directory: canonical, manifestSha256: hash(serialized(manifest)) };
}

function requireLocationPath(canonical: string, options: Options): void {
  assert.ok(path.isAbsolute(canonical) && canonical === path.resolve(canonical), 'Release location must be a canonical absolute path');
  const anchors = roots(options);
  assert.ok(![anchors.repository, anchors.home].some(anchor => inside(anchor, canonical)), 'A release location cannot contain the repository or home root');
  if (inside(canonical, anchors.repository)) {
    const relative = path.relative(anchors.repository, canonical);
    assert.ok(relative.startsWith(`.cache${path.sep}`) || relative.startsWith(`onchain${path.sep}ethereum${path.sep}.local${path.sep}`),
      'Release locations inside the repository must use private ignored directories');
  }
}

function registryDirectory(options: Options): string {
  const directory = path.resolve(options.registryDirectory ?? path.join(roots(options).repository, '.cache/111k-release-locations'));
  try {
    assert.ok(fs.lstatSync(directory).isDirectory(), 'Release location registry cannot be a symlink');
    return fs.realpathSync(directory);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return directory; throw error; }
}

function registryPath(scope: Ethereum111kReleaseScope, options: Options): string {
  requireScope(scope);
  return path.join(registryDirectory(options), `${scope.deploymentId}.json`);
}

export function read111kReleaseLocation(expected: Ethereum111kReleaseScope, options: Options = {}): Ethereum111kReleaseLocation | null {
  const filename = registryPath(expected, options);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  assert.ok(stat.isFile(), 'Release location record cannot be a symlink');
  const record = JSON.parse(fs.readFileSync(filename, 'utf8')) as Ethereum111kReleaseLocation;
  assert.equal(record.version, 1);
  for (const [key, value] of Object.entries(requireScope(expected))) assert.equal(record[key as keyof Ethereum111kReleaseLocation], value,
    `Recorded release location ${key} changed`);
  requireLocationPath(record.directory, options);
  assert.match(record.manifestSha256, /^[a-f0-9]{64}$/);
  return record;
}

export async function record111kReleaseLocation(directory: string, expected: Ethereum111kReleaseScope,
  options: Options = {}): Promise<Ethereum111kReleaseLocation> {
  const current = inspect111kReleaseLocation(directory, expected, options);
  let registry = registryDirectory(options);
  fs.mkdirSync(registry, { recursive: true, mode: 0o700 });
  assert.ok(fs.lstatSync(registry).isDirectory(), 'Release location registry cannot be a symlink');
  registry = fs.realpathSync(registry);
  return withMetadataLock(path.join(registry, `${current.deploymentId}.lock`), async () => {
    const previous = read111kReleaseLocation(expected, options);
    if (previous) {
      assert.equal(previous.manifestSha256, current.manifestSha256, 'Frozen release manifest changed at its recorded location');
      if (previous.directory === current.directory) return previous;
      let absent = false;
      try { fs.lstatSync(previous.directory); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        absent = true;
      }
      assert.ok(absent, 'Another recorded release copy still exists; reconcile it before relocating');
    }
    const filename = registryPath(expected, options);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(handle, serialized(current)); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temporary, filename);
    const parent = fs.openSync(registry, 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    return current;
  });
}

export async function resolve111kReleaseLocation(expected: Ethereum111kReleaseScope,
  options: Options & { directory?: string } = {}): Promise<Ethereum111kReleaseLocation> {
  if (options.directory) return record111kReleaseLocation(options.directory, expected, options);
  const recorded = read111kReleaseLocation(expected, options);
  if (recorded) {
    const observed = inspect111kReleaseLocation(recorded.directory, expected, options);
    assert.deepEqual(observed, recorded, 'Recorded release location identity changed');
    return recorded;
  }
  const root = roots(options).repository;
  const candidates = [path.join(root, `.cache/111k-${expected.deploymentId}-release/contract`),
    path.join(root, `.cache/111k-${expected.deploymentId}-release`), path.join(root, `onchain/ethereum/.local/111k-sepolia-${expected.deploymentId}`)];
  const directory = candidates.find(candidate => fs.existsSync(path.join(candidate, 'manifest.json')));
  assert.ok(directory, 'Previous release location is unknown; pass --previous-directory before preparing the replacement');
  return record111kReleaseLocation(directory, expected, options);
}
