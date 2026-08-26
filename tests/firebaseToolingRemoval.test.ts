import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts: Record<string, string>;
};

test('Firebase tooling remains absent from the repository', () => {
  const dependencies = [
    ...Object.keys(packageJson.dependencies || {}),
    ...Object.keys(packageJson.devDependencies || {}),
  ];
  assert.deepEqual(
    dependencies.filter((name) => name === 'firebase' || name.startsWith('firebase-') || name.startsWith('@firebase/')),
    [],
  );
  assert.doesNotMatch(Object.values(packageJson.scripts).join('\n'), /\bfirebase\b/i);
  for (const path of ['firebase.json', '.firebaserc', 'firestore.rules', 'firestore.indexes.json']) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), false, `${path} must stay absent`);
  }
});
