import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const firebaseConfig = JSON.parse(
  readFileSync(new URL('../firebase.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

function firestoreDeploySegments(script: string): string[] {
  return script
    .split(/\s*&&\s*/)
    .filter((command) => /^firebase deploy\b/.test(command));
}

test('Firestore deployment targets mons-shop and excludes Cloud Functions', () => {
  const deployCommands = Object.entries(packageJson.scripts).flatMap(([name, script]) =>
    firestoreDeploySegments(script).map((command) => ({ name, command })),
  );
  assert.deepEqual(deployCommands.map(({ name }) => name), [
    'deploy:firestore',
    'deploy:firestore',
  ]);

  for (const { name, command } of deployCommands) {
    assert.match(command, /(?:^|\s)--project mons-shop(?:\s|$)/, `${name} must target mons-shop explicitly`);
    assert.doesNotMatch(command, /(?:^|[,\s])functions(?::[^,\s]+)?(?:[,\s]|$)/);
  }
  assert.equal(packageJson.scripts['deploy:firebase'], undefined);
  assert.equal(packageJson.scripts['deploy:functions'], undefined);
  assert.equal(packageJson.scripts['deploy:firebaseNewDrops'], undefined);
  assert.equal(firebaseConfig.functions, undefined);
  assert.equal(packageJson.dependencies?.['firebase-functions'], undefined);
  assert.equal(packageJson.devDependencies?.['firebase-functions'], undefined);
});

test('Firestore deployment validates rules before indexes and rules releases', () => {
  const segments = packageJson.scripts['deploy:firestore'].split(/\s*&&\s*/);
  assert.deepEqual(segments, [
    'npm run test:firestore-rules',
    'firebase deploy --project mons-shop --only firestore:indexes',
    'firebase deploy --project mons-shop --only firestore:rules',
  ]);
});
