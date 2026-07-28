import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PublicKey,
  type Commitment,
  type Connection,
} from '@solana/web3.js';
import {
  assertMplCoreCollectionHasUpdateDelegates,
  assertExistingConfigMatchesResume,
  assertReceiptPoolCollectionUpdateDelegatePolicy,
  assertReceiptPoolCapacity,
  assertReceiptMetadataRange,
  commitDeploymentRegistry,
  decodeBoxMinterConfigForDeployPreflight,
  decodeReceiptTreeState,
  decodeMplCoreCollectionUpdateDelegates,
  finalizeDiscountMerkleAndDeploymentRegistry,
  formatFreshProgramKeypairNotice,
  prepareStripeCheckoutConfig,
  registerDeploymentCleanup,
  revalidateReusableProgramResolution,
  validateReceiptPoolDeploymentOnchain,
  validateDiscountMerkleDatasetForDeploy,
} from '../scripts/deploy-all-onchain.ts';
import {
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED,
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS,
  BOX_MINTER_CONFIG_DISCRIMINATOR,
} from '../functions/src/shared/boxMinterConfigCodec.ts';
import { LITTLE_SWAG_HOODIE_COLLECTION_IMAGE_URL } from '../src/config/dropMediaDefaults.ts';
import { NEW_DROP as CARD_NFT_2_NEW_DROP } from '../scripts/newDrops/card_nft_2.ts';
import { NEW_DROP as LITTLE_SWAG_HOODIES_NEW_DROP } from '../scripts/newDrops/little_swag_hoodies.ts';
import { NEW_DROP as LITTLE_SWAG_HOODIES_DEVNET_NEW_DROP } from '../scripts/newDrops/little_swag_hoodies_devnet.ts';
import { NEW_DROP as CARD_NFT_BINDER_NEW_DROP } from '../scripts/newDrops/card_nft_binder.ts';
import { NEW_DROP as CARD_NFT_BINDER_DEVNET_NEW_DROP } from '../scripts/newDrops/card_nft_binder_devnet.ts';
import {
  MONS_SHOP_RECEIPTS_POOL_ID,
  requireReceiptPoolSpec,
} from '../scripts/shared/receiptPoolConfig.ts';
import {
  assertReceiptPoolRpcGenesisHash,
  classifyReceiptPoolJournalRetry,
  completeReceiptPoolJournal,
  RECEIPT_POOL_CLUSTER_GENESIS_HASHES,
  RECEIPT_POOL_FINALIZED_COMMITMENT,
} from '../scripts/deploy-receipt-pool.ts';
import {
  DeploymentRegistryPostCommitVerificationError,
  isDeploymentRegistryPostCommitVerificationError,
  type DeploymentDropConfigSerialized,
} from '../scripts/shared/deploymentRegistry.ts';
import { loadNewDropConfigById } from '../scripts/shared/newDropLoader.ts';

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

function encodeExactResumeConfig(args: {
  admin: PublicKey;
  treasury: PublicKey;
  coreCollection: PublicKey;
  discountMerkleRoot: Buffer;
  dropSeed: Buffer;
  started?: boolean;
  minted?: number;
}): Buffer {
  const payload = Buffer.concat([
    Buffer.from(BOX_MINTER_CONFIG_DISCRIMINATOR),
    args.admin.toBuffer(),
    args.treasury.toBuffer(),
    args.coreCollection.toBuffer(),
    u64LE(100),
    u64LE(90),
    args.discountMerkleRoot,
    u32LE(15),
    u8(1),
    u8(0),
    u32LE(args.minted ?? 0),
    borshString('binder'),
    borshString('receipts'),
    borshString('https://cdn.lil.org/nft/card_nft_binder/json'),
    u8(args.started ? 1 : 0),
    u8(255),
    u8(1),
    borshString('binder'),
    u8(0),
    ...Array.from({ length: 9 }, () => u32LE(0)),
    args.dropSeed,
  ]);
  const data = Buffer.alloc(BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED);
  assert.ok(payload.length <= data.length);
  payload.copy(data);
  return data;
}

function exactResumeArgs(overrides: {
  data?: Buffer;
  symbol?: string;
} = {}) {
  const admin = pubkey(1);
  const treasury = pubkey(2);
  const coreCollection = pubkey(3);
  const discountMerkleRoot = Buffer.alloc(32, 7);
  const dropSeed = Buffer.alloc(32, 9);
  return {
    data:
      overrides.data ??
      encodeExactResumeConfig({
        admin,
        treasury,
        coreCollection,
        discountMerkleRoot,
        dropSeed,
      }),
    admin,
    treasury,
    coreCollection,
    priceLamports: 100n,
    discountPriceLamports: 90n,
    discountMintsPerWallet: 1,
    discountMerkleRoot,
    maxSupply: 15,
    itemsPerBox: 0,
    maxPerTx: 1,
    namePrefix: 'binder',
    figureNamePrefix: 'binder',
    symbol: overrides.symbol ?? 'receipts',
    metadataBase: 'https://cdn.lil.org/nft/card_nft_binder/json',
    dropSeed,
  };
}

test('deploy config decoding preserves its size error and ownership-gated discriminator policy', () => {
  assert.throws(
    () =>
      decodeBoxMinterConfigForDeployPreflight(
        Buffer.alloc(BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS - 1),
      ),
    new RegExp(
      `expected config account size >= ${BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS} bytes`,
    ),
  );

  const decoded = decodeBoxMinterConfigForDeployPreflight(
    Buffer.alloc(BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS),
  );
  assert.equal(decoded.itemsPerBox, 0);
  assert.equal(decoded.admin.toBase58(), PublicKey.default.toBase58());
});

test('exact resume accepts only an identical unstarted zero-mint config', () => {
  const expected = exactResumeArgs();
  assert.doesNotThrow(() => assertExistingConfigMatchesResume(expected));
  assert.throws(
    () =>
      assertExistingConfigMatchesResume({
        ...expected,
        symbol: 'different',
      }),
    /symbol differ/,
  );
  assert.throws(
    () =>
      assertExistingConfigMatchesResume(
        exactResumeArgs({
          data: encodeExactResumeConfig({
            admin: expected.admin,
            treasury: expected.treasury,
            coreCollection: expected.coreCollection,
            discountMerkleRoot: expected.discountMerkleRoot,
            dropSeed: expected.dropSeed,
            started: true,
          }),
        }),
      ),
    /started differ/,
  );
  assert.throws(
    () =>
      assertExistingConfigMatchesResume(
        exactResumeArgs({
          data: encodeExactResumeConfig({
            admin: expected.admin,
            treasury: expected.treasury,
            coreCollection: expected.coreCollection,
            discountMerkleRoot: expected.discountMerkleRoot,
            dropSeed: expected.dropSeed,
            minted: 1,
          }),
        }),
      ),
    /minted differ/,
  );
});

test('receipt pool tree decoder reads Bubblegum V2 capacity and mint state', () => {
  const creator = pubkey(44);
  const authority = pubkey(45);
  const merkleTreeData = Buffer.alloc(56);
  merkleTreeData[0] = 1;
  merkleTreeData[1] = 0;
  merkleTreeData.writeUInt32LE(64, 2);
  merkleTreeData.writeUInt32LE(14, 6);
  authority.toBuffer().copy(merkleTreeData, 10);
  const treeConfigData = Buffer.alloc(96);
  Buffer.from([122, 245, 175, 248, 171, 34, 0, 207]).copy(
    treeConfigData,
  );
  creator.toBuffer().copy(treeConfigData, 8);
  creator.toBuffer().copy(treeConfigData, 40);
  treeConfigData.writeBigUInt64LE(16_384n, 72);
  treeConfigData.writeBigUInt64LE(15n, 80);
  treeConfigData[88] = 0;
  treeConfigData[90] = 1;

  const decoded = decodeReceiptTreeState({
    merkleTreeData,
    treeConfigData,
  });
  assert.equal(decoded.maxDepth, 14);
  assert.equal(decoded.maxBufferSize, 64);
  assert.equal(decoded.authority.toBase58(), authority.toBase58());
  assert.equal(decoded.creator.toBase58(), creator.toBase58());
  assert.equal(decoded.delegate.toBase58(), creator.toBase58());
  assert.equal(decoded.totalCapacity, 16_384);
  assert.equal(decoded.numMinted, 15);
  assert.equal(decoded.isPublic, false);
  assert.equal(decoded.version, 1);
});

test('receipt pool on-chain validation uses its explicit commitment', async () => {
  let observedCommitment: Commitment | undefined;
  const connection = {
    getMultipleAccountsInfo: async (
      _addresses: PublicKey[],
      config?: { commitment?: Commitment },
    ) => {
      observedCommitment = config?.commitment;
      return [null, null, null];
    },
  } as unknown as Connection;

  await assert.rejects(
    () =>
      validateReceiptPoolDeploymentOnchain({
        connection,
        collectionMint: pubkey(50),
        receiptsMerkleTree: pubkey(51),
        authority: pubkey(52),
        collectionMetadataUri:
          'https://assets.example.com/receipt-pool/collection.json',
        collectionName: 'receipt pool',
        royaltiesBasisPoints: 500,
        royaltiesRecipient: pubkey(53),
        receiptsTreeMaxDepth: 14,
        receiptsTreeMaxBufferSize: 64,
        receiptsTreeCanopyDepth: 8,
        commitment: RECEIPT_POOL_FINALIZED_COMMITMENT,
      }),
    /Missing receipt pool collection/,
  );
  assert.equal(observedCommitment, 'finalized');
});

function makeDiscountMerkleFinalizationFixture() {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'mons-shop-proof-finalization-'));
  const root = Buffer.alloc(32, 7);
  const rootHex = root.toString('hex');
  const proofs = { [pubkey(90).toBase58()]: [] };
  return {
    rootDir,
    root,
    rootHex,
    proofs,
    payload: `${JSON.stringify({ root: rootHex, proofs }, null, 2)}\n`,
    filePath: path.join(rootDir, 'default.json'),
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

type DeploymentRegistryTestDrop = DeploymentDropConfigSerialized;

function deploymentRegistryTestDrop(args: {
  dropId: string;
  programId: string;
  dropFamily?: DeploymentDropConfigSerialized['dropFamily'];
  metadataPathFormat?: 'legacy' | 'compact';
  discountMerkleRoot?: string;
}): DeploymentRegistryTestDrop {
  return {
    dropId: args.dropId,
    solanaCluster: 'devnet',
    dropFamily: args.dropFamily || 'default',
    collectionName: args.dropId,
    metadataBase: `https://assets.example.com/drops/${args.dropId}`,
    metadataPathFormat: args.metadataPathFormat || 'compact',
    treasury: pubkey(10).toBase58(),
    priceSol: 1,
    discountPriceSol: 0.5,
    discountMintsPerWallet: 1,
    discountMerkleRoot: args.discountMerkleRoot || '11'.repeat(32),
    maxSupply: 10,
    itemsPerBox: 1,
    maxPerTx: 5,
    namePrefix: 'box',
    figureNamePrefix: 'figure',
    symbol: 'mons',
    boxMinterProgramId: args.programId,
    collectionMint: pubkey(11).toBase58(),
    receiptsMerkleTree: pubkey(12).toBase58(),
    deliveryLookupTable: pubkey(13).toBase58(),
  };
}

function makeDeploymentRegistryFixture(
  drops: DeploymentRegistryTestDrop[],
) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'mons-shop-deploy-registry-'));
  const registryPath = path.join(
    rootDir,
    'functions',
    'src',
    'shared',
    'deploymentRegistry.ts',
  );
  mkdirSync(path.dirname(registryPath), { recursive: true });
  const writeDrops = (nextDrops: DeploymentRegistryTestDrop[]) => {
    const serialized = JSON.stringify(
      Object.fromEntries(nextDrops.map((drop) => [drop.dropId, drop])),
    );
    writeFileSync(
      registryPath,
      [
        `export const DEPLOYMENT_DROPS = ${serialized};`,
        '',
      ].join('\n'),
      'utf8',
    );
  };
  writeDrops(drops);
  return { rootDir, registryPath, writeDrops };
}

async function captureRejection(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (err) {
    return err;
  }
  assert.fail('Expected promise to reject');
}

test('new-drop loading validates IDs before path traversal or module import', async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'mons-shop-new-drop-loader-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const configsDir = path.join(rootDir, 'scripts', 'newDrops');
  mkdirSync(configsDir, { recursive: true });
  writeFileSync(
    path.join(configsDir, 'constructor.ts'),
    "throw new Error('unsafe config module was imported');\n",
    'utf8',
  );

  for (const dropId of [
    'constructor',
    '../outside',
    'bad id',
    'a'.repeat(65),
  ]) {
    await assert.rejects(
      loadNewDropConfigById({ root: rootDir, dropId }),
      /Invalid requested dropId/,
      dropId,
    );
  }

  const boundaryDropId = `a${'b'.repeat(63)}`;
  writeFileSync(
    path.join(configsDir, `${boundaryDropId}.ts`),
    `export const NEW_DROP = {
      shared: {},
      deploy: {},
      onchain: { dropId: '${boundaryDropId}' },
    };\n`,
    'utf8',
  );
  const loaded = await loadNewDropConfigById({
    root: rootDir,
    dropId: boundaryDropId.toUpperCase(),
  });
  assert.equal(loaded.config.onchain.dropId, boundaryDropId);
  assert.equal(loaded.configPath, path.join(configsDir, `${boundaryDropId}.ts`));
});

test('new-drop loading rejects an unsafe configured ID after loading a safe file', async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'mons-shop-new-drop-config-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const configsDir = path.join(rootDir, 'scripts', 'newDrops');
  mkdirSync(configsDir, { recursive: true });
  writeFileSync(
    path.join(configsDir, 'safe_file.ts'),
    `export const NEW_DROP = {
      shared: {},
      deploy: {},
      onchain: { dropId: 'constructor' },
    };\n`,
    'utf8',
  );

  await assert.rejects(
    loadNewDropConfigById({ root: rootDir, dropId: 'safe_file' }),
    /Invalid NEW_DROP\.onchain\.dropId/,
  );
});

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

test('canonical registry commit keeps durable bytes when verification reading fails', async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'mons-shop-registry-commit-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const registryPath = path.join(rootDir, 'deploymentRegistry.ts');
  const before = 'export const DEPLOYMENT_DROPS = { before: true };\n';
  const written = 'export const DEPLOYMENT_DROPS = { after: true };\n';
  writeFileSync(registryPath, before, 'utf8');
  const verificationError = new Error('verification read failed');
  let snapshotCalls = 0;

  const rejected = await captureRejection(() =>
    commitDeploymentRegistry(
      {
        registryPath,
        expectedSnapshot: { exists: true, content: before },
        expectedWrittenSnapshot: { exists: true, content: written },
      },
      {
        snapshot(filePath) {
          snapshotCalls += 1;
          if (snapshotCalls === 2) throw verificationError;
          return {
            exists: true,
            content: readFileSync(filePath, 'utf8'),
          };
        },
      },
    ),
  );

  assert.equal(
    isDeploymentRegistryPostCommitVerificationError(rejected),
    true,
  );
  assert.equal(
    rejected instanceof DeploymentRegistryPostCommitVerificationError,
    true,
  );
  assert.strictEqual(
    (rejected as DeploymentRegistryPostCommitVerificationError).cause,
    verificationError,
  );
  assert.equal(snapshotCalls, 2);
  assert.equal(readFileSync(registryPath, 'utf8'), written);
});

test('canonical registry verification preserves a concurrent post-write change', async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'mons-shop-registry-commit-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const registryPath = path.join(rootDir, 'deploymentRegistry.ts');
  const before = 'export const DEPLOYMENT_DROPS = { before: true };\n';
  const written = 'export const DEPLOYMENT_DROPS = { after: true };\n';
  const concurrent = 'export const DEPLOYMENT_DROPS = { concurrent: true };\n';
  writeFileSync(registryPath, before, 'utf8');
  let snapshotCalls = 0;

  const rejected = await captureRejection(() =>
    commitDeploymentRegistry(
      {
        registryPath,
        expectedSnapshot: { exists: true, content: before },
        expectedWrittenSnapshot: { exists: true, content: written },
      },
      {
        snapshot(filePath) {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            writeFileSync(filePath, concurrent, 'utf8');
          }
          return {
            exists: true,
            content: readFileSync(filePath, 'utf8'),
          };
        },
      },
    ),
  );

  assert.equal(
    isDeploymentRegistryPostCommitVerificationError(rejected),
    true,
  );
  assert.equal(
    rejected instanceof DeploymentRegistryPostCommitVerificationError,
    true,
  );
  assert.match(
    String((rejected as DeploymentRegistryPostCommitVerificationError).cause),
    /write did not produce the prepared content/,
  );
  assert.equal(readFileSync(registryPath, 'utf8'), concurrent);
});

test('canonical registry commit rejects source drift before mutation', async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'mons-shop-registry-commit-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const registryPath = path.join(rootDir, 'deploymentRegistry.ts');
  const prepared = 'export const DEPLOYMENT_DROPS = { prepared: true };\n';
  const changed = 'export const DEPLOYMENT_DROPS = { changed: true };\n';
  writeFileSync(registryPath, changed, 'utf8');

  const rejected = await captureRejection(() =>
    commitDeploymentRegistry({
      registryPath,
      expectedSnapshot: { exists: true, content: prepared },
      expectedWrittenSnapshot: {
        exists: true,
        content: 'export const DEPLOYMENT_DROPS = { after: true };\n',
      },
    }),
  );

  assert.match(
    String(rejected),
    /Canonical deployment registry changed after it was prepared/,
  );
  assert.equal(
    isDeploymentRegistryPostCommitVerificationError(rejected),
    false,
  );
  assert.equal(readFileSync(registryPath, 'utf8'), changed);
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

test('shared receipt pool collection forbids config PDA delegates', () => {
  const authority = pubkey(30);
  const configPda = pubkey(10);
  assert.doesNotThrow(() =>
    assertReceiptPoolCollectionUpdateDelegatePolicy({
      data: encodeCollectionWithUpdateDelegates({
        delegates: [authority],
      }),
      authority,
    }),
  );
  assert.throws(
    () =>
      assertReceiptPoolCollectionUpdateDelegatePolicy({
        data: encodeCollectionWithUpdateDelegates({
          delegates: [authority, configPda],
        }),
        authority,
      }),
    /delegate only to its fixed authority/,
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

test('card_nft_binder configs use the shared Stripe-only receipt pool', () => {
  const spec = requireReceiptPoolSpec(MONS_SHOP_RECEIPTS_POOL_ID);
  assert.equal(spec.collectionMetadataUri, 'https://cdn.lil.org/nft/mons_shop_receipts/collection.json');
  assert.equal(spec.receiptsTree.maxDepth, 14);
  assert.equal(spec.receiptsTree.maxBufferSize, 64);
  assert.equal(spec.receiptsTree.canopyDepth, 8);

  for (const drop of [
    CARD_NFT_BINDER_NEW_DROP,
    CARD_NFT_BINDER_DEVNET_NEW_DROP,
  ]) {
    assert.equal(drop.onchain.dropFamily, 'card_nft_binder');
    assert.equal(drop.onchain.displayName, 'Card NFT Binder');
    assert.equal(drop.onchain.salesMode, 'stripe_receipt_only');
    assert.equal(drop.onchain.receiptPoolId, MONS_SHOP_RECEIPTS_POOL_ID);
    assert.equal(drop.onchain.metadataBase, 'https://cdn.lil.org/nft/card_nft_binder/json');
    assert.equal(drop.onchain.collectionMetadata, undefined);
    assert.equal(drop.onchain.receiptsTree, undefined);
    assert.equal(drop.onchain.coreCollectionRoyaltiesBps, undefined);
    assert.equal(drop.onchain.symbol, undefined);
    assert.equal(drop.onchain.priceSol, 1_000_000);
    assert.equal(drop.onchain.discountPriceSol, 1_000_000);
    assert.equal(drop.onchain.stripeCheckoutEnabled, true);
    assert.equal(drop.onchain.itemsPerBox, 0);
    assert.equal(drop.onchain.maxPerTx, 1);
    assert.equal(drop.onchain.maxSupply, 15);
  }

  assert.equal(
    CARD_NFT_BINDER_NEW_DROP.deploy.reuseProgramIdFromDropId,
    'little_swag_hoodies',
  );
  assert.equal(
    CARD_NFT_BINDER_DEVNET_NEW_DROP.deploy.reuseProgramIdFromDropId,
    'little_swag_hoodies_devnet',
  );
  assert.equal(
    CARD_NFT_BINDER_NEW_DROP.onchain.stripeLiveUnitAmountCents,
    10_000,
  );
  assert.equal(
    CARD_NFT_BINDER_DEVNET_NEW_DROP.onchain.stripeLiveUnitAmountCents,
    undefined,
  );
});

test('shared receipt pool capacity is aggregate and rejects untracked mints', () => {
  const existing = deploymentRegistryTestDrop({
    dropId: 'existing_receipt_drop',
    programId: pubkey(70).toBase58(),
  });
  existing.solanaCluster = 'devnet';
  existing.salesMode = 'stripe_receipt_only';
  existing.receiptPoolId = MONS_SHOP_RECEIPTS_POOL_ID;
  existing.metadataBase = 'https://assets.example.com/receipt-a';
  existing.maxSupply = 10;
  existing.itemsPerBox = 0;
  existing.maxPerTx = 1;

  assert.deepEqual(
    assertReceiptPoolCapacity({
      solanaCluster: 'devnet',
      receiptPoolId: MONS_SHOP_RECEIPTS_POOL_ID,
      metadataBase: 'https://assets.example.com/receipt-b',
      maxSupply: 15,
      treeMaxDepth: 14,
      existingDrops: { existing_receipt_drop: existing },
      onchainNumMinted: 10,
    }),
    { reservedLeaves: 25, capacity: 16_384 },
  );
  assert.throws(
    () =>
      assertReceiptPoolCapacity({
        solanaCluster: 'devnet',
        receiptPoolId: MONS_SHOP_RECEIPTS_POOL_ID,
        metadataBase: 'https://assets.example.com/receipt-b',
        maxSupply: 15,
        treeMaxDepth: 14,
        existingDrops: { existing_receipt_drop: existing },
        onchainNumMinted: 11,
      }),
    /minted leaves but only 10 registered leaves/,
  );
  assert.throws(
    () =>
      assertReceiptPoolCapacity({
        solanaCluster: 'devnet',
        receiptPoolId: MONS_SHOP_RECEIPTS_POOL_ID,
        metadataBase: existing.metadataBase,
        maxSupply: 1,
        treeMaxDepth: 14,
        existingDrops: { existing_receipt_drop: existing },
      }),
    /already has a drop using metadataBase/,
  );
});

test('receipt metadata preflight uses pool capacity above 10,000', async () => {
  let fetched = 0;
  await assertReceiptMetadataRange({
    metadataBase: 'https://assets.example.com/large-receipt-drop',
    maxSupply: 10_001,
    treeCapacity: 16_384,
    fetchImpl: async (input) => {
      fetched += 1;
      const match = /\/rb(\d+)\.json$/.exec(String(input));
      assert.ok(match);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: Number(match[1]),
          name: `Receipt ${match[1]}`,
          image: 'https://assets.example.com/receipt.webp',
        }),
      } as Response;
    },
  });
  assert.equal(fetched, 10_001);

  await assert.rejects(
    () =>
      assertReceiptMetadataRange({
        metadataBase: 'https://assets.example.com/oversized-receipt-drop',
        maxSupply: 16_385,
        treeCapacity: 16_384,
        fetchImpl: async () => {
          throw new Error('fetch must not run');
        },
      }),
    /expected an integer in 1\.\.16384/,
  );
});

test('receipt metadata preflight limits request concurrency to 16', async () => {
  let active = 0;
  let maxActive = 0;
  await assertReceiptMetadataRange({
    metadataBase: 'https://assets.example.com/concurrent-receipt-drop',
    maxSupply: 40,
    treeCapacity: 16_384,
    fetchImpl: async (input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      const match = /\/rb(\d+)\.json$/.exec(String(input));
      assert.ok(match);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: Number(match[1]),
          name: `Receipt ${match[1]}`,
          image: 'https://assets.example.com/receipt.webp',
        }),
      } as Response;
    },
  });
  assert.equal(maxActive, 16);
});

test('receipt pool journal retries recover atomically and regenerate only after expiry', () => {
  assert.equal(
    classifyReceiptPoolJournalRetry({
      collectionExists: true,
      treeExists: true,
      currentBlockHeight: 10,
      lastValidBlockHeight: 20,
    }),
    'recover',
  );
  assert.equal(
    classifyReceiptPoolJournalRetry({
      collectionExists: true,
      treeExists: false,
      currentBlockHeight: 10,
      lastValidBlockHeight: 20,
    }),
    'partial',
  );
  assert.equal(
    classifyReceiptPoolJournalRetry({
      collectionExists: false,
      treeExists: false,
      currentBlockHeight: 20,
      lastValidBlockHeight: 20,
    }),
    'wait_for_expiry',
  );
  assert.equal(
    classifyReceiptPoolJournalRetry({
      collectionExists: false,
      treeExists: false,
      currentBlockHeight: 21,
      lastValidBlockHeight: 20,
    }),
    'regenerate',
  );
});

test('receipt pool deployment validates cluster identity and finalization before commit', async () => {
  assert.doesNotThrow(() =>
    assertReceiptPoolRpcGenesisHash({
      solanaCluster: 'devnet',
      genesisHash: RECEIPT_POOL_CLUSTER_GENESIS_HASHES.devnet,
    }),
  );
  assert.doesNotThrow(() =>
    assertReceiptPoolRpcGenesisHash({
      solanaCluster: 'mainnet-beta',
      genesisHash:
        RECEIPT_POOL_CLUSTER_GENESIS_HASHES['mainnet-beta'],
    }),
  );
  assert.throws(
    () =>
      assertReceiptPoolRpcGenesisHash({
        solanaCluster: 'devnet',
        genesisHash:
          RECEIPT_POOL_CLUSTER_GENESIS_HASHES['mainnet-beta'],
      }),
    /genesis hash mismatch/,
  );
  assert.throws(
    () =>
      assertReceiptPoolRpcGenesisHash({
        solanaCluster: 'mainnet-beta',
        genesisHash: 'unknown-genesis-hash',
      }),
    /genesis hash mismatch/,
  );
  assert.equal(RECEIPT_POOL_FINALIZED_COMMITMENT, 'finalized');

  const events: string[] = [];
  await assert.rejects(
    () =>
      completeReceiptPoolJournal({
        journalPath: '/unused/receipt-pool-journal.json',
        finalize: async () => {
          events.push('finalize');
          throw new Error('finalization failed');
        },
        commit: async () => {
          events.push('commit');
        },
        removeJournal: () => {
          events.push('remove');
        },
      }),
    /finalization failed/,
  );
  assert.deepEqual(events, ['finalize']);
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
