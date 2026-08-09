import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
};

function firebaseDeploySegments(script: string): string[] {
  return script
    .split(/\s*&&\s*/)
    .filter((command) => /^firebase deploy\b/.test(command));
}

test('Firebase deployment scripts target mons-shop and keep Functions separate from rules', () => {
  const deployCommands = Object.entries(packageJson.scripts).flatMap(([name, script]) =>
    firebaseDeploySegments(script).map((command) => ({ name, command })),
  );
  assert.ok(deployCommands.length > 0);

  for (const { name, command } of deployCommands) {
    assert.match(command, /(?:^|\s)--project mons-shop(?:\s|$)/, `${name} must target mons-shop explicitly`);
    const deploysFunctions = /(?:^|[,\s])functions(?::[^,\s]+)?(?:[,\s]|$)/.test(command);
    const deploysRules = /(?:^|[,\s])firestore:rules(?:[,\s]|$)/.test(command);
    assert.equal(deploysFunctions && deploysRules, false, `${name} must deploy Functions and rules separately`);
  }
});

test('full Firebase deployment validates rules before ordered backend and rules releases', () => {
  const segments = packageJson.scripts['deploy:firebase'].split(/\s*&&\s*/);
  assert.deepEqual(segments, [
    'npm run test:firestore-rules',
    'firebase deploy --project mons-shop --only firestore:indexes,functions',
    'firebase deploy --project mons-shop --only firestore:rules',
  ]);
});
