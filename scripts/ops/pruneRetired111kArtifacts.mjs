import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const manifestPath = path.join(repositoryRoot, 'releases/111k-testnet-cleanup-2026-11-08/local-artifacts.json');
const currentContract = '0x938b6a488951b2797b29284d6939dd70efe146a0';
const releaseNames = new Set(['111k-sepolia', '111k-sepolia-discounts', '111k-sepolia-proceeds',
  '111k-sepolia-seaport', '111k-sepolia-offchain', '111k-sepolia-single-contract',
  ...Array.from({ length: 9 }, (_, index) => `111k-sepolia-v${index + 7}`),
  '111k-concurrency-2026-10-30', '111k-lifecycle-2026-10-30', '111k-recovery-2026-10-30',
  '111k-reveal-2026-10-29', '111k-scheduler-index-2026-10-30', '111k-unminted-2026-10-30',
  '111k-validation-2026-10-18']);
const scratchNames = new Set(['old-reveal-manifest.json', 'old-reveal-paused.log',
  'old-reveal-status-before-pause.log', 'verify-old-paused.mjs', 'old-contract-paused.log',
  'reset-id.txt', 'reset-preview.log', 'reset-write.log']);
const hash = value => createHash('sha256').update(value).digest('hex');
const json = filename => JSON.parse(readFileSync(filename, 'utf8'));

function validPath(entry) {
  assert.ok(['repository', 'home'].includes(entry.root), 'Unknown artifact root');
  assert.ok(typeof entry.path === 'string' && !path.isAbsolute(entry.path) &&
    entry.path.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid artifact path');
  if (entry.root === 'home') {
    assert.ok(/^\.mons-shop-backups\/ethereum111k(?:-acceptance|-proceeds-acceptance)?\/[a-z0-9-]+\.json$/.test(entry.path) ||
      entry.path === '.mons-shop-backups/111k-metadata/2026-10-27-minimal/sepolia', 'Unapproved backup path');
    assert.ok(entry.guard, 'Backup identity guard is required');
    const scope = entry.guard.values;
    if (scope.network) assert.equal(scope.network, 'sepolia');
    else {
      assert.equal(scope['scope.chainId'] ?? scope.chainId, 11155111);
      const contract = scope['scope.contractAddress'] ?? scope.oldContract;
      assert.match(contract, /^0x[0-9a-f]{40}$/);
      assert.notEqual(contract, currentContract, 'Current deployment backup is protected');
    }
    return;
  }
  const parts = entry.path.split('/');
  const release = parts.length === 2 && parts[0] === 'releases' && releaseNames.has(parts[1]);
  const scratch = parts.length === 3 && parts[0] === '.cache' && parts[1] === '111k-v16-release' && scratchNames.has(parts[2]);
  const oldLog = /^\.cache\/111k-(?:v4-[a-z0-9-]+\.(?:log|json)|metadata-v4-(?:generate|validate)\.log)$/.test(entry.path);
  assert.ok(release || scratch || oldLog || [
    '.cache/111k-v15-release', '.cache/111k-metadata/final-cdn-v4-2026-11-07',
    'onchain/ethereum/broadcast/Deploy111K.s.sol/11155111', 'onchain/ethereum/.local/deployment.json',
  ].includes(entry.path), 'Artifact is outside the explicit retirement scope');
}

function existingPath(root, relative) {
  let filename = realpathSync(root);
  for (const part of relative.split('/')) {
    filename = path.join(filename, part);
    try { assert.ok(!lstatSync(filename).isSymbolicLink(), `Refusing symlink: ${relative}`); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  return filename;
}

export function artifactInventory(filename) {
  let files = 0;
  let bytes = 0;
  const entries = [];
  const visit = (current, relative) => {
    const stat = lstatSync(current);
    assert.ok(!stat.isSymbolicLink(), `Refusing symlink: ${current}`);
    if (stat.isDirectory()) {
      entries.push(`d\0${relative}\0`);
      for (const name of readdirSync(current).sort()) visit(path.join(current, name), relative ? `${relative}/${name}` : name);
    } else {
      assert.ok(stat.isFile(), `Refusing special file: ${current}`);
      files += 1;
      bytes += stat.size;
      entries.push(`f\0${relative}\0${stat.size}\0`);
    }
  };
  visit(filename, '');
  return { files, bytes, entriesSha256: hash(entries.join('')) };
}

export function inspectArtifact(entry, roots) {
  validPath(entry);
  const filename = existingPath(roots[entry.root], entry.path);
  if (!filename) return { root: entry.root, path: entry.path, status: 'absent', files: 0, bytes: 0 };
  const stat = lstatSync(filename);
  assert.equal(stat.isDirectory() ? 'directory' : 'file', entry.kind, `Artifact kind changed: ${entry.path}`);
  const inventory = artifactInventory(filename);
  assert.deepEqual(inventory, entry.inventory, `Artifact inventory changed: ${entry.path}`);
  if (entry.sha256) assert.equal(hash(readFileSync(filename)), entry.sha256, `Artifact content changed: ${entry.path}`);
  if (entry.guard) {
    assert.ok(entry.guard.path === '' || !path.isAbsolute(entry.guard.path) &&
      entry.guard.path.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid guard path');
    const guardPath = entry.guard.path ? existingPath(filename, entry.guard.path) : filename;
    assert.ok(guardPath, `Missing identity guard: ${entry.path}`);
    assert.equal(hash(readFileSync(guardPath)), entry.guard.sha256, `Identity guard changed: ${entry.path}`);
    const data = json(guardPath);
    for (const [key, expected] of Object.entries(entry.guard.values)) {
      assert.deepEqual(key.split('.').reduce((value, part) => value?.[part], data), expected, `Identity changed: ${entry.path}:${key}`);
    }
  }
  return { root: entry.root, path: entry.path, status: 'ready', ...inventory };
}

export function pruneArtifacts(manifest, roots, write = false) {
  assert.equal(manifest.version, 1);
  assert.equal(manifest.protectedContract, currentContract);
  const keys = manifest.artifacts.map(entry => `${entry.root}:${entry.path}`);
  assert.equal(new Set(keys).size, keys.length, 'Duplicate artifact targets');
  const report = manifest.artifacts.map(entry => inspectArtifact(entry, roots));
  if (write) {
    for (let index = 0; index < manifest.artifacts.length; index++) {
      const entry = manifest.artifacts[index];
      const checked = inspectArtifact(entry, roots);
      if (checked.status === 'absent') continue;
      rmSync(existingPath(roots[entry.root], entry.path), { recursive: true });
      report[index] = { ...checked, status: 'removed' };
    }
  }
  return { write, artifacts: report, files: report.reduce((sum, item) => sum + item.files, 0),
    bytes: report.reduce((sum, item) => sum + item.bytes, 0) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--write',
    'Use node scripts/ops/pruneRetired111kArtifacts.mjs [--write]');
  const config = readFileSync(path.join(repositoryRoot, 'cloud/workers/api/wrangler.jsonc'), 'utf8');
  assert.equal(config.match(/"ETHEREUM_111K_CONTRACT_ADDRESS"\s*:\s*"([^"]+)"/)?.[1], currentContract,
    'Current deployment changed; rebuild the retirement manifest');
  console.log(JSON.stringify(pruneArtifacts(json(manifestPath), { repository: repositoryRoot, home: homedir() },
    process.argv[2] === '--write'), null, 2));
}
