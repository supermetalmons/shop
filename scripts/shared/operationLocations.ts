import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { initializeOperationsDirectory } from './localArtifacts.ts';

function inspectPath(root: string, relative: string): boolean {
  let current = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    try {
      const stat = lstatSync(current);
      assert.ok(!stat.isSymbolicLink(), `Operation evidence cannot use a symlink: ${current}`);
      assert.ok(index === parts.length - 1 || stat.isDirectory(), `Operation evidence parent must be a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

function relativePath(value: string): string {
  assert.ok(value && !path.isAbsolute(value) && !value.includes('\\') &&
    value.split('/').every(part => part && part !== '.' && part !== '..'), 'Operation paths must be repository-relative');
  return value;
}

export function operationPathCandidates(repositoryRoot: string, relative: string): [string, string] {
  const root = realpathSync(repositoryRoot);
  relativePath(relative);
  return ['.operations', '.cache'].map(base => {
    const candidate = `${base}/${relative}`;
    inspectPath(root, candidate);
    return path.join(root, candidate);
  }) as [string, string];
}

export function resolveOperationPath(repositoryRoot: string, relative: string): string {
  const candidates = operationPathCandidates(repositoryRoot, relative);
  const exists = candidates.map(candidate => {
    try { lstatSync(candidate); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  });
  assert.ok(!(exists[0] && exists[1]), `Operation evidence exists in both .operations and .cache; preserve both locations and resolve the conflict: ${relative}`);
  return candidates[exists[1] ? 1 : 0];
}

export function prepareOperationPath(repositoryRoot: string, filename: string): void {
  const root = realpathSync(repositoryRoot);
  const relative = relativePath(path.relative(root, filename));
  assert.ok(relative.startsWith('.operations/') || relative.startsWith('.cache/'), 'Operation evidence must use a private operation location');
  inspectPath(root, relative);
  if (relative.startsWith('.operations/')) initializeOperationsDirectory(root);
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  inspectPath(root, relative);
}
