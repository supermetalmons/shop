import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  abortPreparedRepoWipe,
  applyPreparedRepoWipe,
  applyRepoWipe,
  applyWipePhases,
  asFirestoreDocumentId,
  assertRepoWipeRegistryWritable,
  assertWipeRegistryConsistency,
  buildRepoPlan,
  normalizeStoredDropIdField,
  prepareRepoWipe,
  RepoWipePostCommitCleanupError,
  type RepoPlan,
} from '../functions/scripts/wipeDrop.ts';
import {
  DeploymentRegistryPostCommitVerificationError,
  type DropFamily,
} from '../scripts/shared/deploymentRegistry.ts';

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

test('Firestore document IDs remain exact while stored dropId fields normalize permissively', () => {
  assert.equal(asFirestoreDocumentId('Legacy.Drop-V1'), 'Legacy.Drop-V1');
  assert.equal(asFirestoreDocumentId(' drop with spaces '), ' drop with spaces ');
  assert.equal(asFirestoreDocumentId(''), undefined);
  assert.equal(asFirestoreDocumentId(null), undefined);

  assert.equal(
    normalizeStoredDropIdField(' Legacy.Drop-V1 '),
    'legacy.drop-v1',
  );
  assert.equal(normalizeStoredDropIdField('   '), undefined);
  assert.equal(normalizeStoredDropIdField(123), undefined);
});

function makeRepoPlanFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mons-shop-wipe-recovery-'));
  const registryPath = path.join(root, 'deploymentRegistry.ts');
  const firstCanonicalPath = path.join(root, 'first.json');
  const secondCanonicalPath = path.join(root, 'second.json');
  const original = {
    registry: 'registry-before\n',
    firstCanonical: 'first-before\n',
    secondCanonical: 'second-before\n',
  };
  writeFileSync(registryPath, original.registry, 'utf8');
  writeFileSync(firstCanonicalPath, original.firstCanonical, 'utf8');
  writeFileSync(secondCanonicalPath, original.secondCanonical, 'utf8');
  const fingerprint = (content: string) =>
    createHash('sha256').update(content).digest('hex');

  return {
    root,
    original,
    registryPath,
    firstCanonicalPath,
    secondCanonicalPath,
    plan: {
      registryPath,
      dropsNext: {},
      registryWillChange: true,
      registryExpectedContent: original.registry,
      registryNextContent: 'registry-after\n',
      canonicalDeleteTargets: [
        {
          relativePath: 'first.json',
          absolutePath: firstCanonicalPath,
          expectedSha256: fingerprint(original.firstCanonical),
        },
        {
          relativePath: 'second.json',
          absolutePath: secondCanonicalPath,
          expectedSha256: fingerprint(original.secondCanonical),
        },
      ],
      extraReferences: [],
    } as RepoPlan,
  };
}

function addSharedRecoveryTarget(
  fixture: ReturnType<typeof makeRepoPlanFixture>,
) {
  const relativePath = 'shared.json';
  const absolutePath = path.join(fixture.root, relativePath);
  const digest = createHash('sha256')
    .update(`wipe-drop-quarantine\0${relativePath}`)
    .digest('hex')
    .slice(0, 20);
  const quarantinePath = path.join(
    fixture.root,
    `.${relativePath}.wipe-drop-${digest}`,
    relativePath,
  );
  const quarantineContent = 'shared-before\n';
  mkdirSync(path.dirname(quarantinePath), { recursive: true });
  writeFileSync(quarantinePath, quarantineContent, 'utf8');
  const quarantineStat = lstatSync(quarantinePath);
  fixture.plan.recoveryRestoreTargets = [
    {
      relativePath,
      absolutePath,
      quarantinePath,
      quarantineExpectedSha256: createHash('sha256')
        .update(quarantineContent)
        .digest('hex'),
      quarantineExpectedMode: quarantineStat.mode & 0o7777,
      quarantineExpectedKind: 'file',
    },
  ];
  const manifestPath = path.join(
    fixture.root,
    '.cache',
    'wipe-drop',
    'target.json',
  );
  const manifestContent =
    '{"version":1,"dropId":"target","targets":[]}\n';
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, manifestContent, 'utf8');
  fixture.plan.recoveryManifest = {
    filePath: manifestPath,
    expectedContent: manifestContent,
    content: manifestContent,
  };
  return {
    relativePath,
    absolutePath,
    quarantinePath,
    quarantineContent,
    manifestPath,
    manifestContent,
  };
}

function addNewRecoveryManifest(
  fixture: ReturnType<typeof makeRepoPlanFixture>,
) {
  const filePath = path.join(
    fixture.root,
    '.cache',
    'wipe-drop',
    'target.json',
  );
  const content =
    '{"version":1,"dropId":"target","targets":[]}\n';
  fixture.plan.recoveryManifest = {
    filePath,
    content,
  };
  return { filePath, content };
}

test('prepared repository wipes are immutable full snapshots', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const prepared = prepareRepoWipe(fixture.plan);

  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.canonicalDeleteTargets), true);
  prepared.canonicalDeleteTargets.forEach((target) => {
    assert.equal(Object.isFrozen(target), true);
    assert.equal(Object.isFrozen(target.snapshot), true);
    if (target.snapshot.exists && target.snapshot.kind === 'file') {
      assert.equal(
        Buffer.from(target.snapshot.contentBase64, 'base64').toString('utf8'),
        readFileSync(target.absolutePath, 'utf8'),
      );
    }
  });
});

test('local wipe makes its journal and quarantines durable before the registry write', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifest = addNewRecoveryManifest(fixture);
  const events: string[] = [];

  applyRepoWipe(fixture.plan, {
    stageFile: (sourcePath, stagedPath) => {
      events.push(`stage:${path.basename(sourcePath)}`);
      renameSync(sourcePath, stagedPath);
    },
    syncFile: (filePath) => {
      events.push(`sync-file:${path.basename(filePath)}`);
    },
    syncDirectory: (directoryPath) => {
      events.push(`sync-dir:${directoryPath}`);
    },
    writeRegistry: ({ filePath, nextContent }) => {
      events.push('write:registry');
      assert.equal(existsSync(fixture.firstCanonicalPath), false);
      assert.equal(existsSync(fixture.secondCanonicalPath), false);
      writeFileSync(filePath, nextContent, 'utf8');
    },
  });

  const manifestSyncIndex = events.indexOf(
    `sync-file:${path.basename(manifest.filePath)}`,
  );
  const firstStageIndex = events.indexOf('stage:first.json');
  const firstQuarantineSyncIndex = events.indexOf(
    'sync-file:first.json',
  );
  const registryWriteIndex = events.indexOf('write:registry');
  assert.ok(manifestSyncIndex >= 0);
  assert.ok(manifestSyncIndex < firstStageIndex);
  assert.ok(firstStageIndex < firstQuarantineSyncIndex);
  assert.ok(firstQuarantineSyncIndex < registryWriteIndex);
  assert.equal(
    events
      .slice(firstQuarantineSyncIndex, registryWriteIndex)
      .includes(`sync-dir:${fixture.root}`),
    true,
  );
});

test('local wipe aborts before staging when its recovery journal cannot be made durable', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifest = addNewRecoveryManifest(fixture);
  const durabilityError = new Error('journal fsync failed');
  let injected = false;
  let stages = 0;
  let registryWrites = 0;

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        stageFile: () => {
          stages += 1;
        },
        syncFile: (filePath) => {
          if (
            !injected &&
            filePath === manifest.filePath
          ) {
            injected = true;
            throw durabilityError;
          }
        },
        writeRegistry: () => {
          registryWrites += 1;
        },
      }),
    (error) => error === durabilityError,
  );

  assert.equal(stages, 0);
  assert.equal(registryWrites, 0);
  assert.equal(existsSync(manifest.filePath), false);
  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    fixture.original.firstCanonical,
  );
});

test('local wipe aborts before staging when its journal directory cannot be made durable', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifest = addNewRecoveryManifest(fixture);
  const durabilityError = new Error('journal directory fsync failed');
  let injected = false;
  let stages = 0;
  let registryWrites = 0;

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        stageFile: () => {
          stages += 1;
        },
        syncDirectory: (directoryPath) => {
          if (
            !injected &&
            directoryPath === path.dirname(manifest.filePath)
          ) {
            injected = true;
            throw durabilityError;
          }
        },
        writeRegistry: () => {
          registryWrites += 1;
        },
      }),
    (error) => error === durabilityError,
  );

  assert.equal(stages, 0);
  assert.equal(registryWrites, 0);
  assert.equal(existsSync(manifest.filePath), false);
});

test('local wipe rolls back and skips the registry when quarantine durability fails', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const durabilityError = new Error('quarantine fsync failed');
  let injected = false;
  let registryWrites = 0;

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        syncFile: (filePath) => {
          if (
            !injected &&
            filePath.includes('.wipe-drop-')
          ) {
            injected = true;
            throw durabilityError;
          }
        },
        writeRegistry: () => {
          registryWrites += 1;
        },
      }),
    (error) => error === durabilityError,
  );

  assert.equal(registryWrites, 0);
  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    fixture.original.firstCanonical,
  );
  assert.equal(
    readFileSync(fixture.secondCanonicalPath, 'utf8'),
    fixture.original.secondCanonical,
  );
});

test('local wipe removes an uncommitted staging directory when its parent sync fails', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const durabilityError = new Error('staging parent fsync failed');
  const prepared = prepareRepoWipe(fixture.plan);
  const firstTarget = prepared.canonicalDeleteTargets[0];
  const stagedDirectory = path.dirname(firstTarget.quarantinePath);
  let injected = false;
  let registryWrites = 0;

  assert.throws(
    () =>
      applyPreparedRepoWipe(prepared, {
        syncDirectory: (directoryPath) => {
          if (
            !injected &&
            directoryPath === path.dirname(stagedDirectory) &&
            existsSync(stagedDirectory)
          ) {
            injected = true;
            throw durabilityError;
          }
        },
        writeRegistry: () => {
          registryWrites += 1;
        },
      }),
    (error) =>
      error === durabilityError ||
      (
        error instanceof Error &&
        error.cause === durabilityError
      ),
  );

  assert.equal(injected, true);
  assert.equal(registryWrites, 0);
  assert.equal(existsSync(stagedDirectory), false);
  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    fixture.original.firstCanonical,
  );
});

test('recovery persistence reports a failed preferred copy and its durable fallback', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const prepared = prepareRepoWipe(fixture.plan);
  const quarantinePath =
    prepared.canonicalDeleteTargets[0].quarantinePath;
  let removeFaultInjected = false;
  let preferredSyncFaultInjected = false;
  let caughtError: RepoWipePostCommitCleanupError | undefined;

  try {
    applyPreparedRepoWipe(prepared, {
      removeFile: (filePath) => {
        if (!removeFaultInjected) {
          removeFaultInjected = true;
          throw new Error('retirement unlink failed');
        }
        unlinkSync(filePath);
      },
      syncFile: (filePath) => {
        if (
          removeFaultInjected &&
          filePath === quarantinePath
        ) {
          preferredSyncFaultInjected = true;
          throw new Error('preferred recovery fsync failed');
        }
      },
    });
  } catch (error) {
    if (error instanceof RepoWipePostCommitCleanupError) {
      caughtError = error;
    } else {
      throw error;
    }
  }

  assert.ok(caughtError);
  assert.equal(preferredSyncFaultInjected, true);
  assert.equal(existsSync(quarantinePath), true);
  assert.equal(existsSync(`${quarantinePath}.prepared`), true);
  assert.equal(
    caughtError.uncertainPaths.includes(quarantinePath),
    true,
  );
  assert.equal(caughtError.recoveryPaths.includes(quarantinePath), false);
  assert.equal(
    caughtError.recoveryPaths.includes(`${quarantinePath}.prepared`),
    true,
  );
});

test('recovery directory fsync failure cleans the partial chain before fallback retry', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const prepared = prepareRepoWipe(fixture.plan);
  const target = prepared.canonicalDeleteTargets[1];
  const quarantinePath = target.quarantinePath;
  let writerFailed = false;
  let rollbackSyncFailed = false;
  let parentSyncFailed = false;

  assert.throws(
    () =>
      applyPreparedRepoWipe(prepared, {
        writeRegistry: () => {
          writerFailed = true;
          throw new Error('registry write failed');
        },
        syncFile: (filePath) => {
          if (
            writerFailed &&
            !rollbackSyncFailed &&
            filePath === target.absolutePath
          ) {
            rollbackSyncFailed = true;
            rmSync(path.dirname(quarantinePath), {
              recursive: true,
              force: true,
            });
            throw new Error('rollback canonical fsync failed');
          }
        },
        syncDirectory: (directoryPath) => {
          if (
            rollbackSyncFailed &&
            !parentSyncFailed &&
            directoryPath === fixture.root
          ) {
            parentSyncFailed = true;
            throw new Error('recovery parent fsync failed');
          }
        },
      }),
    /rollback was incomplete/,
  );

  assert.equal(parentSyncFailed, true);
  assert.equal(existsSync(quarantinePath), false);
  assert.equal(existsSync(`${quarantinePath}.prepared`), true);
});

test('post-commit cleanup durability failures never roll back the registry', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const durabilityError = new Error('retirement directory fsync failed');
  let registryCommitted = false;
  let removedRetirement = false;
  let injected = false;

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        writeRegistry: ({ filePath, nextContent }) => {
          writeFileSync(filePath, nextContent, 'utf8');
          registryCommitted = true;
        },
        removeFile: (filePath) => {
          unlinkSync(filePath);
          removedRetirement = true;
        },
        syncDirectory: () => {
          if (
            registryCommitted &&
            removedRetirement &&
            !injected
          ) {
            injected = true;
            throw durabilityError;
          }
        },
      }),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError,
  );

  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.plan.registryNextContent,
  );
  assert.equal(existsSync(fixture.firstCanonicalPath), false);
  assert.equal(existsSync(fixture.secondCanonicalPath), false);
});

test('post-removal journal restoration durably recreates each parent directory', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifest = addNewRecoveryManifest(fixture);
  const restoreDirectorySyncs: string[] = [];
  let postRemovalRecheck = false;

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        pathEntryExists: (filePath) => {
          if (
            filePath === fixture.firstCanonicalPath &&
            !existsSync(manifest.filePath)
          ) {
            postRemovalRecheck = true;
            return true;
          }
          return existsSync(filePath);
        },
        syncDirectory: (directoryPath) => {
          if (postRemovalRecheck) {
            restoreDirectorySyncs.push(directoryPath);
          }
        },
      }),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError &&
      error.residualPaths.includes('first.json'),
  );

  assert.equal(existsSync(manifest.filePath), true);
  assert.deepEqual(
    restoreDirectorySyncs.slice(0, 3),
    [
      fixture.root,
      path.join(fixture.root, '.cache'),
      path.dirname(manifest.filePath),
    ],
  );
});

test('journal unlink followed by directory fsync failure restores the journal', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifest = addNewRecoveryManifest(fixture);
  const durabilityError = new Error(
    'journal retirement directory fsync failed',
  );
  let registryCommitted = false;
  let injected = false;

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        writeRegistry: ({ filePath, nextContent }) => {
          writeFileSync(filePath, nextContent, 'utf8');
          registryCommitted = true;
        },
        syncDirectory: (directoryPath) => {
          if (
            registryCommitted &&
            !injected &&
            path.basename(directoryPath).startsWith(
              `.${path.basename(manifest.filePath)}.wipe-drop-retire-`,
            ) &&
            readdirSync(directoryPath).length === 0
          ) {
            injected = true;
            throw durabilityError;
          }
        },
      }),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError,
  );

  assert.equal(injected, true);
  assert.equal(existsSync(manifest.filePath), true);
  assert.equal(
    readFileSync(manifest.filePath, 'utf8'),
    manifest.content,
  );
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.plan.registryNextContent,
  );
  assert.equal(existsSync(fixture.firstCanonicalPath), false);
  assert.equal(existsSync(fixture.secondCanonicalPath), false);
});

test('journal retirement directory fsync failure leaves no unreported temp directory', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifest = addNewRecoveryManifest(fixture);
  const manifestDirectory = path.dirname(manifest.filePath);
  let registryCommitted = false;
  let injected = false;

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        writeRegistry: ({ filePath, nextContent }) => {
          writeFileSync(filePath, nextContent, 'utf8');
          registryCommitted = true;
        },
        syncDirectory: (directoryPath) => {
          if (
            registryCommitted &&
            !injected &&
            directoryPath === manifestDirectory &&
            existsSync(manifest.filePath) &&
            readdirSync(manifestDirectory).some((entry) =>
              entry.startsWith(
                `.${path.basename(manifest.filePath)}.wipe-drop-retire-`,
              ),
            )
          ) {
            injected = true;
            throw new Error(
              'journal retirement parent fsync failed',
            );
          }
        },
      }),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError,
  );

  assert.equal(injected, true);
  assert.equal(existsSync(manifest.filePath), true);
  assert.equal(
    readdirSync(manifestDirectory).some((entry) =>
      entry.startsWith(
        `.${path.basename(manifest.filePath)}.wipe-drop-retire-`,
      ),
    ),
    false,
  );
});

test('local wipe stages canonical files before the registry write and restores them when that write fails', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const writeError = new Error('canonical registry write failed');
  const events: string[] = [];
  const durabilityEvents: string[] = [];

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        stageFile: (sourcePath, stagedPath) => {
          events.push(`stage:${path.basename(sourcePath)}`);
          renameSync(sourcePath, stagedPath);
        },
        removeFile: (filePath) => {
          events.push(`remove:${path.basename(filePath)}`);
          durabilityEvents.push(`remove:${filePath}`);
          unlinkSync(filePath);
        },
        syncFile: (filePath) => {
          durabilityEvents.push(`sync-file:${filePath}`);
        },
        syncDirectory: (directoryPath) => {
          durabilityEvents.push(`sync-dir:${directoryPath}`);
        },
        writeRegistry: () => {
          events.push('write:registry');
          assert.equal(existsSync(fixture.firstCanonicalPath), false);
          assert.equal(existsSync(fixture.secondCanonicalPath), false);
          throw writeError;
        },
      }),
    (error) => error === writeError,
  );

  assert.deepEqual(events, [
    'stage:first.json',
    'stage:second.json',
    'write:registry',
    'remove:second.json',
    'remove:first.json',
  ]);
  assert.equal(readFileSync(fixture.registryPath, 'utf8'), fixture.original.registry);
  assert.equal(readFileSync(fixture.firstCanonicalPath, 'utf8'), fixture.original.firstCanonical);
  assert.equal(readFileSync(fixture.secondCanonicalPath, 'utf8'), fixture.original.secondCanonical);
  for (const canonicalPath of [
    fixture.firstCanonicalPath,
    fixture.secondCanonicalPath,
  ]) {
    const canonicalSyncIndex = durabilityEvents.indexOf(
      `sync-file:${canonicalPath}`,
    );
    const quarantineRemoveIndex = durabilityEvents.findIndex(
      (event) =>
        event.startsWith('remove:') &&
        path.basename(event.slice('remove:'.length)) ===
          path.basename(canonicalPath),
    );
    assert.ok(canonicalSyncIndex >= 0);
    assert.ok(canonicalSyncIndex < quarantineRemoveIndex);
  }
});

test('registry rollback preserves a staged regular file inode and its hard links', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const hardLinkPath = path.join(fixture.root, 'first-hard-link.json');
  linkSync(fixture.firstCanonicalPath, hardLinkPath);
  const originalStat = lstatSync(fixture.firstCanonicalPath);
  const writeError = new Error('canonical registry write failed');

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        writeRegistry: () => {
          throw writeError;
        },
      }),
    (error) => error === writeError,
  );

  const canonicalStat = lstatSync(fixture.firstCanonicalPath);
  const hardLinkStat = lstatSync(hardLinkPath);
  assert.equal(canonicalStat.dev, originalStat.dev);
  assert.equal(canonicalStat.ino, originalStat.ino);
  assert.equal(hardLinkStat.dev, originalStat.dev);
  assert.equal(hardLinkStat.ino, originalStat.ino);
  assert.equal(canonicalStat.nlink, 2);
  assert.equal(
    readFileSync(hardLinkPath, 'utf8'),
    fixture.original.firstCanonical,
  );
});

test('registry rollback fails closed when the filesystem cannot restore a hard link', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const prepared = prepareRepoWipe(fixture.plan);
  const writeError = new Error('canonical registry write failed');
  const linkError = Object.assign(
    new Error('hard links are unsupported'),
    { code: 'ENOTSUP' },
  );

  assert.throws(
    () =>
      applyPreparedRepoWipe(prepared, {
        linkFile: () => {
          throw linkError;
        },
        writeRegistry: () => {
          throw writeError;
        },
      }),
    (error: unknown) =>
      error instanceof Error &&
      /rollback was incomplete/.test(error.message) &&
      error.cause === writeError,
  );

  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.original.registry,
  );
  for (const target of prepared.canonicalDeleteTargets) {
    assert.equal(existsSync(target.absolutePath), false);
    assert.equal(existsSync(target.quarantinePath), true);
  }
});

test('local wipe aborts before deletion when the first target changed after planning', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const changed = 'first-edited-after-plan\n';
  writeFileSync(fixture.firstCanonicalPath, changed, 'utf8');
  let removes = 0;
  let registryWrites = 0;

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        removeFile: () => {
          removes += 1;
        },
        writeRegistry: () => {
          registryWrites += 1;
        },
      }),
    /plan conflict for first\.json: target changed after the plan was prepared/,
  );

  assert.equal(removes, 0);
  assert.equal(registryWrites, 0);
  assert.equal(readFileSync(fixture.firstCanonicalPath, 'utf8'), changed);
  assert.equal(
    readFileSync(fixture.secondCanonicalPath, 'utf8'),
    fixture.original.secondCanonical,
  );
});

test('local wipe preserves a later drifted target, commits the registry, and reports residual cleanup', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const changed = 'second-edited-before-its-delete\n';
  let removes = 0;

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        stageFile: (sourcePath, stagedPath) => {
          renameSync(sourcePath, stagedPath);
          removes += 1;
          if (removes === 1) {
            writeFileSync(fixture.secondCanonicalPath, changed, 'utf8');
          }
        },
      }),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError &&
      error.residualPaths.length === 1 &&
      error.residualPaths[0] === 'second.json',
  );

  assert.equal(removes, 1);
  assert.equal(existsSync(fixture.firstCanonicalPath), false);
  assert.equal(readFileSync(fixture.secondCanonicalPath, 'utf8'), changed);
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.plan.registryNextContent,
  );
});

test('local wipe does not stage an exact-payload inode replacement', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const prepared = prepareRepoWipe(fixture.plan);
  const originalInode = lstatSync(fixture.firstCanonicalPath).ino;
  rmSync(fixture.firstCanonicalPath);
  writeFileSync(
    fixture.firstCanonicalPath,
    fixture.original.firstCanonical,
    'utf8',
  );
  const replacementInode = lstatSync(fixture.firstCanonicalPath).ino;
  assert.notEqual(replacementInode, originalInode);

  assert.throws(
    () => applyPreparedRepoWipe(prepared),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError &&
      error.residualPaths.join(',') === 'first.json',
  );

  assert.equal(lstatSync(fixture.firstCanonicalPath).ino, replacementInode);
  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    fixture.original.firstCanonical,
  );
  assert.equal(existsSync(fixture.secondCanonicalPath), false);
});

test('local wipe quarantines and reports a replacement raced in between identity check and staging', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const prepared = prepareRepoWipe(fixture.plan);
  let replacementInode = 0;

  assert.throws(
    () =>
      applyPreparedRepoWipe(prepared, {
        stageFile: (sourcePath, stagedPath) => {
          if (sourcePath === fixture.firstCanonicalPath) {
            rmSync(sourcePath);
            writeFileSync(
              sourcePath,
              fixture.original.firstCanonical,
              'utf8',
            );
            replacementInode = lstatSync(sourcePath).ino;
          }
          renameSync(sourcePath, stagedPath);
        },
      }),
    (error: unknown) => {
      if (!(error instanceof RepoWipePostCommitCleanupError)) return false;
      assert.equal(error.residualPaths.includes('first.json'), true);
      assert.equal(error.recoveryPaths.length >= 1, true);
      assert.equal(lstatSync(error.recoveryPaths[0]).ino, replacementInode);
      return true;
    },
  );

  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    fixture.original.firstCanonical,
  );
});

test('local wipe reports a raced quarantine when an ordinary registry error rolls back owned deletions', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const prepared = prepareRepoWipe(fixture.plan);
  const writerError = new Error('registry write rejected');
  const replacement = 'replacement-raced-into-quarantine\n';

  assert.throws(
    () =>
      applyPreparedRepoWipe(prepared, {
        stageFile: (sourcePath, stagedPath) => {
          if (sourcePath === fixture.firstCanonicalPath) {
            rmSync(sourcePath);
            writeFileSync(sourcePath, replacement, 'utf8');
          }
          renameSync(sourcePath, stagedPath);
        },
        writeRegistry: () => {
          throw writerError;
        },
      }),
    (error: unknown) =>
      error instanceof Error &&
      /rollback was incomplete/.test(error.message) &&
      /preserved recovery entry remains/.test(error.message) &&
      error.cause === writerError,
  );

  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    replacement,
  );
  assert.equal(
    readFileSync(fixture.secondCanonicalPath, 'utf8'),
    fixture.original.secondCanonical,
  );
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.original.registry,
  );
  assert.equal(
    readFileSync(
      prepared.canonicalDeleteTargets[0].quarantinePath,
      'utf8',
    ),
    replacement,
  );
});

test('local wipe treats an already-missing target idempotently but rejects an unsupported target', (t) => {
  const missingFixture = makeRepoPlanFixture();
  const unsupportedFixture = makeRepoPlanFixture();
  t.after(() => {
    rmSync(missingFixture.root, { recursive: true, force: true });
    rmSync(unsupportedFixture.root, { recursive: true, force: true });
  });
  rmSync(missingFixture.firstCanonicalPath);
  rmSync(unsupportedFixture.firstCanonicalPath);
  mkdirSync(unsupportedFixture.firstCanonicalPath);

  assert.doesNotThrow(() => applyRepoWipe(missingFixture.plan));
  assert.equal(existsSync(missingFixture.firstCanonicalPath), false);
  assert.equal(existsSync(missingFixture.secondCanonicalPath), false);
  assert.equal(
    readFileSync(missingFixture.registryPath, 'utf8'),
    missingFixture.plan.registryNextContent,
  );
  assert.throws(
    () => applyRepoWipe(unsupportedFixture.plan),
    /plan conflict for first\.json: target is unreadable or unsupported/,
  );
  assert.equal(
    readFileSync(unsupportedFixture.secondCanonicalPath, 'utf8'),
    unsupportedFixture.original.secondCanonical,
  );
});

test('local wipe removes exact recovery provenance only after complete committed cleanup', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifestPath = path.join(
    fixture.root,
    '.cache',
    'wipe-drop',
    'target.json',
  );
  fixture.plan.recoveryManifest = {
    filePath: manifestPath,
    content: '{"version":1}\n',
  };

  applyRepoWipe(fixture.plan);

  assert.equal(existsSync(manifestPath), false);
  assert.equal(existsSync(fixture.firstCanonicalPath), false);
  assert.equal(existsSync(fixture.secondCanonicalPath), false);
});

test('local wipe retains exact recovery provenance when post-Firestore residual cleanup remains', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifestPath = path.join(
    fixture.root,
    '.cache',
    'wipe-drop',
    'target.json',
  );
  const manifestContent = '{"version":1}\n';
  fixture.plan.recoveryManifest = {
    filePath: manifestPath,
    content: manifestContent,
  };
  const prepared = prepareRepoWipe(fixture.plan);
  writeFileSync(fixture.firstCanonicalPath, 'edited-after-prepare\n', 'utf8');

  assert.throws(
    () => applyPreparedRepoWipe(prepared),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError &&
      error.residualPaths.join(',') === 'first.json',
  );
  assert.equal(readFileSync(manifestPath, 'utf8'), manifestContent);
});

test('local wipe preserves a recovery manifest replaced after the registry commit', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifestPath = path.join(
    fixture.root,
    '.cache',
    'wipe-drop',
    'target.json',
  );
  const preparedContent = '{"version":1,"prepared":true}\n';
  const replacementContent = '{"version":1,"editor":true}\n';
  fixture.plan.recoveryManifest = {
    filePath: manifestPath,
    content: preparedContent,
  };

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        writeRegistry: () => {
          writeFileSync(
            fixture.registryPath,
            fixture.plan.registryNextContent,
            'utf8',
          );
          writeFileSync(
            manifestPath,
            replacementContent,
            'utf8',
          );
        },
      }),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError &&
      error.uncertainPaths.includes(manifestPath) &&
      error.recoveryPaths.includes(`${manifestPath}.prepared`),
  );

  assert.equal(
    readFileSync(manifestPath, 'utf8'),
    replacementContent,
  );
  assert.equal(existsSync(fixture.firstCanonicalPath), false);
  assert.equal(existsSync(fixture.secondCanonicalPath), false);
});

test('wipe registry writability preflight rejects a read-only target before mutations', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root can open read-only files for writing');
    return;
  }
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  chmodSync(fixture.registryPath, 0o444);

  try {
    assert.throws(
      () => assertRepoWipeRegistryWritable(fixture.plan),
      (error: unknown) =>
        error instanceof Error &&
        ['EACCES', 'EPERM'].includes(
          String((error as NodeJS.ErrnoException).code),
        ),
    );
    assert.equal(
      readFileSync(fixture.registryPath, 'utf8'),
      fixture.original.registry,
    );
    assert.equal(
      readFileSync(fixture.firstCanonicalPath, 'utf8'),
      fixture.original.firstCanonical,
    );
  } finally {
    chmodSync(fixture.registryPath, 0o600);
  }
});

test('wipe registry writability preflight still opens the registry when its row is already absent', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root can open read-only files for writing');
    return;
  }
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fixture.plan.registryWillChange = false;
  chmodSync(fixture.registryPath, 0o444);

  try {
    assert.throws(
      () => assertRepoWipeRegistryWritable(fixture.plan),
      (error: unknown) =>
        error instanceof Error &&
        ['EACCES', 'EPERM'].includes(
          String((error as NodeJS.ErrnoException).code),
        ),
    );
  } finally {
    chmodSync(fixture.registryPath, 0o600);
  }
});

test('wipe preparation probes every staging parent before Firestore', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root can create entries in read-only directories');
    return;
  }
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  chmodSync(fixture.root, 0o555);

  try {
    assert.throws(
      () => prepareRepoWipe(fixture.plan),
      (error: unknown) =>
        error instanceof Error &&
        ['EACCES', 'EPERM'].includes(
          String((error as NodeJS.ErrnoException).code),
        ),
    );
  } finally {
    chmodSync(fixture.root, 0o700);
  }

  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    fixture.original.firstCanonical,
  );
  assert.equal(
    readFileSync(fixture.secondCanonicalPath, 'utf8'),
    fixture.original.secondCanonical,
  );
});

test('local wipe keeps deletions when post-commit verification fails but the live registry has exact next bytes', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const committedError = new DeploymentRegistryPostCommitVerificationError(
    fixture.registryPath,
    new Error('pathname replaced after fsync'),
  );

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        removeFile: (filePath) => rmSync(filePath, { force: true }),
        writeRegistry: () => {
          writeFileSync(
            fixture.registryPath,
            fixture.plan.registryNextContent,
            'utf8',
          );
          throw committedError;
        },
      }),
    (error) => error === committedError,
  );

  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.plan.registryNextContent,
  );
  assert.equal(existsSync(fixture.firstCanonicalPath), false);
  assert.equal(existsSync(fixture.secondCanonicalPath), false);
});

test('local wipe prioritizes residual cleanup details when the live registry committed despite a verification error', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const prepared = prepareRepoWipe(fixture.plan);
  const changed = 'first-edited-after-preparation\n';
  writeFileSync(fixture.firstCanonicalPath, changed, 'utf8');
  const committedError = new DeploymentRegistryPostCommitVerificationError(
    fixture.registryPath,
    new Error('verification failed after durable write'),
  );

  assert.throws(
    () =>
      applyPreparedRepoWipe(prepared, {
        removeFile: (filePath) => rmSync(filePath, { force: true }),
        writeRegistry: () => {
          writeFileSync(
            fixture.registryPath,
            fixture.plan.registryNextContent,
            'utf8',
          );
          throw committedError;
        },
      }),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError &&
      error.residualPaths.join(',') === 'first.json' &&
      error.cause === committedError,
  );

  assert.equal(readFileSync(fixture.firstCanonicalPath, 'utf8'), changed);
  assert.equal(existsSync(fixture.secondCanonicalPath), false);
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.plan.registryNextContent,
  );
});

test('local wipe rescans canonical paths recreated during a successful registry write', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const replacement = 'recreated-during-registry-write\n';

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        writeRegistry: () => {
          writeFileSync(
            fixture.registryPath,
            fixture.plan.registryNextContent,
            'utf8',
          );
          writeFileSync(fixture.firstCanonicalPath, replacement, 'utf8');
        },
      }),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError &&
      error.residualPaths.join(',') === 'first.json',
  );

  assert.equal(readFileSync(fixture.firstCanonicalPath, 'utf8'), replacement);
  assert.equal(existsSync(fixture.secondCanonicalPath), false);
});

test('local wipe converts a successful-writer canonical recheck failure into residual cleanup', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const recheckError = new Error('simulated post-write lstat failure');
  let writerReturned = false;

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        writeRegistry: () => {
          writeFileSync(
            fixture.registryPath,
            fixture.plan.registryNextContent,
            'utf8',
          );
          writerReturned = true;
        },
        pathEntryExists: (filePath) => {
          if (
            writerReturned &&
            filePath === fixture.firstCanonicalPath
          ) {
            throw recheckError;
          }
          return existsSync(filePath);
        },
      }),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError &&
      error.residualPaths.join(',') === 'first.json' &&
      error.cause instanceof Error &&
      error.cause.cause === recheckError,
  );

  assert.equal(existsSync(fixture.firstCanonicalPath), false);
  assert.equal(existsSync(fixture.secondCanonicalPath), false);
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.plan.registryNextContent,
  );
});

test('local wipe converts a visible post-commit recheck failure into residual cleanup while retaining the writer cause', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const committedError =
    new DeploymentRegistryPostCommitVerificationError(
      fixture.registryPath,
      new Error('post-commit pathname verification failed'),
    );
  let writerCommitted = false;

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        writeRegistry: () => {
          writeFileSync(
            fixture.registryPath,
            fixture.plan.registryNextContent,
            'utf8',
          );
          writerCommitted = true;
          throw committedError;
        },
        pathEntryExists: (filePath) => {
          if (
            writerCommitted &&
            filePath === fixture.firstCanonicalPath
          ) {
            throw new Error('simulated visible-commit lstat failure');
          }
          return existsSync(filePath);
        },
      }),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError &&
      error.residualPaths.join(',') === 'first.json' &&
      error.cause === committedError,
  );

  assert.equal(existsSync(fixture.firstCanonicalPath), false);
  assert.equal(existsSync(fixture.secondCanonicalPath), false);
});

test('local wipe reconstructs and reports a quarantine that disappears after a visible registry commit', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const prepared = prepareRepoWipe(fixture.plan);
  const firstQuarantine =
    prepared.canonicalDeleteTargets[0].quarantinePath;

  assert.throws(
    () =>
      applyPreparedRepoWipe(prepared, {
        writeRegistry: () => {
          writeFileSync(
            fixture.registryPath,
            fixture.plan.registryNextContent,
            'utf8',
          );
          rmSync(firstQuarantine, { force: true });
        },
      }),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError &&
      error.recoveryPaths.includes(firstQuarantine),
  );

  assert.equal(
    readFileSync(firstQuarantine, 'utf8'),
    fixture.original.firstCanonical,
  );
  assert.equal(existsSync(fixture.firstCanonicalPath), false);
  assert.equal(existsSync(fixture.secondCanonicalPath), false);
});

test('local wipe prioritizes canonical recreation during a typed post-commit registry error', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const replacement = 'recreated-before-postcommit-error\n';
  const committedError = new DeploymentRegistryPostCommitVerificationError(
    fixture.registryPath,
    new Error('verification raced with recreation'),
  );

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        writeRegistry: () => {
          writeFileSync(
            fixture.registryPath,
            fixture.plan.registryNextContent,
            'utf8',
          );
          writeFileSync(fixture.firstCanonicalPath, replacement, 'utf8');
          throw committedError;
        },
      }),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError &&
      error.residualPaths.join(',') === 'first.json' &&
      error.cause === committedError,
  );

  assert.equal(readFileSync(fixture.firstCanonicalPath, 'utf8'), replacement);
  assert.equal(existsSync(fixture.secondCanonicalPath), false);
});

test('local wipe always invokes the optimistic registry writer when the row is already absent', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fixture.plan.registryWillChange = false;
  fixture.plan.registryNextContent = fixture.plan.registryExpectedContent;
  const concurrentRegistryError = new Error(
    'registry row was concurrently reintroduced',
  );
  let registryWrites = 0;

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        writeRegistry: () => {
          registryWrites += 1;
          throw concurrentRegistryError;
        },
      }),
    (error) => error === concurrentRegistryError,
  );

  assert.equal(registryWrites, 1);
  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    fixture.original.firstCanonical,
  );
  assert.equal(
    readFileSync(fixture.secondCanonicalPath, 'utf8'),
    fixture.original.secondCanonical,
  );
});

test('local wipe restores only its deletions when post-commit verification finds a replaced live registry', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const detachedRegistryPath = `${fixture.registryPath}.detached`;
  const editorContent = 'registry-replaced-by-editor\n';
  const committedError = new DeploymentRegistryPostCommitVerificationError(
    fixture.registryPath,
    new Error('pathname replaced after fsync'),
  );

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        removeFile: (filePath) => rmSync(filePath, { force: true }),
        writeRegistry: () => {
          renameSync(fixture.registryPath, detachedRegistryPath);
          writeFileSync(
            detachedRegistryPath,
            fixture.plan.registryNextContent,
            'utf8',
          );
          writeFileSync(fixture.registryPath, editorContent, 'utf8');
          throw committedError;
        },
      }),
    (error) => error === committedError,
  );

  assert.equal(readFileSync(fixture.registryPath, 'utf8'), editorContent);
  assert.equal(
    readFileSync(detachedRegistryPath, 'utf8'),
    fixture.plan.registryNextContent,
  );
  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    fixture.original.firstCanonical,
  );
  assert.equal(
    readFileSync(fixture.secondCanonicalPath, 'utf8'),
    fixture.original.secondCanonical,
  );
});

test('local wipe rolls back deletions when a nominally successful writer leaves different live registry bytes', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const replacementRegistry = 'registry-replaced-after-writer\n';

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        writeRegistry: () => {
          writeFileSync(
            fixture.registryPath,
            replacementRegistry,
            'utf8',
          );
        },
      }),
    /Canonical deployment registry changed after the wipe writer returned/,
  );

  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    replacementRegistry,
  );
  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    fixture.original.firstCanonical,
  );
  assert.equal(
    readFileSync(fixture.secondCanonicalPath, 'utf8'),
    fixture.original.secondCanonical,
  );
});

test('local wipe restores its deletions without recreating a missing live registry after post-commit verification', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const committedError = new DeploymentRegistryPostCommitVerificationError(
    fixture.registryPath,
    new Error('live pathname disappeared'),
  );

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        removeFile: (filePath) => rmSync(filePath, { force: true }),
        writeRegistry: () => {
          rmSync(fixture.registryPath, { force: true });
          throw committedError;
        },
      }),
    (error) => error === committedError,
  );

  assert.equal(existsSync(fixture.registryPath), false);
  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    fixture.original.firstCanonical,
  );
  assert.equal(
    readFileSync(fixture.secondCanonicalPath, 'utf8'),
    fixture.original.secondCanonical,
  );
});

test('local wipe restores canonical files and never writes the registry when staging fails', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const deleteError = new Error('canonical delete failed');
  let deletes = 0;
  let registryWrites = 0;

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        writeRegistry: () => {
          registryWrites += 1;
        },
        stageFile: (sourcePath, stagedPath) => {
          renameSync(sourcePath, stagedPath);
          deletes += 1;
          if (deletes === 2) throw deleteError;
        },
      }),
    (error) => error === deleteError,
  );

  assert.equal(registryWrites, 0);
  assert.equal(readFileSync(fixture.registryPath, 'utf8'), fixture.original.registry);
  assert.equal(readFileSync(fixture.firstCanonicalPath, 'utf8'), fixture.original.firstCanonical);
  assert.equal(readFileSync(fixture.secondCanonicalPath, 'utf8'), fixture.original.secondCanonical);
});

test('local wipe restores an immutable snapshot when a moved staging entry disappears before bookkeeping', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const prepared = prepareRepoWipe(fixture.plan);
  let registryWrites = 0;

  assert.throws(
    () =>
      applyPreparedRepoWipe(prepared, {
        stageFile: (sourcePath, stagedPath) => {
          renameSync(sourcePath, stagedPath);
          unlinkSync(stagedPath);
        },
        writeRegistry: () => {
          registryWrites += 1;
        },
      }),
    /Staged wipe target disappeared before it could be verified: first\.json/,
  );

  assert.equal(registryWrites, 0);
  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    fixture.original.firstCanonical,
  );
  assert.equal(
    readFileSync(fixture.secondCanonicalPath, 'utf8'),
    fixture.original.secondCanonical,
  );
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.original.registry,
  );
});

test('local wipe rolls back a moved target when its staging pathname becomes unreadable during bookkeeping', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const prepared = prepareRepoWipe(fixture.plan);
  const inspectionError = new Error('simulated staging lstat failure');
  let injected = false;
  let registryWrites = 0;

  assert.throws(
    () =>
      applyPreparedRepoWipe(prepared, {
        pathEntryExists: (filePath) => {
          if (
            !injected &&
            filePath ===
              prepared.canonicalDeleteTargets[0].quarantinePath &&
            existsSync(filePath)
          ) {
            injected = true;
            throw inspectionError;
          }
          return existsSync(filePath);
        },
        writeRegistry: () => {
          registryWrites += 1;
        },
      }),
    (error: unknown) =>
      error instanceof Error &&
      /Could not inspect staged wipe target first\.json/.test(
        error.message,
      ) &&
      error.cause === inspectionError,
  );

  assert.equal(injected, true);
  assert.equal(registryWrites, 0);
  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    fixture.original.firstCanonical,
  );
  assert.equal(
    readFileSync(fixture.secondCanonicalPath, 'utf8'),
    fixture.original.secondCanonical,
  );
});

test('local wipe reconciles every quarantine again immediately before the registry write', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const prepared = prepareRepoWipe(fixture.plan);
  const firstQuarantine =
    prepared.canonicalDeleteTargets[0].quarantinePath;
  let stages = 0;
  let registryWrites = 0;

  assert.throws(
    () =>
      applyPreparedRepoWipe(prepared, {
        stageFile: (sourcePath, stagedPath) => {
          renameSync(sourcePath, stagedPath);
          stages += 1;
          if (stages === 2) {
            rmSync(firstQuarantine, { force: true });
          }
        },
        writeRegistry: () => {
          registryWrites += 1;
        },
      }),
    /Owned wipe quarantine disappeared before the registry write; its canonical path was safely restored: first\.json/,
  );

  assert.equal(registryWrites, 0);
  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    fixture.original.firstCanonical,
  );
  assert.equal(
    readFileSync(fixture.secondCanonicalPath, 'utf8'),
    fixture.original.secondCanonical,
  );
  assert.equal(existsSync(firstQuarantine), false);
});

test('pre-writer reconciliation persists the original snapshot when a missing quarantine has a different canonical replacement', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const prepared = prepareRepoWipe(fixture.plan);
  const firstQuarantine =
    prepared.canonicalDeleteTargets[0].quarantinePath;
  const replacement = 'editor-replacement-before-registry\n';
  let stages = 0;
  let registryWrites = 0;

  assert.throws(
    () =>
      applyPreparedRepoWipe(prepared, {
        stageFile: (sourcePath, stagedPath) => {
          renameSync(sourcePath, stagedPath);
          stages += 1;
          if (stages === 2) {
            rmSync(firstQuarantine, { force: true });
            writeFileSync(
              fixture.firstCanonicalPath,
              replacement,
              'utf8',
            );
          }
        },
        writeRegistry: () => {
          registryWrites += 1;
        },
      }),
    (error: unknown) =>
      error instanceof Error &&
      /rollback was incomplete/.test(error.message) &&
      error.message.includes(firstQuarantine),
  );

  assert.equal(registryWrites, 0);
  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    replacement,
  );
  assert.equal(
    readFileSync(firstQuarantine, 'utf8'),
    fixture.original.firstCanonical,
  );
  assert.equal(
    readFileSync(fixture.secondCanonicalPath, 'utf8'),
    fixture.original.secondCanonical,
  );
});

test('writer-error rollback persists the original snapshot when quarantine and canonical race independently', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const prepared = prepareRepoWipe(fixture.plan);
  const firstQuarantine =
    prepared.canonicalDeleteTargets[0].quarantinePath;
  const replacement = 'editor-replacement-during-writer\n';
  const writerError = new Error('registry writer failed');

  assert.throws(
    () =>
      applyPreparedRepoWipe(prepared, {
        writeRegistry: () => {
          rmSync(firstQuarantine, { force: true });
          writeFileSync(
            fixture.firstCanonicalPath,
            replacement,
            'utf8',
          );
          throw writerError;
        },
      }),
    (error: unknown) =>
      error instanceof Error &&
      /rollback was incomplete/.test(error.message) &&
      error.cause === writerError &&
      error.message.includes(firstQuarantine),
  );

  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    replacement,
  );
  assert.equal(
    readFileSync(firstQuarantine, 'utf8'),
    fixture.original.firstCanonical,
  );
  assert.equal(
    readFileSync(fixture.secondCanonicalPath, 'utf8'),
    fixture.original.secondCanonical,
  );
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.original.registry,
  );
});

test('local wipe rollback does not overwrite an unreached canonical file', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const deleteError = new Error('first canonical delete failed');
  const unreachedSource = 'second-changed-before-it-was-reached\n';

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        stageFile: (sourcePath, stagedPath) => {
          renameSync(sourcePath, stagedPath);
          writeFileSync(fixture.secondCanonicalPath, unreachedSource, 'utf8');
          throw deleteError;
        },
      }),
    (error) => error === deleteError,
  );

  assert.equal(readFileSync(fixture.registryPath, 'utf8'), fixture.original.registry);
  assert.equal(readFileSync(fixture.firstCanonicalPath, 'utf8'), fixture.original.firstCanonical);
  assert.equal(readFileSync(fixture.secondCanonicalPath, 'utf8'), unreachedSource);
});

test('local wipe rollback does not overwrite a concurrently recreated deleted file', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const replacementSource = 'first-recreated-by-editor\n';

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        removeFile: (filePath) => {
          rmSync(filePath, { force: true });
        },
        writeRegistry: () => {
          writeFileSync(fixture.firstCanonicalPath, replacementSource, 'utf8');
          throw new Error('registry write failed after editor replacement');
        },
      }),
    /rollback was incomplete/,
  );

  assert.equal(readFileSync(fixture.registryPath, 'utf8'), fixture.original.registry);
  assert.equal(readFileSync(fixture.firstCanonicalPath, 'utf8'), replacementSource);
  assert.equal(readFileSync(fixture.secondCanonicalPath, 'utf8'), fixture.original.secondCanonical);
});

test('local wipe never overwrites a target recreated before the post-delete check', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const replacementSource = 'first-recreated-during-delete\n';

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        stageFile: (sourcePath, stagedPath) => {
          renameSync(sourcePath, stagedPath);
          writeFileSync(sourcePath, replacementSource, 'utf8');
        },
      }),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError &&
      error.residualPaths.join(',') === 'first.json,second.json',
  );

  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    replacementSource,
  );
  assert.equal(
    readFileSync(fixture.secondCanonicalPath, 'utf8'),
    replacementSource,
  );
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.plan.registryNextContent,
  );
});

test('local wipe rollback restores an auxiliary symlink as a symlink', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const targetName = 'first-target.json';
  const targetPath = path.join(fixture.root, targetName);
  rmSync(fixture.firstCanonicalPath, { force: true });
  writeFileSync(targetPath, fixture.original.firstCanonical, 'utf8');
  symlinkSync(targetName, fixture.firstCanonicalPath);
  const syncedRegularFiles: string[] = [];

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        syncFile: (filePath) => {
          syncedRegularFiles.push(filePath);
        },
        writeRegistry: () => {
          throw new Error('registry write failed');
        },
      }),
    /registry write failed/,
  );

  assert.equal(lstatSync(fixture.firstCanonicalPath).isSymbolicLink(), true);
  assert.equal(readlinkSync(fixture.firstCanonicalPath), targetName);
  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    fixture.original.firstCanonical,
  );
  assert.equal(
    syncedRegularFiles.some(
      (filePath) => path.basename(filePath) === 'first.json',
    ),
    false,
  );
});

test('local wipe rollback restores exact auxiliary permission bits', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  chmodSync(fixture.firstCanonicalPath, 0o641);
  chmodSync(fixture.secondCanonicalPath, 0o604);

  assert.throws(
    () =>
      applyRepoWipe(fixture.plan, {
        removeFile: (filePath) => rmSync(filePath, { force: true }),
        writeRegistry: () => {
          throw new Error('registry write failed');
        },
      }),
    /registry write failed/,
  );

  assert.equal(statSync(fixture.firstCanonicalPath).mode & 0o7777, 0o641);
  assert.equal(statSync(fixture.secondCanonicalPath).mode & 0o7777, 0o604);
});

test('local wipe accepts only an exact concurrent recreation during rollback', (t) => {
  const matching = makeRepoPlanFixture();
  const wrongMode = makeRepoPlanFixture();
  const wrongKind = makeRepoPlanFixture();
  t.after(() => {
    rmSync(matching.root, { recursive: true, force: true });
    rmSync(wrongMode.root, { recursive: true, force: true });
    rmSync(wrongKind.root, { recursive: true, force: true });
  });
  for (const fixture of [matching, wrongMode, wrongKind]) {
    chmodSync(fixture.firstCanonicalPath, 0o640);
  }

  const recreateAndFail = (
    fixture: ReturnType<typeof makeRepoPlanFixture>,
    recreate: () => void,
  ) =>
    applyRepoWipe(fixture.plan, {
      removeFile: (filePath) => rmSync(filePath, { force: true }),
      writeRegistry: () => {
        recreate();
        throw new Error('registry write failed');
      },
    });

  assert.throws(
    () =>
      recreateAndFail(matching, () => {
        writeFileSync(
          matching.firstCanonicalPath,
          matching.original.firstCanonical,
          'utf8',
        );
        chmodSync(matching.firstCanonicalPath, 0o640);
      }),
    /^Error: registry write failed$/,
  );
  assert.equal(statSync(matching.firstCanonicalPath).mode & 0o7777, 0o640);

  assert.throws(
    () =>
      recreateAndFail(wrongMode, () => {
        writeFileSync(
          wrongMode.firstCanonicalPath,
          wrongMode.original.firstCanonical,
          'utf8',
        );
        chmodSync(wrongMode.firstCanonicalPath, 0o600);
      }),
    /rollback was incomplete/,
  );
  assert.equal(statSync(wrongMode.firstCanonicalPath).mode & 0o7777, 0o600);

  const symlinkTarget = path.join(wrongKind.root, 'editor-target.json');
  writeFileSync(
    symlinkTarget,
    wrongKind.original.firstCanonical,
    'utf8',
  );
  assert.throws(
    () =>
      recreateAndFail(wrongKind, () => {
        symlinkSync(path.basename(symlinkTarget), wrongKind.firstCanonicalPath);
      }),
    /rollback was incomplete/,
  );
  assert.equal(lstatSync(wrongKind.firstCanonicalPath).isSymbolicLink(), true);
});

test('wipe phases abort preparation drift before Firestore starts', async (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const changed = 'edited-before-prepare\n';
  writeFileSync(fixture.firstCanonicalPath, changed, 'utf8');
  let firestoreCalled = false;

  await assert.rejects(
    applyWipePhases({
      prepareRepo: () => prepareRepoWipe(fixture.plan),
      applyFirestore: async () => {
        firestoreCalled = true;
      },
      applyPreparedRepo: (prepared) => applyPreparedRepoWipe(prepared),
    }),
    /plan conflict for first\.json: target changed after the plan was prepared/,
  );

  assert.equal(firestoreCalled, false);
  assert.equal(readFileSync(fixture.firstCanonicalPath, 'utf8'), changed);
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.original.registry,
  );
});

test('wipe phases never touch local files after a Firestore failure', async (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const firestoreError = new Error('Firestore wipe failed');
  let applyPreparedCalled = false;

  await assert.rejects(
    applyWipePhases({
      prepareRepo: () => prepareRepoWipe(fixture.plan),
      applyFirestore: async () => {
        throw firestoreError;
      },
      applyPreparedRepo: (prepared) => {
        applyPreparedCalled = true;
        applyPreparedRepoWipe(prepared);
      },
    }),
    (error) => error === firestoreError,
  );
  assert.equal(applyPreparedCalled, false);
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.original.registry,
  );
  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    fixture.original.firstCanonical,
  );
  assert.equal(
    readFileSync(fixture.secondCanonicalPath, 'utf8'),
    fixture.original.secondCanonical,
  );
});

test('wipe phases remove a newly prepared recovery journal after a Firestore failure', async (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifestPath = path.join(
    fixture.root,
    '.cache',
    'wipe-drop',
    'target.json',
  );
  fixture.plan.recoveryManifest = {
    filePath: manifestPath,
    content: '{"version":1,"prepared":true}\n',
  };
  const firestoreError = new Error('Firestore wipe failed');

  await assert.rejects(
    applyWipePhases({
      prepareRepo: () => prepareRepoWipe(fixture.plan),
      applyFirestore: async () => {
        assert.equal(existsSync(manifestPath), true);
        throw firestoreError;
      },
      applyPreparedRepo: (prepared) =>
        applyPreparedRepoWipe(prepared),
      abortPreparedRepo: (prepared) =>
        abortPreparedRepoWipe(prepared),
    }),
    (error) => error === firestoreError,
  );

  assert.equal(existsSync(manifestPath), false);
  assert.equal(
    existsSync(path.join(fixture.root, '.cache')),
    false,
  );
  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    fixture.original.firstCanonical,
  );
  assert.equal(
    readFileSync(fixture.secondCanonicalPath, 'utf8'),
    fixture.original.secondCanonical,
  );
});

test('wipe phases preserve drift during Firestore, remove the registry row, and report residual cleanup', async (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const changed = 'edited-while-firestore-was-deleting\n';

  await assert.rejects(
    applyWipePhases({
      prepareRepo: () => prepareRepoWipe(fixture.plan),
      applyFirestore: async () => {
        writeFileSync(fixture.firstCanonicalPath, changed, 'utf8');
      },
      applyPreparedRepo: (prepared) => applyPreparedRepoWipe(prepared),
    }),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError &&
      error.residualPaths.length === 1 &&
      error.residualPaths[0] === 'first.json',
  );

  assert.equal(readFileSync(fixture.firstCanonicalPath, 'utf8'), changed);
  assert.equal(existsSync(fixture.secondCanonicalPath), false);
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.plan.registryNextContent,
  );
});

test('a partial wipe can retry after the registry row and canonical files are already absent', async (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  let firestoreCalls = 0;

  applyRepoWipe(fixture.plan);
  assert.equal(existsSync(fixture.firstCanonicalPath), false);
  assert.equal(existsSync(fixture.secondCanonicalPath), false);

  const retryPlan = {
    ...fixture.plan,
    registryWillChange: false,
    registryExpectedContent: fixture.plan.registryNextContent,
  };
  retryPlan.registryNextContent = retryPlan.registryExpectedContent;

  await applyWipePhases({
    prepareRepo: () => prepareRepoWipe(retryPlan),
    applyFirestore: async () => {
      firestoreCalls += 1;
    },
    applyPreparedRepo: (prepared) => applyPreparedRepoWipe(prepared),
  });

  assert.equal(firestoreCalls, 1);
  assert.equal(existsSync(fixture.firstCanonicalPath), false);
  assert.equal(existsSync(fixture.secondCanonicalPath), false);
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.plan.registryNextContent,
  );
});

test('shared recovery preparation leaves a missing canonical and its adopted quarantine untouched when Firestore fails', async (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const shared = addSharedRecoveryTarget(fixture);
  const quarantineInode = lstatSync(shared.quarantinePath).ino;
  const manifestInode = lstatSync(shared.manifestPath).ino;
  const firestoreError = new Error('Firestore wipe failed');

  await assert.rejects(
    applyWipePhases({
      prepareRepo: () => {
        const prepared = prepareRepoWipe(fixture.plan);
        assert.equal(existsSync(shared.absolutePath), false);
        return prepared;
      },
      applyFirestore: async () => {
        assert.equal(existsSync(shared.absolutePath), false);
        throw firestoreError;
      },
      applyPreparedRepo: (prepared) =>
        applyPreparedRepoWipe(prepared),
      abortPreparedRepo: (prepared) =>
        abortPreparedRepoWipe(prepared),
    }),
    (error) => error === firestoreError,
  );

  assert.equal(existsSync(shared.absolutePath), false);
  assert.equal(lstatSync(shared.quarantinePath).ino, quarantineInode);
  assert.equal(
    readFileSync(shared.quarantinePath, 'utf8'),
    shared.quarantineContent,
  );
  assert.equal(lstatSync(shared.manifestPath).ino, manifestInode);
  assert.equal(
    readFileSync(shared.manifestPath, 'utf8'),
    shared.manifestContent,
  );
});

test('shared recovery preserves a canonical replacement created during Firestore while converging the registry', async (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const shared = addSharedRecoveryTarget(fixture);
  const replacement = 'shared-concurrent-replacement\n';

  await assert.rejects(
    applyWipePhases({
      prepareRepo: () => prepareRepoWipe(fixture.plan),
      applyFirestore: async () => {
        writeFileSync(shared.absolutePath, replacement, 'utf8');
      },
      applyPreparedRepo: (prepared) =>
        applyPreparedRepoWipe(prepared),
    }),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError &&
      error.residualPaths.includes(shared.relativePath) &&
      error.recoveryPaths.includes(shared.quarantinePath),
  );

  assert.equal(
    readFileSync(shared.absolutePath, 'utf8'),
    replacement,
  );
  assert.equal(
    readFileSync(shared.quarantinePath, 'utf8'),
    shared.quarantineContent,
  );
  assert.equal(existsSync(shared.manifestPath), true);
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.plan.registryNextContent,
  );
});

test('shared recovery durability failure aborts before the registry write', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const shared = addSharedRecoveryTarget(fixture);
  const prepared = prepareRepoWipe(fixture.plan);
  const durabilityError = new Error('restored canonical fsync failed');
  let registryWrites = 0;

  assert.throws(
    () =>
      applyPreparedRepoWipe(prepared, {
        syncFile: (filePath) => {
          if (filePath === shared.absolutePath) {
            throw durabilityError;
          }
        },
        writeRegistry: () => {
          registryWrites += 1;
        },
      }),
    (error) => error === durabilityError,
  );

  assert.equal(registryWrites, 0);
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.original.registry,
  );
  assert.equal(existsSync(shared.quarantinePath), true);
});

test('shared recovery makes an adopted quarantine durable before writing the registry', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const shared = addSharedRecoveryTarget(fixture);
  const prepared = prepareRepoWipe(fixture.plan);
  const replacement = 'shared-concurrent-replacement\n';
  writeFileSync(shared.absolutePath, replacement, 'utf8');
  const durabilityError = new Error('adopted quarantine fsync failed');
  let registryWrites = 0;

  assert.throws(
    () =>
      applyPreparedRepoWipe(prepared, {
        syncFile: (filePath) => {
          if (filePath === shared.quarantinePath) {
            throw durabilityError;
          }
        },
        writeRegistry: () => {
          registryWrites += 1;
        },
      }),
    (error) =>
      error === durabilityError ||
      (
        error instanceof Error &&
        error.cause === durabilityError
      ),
  );

  assert.equal(registryWrites, 0);
  assert.equal(
    readFileSync(shared.absolutePath, 'utf8'),
    replacement,
  );
  assert.equal(existsSync(shared.quarantinePath), true);
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.original.registry,
  );
});

test('shared recovery retains its quarantine when the canonical disappears during registry application', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const shared = addSharedRecoveryTarget(fixture);
  const prepared = prepareRepoWipe(fixture.plan);
  assert.equal(existsSync(shared.absolutePath), false);

  assert.throws(
    () =>
      applyPreparedRepoWipe(prepared, {
        writeRegistry: (args) => {
          writeFileSync(
            args.filePath,
            args.nextContent,
            'utf8',
          );
          assert.equal(
            readFileSync(shared.absolutePath, 'utf8'),
            shared.quarantineContent,
          );
          rmSync(shared.absolutePath);
        },
      }),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError &&
      error.residualPaths.includes(shared.relativePath) &&
      error.recoveryPaths.includes(shared.quarantinePath),
  );

  assert.equal(existsSync(shared.absolutePath), false);
  assert.equal(
    readFileSync(shared.quarantinePath, 'utf8'),
    shared.quarantineContent,
  );
  assert.equal(existsSync(shared.manifestPath), true);
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.plan.registryNextContent,
  );
});

test('stable shared recovery restores a missing canonical only after preparation and then converges cleanup', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const shared = addSharedRecoveryTarget(fixture);

  const prepared = prepareRepoWipe(fixture.plan);
  assert.equal(existsSync(shared.absolutePath), false);
  assert.equal(existsSync(shared.quarantinePath), true);

  applyPreparedRepoWipe(prepared);

  assert.equal(
    readFileSync(shared.absolutePath, 'utf8'),
    shared.quarantineContent,
  );
  assert.equal(existsSync(shared.quarantinePath), false);
  assert.equal(existsSync(shared.manifestPath), false);
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.plan.registryNextContent,
  );
});

test('wipe preparation rejects debris in the deterministic staging directory before Firestore', async (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const quarantinePath =
    prepareRepoWipe(fixture.plan).canonicalDeleteTargets[0]
      .quarantinePath;
  mkdirSync(path.dirname(quarantinePath), { recursive: true });
  writeFileSync(`${quarantinePath}.prepared`, 'stale-recovery\n');
  let firestoreCalled = false;

  await assert.rejects(
    applyWipePhases({
      prepareRepo: () => prepareRepoWipe(fixture.plan),
      applyFirestore: async () => {
        firestoreCalled = true;
      },
      applyPreparedRepo: (prepared) =>
        applyPreparedRepoWipe(prepared),
    }),
    /deterministic quarantine directory contains unexpected recovery entries/,
  );

  assert.equal(firestoreCalled, false);
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.original.registry,
  );
  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    fixture.original.firstCanonical,
  );
});

test('a source that disappears before a throwing stage rename is not resurrected by rollback', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const prepared = prepareRepoWipe(fixture.plan);

  applyPreparedRepoWipe(prepared, {
    stageFile: (sourcePath, stagedPath) => {
      if (sourcePath === fixture.firstCanonicalPath) {
        rmSync(sourcePath);
        throw new Error('source disappeared before rename');
      }
      renameSync(sourcePath, stagedPath);
    },
  });

  assert.equal(existsSync(fixture.firstCanonicalPath), false);
  assert.equal(existsSync(fixture.secondCanonicalPath), false);
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.plan.registryNextContent,
  );
});

test('a same-content new-inode quarantine created by a throwing stage adapter is preserved as a conflict', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const prepared = prepareRepoWipe(fixture.plan);
  const firstQuarantine =
    prepared.canonicalDeleteTargets[0].quarantinePath;
  let replacementInode = 0;

  assert.throws(
    () =>
      applyPreparedRepoWipe(prepared, {
        stageFile: (sourcePath, stagedPath) => {
          if (sourcePath === fixture.firstCanonicalPath) {
            rmSync(sourcePath);
            writeFileSync(
              stagedPath,
              fixture.original.firstCanonical,
              'utf8',
            );
            replacementInode = lstatSync(stagedPath).ino;
            throw new Error('replacement raced into quarantine');
          }
          renameSync(sourcePath, stagedPath);
        },
      }),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError &&
      error.residualPaths.includes('first.json') &&
      error.recoveryPaths.includes(firstQuarantine),
  );

  assert.equal(lstatSync(firstQuarantine).ino, replacementInode);
  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    fixture.original.firstCanonical,
  );
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.plan.registryNextContent,
  );
});

test('committed quarantine purge never unlinks a replacement raced into the public quarantine pathname', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const prepared = prepareRepoWipe(fixture.plan);
  const firstQuarantine =
    prepared.canonicalDeleteTargets[0].quarantinePath;
  const preparedRecoveryPath = `${firstQuarantine}.prepared`;
  const replacement = 'replacement-at-purge\n';
  let injected = false;

  assert.throws(
    () =>
      applyPreparedRepoWipe(prepared, {
        removeFile: (retiredPath) => {
          if (!injected && path.basename(retiredPath) === 'first.json') {
            injected = true;
            writeFileSync(firstQuarantine, replacement, 'utf8');
          }
          unlinkSync(retiredPath);
        },
      }),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError &&
      error.recoveryPaths.includes(firstQuarantine) &&
      error.recoveryPaths.includes(preparedRecoveryPath),
  );

  assert.equal(injected, true);
  assert.equal(readFileSync(firstQuarantine, 'utf8'), replacement);
  assert.equal(
    readFileSync(preparedRecoveryPath, 'utf8'),
    fixture.original.firstCanonical,
  );
  assert.equal(existsSync(fixture.firstCanonicalPath), false);
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.plan.registryNextContent,
  );
});

test('rollback quarantine cleanup never unlinks a replacement raced into the public quarantine pathname', (t) => {
  const fixture = makeRepoPlanFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const prepared = prepareRepoWipe(fixture.plan);
  const secondQuarantine =
    prepared.canonicalDeleteTargets[1].quarantinePath;
  const preparedRecoveryPath = `${secondQuarantine}.prepared`;
  const replacement = 'replacement-at-rollback\n';
  const writerError = new Error('registry write failed');
  let injected = false;

  assert.throws(
    () =>
      applyPreparedRepoWipe(prepared, {
        removeFile: (retiredPath) => {
          if (!injected && path.basename(retiredPath) === 'second.json') {
            injected = true;
            writeFileSync(secondQuarantine, replacement, 'utf8');
          }
          unlinkSync(retiredPath);
        },
        writeRegistry: () => {
          throw writerError;
        },
      }),
    (error: unknown) =>
      error instanceof Error &&
      /rollback was incomplete/.test(error.message) &&
      error.cause === writerError,
  );

  assert.equal(injected, true);
  assert.equal(readFileSync(secondQuarantine, 'utf8'), replacement);
  assert.equal(
    readFileSync(preparedRecoveryPath, 'utf8'),
    fixture.original.secondCanonical,
  );
  assert.equal(
    readFileSync(fixture.firstCanonicalPath, 'utf8'),
    fixture.original.firstCanonical,
  );
  assert.equal(
    readFileSync(fixture.secondCanonicalPath, 'utf8'),
    fixture.original.secondCanonical,
  );
  assert.equal(
    readFileSync(fixture.registryPath, 'utf8'),
    fixture.original.registry,
  );
});

function completeRegistryDrop(
  dropId: string,
  dropFamily: 'default' | 'poncho_drifella',
  discountMerkleRoot: string,
) {
  return {
    solanaCluster: 'devnet',
    dropId,
    dropFamily,
    collectionName: dropId,
    metadataBase: `https://assets.example.com/drops/${dropId}`,
    metadataPathFormat: 'compact',
    treasury: 'Treasury11111111111111111111111111111111',
    priceSol: 1,
    discountPriceSol: 0.5,
    discountMintsPerWallet: 1,
    discountMerkleRoot,
    maxSupply: 10,
    itemsPerBox: 1,
    maxPerTx: 5,
    namePrefix: 'box',
    figureNamePrefix: 'figure',
    symbol: 'mons',
    boxMinterProgramId: 'Program1111111111111111111111111111111111',
    collectionMint: 'Collection11111111111111111111111111111111',
    receiptsMerkleTree: 'Tree111111111111111111111111111111111111',
    deliveryLookupTable: 'Lookup1111111111111111111111111111111111',
  };
}

test('untracked legacy Merkle cleanup requires exact journal provenance', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mons-shop-wipe-owned-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const targetDropId = 'poncho_drifella_devnet_x10';
  const targetRoot = '33'.repeat(32);
  const siblingRoot = '44'.repeat(32);
  const registryPath = path.join(
    root,
    'functions',
    'src',
    'shared',
    'deploymentRegistry.ts',
  );
  const legacyRelativePath =
    `src/drops/discountMerkles/${targetDropId}.json`;
  const legacyMerklePath = path.join(root, legacyRelativePath);
  const rows = {
    [targetDropId]: completeRegistryDrop(
      targetDropId,
      'poncho_drifella',
      targetRoot,
    ),
    sibling: completeRegistryDrop(
      'sibling',
      'default',
      siblingRoot,
    ),
  };
  mkdirSync(path.dirname(registryPath), { recursive: true });
  mkdirSync(path.dirname(legacyMerklePath), { recursive: true });
  writeFileSync(
    registryPath,
    [
      '// BEGIN AUTO-GENERATED DEPLOYMENT DROP REGISTRY',
      `export const DEPLOYMENT_DROPS = ${JSON.stringify(rows, null, 2)};`,
      '// END AUTO-GENERATED DEPLOYMENT DROP REGISTRY',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    legacyMerklePath,
    `${JSON.stringify({ root: targetRoot, claims: [] }, null, 2)}\n`,
    'utf8',
  );
  for (const args of [['init'], ['add', '.']]) {
    const result = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }

  const journalSourcePlan = await buildRepoPlan({
    root,
    dropId: targetDropId,
  });
  assert.ok(journalSourcePlan.recoveryManifest);
  assert.equal(
    journalSourcePlan.canonicalDeleteTargets.some(
      (target) => target.relativePath === legacyRelativePath,
    ),
    true,
  );

  const untrackResult = spawnSync(
    'git',
    ['rm', '--cached', '--', legacyRelativePath],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(untrackResult.status, 0, untrackResult.stderr);
  const unownedPlan = await buildRepoPlan({
    root,
    dropId: targetDropId,
  });
  assert.equal(
    unownedPlan.canonicalDeleteTargets.some(
      (target) => target.relativePath === legacyRelativePath,
    ),
    false,
  );

  mkdirSync(
    path.dirname(journalSourcePlan.recoveryManifest.filePath),
    { recursive: true },
  );
  writeFileSync(
    journalSourcePlan.recoveryManifest.filePath,
    journalSourcePlan.recoveryManifest.content,
    'utf8',
  );
  const authenticatedRetryPlan = await buildRepoPlan({
    root,
    dropId: targetDropId,
  });
  assert.equal(
    authenticatedRetryPlan.canonicalDeleteTargets.some(
      (target) => target.relativePath === legacyRelativePath,
    ),
    true,
  );

  const fingerprintlessManifest = JSON.parse(
    journalSourcePlan.recoveryManifest.content,
  ) as {
    targets: Array<Record<string, unknown>>;
  };
  const fingerprintlessLegacyTarget =
    fingerprintlessManifest.targets.find(
      (target) => target.relativePath === legacyRelativePath,
    );
  assert.ok(fingerprintlessLegacyTarget);
  for (const fieldName of [
    'expectedSha256',
    'expectedDevice',
    'expectedInode',
    'expectedMode',
    'expectedKind',
    'expectedSymlinkTarget',
  ]) {
    delete fingerprintlessLegacyTarget[fieldName];
  }
  writeFileSync(
    journalSourcePlan.recoveryManifest.filePath,
    `${JSON.stringify(fingerprintlessManifest, null, 2)}\n`,
    'utf8',
  );
  const fingerprintlessRetryPlan = await buildRepoPlan({
    root,
    dropId: targetDropId,
  });
  assert.equal(
    fingerprintlessRetryPlan.canonicalDeleteTargets.some(
      (target) => target.relativePath === legacyRelativePath,
    ),
    false,
  );

  const legacyTarget =
    journalSourcePlan.canonicalDeleteTargets.find(
      (target) => target.relativePath === legacyRelativePath,
    );
  assert.ok(legacyTarget?.quarantinePath);
  mkdirSync(path.dirname(legacyTarget.quarantinePath), {
    recursive: true,
  });
  renameSync(legacyMerklePath, legacyTarget.quarantinePath);
  await assert.rejects(
    () =>
      buildRepoPlan({
        root,
        dropId: targetDropId,
      }),
    /Wipe quarantine exists without complete recovery provenance/,
  );
  renameSync(legacyTarget.quarantinePath, legacyMerklePath);
  rmSync(path.dirname(legacyTarget.quarantinePath), {
    recursive: true,
    force: true,
  });

  writeFileSync(
    journalSourcePlan.recoveryManifest.filePath,
    journalSourcePlan.recoveryManifest.content,
    'utf8',
  );
  mkdirSync(path.dirname(legacyTarget.quarantinePath), {
    recursive: true,
  });
  renameSync(legacyMerklePath, legacyTarget.quarantinePath);
  unlinkSync(legacyTarget.quarantinePath);
  writeFileSync(
    legacyTarget.quarantinePath,
    `${JSON.stringify(
      { root: targetRoot, claims: [], replacedAfterJournal: true },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await assert.rejects(
    () =>
      buildRepoPlan({
        root,
        dropId: targetDropId,
      }),
    /Wipe quarantine does not match stable recovery provenance/,
  );
  unlinkSync(legacyTarget.quarantinePath);
  writeFileSync(
    legacyMerklePath,
    `${JSON.stringify({ root: targetRoot, claims: [] }, null, 2)}\n`,
    'utf8',
  );
  rmSync(path.dirname(legacyTarget.quarantinePath), {
    recursive: true,
    force: true,
  });

  writeFileSync(
    journalSourcePlan.recoveryManifest.filePath,
    journalSourcePlan.recoveryManifest.content,
    'utf8',
  );
  writeFileSync(
    legacyMerklePath,
    `${JSON.stringify(
      { root: targetRoot, claims: [], changedAfterJournal: true },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const mismatchedRetryPlan = await buildRepoPlan({
    root,
    dropId: targetDropId,
  });
  assert.equal(
    mismatchedRetryPlan.canonicalDeleteTargets.some(
      (target) => target.relativePath === legacyRelativePath,
    ),
    false,
  );
});

test('row-absent retry rejects an untracked canonical Merkle replacement without exact provenance', async (t) => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), 'mons-shop-wipe-canonical-owned-'),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const targetDropId = 'poncho_drifella_devnet_x10';
  const targetRoot = '77'.repeat(32);
  const siblingRoot = '88'.repeat(32);
  const registryPath = path.join(
    root,
    'functions',
    'src',
    'shared',
    'deploymentRegistry.ts',
  );
  const canonicalRelativePath =
    'src/drops/discountMerkles/poncho_drifella.json';
  const canonicalMerklePath = path.join(root, canonicalRelativePath);
  const targetSourcePath = path.join(
    root,
    'src',
    'drops',
    `${targetDropId}.ts`,
  );
  const newDropConfigPath = path.join(
    root,
    'scripts',
    'newDrops',
    `${targetDropId}.ts`,
  );
  const rows = {
    [targetDropId]: completeRegistryDrop(
      targetDropId,
      'poncho_drifella',
      targetRoot,
    ),
    sibling: completeRegistryDrop(
      'sibling',
      'default',
      siblingRoot,
    ),
  };

  mkdirSync(path.dirname(registryPath), { recursive: true });
  mkdirSync(path.dirname(canonicalMerklePath), { recursive: true });
  mkdirSync(path.dirname(newDropConfigPath), { recursive: true });
  writeFileSync(
    registryPath,
    [
      '// BEGIN AUTO-GENERATED DEPLOYMENT DROP REGISTRY',
      `export const DEPLOYMENT_DROPS = ${JSON.stringify(rows, null, 2)};`,
      '// END AUTO-GENERATED DEPLOYMENT DROP REGISTRY',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    canonicalMerklePath,
    `${JSON.stringify({ root: targetRoot, claims: [] }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(targetSourcePath, 'export const drop = true;\n', 'utf8');
  writeFileSync(
    newDropConfigPath,
    `export const NEW_DROP = { onchain: { dropId: '${targetDropId}', dropFamily: 'poncho_drifella' } };\n`,
    'utf8',
  );
  for (const args of [['init'], ['add', '.']]) {
    const result = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }

  const initialPlan = await buildRepoPlan({
    root,
    dropId: targetDropId,
  });
  assert.ok(initialPlan.recoveryManifest);
  assert.equal(
    initialPlan.canonicalDeleteTargets.some(
      (target) => target.relativePath === canonicalRelativePath,
    ),
    true,
  );
  mkdirSync(path.dirname(initialPlan.recoveryManifest.filePath), {
    recursive: true,
  });
  writeFileSync(
    initialPlan.recoveryManifest.filePath,
    initialPlan.recoveryManifest.content,
    'utf8',
  );
  writeFileSync(registryPath, initialPlan.registryNextContent, 'utf8');
  assert.doesNotMatch(
    initialPlan.registryNextContent,
    new RegExp(`\\b${targetDropId}\\b`),
  );

  const untrackResult = spawnSync(
    'git',
    ['rm', '--cached', '--', canonicalRelativePath],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(untrackResult.status, 0, untrackResult.stderr);
  const trackedResult = spawnSync(
    'git',
    ['ls-files', '--', canonicalRelativePath],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(trackedResult.status, 0, trackedResult.stderr);
  assert.equal(trackedResult.stdout, '');
  const replacementContent = `${JSON.stringify(
    {
      root: targetRoot,
      claims: [],
      replacementAfterJournal: true,
    },
    null,
    2,
  )}\n`;
  writeFileSync(canonicalMerklePath, replacementContent, 'utf8');
  const journalTarget = (
    JSON.parse(initialPlan.recoveryManifest.content) as {
      targets: Array<{
        relativePath: string;
        expectedSha256?: string;
      }>;
    }
  ).targets.find(
    (target) => target.relativePath === canonicalRelativePath,
  );
  assert.ok(journalTarget?.expectedSha256);
  assert.notEqual(
    journalTarget.expectedSha256,
    createHash('sha256').update(replacementContent).digest('hex'),
  );
  const canonicalTarget = initialPlan.canonicalDeleteTargets.find(
    (target) => target.relativePath === canonicalRelativePath,
  );
  assert.ok(canonicalTarget?.quarantinePath);
  assert.equal(existsSync(canonicalTarget.quarantinePath), false);

  const retryResult = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      [
        'const { buildRepoPlan } = await import(process.argv[1]);',
        'await buildRepoPlan({ root: process.argv[2], dropId: process.argv[3] });',
      ].join(' '),
      new URL(
        '../functions/scripts/wipeDrop.ts',
        import.meta.url,
      ).href,
      root,
      targetDropId,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.notEqual(retryResult.status, 0);
  assert.match(
    retryResult.stderr,
    /Unsafe wipe recovery target is no longer exclusively owned/,
  );
  assert.equal(
    readFileSync(canonicalMerklePath, 'utf8'),
    replacementContent,
  );
});

test('row-absent planning uses exact recovery provenance for legacy Merkle cleanup', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mons-shop-wipe-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const targetDropId = 'poncho_drifella_devnet_x10';
  const targetRoot = '33'.repeat(32);
  const siblingRoot = '44'.repeat(32);
  const registryPath = path.join(
    root,
    'functions',
    'src',
    'shared',
    'deploymentRegistry.ts',
  );
  const canonicalMerklePath = path.join(
    root,
    'src',
    'drops',
    'discountMerkles',
    'poncho_drifella.json',
  );
  const legacyMerklePath = path.join(
    root,
    'src',
    'drops',
    'discountMerkles',
    `${targetDropId}.json`,
  );
  const targetSourcePath = path.join(
    root,
    'src',
    'drops',
    `${targetDropId}.ts`,
  );
  const newDropConfigPath = path.join(
    root,
    'scripts',
    'newDrops',
    `${targetDropId}.ts`,
  );
  const rows = {
    [targetDropId]: completeRegistryDrop(
      targetDropId,
      'poncho_drifella',
      targetRoot,
    ),
    sibling: completeRegistryDrop('sibling', 'default', siblingRoot),
  };
  mkdirSync(path.dirname(registryPath), { recursive: true });
  mkdirSync(path.dirname(canonicalMerklePath), { recursive: true });
  mkdirSync(path.dirname(newDropConfigPath), { recursive: true });
  writeFileSync(
    registryPath,
    [
      '// BEGIN AUTO-GENERATED DEPLOYMENT DROP REGISTRY',
      `export const DEPLOYMENT_DROPS = ${JSON.stringify(rows, null, 2)};`,
      '// END AUTO-GENERATED DEPLOYMENT DROP REGISTRY',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    canonicalMerklePath,
    `${JSON.stringify({ root: targetRoot, claims: [] }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    legacyMerklePath,
    `${JSON.stringify({ root: targetRoot, claims: [] }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(targetSourcePath, 'export const drop = true;\n', 'utf8');
  writeFileSync(
    newDropConfigPath,
    `export const NEW_DROP = { onchain: { dropId: '${targetDropId}', dropFamily: 'poncho_drifella' } };\n`,
    'utf8',
  );
  for (const args of [['init'], ['add', '.']]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }

  const firstPlanResult = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      [
        'const { buildRepoPlan } = await import(process.argv[1]);',
        'const plan = await buildRepoPlan({ root: process.argv[2], dropId: process.argv[3] });',
        'console.log(JSON.stringify(plan));',
      ].join(' '),
      new URL('../functions/scripts/wipeDrop.ts', import.meta.url).href,
      root,
      targetDropId,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(firstPlanResult.status, 0, firstPlanResult.stderr);
  const firstPlan = JSON.parse(firstPlanResult.stdout) as RepoPlan;
  assert.ok(firstPlan.recoveryManifest);
  mkdirSync(path.dirname(firstPlan.recoveryManifest.filePath), {
    recursive: true,
  });
  writeFileSync(
    firstPlan.recoveryManifest.filePath,
    firstPlan.recoveryManifest.content,
    'utf8',
  );
  writeFileSync(registryPath, firstPlan.registryNextContent, 'utf8');

  const retryPlan = await buildRepoPlan({
    root,
    dropId: targetDropId,
  });
  assert.equal(retryPlan.registryWillChange, false);
  assert.equal(
    retryPlan.registryNextContent,
    retryPlan.registryExpectedContent,
  );
  assert.equal(
    retryPlan.registryNextContent,
    readFileSync(registryPath, 'utf8'),
  );
  const retryTargets = new Map(
    retryPlan.canonicalDeleteTargets.map((target) => [
      target.relativePath,
      target.expectedSha256,
    ]),
  );
  assert.equal(
    retryTargets.has(
      `src/drops/discountMerkles/${targetDropId}.json`,
    ),
    true,
  );
  const exactPrepared = prepareRepoWipe(retryPlan);
  const legacyPreparedTarget =
    exactPrepared.canonicalDeleteTargets.find(
      (target) =>
        target.relativePath ===
        `src/drops/discountMerkles/${targetDropId}.json`,
    );
  assert.ok(legacyPreparedTarget);
  assert.throws(
    () =>
      applyPreparedRepoWipe(exactPrepared, {
        removeFile: (filePath) => {
          if (
            path.basename(filePath) ===
            path.basename(legacyMerklePath)
          ) {
            throw new Error('preserve exact legacy quarantine');
          }
          unlinkSync(filePath);
        },
      }),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError &&
      error.recoveryPaths.includes(
        legacyPreparedTarget.quarantinePath,
      ),
  );
  assert.equal(existsSync(legacyMerklePath), false);
  assert.equal(
    existsSync(legacyPreparedTarget.quarantinePath),
    true,
  );

  writeFileSync(
    legacyMerklePath,
    `${JSON.stringify(
      { root: targetRoot, claims: [], editedDuringFirestore: true },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const changedRetryPlan = await buildRepoPlan({
    root,
    dropId: targetDropId,
  });
  assert.equal(
    changedRetryPlan.canonicalDeleteTargets.some(
      (target) =>
        target.relativePath ===
        `src/drops/discountMerkles/${targetDropId}.json`,
    ),
    true,
  );
  const changedPrepared = prepareRepoWipe(changedRetryPlan);
  assert.throws(
    () => applyPreparedRepoWipe(changedPrepared),
    (error: unknown) =>
      error instanceof RepoWipePostCommitCleanupError &&
      error.residualPaths.includes(
        `src/drops/discountMerkles/${targetDropId}.json`,
      ) &&
      error.recoveryPaths.includes(
        legacyPreparedTarget.quarantinePath,
      ),
  );

  assert.equal(
    JSON.parse(readFileSync(legacyMerklePath, 'utf8'))
      .editedDuringFirestore,
    true,
  );
  assert.equal(existsSync(canonicalMerklePath), false);
  assert.equal(existsSync(targetSourcePath), false);
  assert.equal(
    existsSync(changedRetryPlan.recoveryManifest!.filePath),
    true,
  );
  assert.equal(
    existsSync(legacyPreparedTarget.quarantinePath),
    true,
  );
  assert.equal(
    readFileSync(registryPath, 'utf8'),
    retryPlan.registryExpectedContent,
  );
});

test('row-absent recovery restores rather than deletes a family Merkle quarantine newly shared by a sibling', async (t) => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), 'mons-shop-wipe-shared-merkle-'),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const targetDropId = 'poncho_drifella';
  const targetRoot = '55'.repeat(32);
  const siblingRoot = '66'.repeat(32);
  const registryPath = path.join(
    root,
    'functions',
    'src',
    'shared',
    'deploymentRegistry.ts',
  );
  const canonicalMerklePath = path.join(
    root,
    'src',
    'drops',
    'discountMerkles',
    'poncho_drifella.json',
  );
  const merkleDatasetPath = path.join(
    path.dirname(canonicalMerklePath),
    'poncho_drifella.dataset.json',
  );
  const targetSourcePath = path.join(
    root,
    'src',
    'drops',
    `${targetDropId}.ts`,
  );
  const newDropConfigPath = path.join(
    root,
    'scripts',
    'newDrops',
    `${targetDropId}.ts`,
  );
  const registrySource = (
    rows: Record<string, ReturnType<typeof completeRegistryDrop>>,
  ) =>
    [
      '// BEGIN AUTO-GENERATED DEPLOYMENT DROP REGISTRY',
      `export const DEPLOYMENT_DROPS = ${JSON.stringify(rows, null, 2)};`,
      '// END AUTO-GENERATED DEPLOYMENT DROP REGISTRY',
      '',
    ].join('\n');

  mkdirSync(path.dirname(registryPath), { recursive: true });
  mkdirSync(path.dirname(canonicalMerklePath), { recursive: true });
  mkdirSync(path.dirname(newDropConfigPath), { recursive: true });
  writeFileSync(
    registryPath,
    registrySource({
      [targetDropId]: completeRegistryDrop(
        targetDropId,
        'poncho_drifella',
        targetRoot,
      ),
      sibling: completeRegistryDrop(
        'sibling',
        'default',
        siblingRoot,
      ),
    }),
    'utf8',
  );
  writeFileSync(
    merkleDatasetPath,
    `${JSON.stringify({ root: targetRoot, claims: [] }, null, 2)}\n`,
    'utf8',
  );
  symlinkSync(
    path.basename(merkleDatasetPath),
    canonicalMerklePath,
  );
  writeFileSync(targetSourcePath, 'export const drop = true;\n', 'utf8');
  writeFileSync(
    newDropConfigPath,
    `export const NEW_DROP = { onchain: { dropId: '${targetDropId}', dropFamily: 'poncho_drifella' } };\n`,
    'utf8',
  );
  for (const args of [['init'], ['add', '.']]) {
    const result = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }

  const initialPlanResult = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      [
        'const { buildRepoPlan } = await import(process.argv[1]);',
        'const plan = await buildRepoPlan({ root: process.argv[2], dropId: process.argv[3] });',
        'console.log(JSON.stringify(plan));',
      ].join(' '),
      new URL(
        '../functions/scripts/wipeDrop.ts',
        import.meta.url,
      ).href,
      root,
      targetDropId,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(
    initialPlanResult.status,
    0,
    initialPlanResult.stderr,
  );
  const initialPlan = JSON.parse(
    initialPlanResult.stdout,
  ) as RepoPlan;
  const familyTarget = initialPlan.canonicalDeleteTargets.find(
    (target) =>
      target.relativePath ===
      'src/drops/discountMerkles/poncho_drifella.json',
  );
  assert.ok(familyTarget?.quarantinePath);
  assert.ok(initialPlan.recoveryManifest);
  mkdirSync(path.dirname(initialPlan.recoveryManifest.filePath), {
    recursive: true,
  });
  writeFileSync(
    initialPlan.recoveryManifest.filePath,
    initialPlan.recoveryManifest.content,
    'utf8',
  );
  mkdirSync(path.dirname(familyTarget.quarantinePath), {
    recursive: true,
  });
  renameSync(canonicalMerklePath, familyTarget.quarantinePath);

  const sharedRegistryContent = registrySource({
    sibling: completeRegistryDrop(
      'sibling',
      'poncho_drifella',
      targetRoot,
    ),
  });
  writeFileSync(registryPath, sharedRegistryContent, 'utf8');

  const recoveryPlan = await buildRepoPlan({
    root,
    dropId: targetDropId,
  });
  assert.equal(recoveryPlan.registryWillChange, false);
  assert.equal(
    recoveryPlan.canonicalDeleteTargets.some(
      (target) =>
        target.relativePath ===
        'src/drops/discountMerkles/poncho_drifella.json',
    ),
    false,
  );
  assert.equal(
    recoveryPlan.recoveryRestoreTargets?.length,
    1,
  );

  assert.ok(recoveryPlan.recoveryManifest);
  const restoreOnlyManifest = JSON.parse(
    recoveryPlan.recoveryManifest.content,
  ) as {
    targets: Array<{
      relativePath: string;
      restoreOnly?: true;
    }>;
  };
  assert.equal(
    restoreOnlyManifest.targets.find(
      (target) =>
        target.relativePath ===
        'src/drops/discountMerkles/poncho_drifella.json',
    )?.restoreOnly,
    true,
  );
  writeFileSync(
    recoveryPlan.recoveryManifest.filePath,
    recoveryPlan.recoveryManifest.content,
    'utf8',
  );
  const restoreOnlyRetryPlan = await buildRepoPlan({
    root,
    dropId: targetDropId,
  });
  assert.equal(
    restoreOnlyRetryPlan.canonicalDeleteTargets.some(
      (target) =>
        target.relativePath ===
        'src/drops/discountMerkles/poncho_drifella.json',
    ),
    false,
  );
  assert.equal(
    restoreOnlyRetryPlan.recoveryRestoreTargets?.length,
    1,
  );

  const prepared = prepareRepoWipe(restoreOnlyRetryPlan);
  assert.equal(existsSync(canonicalMerklePath), false);
  assert.equal(
    lstatSync(familyTarget.quarantinePath).isSymbolicLink(),
    true,
  );
  applyPreparedRepoWipe(prepared);

  assert.equal(lstatSync(canonicalMerklePath).isSymbolicLink(), true);
  assert.equal(
    readlinkSync(canonicalMerklePath),
    path.basename(merkleDatasetPath),
  );
  assert.equal(
    JSON.parse(readFileSync(canonicalMerklePath, 'utf8')).root,
    targetRoot,
  );
  assert.equal(existsSync(familyTarget.quarantinePath), false);
  assert.equal(existsSync(targetSourcePath), false);
  assert.equal(
    existsSync(restoreOnlyRetryPlan.recoveryManifest!.filePath),
    false,
  );
  assert.equal(readFileSync(registryPath, 'utf8'), sharedRegistryContent);

  writeFileSync(
    targetSourcePath,
    'export const recreatedResidual = true;\n',
    'utf8',
  );
  const noJournalRetry = await buildRepoPlan({
    root,
    dropId: targetDropId,
  });
  const genericJournal = JSON.parse(
    noJournalRetry.recoveryManifest!.content,
  );
  assert.equal(genericJournal.dropFamily, undefined);
  assert.equal(genericJournal.discountMerkleRoot, undefined);
  applyPreparedRepoWipe(prepareRepoWipe(noJournalRetry));
  assert.equal(existsSync(targetSourcePath), false);
  assert.equal(
    existsSync(noJournalRetry.recoveryManifest!.filePath),
    false,
  );

  mkdirSync(
    path.dirname(noJournalRetry.recoveryManifest!.filePath),
    { recursive: true },
  );
  writeFileSync(
    noJournalRetry.recoveryManifest!.filePath,
    `${JSON.stringify({
      version: 1,
      dropId: targetDropId,
      dropFamily: 'invented_family',
      discountMerkleRoot: targetRoot,
      targets: [],
    })}\n`,
    'utf8',
  );
  await assert.rejects(
    buildRepoPlan({ root, dropId: targetDropId }),
    /Invalid wipe recovery manifest/,
  );
});
