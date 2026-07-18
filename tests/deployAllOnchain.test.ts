import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import {
  assertMplCoreCollectionHasUpdateDelegates,
  commitDeploymentRegistryPair,
  decodeMplCoreCollectionUpdateDelegates,
  finalizeDiscountMerkleAndDeploymentRegistry,
  formatFreshProgramKeypairNotice,
  prepareStripeCheckoutConfig,
  registerDeploymentCleanup,
  revalidateReusableProgramResolution,
  validateDiscountMerkleDatasetForDeploy,
} from '../scripts/deploy-all-onchain.ts';
import { LITTLE_SWAG_HOODIE_COLLECTION_IMAGE_URL } from '../src/config/dropMediaDefaults.ts';
import { NEW_DROP as CARD_NFT_2_NEW_DROP } from '../scripts/newDrops/card_nft_2.ts';
import { NEW_DROP as LITTLE_SWAG_HOODIES_NEW_DROP } from '../scripts/newDrops/little_swag_hoodies.ts';
import { NEW_DROP as LITTLE_SWAG_HOODIES_DEVNET_NEW_DROP } from '../scripts/newDrops/little_swag_hoodies_devnet.ts';

function u8(value: number): Buffer {
  return Buffer.from([value & 0xff]);
}

function u32LE(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

function u64LE(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value), 0);
  return buf;
}

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u32LE(bytes.length), bytes]);
}

function pubkey(seed: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff));
}

function makeDiscountMerkleFinalizationFixture() {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'mons-shop-proof-finalization-'));
  const root = Buffer.alloc(32, 7);
  const rootHex = root.toString('hex');
  const proofs = { [pubkey(90).toBase58()]: [] };
  const frontendConfigPath = path.join(rootDir, 'frontend.mjs');
  const functionsConfigPath = path.join(rootDir, 'functions.mjs');
  writeFileSync(frontendConfigPath, 'export const FRONTEND_DROPS = {};\n', 'utf8');
  writeFileSync(functionsConfigPath, 'export const FUNCTIONS_DROPS = {};\n', 'utf8');
  return {
    rootDir,
    root,
    rootHex,
    proofs,
    payload: `${JSON.stringify({ root: rootHex, proofs }, null, 2)}\n`,
    filePath: path.join(rootDir, 'default.json'),
    frontendConfigPath,
    functionsConfigPath,
  };
}

function makeDeploymentCleanupRuntime() {
  type Event = 'exit' | 'SIGINT' | 'SIGTERM';
  const listeners = new Map<Event, Set<() => void>>();
  const exitCodes: number[] = [];
  const runtime = {
    once(event: Event, listener: () => void) {
      const eventListeners = listeners.get(event) || new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    },
    off(event: Event, listener: () => void) {
      listeners.get(event)?.delete(listener);
    },
    exit(code: number) {
      exitCodes.push(code);
    },
  };
  return {
    runtime,
    exitCodes,
    emit(event: Event) {
      const eventListeners = [...(listeners.get(event) || [])];
      listeners.delete(event);
      for (const listener of eventListeners) listener();
    },
    listenerCount(event: Event) {
      return listeners.get(event)?.size || 0;
    },
  };
}

type DeploymentRegistryTestDrop = {
  dropId: string;
  solanaCluster: 'devnet';
  dropFamily: string;
  metadataPathFormat: 'legacy' | 'compact';
  discountMerkleRoot: string;
  boxMinterProgramId: string;
};

function deploymentRegistryTestDrop(args: {
  dropId: string;
  programId: string;
  dropFamily?: string;
  metadataPathFormat?: 'legacy' | 'compact';
  discountMerkleRoot?: string;
}): DeploymentRegistryTestDrop {
  return {
    dropId: args.dropId,
    solanaCluster: 'devnet',
    dropFamily: args.dropFamily || 'default',
    metadataPathFormat: args.metadataPathFormat || 'compact',
    discountMerkleRoot: args.discountMerkleRoot || '11'.repeat(32),
    boxMinterProgramId: args.programId,
  };
}

function makeDeploymentRegistryFixture(
  frontendDrops: DeploymentRegistryTestDrop[],
  functionsDrops: DeploymentRegistryTestDrop[] = frontendDrops,
) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'mons-shop-deploy-registry-'));
  const frontendConfigPath = path.join(rootDir, 'src', 'config', 'deployment.ts');
  const functionsConfigPath = path.join(rootDir, 'functions', 'src', 'config', 'deployment.ts');
  mkdirSync(path.dirname(frontendConfigPath), { recursive: true });
  mkdirSync(path.dirname(functionsConfigPath), { recursive: true });

  const writeDrops = (
    nextFrontendDrops: DeploymentRegistryTestDrop[],
    nextFunctionsDrops: DeploymentRegistryTestDrop[] = nextFrontendDrops,
  ) => {
    writeFileSync(
      frontendConfigPath,
      `export const FRONTEND_DROPS = ${JSON.stringify(Object.fromEntries(nextFrontendDrops.map((drop) => [drop.dropId, drop])))};\n`,
      'utf8',
    );
    writeFileSync(
      functionsConfigPath,
      `export const FUNCTIONS_DROPS = ${JSON.stringify(Object.fromEntries(nextFunctionsDrops.map((drop) => [drop.dropId, drop])))};\n`,
      'utf8',
    );
  };
  writeDrops(frontendDrops, functionsDrops);
  return { rootDir, frontendConfigPath, functionsConfigPath, writeDrops };
}

async function captureRejection(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (err) {
    return err;
  }
  assert.fail('Expected promise to reject');
}

test('deploy discount Merkle preflight reuses an exact family dataset', async (t) => {
  const root = Buffer.alloc(32, 7);
  const rootHex = root.toString('hex');
  const proofs = { [pubkey(90).toBase58()]: [] };
  const programId = pubkey(1).toBase58();
  const fixture = makeDeploymentRegistryFixture([
    deploymentRegistryTestDrop({
      dropId: 'card_drop_existing',
      dropFamily: 'card_nft_2',
      programId,
      discountMerkleRoot: rootHex,
    }),
  ]);
  t.after(() => rmSync(fixture.rootDir, { recursive: true, force: true }));
  const filePath = path.join(fixture.rootDir, 'src', 'drops', 'discountMerkles', 'card_nft_2.json');
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({ root: rootHex, proofs }, null, 2)}\n`, 'utf8');

  const result = await validateDiscountMerkleDatasetForDeploy({
    root: fixture.rootDir,
    dropId: 'card_drop_next',
    dropFamily: 'card_nft_2',
    merkleRoot: root,
    proofs,
  });

  assert.equal(result.filePath, filePath);
  assert.equal(result.fileName, 'card_nft_2.json');
});

test('deploy discount Merkle preflight rejects a family mapped to a different root', async (t) => {
  const fixture = makeDeploymentRegistryFixture([
    deploymentRegistryTestDrop({
      dropId: 'card_drop_existing',
      dropFamily: 'card_nft_2',
      programId: pubkey(1).toBase58(),
      discountMerkleRoot: '11'.repeat(32),
    }),
  ]);
  t.after(() => rmSync(fixture.rootDir, { recursive: true, force: true }));

  await assert.rejects(
    validateDiscountMerkleDatasetForDeploy({
      root: fixture.rootDir,
      dropId: 'card_drop_next',
      dropFamily: 'card_nft_2',
      merkleRoot: Buffer.alloc(32, 0x22),
      proofs: {},
    }),
    /family card_nft_2 maps to conflicting roots/,
  );
});

test('reusable program revalidation accepts a same-program registry addition', async (t) => {
  const programId = pubkey(1).toBase58();
  const fixture = makeDeploymentRegistryFixture([
    deploymentRegistryTestDrop({ dropId: 'lineage_alpha', programId }),
    deploymentRegistryTestDrop({ dropId: 'lineage_beta', programId }),
  ]);
  t.after(() => rmSync(fixture.rootDir, { recursive: true, force: true }));

  const result = await revalidateReusableProgramResolution({
    root: fixture.rootDir,
    solanaCluster: 'devnet',
    dropId: 'lineage_next',
    desiredMetadataPathFormat: 'compact',
    expected: { programId, source: 'pre-prompt registry' },
  });

  assert.equal(result.programId, programId);
});

test('reusable program revalidation rejects newly ambiguous automatic selection', async (t) => {
  const programA = pubkey(1).toBase58();
  const programB = pubkey(2).toBase58();
  const fixture = makeDeploymentRegistryFixture([
    deploymentRegistryTestDrop({ dropId: 'lineage_alpha', programId: programA }),
    deploymentRegistryTestDrop({ dropId: 'lineage_beta', programId: programB }),
  ]);
  t.after(() => rmSync(fixture.rootDir, { recursive: true, force: true }));

  await assert.rejects(
    revalidateReusableProgramResolution({
      root: fixture.rootDir,
      solanaCluster: 'devnet',
      dropId: 'lineage_next',
      desiredMetadataPathFormat: 'compact',
      expected: { programId: programA, source: 'pre-prompt registry' },
    }),
    /reuseProgramId=true is ambiguous/,
  );
});

test('reusable program revalidation rejects an explicit reference rebound to another program', async (t) => {
  const programA = pubkey(1).toBase58();
  const programB = pubkey(2).toBase58();
  const fixture = makeDeploymentRegistryFixture([
    deploymentRegistryTestDrop({ dropId: 'lineage_reference', programId: programB }),
  ]);
  t.after(() => rmSync(fixture.rootDir, { recursive: true, force: true }));

  await assert.rejects(
    revalidateReusableProgramResolution({
      root: fixture.rootDir,
      solanaCluster: 'devnet',
      dropId: 'lineage_next',
      desiredMetadataPathFormat: 'compact',
      referenceDropId: 'lineage_reference',
      expected: { programId: programA, source: 'lineage_reference before prompt' },
    }),
    new RegExp(`Reusable program selection changed[\\s\\S]*${programA}[\\s\\S]*${programB}[\\s\\S]*Rerun`),
  );
});

test('reusable program revalidation rejects a disappeared explicit reference', async (t) => {
  const programId = pubkey(1).toBase58();
  const fixture = makeDeploymentRegistryFixture([]);
  t.after(() => rmSync(fixture.rootDir, { recursive: true, force: true }));

  await assert.rejects(
    revalidateReusableProgramResolution({
      root: fixture.rootDir,
      solanaCluster: 'devnet',
      dropId: 'lineage_next',
      desiredMetadataPathFormat: 'compact',
      referenceDropId: 'lineage_reference',
      expected: { programId, source: 'lineage_reference before prompt' },
    }),
    /reuseProgramIdFromDropId=lineage_reference did not match/,
  );
});

test('reusable program revalidation repeats metadata-format compatibility under lock', async (t) => {
  const programId = pubkey(1).toBase58();
  const fixture = makeDeploymentRegistryFixture([
    deploymentRegistryTestDrop({ dropId: 'compact_drop', programId }),
    deploymentRegistryTestDrop({
      dropId: 'legacy_drop',
      programId,
      metadataPathFormat: 'legacy',
    }),
  ]);
  t.after(() => rmSync(fixture.rootDir, { recursive: true, force: true }));

  await assert.rejects(
    revalidateReusableProgramResolution({
      root: fixture.rootDir,
      solanaCluster: 'devnet',
      dropId: 'lineage_next',
      desiredMetadataPathFormat: 'compact',
      expected: { programId, source: 'pre-prompt registry' },
    }),
    /registry already maps that program id to a different layout/,
  );
});

test('deployment cleanup removes the temp keypair, releases the lock, and detaches handlers', (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'mons-shop-deployment-cleanup-'));
  const tempKeypairPath = path.join(rootDir, 'deployer.json');
  writeFileSync(tempKeypairPath, '[1,2,3]\n', 'utf8');
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const fakeProcess = makeDeploymentCleanupRuntime();
  let releaseCalls = 0;
  const deploymentCleanup = registerDeploymentCleanup({
    releaseDeploymentRegistryLock: () => {
      releaseCalls += 1;
      return true;
    },
    runtime: fakeProcess.runtime,
  });

  assert.equal(fakeProcess.listenerCount('exit'), 1);
  assert.equal(fakeProcess.listenerCount('SIGINT'), 1);
  assert.equal(fakeProcess.listenerCount('SIGTERM'), 1);
  deploymentCleanup.setTempKeypairPath(tempKeypairPath);

  assert.equal(deploymentCleanup.cleanup(), true);
  assert.equal(existsSync(tempKeypairPath), false);
  assert.equal(releaseCalls, 1);
  assert.equal(fakeProcess.listenerCount('exit'), 0);
  assert.equal(fakeProcess.listenerCount('SIGINT'), 0);
  assert.equal(fakeProcess.listenerCount('SIGTERM'), 0);
  assert.equal(deploymentCleanup.cleanup(), true);
  assert.equal(releaseCalls, 1);
});

test('deployment cleanup keeps the exit fallback attached to retry a failed lock release', () => {
  const fakeProcess = makeDeploymentCleanupRuntime();
  let releaseCalls = 0;
  const deploymentCleanup = registerDeploymentCleanup({
    releaseDeploymentRegistryLock: () => {
      releaseCalls += 1;
      return releaseCalls >= 2;
    },
    runtime: fakeProcess.runtime,
  });

  assert.equal(deploymentCleanup.cleanup(), false);
  assert.equal(fakeProcess.listenerCount('exit'), 1);
  fakeProcess.emit('exit');
  assert.equal(releaseCalls, 2);
  assert.equal(fakeProcess.listenerCount('exit'), 0);
  assert.equal(fakeProcess.listenerCount('SIGINT'), 0);
  assert.equal(fakeProcess.listenerCount('SIGTERM'), 0);
});

test('deployment cleanup still releases the lock when temp-keypair removal must be retried', (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'mons-shop-deployment-cleanup-retry-'));
  const tempKeypairPath = path.join(rootDir, 'deployer.json');
  mkdirSync(tempKeypairPath);
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const fakeProcess = makeDeploymentCleanupRuntime();
  let releaseCalls = 0;
  const deploymentCleanup = registerDeploymentCleanup({
    releaseDeploymentRegistryLock: () => {
      releaseCalls += 1;
      return true;
    },
    runtime: fakeProcess.runtime,
  });
  deploymentCleanup.setTempKeypairPath(tempKeypairPath);

  assert.equal(deploymentCleanup.cleanup(), false);
  assert.equal(releaseCalls, 1);
  assert.equal(fakeProcess.listenerCount('exit'), 1);

  rmSync(tempKeypairPath, { recursive: true, force: true });
  assert.equal(deploymentCleanup.cleanup(), true);
  assert.equal(releaseCalls, 2);
  assert.equal(fakeProcess.listenerCount('exit'), 0);
});

for (const [signal, status] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const) {
  test(`deployment cleanup preserves the ${signal} exit status`, () => {
    const fakeProcess = makeDeploymentCleanupRuntime();
    let releaseCalls = 0;
    registerDeploymentCleanup({
      releaseDeploymentRegistryLock: () => {
        releaseCalls += 1;
        return true;
      },
      runtime: fakeProcess.runtime,
    });

    fakeProcess.emit(signal);

    assert.deepEqual(fakeProcess.exitCodes, [status]);
    assert.equal(releaseCalls, 1);
    assert.equal(fakeProcess.listenerCount('exit'), 0);
    assert.equal(fakeProcess.listenerCount('SIGINT'), 0);
    assert.equal(fakeProcess.listenerCount('SIGTERM'), 0);
  });
}

test('discount Merkle finalization retains a new proof file after a successful registry commit', async (t) => {
  const fixture = makeDiscountMerkleFinalizationFixture();
  t.after(() => rmSync(fixture.rootDir, { recursive: true, force: true }));

  const result = await finalizeDiscountMerkleAndDeploymentRegistry({
    ...fixture,
    commitRegistryChanges: async () => 'committed',
  });

  assert.equal(result, 'committed');
  assert.equal(readFileSync(fixture.filePath, 'utf8'), fixture.payload);
});

test('discount Merkle finalization preserves a newly created proof after registry commit failure', async (t) => {
  const fixture = makeDiscountMerkleFinalizationFixture();
  t.after(() => rmSync(fixture.rootDir, { recursive: true, force: true }));
  const commitError = new Error('registry commit failed');

  const rejected = await captureRejection(() =>
    finalizeDiscountMerkleAndDeploymentRegistry({
      ...fixture,
      commitRegistryChanges: async () => {
        throw commitError;
      },
    }),
  );

  assert.strictEqual(rejected, commitError);
  assert.equal(readFileSync(fixture.filePath, 'utf8'), fixture.payload);
});

test('discount Merkle finalization preserves an already-persisted proof after registry commit failure', async (t) => {
  const fixture = makeDiscountMerkleFinalizationFixture();
  t.after(() => rmSync(fixture.rootDir, { recursive: true, force: true }));
  const existingSource = JSON.stringify({ proofs: fixture.proofs, root: fixture.rootHex });
  writeFileSync(fixture.filePath, existingSource, 'utf8');
  const commitError = new Error('registry commit failed');

  const rejected = await captureRejection(() =>
    finalizeDiscountMerkleAndDeploymentRegistry({
      ...fixture,
      commitRegistryChanges: async () => {
        throw commitError;
      },
    }),
  );

  assert.strictEqual(rejected, commitError);
  assert.equal(readFileSync(fixture.filePath, 'utf8'), existingSource);
});

test('discount Merkle finalization rejects a conflicting pre-existing proof before registry mutation', async (t) => {
  const fixture = makeDiscountMerkleFinalizationFixture();
  t.after(() => rmSync(fixture.rootDir, { recursive: true, force: true }));
  const existingSource = JSON.stringify({
    root: fixture.rootHex,
    proofs: { [Object.keys(fixture.proofs)[0]]: ['00'.repeat(32)] },
  });
  writeFileSync(fixture.filePath, existingSource, 'utf8');
  let commitCalled = false;

  const rejected = await captureRejection(() =>
    finalizeDiscountMerkleAndDeploymentRegistry({
      ...fixture,
      commitRegistryChanges: async () => {
        commitCalled = true;
      },
    }),
  );

  assert.match(String(rejected), /conflicts with the generated dataset/);
  assert.equal(commitCalled, false);
  assert.equal(readFileSync(fixture.filePath, 'utf8'), existingSource);
});

test('paired registry commit restores an existing frontend registry when the Functions commit fails', async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'mons-shop-registry-pair-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const frontendConfigPath = path.join(rootDir, 'frontend.ts');
  const functionsConfigPath = path.join(rootDir, 'functions.ts');
  const frontendBefore = 'export const FRONTEND_DROPS = { before: true };\n';
  const functionsBefore = 'export const FUNCTIONS_DROPS = { before: true };\n';
  writeFileSync(frontendConfigPath, frontendBefore, 'utf8');
  writeFileSync(functionsConfigPath, functionsBefore, 'utf8');
  const commitError = new Error('functions registry commit failed');

  const rejected = await captureRejection(() =>
    commitDeploymentRegistryPair({
      frontendConfigPath,
      functionsConfigPath,
      commitFrontend: () => {
        writeFileSync(frontendConfigPath, 'export const FRONTEND_DROPS = { after: true };\n', 'utf8');
        return frontendConfigPath;
      },
      commitFunctions: () => {
        throw commitError;
      },
    }),
  );

  assert.strictEqual(rejected, commitError);
  assert.equal(readFileSync(frontendConfigPath, 'utf8'), frontendBefore);
  assert.equal(readFileSync(functionsConfigPath, 'utf8'), functionsBefore);
});

test('paired registry commit restores a frontend mutation when its callback throws', async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'mons-shop-registry-pair-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const frontendConfigPath = path.join(rootDir, 'frontend.ts');
  const functionsConfigPath = path.join(rootDir, 'functions.ts');
  const frontendBefore = 'export const FRONTEND_DROPS = { before: true };\n';
  const functionsBefore = 'export const FUNCTIONS_DROPS = { before: true };\n';
  writeFileSync(frontendConfigPath, frontendBefore, 'utf8');
  writeFileSync(functionsConfigPath, functionsBefore, 'utf8');
  const commitError = new Error('frontend registry commit failed');
  let functionsCommitCalled = false;

  const rejected = await captureRejection(() =>
    commitDeploymentRegistryPair({
      frontendConfigPath,
      functionsConfigPath,
      commitFrontend: () => {
        writeFileSync(frontendConfigPath, 'partially written frontend', 'utf8');
        throw commitError;
      },
      commitFunctions: () => {
        functionsCommitCalled = true;
      },
    }),
  );

  assert.strictEqual(rejected, commitError);
  assert.equal(functionsCommitCalled, false);
  assert.equal(readFileSync(frontendConfigPath, 'utf8'), frontendBefore);
  assert.equal(readFileSync(functionsConfigPath, 'utf8'), functionsBefore);
});

test('paired registry commit restores both registry mutations when the Functions callback throws', async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'mons-shop-registry-pair-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const frontendConfigPath = path.join(rootDir, 'frontend.ts');
  const functionsConfigPath = path.join(rootDir, 'functions.ts');
  const frontendBefore = 'export const FRONTEND_DROPS = { before: true };\n';
  const functionsBefore = 'export const FUNCTIONS_DROPS = { before: true };\n';
  writeFileSync(frontendConfigPath, frontendBefore, 'utf8');
  writeFileSync(functionsConfigPath, functionsBefore, 'utf8');
  const commitError = new Error('functions registry commit failed');

  const rejected = await captureRejection(() =>
    commitDeploymentRegistryPair({
      frontendConfigPath,
      functionsConfigPath,
      commitFrontend: () => {
        writeFileSync(frontendConfigPath, 'export const FRONTEND_DROPS = { after: true };\n', 'utf8');
      },
      commitFunctions: () => {
        writeFileSync(functionsConfigPath, 'partially written functions', 'utf8');
        throw commitError;
      },
    }),
  );

  assert.strictEqual(rejected, commitError);
  assert.equal(readFileSync(frontendConfigPath, 'utf8'), frontendBefore);
  assert.equal(readFileSync(functionsConfigPath, 'utf8'), functionsBefore);
});

test('paired registry commit removes a newly created frontend registry when the Functions commit fails', async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'mons-shop-registry-pair-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const frontendConfigPath = path.join(rootDir, 'frontend.ts');
  const functionsConfigPath = path.join(rootDir, 'functions.ts');
  writeFileSync(functionsConfigPath, 'export const FUNCTIONS_DROPS = {};\n', 'utf8');
  const commitError = new Error('functions registry commit failed');

  const rejected = await captureRejection(() =>
    commitDeploymentRegistryPair({
      frontendConfigPath,
      functionsConfigPath,
      commitFrontend: () => {
        writeFileSync(frontendConfigPath, 'export const FRONTEND_DROPS = { after: true };\n', 'utf8');
      },
      commitFunctions: () => {
        throw commitError;
      },
    }),
  );

  assert.strictEqual(rejected, commitError);
  assert.equal(existsSync(frontendConfigPath), false);
});

test('paired registry rollback preserves a concurrent frontend change', async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'mons-shop-registry-pair-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const frontendConfigPath = path.join(rootDir, 'frontend.ts');
  const functionsConfigPath = path.join(rootDir, 'functions.ts');
  writeFileSync(frontendConfigPath, 'export const FRONTEND_DROPS = { before: true };\n', 'utf8');
  writeFileSync(functionsConfigPath, 'export const FUNCTIONS_DROPS = {};\n', 'utf8');
  const concurrentSource = 'export const FRONTEND_DROPS = { concurrent: true };\n';
  const commitError = new Error('functions registry commit failed');

  const rejected = await captureRejection(() =>
    commitDeploymentRegistryPair({
      frontendConfigPath,
      functionsConfigPath,
      commitFrontend: () => {
        writeFileSync(frontendConfigPath, 'export const FRONTEND_DROPS = { after: true };\n', 'utf8');
      },
      commitFunctions: () => {
        writeFileSync(frontendConfigPath, concurrentSource, 'utf8');
        throw commitError;
      },
    }),
  );

  assert.strictEqual(rejected, commitError);
  assert.equal(readFileSync(frontendConfigPath, 'utf8'), concurrentSource);
});

test('paired registry commit rejects source drift before either registry is mutated', async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'mons-shop-registry-pair-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const frontendConfigPath = path.join(rootDir, 'frontend.ts');
  const functionsConfigPath = path.join(rootDir, 'functions.ts');
  const frontendPreparedSource = 'export const FRONTEND_DROPS = { prepared: true };\n';
  const frontendChangedSource = 'export const FRONTEND_DROPS = { changed: true };\n';
  const functionsPreparedSource = 'export const FUNCTIONS_DROPS = { prepared: true };\n';
  writeFileSync(frontendConfigPath, frontendChangedSource, 'utf8');
  writeFileSync(functionsConfigPath, functionsPreparedSource, 'utf8');
  let frontendCommitCalled = false;
  let functionsCommitCalled = false;

  const rejected = await captureRejection(() =>
    commitDeploymentRegistryPair({
      frontendConfigPath,
      functionsConfigPath,
      expectedFrontendSnapshot: { exists: true, content: frontendPreparedSource },
      expectedFunctionsSnapshot: { exists: true, content: functionsPreparedSource },
      commitFrontend: () => {
        frontendCommitCalled = true;
      },
      commitFunctions: () => {
        functionsCommitCalled = true;
      },
    }),
  );

  assert.match(String(rejected), /Frontend deployment registry changed after it was prepared/);
  assert.equal(frontendCommitCalled, false);
  assert.equal(functionsCommitCalled, false);
  assert.equal(readFileSync(frontendConfigPath, 'utf8'), frontendChangedSource);
  assert.equal(readFileSync(functionsConfigPath, 'utf8'), functionsPreparedSource);
});

function encodePluginAuthority(kind: number, address?: PublicKey): Buffer {
  return kind === 3 ? Buffer.concat([u8(kind), (address || pubkey(240)).toBuffer()]) : u8(kind);
}

function encodeCollectionWithUpdateDelegates(args: {
  delegates?: PublicKey[];
  includeUpdateDelegatePlugin?: boolean;
  pluginAuthorityKind?: number;
  pluginAuthorityAddress?: PublicKey;
}): Buffer {
  const base = Buffer.concat([
    u8(5), // CollectionV1
    pubkey(1).toBuffer(), // update authority
    borshString('Test Collection'),
    borshString('https://assets.example.com/collection.json'),
    u32LE(0), // numMinted
    u32LE(0), // currentSize
  ]);

  if (args.includeUpdateDelegatePlugin === false) {
    return base;
  }

  const delegates = args.delegates || [];
  const pluginData = Buffer.concat([u8(4), u32LE(delegates.length), ...delegates.map((delegate) => delegate.toBuffer())]);
  const pluginOffset = base.length + 9;
  const registryOffset = pluginOffset + pluginData.length;
  const registryRecord = Buffer.concat([
    u8(4), // UpdateDelegate plugin type
    encodePluginAuthority(args.pluginAuthorityKind ?? 2, args.pluginAuthorityAddress),
    u64LE(pluginOffset),
  ]);
  const pluginHeader = Buffer.concat([u8(3), u64LE(registryOffset)]);
  const registry = Buffer.concat([u8(4), u32LE(1), registryRecord]);

  return Buffer.concat([base, pluginHeader, pluginData, registry]);
}

test('decodeMplCoreCollectionUpdateDelegates decodes UpdateDelegate entries', () => {
  const configPda = pubkey(10);
  const admin = pubkey(30);
  const data = encodeCollectionWithUpdateDelegates({ delegates: [configPda, admin] });

  const decoded = decodeMplCoreCollectionUpdateDelegates(data);

  assert.ok(decoded);
  assert.equal(decoded.authorityKind, 2);
  assert.deepEqual(
    decoded.delegates.map((delegate) => delegate.toBase58()),
    [configPda.toBase58(), admin.toBase58()],
  );
});

test('assertMplCoreCollectionHasUpdateDelegates rejects missing delegates', () => {
  const configPda = pubkey(10);
  const admin = pubkey(30);
  const data = encodeCollectionWithUpdateDelegates({ delegates: [admin] });

  assert.throws(
    () =>
      assertMplCoreCollectionHasUpdateDelegates({
        data,
        collection: pubkey(50),
        requiredDelegates: [configPda, admin],
      }),
    /Core collection UpdateDelegate missing required delegate/,
  );
});

test('assertMplCoreCollectionHasUpdateDelegates rejects missing UpdateDelegate plugin', () => {
  assert.throws(
    () =>
      assertMplCoreCollectionHasUpdateDelegates({
        data: encodeCollectionWithUpdateDelegates({ includeUpdateDelegatePlugin: false }),
        collection: pubkey(50),
        requiredDelegates: [pubkey(10), pubkey(30)],
      }),
    /Missing\/undecodable UpdateDelegate plugin/,
  );
});

test('assertMplCoreCollectionHasUpdateDelegates rejects externally controlled UpdateDelegate plugin', () => {
  const configPda = pubkey(10);
  const admin = pubkey(30);
  const externalAuthority = pubkey(80);
  const data = encodeCollectionWithUpdateDelegates({
    delegates: [configPda, admin],
    pluginAuthorityKind: 3,
    pluginAuthorityAddress: externalAuthority,
  });

  assert.throws(
    () =>
      assertMplCoreCollectionHasUpdateDelegates({
        data,
        collection: pubkey(50),
        requiredDelegates: [configPda, admin],
      }),
    /UpdateDelegate plugin authority mismatch/,
  );
});

test('formatFreshProgramKeypairNotice warns to back up non-git fresh shared program keypair', () => {
  const notice = formatFreshProgramKeypairNotice({
    programId: 'Program1111111111111111111111111111111111111',
    programKeypairPath: 'onchain/target/deploy/box_minter-keypair.json',
    backupPath: 'onchain/target/deploy/box_minter-keypair.bak.json',
  });

  assert.match(notice, /FRESH SHARED PROGRAM KEYPAIR CREATED/);
  assert.match(notice, /Program1111111111111111111111111111111111111/);
  assert.match(notice, /Keypair path: .*onchain\/target\/deploy\/box_minter-keypair\.json/);
  assert.match(notice, /Back up this keypair file immediately/);
  assert.match(notice, /not tracked by git/);
  assert.match(notice, /Previous keypair backup: .*onchain\/target\/deploy\/box_minter-keypair\.bak\.json/);
});

test('card_nft_2 new drop config enables live Stripe Checkout at $44', () => {
  assert.equal(CARD_NFT_2_NEW_DROP.onchain.stripeCheckoutEnabled, true);
  assert.equal(CARD_NFT_2_NEW_DROP.onchain.stripeLiveUnitAmountCents, 4400);
});

test('little_swag_hoodies new drop configs use CDN collection image', () => {
  for (const drop of [LITTLE_SWAG_HOODIES_NEW_DROP, LITTLE_SWAG_HOODIES_DEVNET_NEW_DROP]) {
    assert.equal(drop.onchain.collectionMetadata.image, LITTLE_SWAG_HOODIE_COLLECTION_IMAGE_URL);
    assert.match(drop.onchain.collectionMetadata.image || '', /^https:\/\/cdn\.lil\.org\//);
  }
});

test('prepareStripeCheckoutConfig fails preflight for Stripe-enabled mainnet drops without live pricing', () => {
  assert.throws(
    () =>
      prepareStripeCheckoutConfig({
        solanaCluster: 'mainnet-beta',
        dropId: 'mainnet_card_drop',
        dropFamily: 'card_nft_2',
      }),
    /stripeLiveUnitAmountCents is required for Stripe-enabled mainnet drop mainnet_card_drop/,
  );
});
