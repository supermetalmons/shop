import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyRepoWipe,
  applyWipePhases,
  assertWipeRegistryConsistency,
} from '../functions/scripts/wipeDrop.ts';
import type { DropFamily } from '../scripts/shared/deploymentRegistry.ts';

const ROOT_A = '11'.repeat(32);
const ROOT_B = '22'.repeat(32);

function drop(
  dropId: string,
  dropFamily: DropFamily = 'card_nft_2',
  discountMerkleRoot = ROOT_A,
) {
  return { dropId, dropFamily, discountMerkleRoot };
}

test('wipe registry validation permits one-sidedness only for the requested target', () => {
  const sibling = drop('sibling');

  assert.doesNotThrow(() =>
    assertWipeRegistryConsistency({
      dropId: 'target',
      frontendDrops: { target: drop('target'), sibling },
      functionsDrops: { sibling },
    }),
  );
  assert.doesNotThrow(() =>
    assertWipeRegistryConsistency({
      dropId: 'target',
      frontendDrops: { sibling },
      functionsDrops: { target: drop('target'), sibling },
    }),
  );

  assert.throws(
    () =>
      assertWipeRegistryConsistency({
        dropId: 'target',
        frontendDrops: { target: drop('target'), sibling },
        functionsDrops: { target: drop('target') },
      }),
    /unrelated drop sibling is missing from the Functions deployment registry/,
  );
});

test('wipe registry validation rejects target and unrelated proof identity mismatches', () => {
  assert.throws(
    () =>
      assertWipeRegistryConsistency({
        dropId: 'target',
        frontendDrops: { target: drop('target') },
        functionsDrops: { target: drop('target', 'little_swag_boxes', ROOT_B) },
      }),
    /target drop target has mismatched discount Merkle references/,
  );

  assert.throws(
    () =>
      assertWipeRegistryConsistency({
        dropId: 'target',
        frontendDrops: { target: drop('target'), sibling: drop('sibling') },
        functionsDrops: {
          target: drop('target'),
          sibling: drop('sibling', 'little_swag_boxes', ROOT_B),
        },
      }),
    /unrelated drop sibling has mismatched discount Merkle references/,
  );
});

function makeRepoPlanFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mons-shop-wipe-recovery-'));
  const frontendConfigPath = path.join(root, 'frontend.ts');
  const functionsConfigPath = path.join(root, 'functions.ts');
  const firstCanonicalPath = path.join(root, 'first.json');
  const secondCanonicalPath = path.join(root, 'second.json');
  const original = {
    frontend: 'frontend-before\n',
    functions: 'functions-before\n',
    firstCanonical: 'first-before\n',
    secondCanonical: 'second-before\n',
  };
  writeFileSync(frontendConfigPath, original.frontend, 'utf8');
  writeFileSync(functionsConfigPath, original.functions, 'utf8');
  writeFileSync(firstCanonicalPath, original.firstCanonical, 'utf8');
  writeFileSync(secondCanonicalPath, original.secondCanonical, 'utf8');

  return {
    root,
    original,
    frontendConfigPath,
    functionsConfigPath,
    firstCanonicalPath,
    secondCanonicalPath,
    plan: {
      frontendConfigPath,
      functionsConfigPath,
      frontendDropsNext: {},
      functionsDropsNext: {},
      frontendConfigWillChange: true,
      functionsConfigWillChange: true,
      targetRegistryState: 'paired' as const,
      canonicalDeleteRelPaths: ['first.json', 'second.json'],
      canonicalDeleteAbsPaths: [firstCanonicalPath, secondCanonicalPath],
      extraReferences: [],
    },
  };
}

test('local wipe restores both registries when the second registry write fails', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const writeError = new Error('Functions registry write failed');

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        writeFrontendRegistry: ({ filePath }) => {
          writeFileSync(filePath, 'frontend-after\n', 'utf8');
        },
        writeFunctionsRegistry: ({ filePath }) => {
          writeFileSync(filePath, 'functions-partial\n', 'utf8');
          throw writeError;
        },
      }),
    (error) => error === writeError,
  );

  assert.equal(readFileSync(fixture.frontendConfigPath, 'utf8'), fixture.original.frontend);
  assert.equal(readFileSync(fixture.functionsConfigPath, 'utf8'), fixture.original.functions);
  assert.equal(readFileSync(fixture.firstCanonicalPath, 'utf8'), fixture.original.firstCanonical);
  assert.equal(readFileSync(fixture.secondCanonicalPath, 'utf8'), fixture.original.secondCanonical);
});

test('local wipe restores registries and canonical files when a deletion fails', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const deleteError = new Error('canonical delete failed');
  let deletes = 0;

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        writeFrontendRegistry: ({ filePath }) => {
          writeFileSync(filePath, 'frontend-after\n', 'utf8');
        },
        writeFunctionsRegistry: ({ filePath }) => {
          writeFileSync(filePath, 'functions-after\n', 'utf8');
        },
        removeFile: (filePath) => {
          rmSync(filePath, { force: true });
          deletes += 1;
          if (deletes === 2) throw deleteError;
        },
      }),
    (error) => error === deleteError,
  );

  assert.equal(readFileSync(fixture.frontendConfigPath, 'utf8'), fixture.original.frontend);
  assert.equal(readFileSync(fixture.functionsConfigPath, 'utf8'), fixture.original.functions);
  assert.equal(readFileSync(fixture.firstCanonicalPath, 'utf8'), fixture.original.firstCanonical);
  assert.equal(readFileSync(fixture.secondCanonicalPath, 'utf8'), fixture.original.secondCanonical);
});

test('local wipe rollback does not overwrite an unreached canonical file', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const deleteError = new Error('first canonical delete failed');
  const unreachedSource = 'second-changed-before-it-was-reached\n';

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        writeFrontendRegistry: ({ filePath }) => {
          writeFileSync(filePath, 'frontend-after\n', 'utf8');
        },
        writeFunctionsRegistry: ({ filePath }) => {
          writeFileSync(filePath, 'functions-after\n', 'utf8');
        },
        removeFile: (filePath) => {
          rmSync(filePath, { force: true });
          writeFileSync(fixture.secondCanonicalPath, unreachedSource, 'utf8');
          throw deleteError;
        },
      }),
    (error) => error === deleteError,
  );

  assert.equal(readFileSync(fixture.frontendConfigPath, 'utf8'), fixture.original.frontend);
  assert.equal(readFileSync(fixture.functionsConfigPath, 'utf8'), fixture.original.functions);
  assert.equal(readFileSync(fixture.firstCanonicalPath, 'utf8'), fixture.original.firstCanonical);
  assert.equal(readFileSync(fixture.secondCanonicalPath, 'utf8'), unreachedSource);
});

test('wipe phases never touch local files after a Firestore failure', async () => {
  const firestoreError = new Error('Firestore wipe failed');
  let repoCalled = false;

  await assert.rejects(
    applyWipePhases({
      applyRepo: () => {
        repoCalled = true;
      },
      applyFirestore: async () => {
        throw firestoreError;
      },
    }),
    (error) => error === firestoreError,
  );
  assert.equal(repoCalled, false);
});

test('wipe phases can retry local mutation after Firestore already succeeded', async () => {
  let repoCalls = 0;
  let firestoreCalls = 0;

  const applyRepo = () => {
    repoCalls += 1;
    if (repoCalls === 1) throw new Error('temporary local failure');
  };
  const applyFirestore = async () => {
    firestoreCalls += 1;
  };

  await assert.rejects(applyWipePhases({ applyRepo, applyFirestore }), /temporary local failure/);

  await applyWipePhases({ applyRepo, applyFirestore });
  assert.equal(repoCalls, 2);
  assert.equal(firestoreCalls, 2);
});
