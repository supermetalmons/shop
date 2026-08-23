import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
};
const firebaseConfig = JSON.parse(readFileSync(new URL('../firebase.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const functionsSource = readFileSync(new URL('../functions/src/index.ts', import.meta.url), 'utf8');

function firebaseDeploySegments(script: string): string[] {
  return script
    .split(/\s*&&\s*/)
    .filter((command) => /^firebase deploy\b/.test(command));
}

test('Firebase deployment scripts target mons-shop and exclude Cloud Functions', () => {
  const deployCommands = Object.entries(packageJson.scripts).flatMap(([name, script]) =>
    firebaseDeploySegments(script).map((command) => ({ name, command })),
  );
  assert.ok(deployCommands.length > 0);

  for (const { name, command } of deployCommands) {
    assert.match(command, /(?:^|\s)--project mons-shop(?:\s|$)/, `${name} must target mons-shop explicitly`);
    const deploysFunctions = /(?:^|[,\s])functions(?::[^,\s]+)?(?:[,\s]|$)/.test(command);
    assert.equal(deploysFunctions, false, `${name} must not deploy Cloud Functions`);
  }
  assert.equal(packageJson.scripts['deploy:functions'], undefined);
  assert.equal(packageJson.scripts['deploy:firebaseNewDrops'], undefined);
  assert.equal(firebaseConfig.functions, undefined);
  assert.doesNotMatch(functionsSource, /export const processStripeCheckoutFulfillment\b/);
});

test('full Firebase deployment validates rules before indexes and rules releases', () => {
  const segments = packageJson.scripts['deploy:firebase'].split(/\s*&&\s*/);
  assert.deepEqual(segments, [
    'npm run test:firestore-rules',
    'firebase deploy --project mons-shop --only firestore:indexes',
    'firebase deploy --project mons-shop --only firestore:rules',
  ]);
});
