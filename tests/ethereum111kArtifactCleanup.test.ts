import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { artifactInventory, pruneArtifacts } from '../scripts/ops/pruneRetired111kArtifacts.mjs';

const currentContract = '0x938b6a488951b2797b29284d6939dd70efe146a0';
const oldContract = '0xe665d1043f72886f49894006ea196450b33f0f89';
const hash = (filename: string) => createHash('sha256').update(readFileSync(filename)).digest('hex');

function fixture(t: { after: (callback: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), '111k-artifact-pruning-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const roots = { repository: join(directory, 'repository'), home: join(directory, 'home') };
  for (const root of Object.values(roots)) mkdirSync(root);
  const write = (relative: string, body: string, root: keyof typeof roots = 'repository') => {
    const filename = join(roots[root], relative);
    mkdirSync(dirname(filename), { recursive: true });
    writeFileSync(filename, body);
    return filename;
  };
  const artifact = (relative: string, root: keyof typeof roots = 'repository') => ({
    root, path: relative, kind: 'file', inventory: artifactInventory(join(roots[root], relative)),
    sha256: hash(join(roots[root], relative)),
  });
  const manifest = (artifacts: unknown[]) => ({ version: 1, protectedContract: currentContract, artifacts });
  return { roots, write, artifact, manifest };
}

test('artifact pruning previews exact targets, preserves current state, and resumes after deletion', t => {
  const f = fixture(t);
  const target = f.write('.cache/111k-v4-build.log', 'old log');
  const current = f.write('.cache/111k-v16-release/contract/transactions.private.json', 'current signed evidence');
  const manifest = f.manifest([f.artifact('.cache/111k-v4-build.log')]);
  assert.equal(pruneArtifacts(manifest, f.roots).artifacts[0].status, 'ready');
  assert.ok(existsSync(target));
  assert.equal(pruneArtifacts(manifest, f.roots, true).artifacts[0].status, 'removed');
  assert.equal(readFileSync(current, 'utf8'), 'current signed evidence');
  assert.equal(pruneArtifacts(manifest, f.roots, true).artifacts[0].status, 'absent');
});

test('every artifact is checked before the first deletion', t => {
  const f = fixture(t);
  const first = f.write('.cache/111k-v4-build.log', 'first');
  const second = f.write('.cache/111k-v4-e2e.log', 'second');
  const manifest = f.manifest([f.artifact('.cache/111k-v4-build.log'), f.artifact('.cache/111k-v4-e2e.log')]);
  writeFileSync(second, 'edited');
  assert.throws(() => pruneArtifacts(manifest, f.roots, true), /content changed/);
  assert.ok(existsSync(first));
  assert.ok(existsSync(second));
});

test('current collections and paths outside the fixed retirement scope cannot be targeted', t => {
  const f = fixture(t);
  for (const relative of ['releases/111k-sepolia-v16', '.cache/111k-v16-release/contract',
    'onchain/ethereum/.local/pre111k-mainnet-v2', '.cache', '../escape']) {
    assert.throws(() => pruneArtifacts(f.manifest([{ root: 'repository', path: relative }]), f.roots, true),
      /scope|Invalid artifact path/);
  }
  assert.throws(() => pruneArtifacts(f.manifest([{ root: 'home',
    path: '.mons-shop-backups/111k-metadata/2026-10-27-minimal/mainnet' }]), f.roots, true), /Unapproved backup path/);
});

test('artifact pruning refuses symlinks inside an otherwise allowed release tree', t => {
  const f = fixture(t);
  const target = join(f.roots.repository, 'releases/111k-sepolia-v15');
  const evidence = f.write('releases/111k-sepolia-v15/evidence.json', '{}');
  const entry = { root: 'repository', path: 'releases/111k-sepolia-v15', kind: 'directory', inventory: artifactInventory(target) };
  symlinkSync(evidence, join(target, 'external.json'));
  assert.throws(() => pruneArtifacts(f.manifest([entry]), f.roots, true), /Refusing symlink/);
  assert.ok(existsSync(evidence));
});

test('old backups require an unchanged, noncurrent Sepolia identity', t => {
  const f = fixture(t);
  const relative = '.mons-shop-backups/ethereum111k/old.json';
  const filename = f.write(relative, JSON.stringify({ scope: { chainId: 11155111, contractAddress: oldContract } }), 'home');
  const artifact = f.artifact(relative, 'home');
  assert.throws(() => pruneArtifacts(f.manifest([artifact]), f.roots, true), /identity guard/);
  const guard = { path: '', sha256: hash(filename), values: { 'scope.chainId': 11155111, 'scope.contractAddress': oldContract } };
  const entry = { ...artifact, guard };
  assert.equal(pruneArtifacts(f.manifest([entry]), f.roots).artifacts[0].status, 'ready');
  assert.throws(() => pruneArtifacts(f.manifest([{ ...entry,
    guard: { ...guard, values: { ...guard.values, 'scope.contractAddress': currentContract } } }]), f.roots, true), /protected/);
  writeFileSync(filename, JSON.stringify({ scope: { chainId: 11155111, contractAddress: currentContract } }));
  assert.throws(() => pruneArtifacts(f.manifest([entry]), f.roots, true), /content changed/);
  assert.ok(existsSync(filename));
});
