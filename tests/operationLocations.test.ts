import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { operationPathCandidates, prepareOperationPath, resolveOperationPath } from '../scripts/shared/operationLocations.ts';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'operation-locations-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (relative: string) => {
    const filename = path.join(root, relative);
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    writeFileSync(filename, 'original evidence');
    return filename;
  };
  return { root, write };
}

test('operation locations inspect without writing and select new work independently of older operations', t => {
  const f = fixture(t);
  const current = path.join(f.root, '.operations/example/new.json');
  assert.equal(resolveOperationPath(f.root, 'example/new.json'), current);
  assert.equal(existsSync(path.join(f.root, '.operations')), false);
  assert.equal(existsSync(path.join(f.root, '.cache')), false);
  const legacy = f.write('.cache/example/existing.json');
  assert.equal(resolveOperationPath(f.root, 'example/existing.json'), legacy);
  assert.equal(resolveOperationPath(f.root, 'example/new.json'), current);
  assert.equal(readFileSync(legacy, 'utf8'), 'original evidence');
  assert.equal(existsSync(path.join(f.root, '.operations')), false);
});

test('operation locations refuse duplicate evidence even when its bytes match', t => {
  const f = fixture(t);
  const current = f.write('.operations/example/existing.json');
  const legacy = f.write('.cache/example/existing.json');
  assert.throws(() => resolveOperationPath(f.root, 'example/existing.json'), /both .operations and .cache/);
  assert.equal(readFileSync(current, 'utf8'), readFileSync(legacy, 'utf8'));
});

test('operation location preparation creates private new parents without moving legacy evidence', t => {
  const f = fixture(t);
  const legacy = f.write('.cache/example/existing.json');
  prepareOperationPath(f.root, resolveOperationPath(f.root, 'example/existing.json'));
  assert.equal(existsSync(path.join(f.root, '.operations')), false);
  const current = resolveOperationPath(f.root, 'example/new.json');
  prepareOperationPath(f.root, current);
  assert.equal(statSync(path.join(f.root, '.operations')).mode & 0o777, 0o700);
  assert.equal(statSync(path.dirname(current)).mode & 0o777, 0o700);
  assert.equal(existsSync(current), false);
  assert.equal(readFileSync(legacy, 'utf8'), 'original evidence');
  chmodSync(path.join(f.root, '.operations'), 0o755);
  assert.throws(() => prepareOperationPath(f.root, current), /private/);
  assert.equal(statSync(path.join(f.root, '.operations')).mode & 0o777, 0o755);
});

test('operation locations reject traversal and symlinks in either evidence root', t => {
  const f = fixture(t);
  for (const relative of ['', '../outside', '/absolute', 'example/../outside', 'example//file', 'example\\file']) {
    assert.throws(() => operationPathCandidates(f.root, relative), /repository-relative/);
  }
  assert.throws(() => prepareOperationPath(f.root, path.join(f.root, 'output/evidence.json')), /private operation location/);
  const target = f.write('outside/secret.json');
  for (const base of ['.operations', '.cache']) {
    const alias = path.join(f.root, base);
    symlinkSync(path.dirname(target), alias);
    assert.throws(() => resolveOperationPath(f.root, 'example.json'), /symlink/);
    rmSync(alias);
  }
  mkdirSync(path.join(f.root, '.operations'), { mode: 0o700 });
  symlinkSync(target, path.join(f.root, '.operations/example.json'));
  assert.throws(() => resolveOperationPath(f.root, 'example.json'), /symlink/);
  assert.equal(readFileSync(target, 'utf8'), 'original evidence');
});
