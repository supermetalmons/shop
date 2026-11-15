import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { applyLocalCacheCleanup, initializeOperationsDirectory, planLocalCacheCleanup } from '../scripts/shared/localArtifacts.ts';
import { runLocalArtifacts } from '../scripts/ops/localArtifacts.ts';

function fixture(t: { after(callback: () => void): void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'local-artifacts-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative: string, value = 'keep') => {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, value);
    return filename;
  };
  return { root, write };
}

test('cache planning is read-only and cleanup removes only manifest-approved downloads', t => {
  const f = fixture(t);
  const cached = f.write('.cache/video-frames/sources/cdn-lil-111k/10.mp4', 'download');
  const protectedFiles = [
    '.operations/111k-new-release/transactions.private.json', '.cache/111k-v17-release/contract/manifest.json',
    '.cache/111k-mainnet-v1-release/recovery/snapshot.json', '.cache/111k-metadata/v17/1.json',
    '.cache/111k-release-locations/v17.json', '.cache/unclassified/1.mp4',
    '.cache/video-frames/sources/cdn-lil-111k/journal.json', '.cache/video-frames/sources/cdn-lil-111k/local.mp4',
    '.cache/video-frames/sources/cdn-lil-111k/999.mp4', '.cache/video-frames/animated/sources/cdn-lil-111k/422.mp4',
    '.cache/video-frames/knives/sources/cdn-lil-111k/3001.glb', '.cache/painting-canvas/sources/cdn-lil-111k/30991.png',
    '.cache/egg-render/sources/cdn-lil-111k/76701.webp',
    'output/video-frames/10.mp4', 'scripts/video-frames/acrylic/presets/08-soft-clear/plate.png',
  ].map(relative => f.write(relative));
  const before = protectedFiles.map(filename => fs.readFileSync(filename));
  const plan = planLocalCacheCleanup(f.root);
  assert.equal(plan.files.length, 1);
  assert.equal(plan.bytes, 8);
  assert.ok(fs.existsSync(cached));
  assert.ok(plan.preserved.includes('.cache/111k-v17-release'));
  assert.deepEqual(applyLocalCacheCleanup(plan), { files: 1, bytes: 8 });
  assert.equal(fs.existsSync(cached), false);
  for (const [index, filename] of protectedFiles.entries()) assert.deepEqual(fs.readFileSync(filename), before[index]);
  assert.equal(planLocalCacheCleanup(f.root).files.length, 0);
});

test('cleanup rejects changed plans before deleting anything', t => {
  const f = fixture(t);
  const first = f.write('.cache/egg-render/sources/cdn-lil-111k/1.webp');
  const second = f.write('.cache/egg-render/sources/cdn-lil-111k/2.webp');
  const plan = planLocalCacheCleanup(f.root);
  fs.writeFileSync(second, 'changed');
  assert.throws(() => applyLocalCacheCleanup(plan), /changed after planning/);
  assert.equal(fs.readFileSync(first, 'utf8'), 'keep');
  assert.equal(fs.readFileSync(second, 'utf8'), 'changed');
});

test('symlinked cache roots are refused and symlinked contents remain untouched', t => {
  const f = fixture(t);
  const original = f.write('private/1.mp4');
  const directory = path.join(f.root, '.cache/video-frames/sources/cdn-lil-111k');
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  fs.symlinkSync(path.dirname(original), directory, 'dir');
  assert.throws(() => planLocalCacheCleanup(f.root), /cannot be a symlink/);
  fs.unlinkSync(directory); fs.mkdirSync(directory);
  fs.symlinkSync(original, path.join(directory, '1.mp4'));
  const plan = planLocalCacheCleanup(f.root);
  assert.equal(plan.files.length, 0);
  applyLocalCacheCleanup(plan);
  assert.ok(fs.lstatSync(path.join(directory, '1.mp4')).isSymbolicLink());
  assert.equal(fs.readFileSync(original, 'utf8'), 'keep');
});

test('cache selection is explicit and CLI writes require --write', t => {
  const f = fixture(t);
  const egg = f.write('.cache/egg-render/sources/cdn-lil-111k/1.webp');
  const knife = f.write('.cache/video-frames/knives/sources/1.glb');
  const currentKnife = f.write('.cache/video-frames/knives/sources/cdn-lil-111k/2.glb');
  runLocalArtifacts(['cache', '--only', 'knife-sources'], f.root);
  assert.ok(fs.existsSync(knife));
  runLocalArtifacts(['cache', '--only', 'knife-sources', '--write'], f.root);
  assert.ok(fs.existsSync(egg));
  assert.ok(fs.existsSync(knife));
  assert.equal(fs.existsSync(currentKnife), false);
  for (const args of [[], ['init', '--write'], ['cache', '--only', 'unknown'], ['cache', '--only', ''],
    ['cache', '--only', 'egg-sources,egg-sources'], ['cache', '--write', '--write'], ['cache', '--only', '../../releases']]) {
    assert.throws(() => runLocalArtifacts(args, f.root));
  }
});

test('operations evidence uses a private directory and never follows an alias', t => {
  const f = fixture(t);
  const directory = initializeOperationsDirectory(f.root);
  assert.equal(directory, path.join(f.root, '.operations'));
  assert.equal(fs.statSync(directory).mode & 0o077, 0);
  assert.equal(initializeOperationsDirectory(f.root), directory);
  fs.chmodSync(directory, 0o755);
  assert.throws(() => initializeOperationsDirectory(f.root), /must be private/);
  fs.rmdirSync(directory);
  fs.symlinkSync(f.root, directory, 'dir');
  assert.throws(() => initializeOperationsDirectory(f.root), /cannot be a symlink/);
});
