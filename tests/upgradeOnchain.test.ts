import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import bs58 from 'bs58';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import {
  assertImmutableArtifactUnchanged,
  assertPostUpgradeProgramIdentity,
  assertProgramBinaryFitsProgramData,
  assertProgramImageEquivalent,
  assertProgramSnapshotUnchanged,
  assertResumeBufferComplete,
  assertResumeBufferConsumed,
  assertResumeBufferUnchanged,
  assertResumeSolanaCliVersion,
  assertSupportedUpgradeTarget,
  assertUpgradeRpcGenesisHash,
  buildProgramDeployArgs,
  buildProgramDumpArgs,
  buildProgramShowArgs,
  buildProgramUpgradeArgs,
  buildProgramWriteBufferArgs,
  captureCoherentUpgradeGateState,
  captureStableProgramSnapshot,
  cleanupUpgradeResources,
  CommandCancellationController,
  CommandCancelledError,
  expectedPaddedProgramImageSha256,
  inspectSharedProgramConfigs,
  inspectResumeBufferAccount,
  loadResumeBufferKeypair,
  parseArgs,
  postUpgradeConfigMinContextSlot,
  programImagesAreEquivalent,
  redactRpcDetailsInText,
  redactRpcUrl,
  runAfterUnchangedUpgradeGate,
  runDeployAttemptWithVerification,
  runBufferWriteAttemptWithVerification,
  runUpgradeCommand,
  shouldDeferUpgradeSignalExit,
  UPGRADE_CLUSTER_GENESIS_HASHES,
  UPGRADE_PROGRAM_TARGETS,
  validateRpcUrl,
  type ProgramShowInfo,
  type SharedProgramConfigAudit,
  type UpgradeGateState,
} from '../scripts/upgrade-onchain.ts';
import { createPromptCancelledError } from '../scripts/shared/interactive.ts';
import {
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED,
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_SPLIT_PAYMENTS_V1,
  BOX_MINTER_CONFIG_DISCRIMINATOR,
  BOX_MINTER_SPLIT_PAYMENTS_V1_MAGIC,
  BOX_MINTER_SPLIT_PAYMENTS_V1_VERSION,
} from '../shared/boxMinterConfigCodec.ts';
import { BOX_MINTER_CONFIG_SEED } from '../shared/boxMinterProtocol.ts';
import {
  BOX_MINTER_CONFIG_TOMBSTONES,
  DEPLOYMENT_DROPS,
  type DeploymentRegistryDrop,
  type PaymentRoutingConfig,
} from '../shared/deploymentRegistry.ts';
import {
  readDeploymentDropRegistry,
  renderDeploymentRegistryFileFromSource,
} from '../scripts/shared/deploymentRegistry.ts';

const REGISTRY_PATH = path.join(
  process.cwd(),
  'shared/deploymentRegistry.ts',
);
const DEVNET_PROGRAM_ID = new PublicKey(
  UPGRADE_PROGRAM_TARGETS.devnet.programId,
);
const TREASURY = 'AWmNR6t5g5zipT2NMkSPRBXxB9Th8LsZcJX71yNyzsgE';
const COLLECTION = 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq';
const THIRD_RECIPIENT = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
const SPLIT_ROUTING = {
  mintProceeds: [
    { address: TREASURY, percentage: 70 },
    { address: COLLECTION, percentage: 20 },
    { address: THIRD_RECIPIENT, percentage: 10 },
  ],
  deliveryPaymentReceiver: COLLECTION,
} as const satisfies PaymentRoutingConfig;

type Route = {
  deliveryPaymentReceiver: string;
  mintProceeds: ReadonlyArray<{ address: string; percentage: number }>;
};

type ConfigFixture = {
  dropId: string;
  pda: PublicKey;
  bump: number;
  dropSeed: Buffer;
  collectionMint: string;
  route: Route;
  size: 376 | 488;
  source: 'active-registry' | 'tombstone';
};

function u32LE(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function u64LE(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value);
  return Buffer.concat([u32LE(bytes.length), bytes]);
}

function routeFromPaymentRouting(paymentRouting: PaymentRoutingConfig): Route {
  return {
    deliveryPaymentReceiver: paymentRouting.deliveryPaymentReceiver,
    mintProceeds: paymentRouting.mintProceeds.map((recipient) => ({
      address: recipient.address,
      percentage: recipient.percentage,
    })),
  };
}

function legacyRoute(treasury: string): Route {
  return {
    deliveryPaymentReceiver: treasury,
    mintProceeds: [{ address: treasury, percentage: 100 }],
  };
}

function activeFixture(drop: DeploymentRegistryDrop): ConfigFixture {
  const dropSeed = createHash('sha256').update(drop.dropId).digest();
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from(BOX_MINTER_CONFIG_SEED), dropSeed],
    DEVNET_PROGRAM_ID,
  );
  assert.equal(pda.toBase58(), drop.boxMinterConfigPda);
  return {
    dropId: drop.dropId,
    pda,
    bump,
    dropSeed,
    collectionMint: drop.collectionMint,
    route: drop.paymentRouting
      ? routeFromPaymentRouting(drop.paymentRouting)
      : legacyRoute(drop.treasury),
    size: drop.paymentRouting ? 488 : 376,
    source: 'active-registry',
  };
}

function devnetFixtures(): ConfigFixture[] {
  const active = Object.values(DEPLOYMENT_DROPS)
    .filter(
      (drop) =>
        drop.solanaCluster === 'devnet' &&
        drop.boxMinterProgramId === DEVNET_PROGRAM_ID.toBase58(),
    )
    .map(activeFixture);
  const tombstones = Object.values(BOX_MINTER_CONFIG_TOMBSTONES)
    .filter(
      (tombstone) =>
        tombstone.solanaCluster === 'devnet' &&
        tombstone.boxMinterProgramId === DEVNET_PROGRAM_ID.toBase58(),
    )
    .map((tombstone): ConfigFixture => {
      const dropSeed = Buffer.from(tombstone.dropSeed, 'hex');
      const [pda, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from(BOX_MINTER_CONFIG_SEED), dropSeed],
        DEVNET_PROGRAM_ID,
      );
      assert.equal(pda.toBase58(), tombstone.boxMinterConfigPda);
      return {
        dropId: tombstone.dropId,
        pda,
        bump,
        dropSeed,
        collectionMint: tombstone.collectionMint,
        route: tombstone.paymentRouting
          ? routeFromPaymentRouting(tombstone.paymentRouting)
          : legacyRoute(tombstone.treasury),
        size: tombstone.accountSize,
        source: 'tombstone',
      };
    });
  return [...active, ...tombstones].sort((left, right) =>
    left.dropId.localeCompare(right.dropId),
  );
}

function configData(
  fixture: ConfigFixture,
  overrides: { treasury?: string; collectionMint?: string } = {},
): Buffer {
  const treasury =
    overrides.treasury || fixture.route.deliveryPaymentReceiver;
  const collectionMint = overrides.collectionMint || fixture.collectionMint;
  const payload = Buffer.concat([
    Buffer.from(BOX_MINTER_CONFIG_DISCRIMINATOR),
    PublicKey.default.toBuffer(),
    new PublicKey(treasury).toBuffer(),
    new PublicKey(collectionMint).toBuffer(),
    u64LE(1n),
    u64LE(1n),
    Buffer.alloc(32),
    u32LE(1),
    Buffer.from([1, 1]),
    u32LE(0),
    borshString('box'),
    borshString('mons'),
    borshString('https://assets.example.com/drop'),
    Buffer.from([0, fixture.bump, 1]),
    borshString('figure'),
    Buffer.alloc(37),
    fixture.dropSeed,
  ]);
  const data = Buffer.alloc(fixture.size);
  payload.copy(data);
  if (fixture.size === BOX_MINTER_CONFIG_ACCOUNT_SIZE_SPLIT_PAYMENTS_V1) {
    Buffer.from(BOX_MINTER_SPLIT_PAYMENTS_V1_MAGIC).copy(
      data,
      BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED,
    );
    data[384] = BOX_MINTER_SPLIT_PAYMENTS_V1_VERSION;
    data[385] = fixture.route.mintProceeds.length;
    for (let index = 0; index < 3; index += 1) {
      const recipient = fixture.route.mintProceeds[index];
      const address = recipient
        ? new PublicKey(recipient.address)
        : PublicKey.default;
      address.toBuffer().copy(data, 386 + index * 32);
      data[482 + index] = recipient?.percentage || 0;
    }
  }
  return data;
}

type MockConfigRow = {
  fixture: ConfigFixture;
  data?: Buffer;
  pubkey?: PublicKey;
  executable?: boolean;
};

function mockConnection(args: {
  rows: MockConfigRow[];
  contextSlot?: number;
  onConfig?: (value: Record<string, unknown>) => void;
}): Connection {
  return {
    getProgramAccounts: async (
      programId: PublicKey,
      config: Record<string, unknown>,
    ) => {
      assert.equal(programId.toBase58(), DEVNET_PROGRAM_ID.toBase58());
      args.onConfig?.(config);
      return {
        context: { slot: args.contextSlot ?? 900 },
        value: args.rows.map((row) => ({
          pubkey: row.pubkey || row.fixture.pda,
          account: {
            data: row.data || configData(row.fixture),
            owner: DEVNET_PROGRAM_ID,
            executable: row.executable ?? false,
            lamports: 1,
            rentEpoch: 0,
          },
        })),
      };
    },
  } as unknown as Connection;
}

function inspect(connection: Connection, minContextSlot = 700) {
  return inspectSharedProgramConfigs({
    connection,
    cluster: 'devnet',
    programId: DEVNET_PROGRAM_ID,
    registryPath: REGISTRY_PATH,
    minContextSlot,
  });
}

function showInfo(
  overrides: Partial<ProgramShowInfo> = {},
): ProgramShowInfo {
  return {
    programId: DEVNET_PROGRAM_ID.toBase58(),
    owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
    programdataAddress: COLLECTION,
    authority: TREASURY,
    lastDeploySlot: 100,
    dataLen: 8,
    lamports: 20,
    balance: 0.00000002,
    ...overrides,
  };
}

function gateState(imageByte: number): UpgradeGateState {
  return {
    program: captureStableProgramSnapshot({
      expectedProgramId: DEVNET_PROGRAM_ID.toBase58(),
      stage: 'gate fixture',
      readShow: () => showInfo(),
      dumpImage: () => Buffer.alloc(8, imageByte),
    }),
    configs: [],
    minContextSlot: 900,
  };
}

test('program show dataLen is the direct payload capacity', () => {
  assert.equal(
    assertProgramBinaryFitsProgramData({
      programId: 'program',
      binaryBytes: 516_992,
      programDataBytes: 518_720,
    }),
    518_720,
  );
});

test('program capacity failure reports the exact explicit extension bytes', () => {
  assert.throws(
    () =>
      assertProgramBinaryFitsProgramData({
        programId: 'program',
        binaryBytes: 546,
        programDataBytes: 520,
      }),
    /solana program extend program 26/,
  );
});

test('program capacity rejects missing, zero, and invalid binary sizes', () => {
  assert.throws(
    () =>
      assertProgramBinaryFitsProgramData({
        programId: 'program',
        binaryBytes: 100,
      }),
    /Could not determine ProgramData payload capacity/,
  );
  assert.throws(() =>
    assertProgramBinaryFitsProgramData({
      programId: 'program',
      binaryBytes: 100,
      programDataBytes: 0,
    }),
  );
  assert.throws(() =>
    assertProgramBinaryFitsProgramData({
      programId: 'program',
      binaryBytes: 0,
      programDataBytes: 100,
    }),
  );
});

test('program image equivalence requires exact ELF bytes and a zero suffix', () => {
  const localBinary = Buffer.from([1, 2, 3, 4]);
  const deployedImage = Buffer.from([1, 2, 3, 4, 0, 0, 0, 0]);
  assert.doesNotThrow(() =>
    assertProgramImageEquivalent({
      localBinary,
      deployedImage,
      payloadCapacity: 8,
    }),
  );
  assert.equal(
    programImagesAreEquivalent({
      localBinary,
      deployedImage,
      payloadCapacity: 8,
    }),
    true,
  );
  assert.throws(
    () =>
      assertProgramImageEquivalent({
        localBinary,
        deployedImage: Buffer.from([1, 2, 3, 4, 0, 9, 0, 0]),
        payloadCapacity: 8,
      }),
    /non-zero data after the local ELF/,
  );
  assert.throws(
    () =>
      assertProgramImageEquivalent({
        localBinary,
        deployedImage: Buffer.from([1, 2, 3, 4]),
        payloadCapacity: 8,
      }),
    /expected exact ProgramData payload capacity/,
  );
});

test('expected image hash hashes ELF plus exact zero padding', () => {
  const localBinary = Buffer.from([7, 8, 9]);
  const expected = createHash('sha256')
    .update(Buffer.from([7, 8, 9, 0, 0]))
    .digest('hex');
  assert.equal(
    expectedPaddedProgramImageSha256({
      localBinary,
      payloadCapacity: 5,
    }),
    expected,
  );
});

test('stable program snapshot is show-dump-show and ignores balance fields', () => {
  const calls: string[] = [];
  const shows = [
    showInfo({ lamports: 20, balance: 1 }),
    showInfo({ lamports: 21, balance: 2 }),
  ];
  const snapshot = captureStableProgramSnapshot({
    expectedProgramId: DEVNET_PROGRAM_ID.toBase58(),
    stage: 'test',
    readShow: () => {
      calls.push('show');
      return shows.shift();
    },
    dumpImage: () => {
      calls.push('dump');
      return Buffer.alloc(8, 4);
    },
  });
  assert.deepEqual(calls, ['show', 'dump', 'show']);
  assert.equal(snapshot.image.length, 8);
});

test('stable program snapshot rejects identity races and wrong dump lengths', () => {
  const changed = [showInfo(), showInfo({ lastDeploySlot: 101 })];
  assert.throws(
    () =>
      captureStableProgramSnapshot({
        expectedProgramId: DEVNET_PROGRAM_ID.toBase58(),
        stage: 'race',
        readShow: () => changed.shift(),
        dumpImage: () => Buffer.alloc(8),
      }),
    /changed during race show-dump-show snapshot/,
  );
  assert.throws(
    () =>
      captureStableProgramSnapshot({
        expectedProgramId: DEVNET_PROGRAM_ID.toBase58(),
        stage: 'length',
        readShow: () => showInfo(),
        dumpImage: () => Buffer.alloc(7),
      }),
    /expected exact ProgramData payload capacity 8/,
  );
});

test('snapshot race gate compares both identity and full dump hash', () => {
  const before = captureStableProgramSnapshot({
    expectedProgramId: DEVNET_PROGRAM_ID.toBase58(),
    stage: 'before',
    readShow: () => showInfo(),
    dumpImage: () => Buffer.alloc(8, 1),
  });
  const changedImage = captureStableProgramSnapshot({
    expectedProgramId: DEVNET_PROGRAM_ID.toBase58(),
    stage: 'after',
    readShow: () => showInfo(),
    dumpImage: () => Buffer.alloc(8, 2),
  });
  assert.throws(
    () =>
      assertProgramSnapshotUnchanged(before, changedImage, 'during build'),
    /Deployed program changed during build/,
  );
});

test('coherent upgrade gates bracket both config reads and reject mutations', async () => {
  const events: string[] = [];
  let auditCall = 0;
  const state = await captureCoherentUpgradeGateState({
    stage: 'final gate test',
    minContextSlot: 90,
    captureProgram: async () => {
      events.push('program');
      return gateState(1).program;
    },
    inspectConfigs: async (minContextSlot) => {
      events.push('config');
      auditCall += 1;
      assert.equal(minContextSlot, auditCall === 1 ? 100 : 110);
      return { slot: auditCall === 1 ? 110 : 120, configs: [] };
    },
  });
  assert.deepEqual(events, [
    'program',
    'config',
    'program',
    'config',
    'program',
  ]);
  assert.equal(state.minContextSlot, 120);

  const raceEvents: string[] = [];
  let raceProgramCall = 0;
  await assert.rejects(
    captureCoherentUpgradeGateState({
      stage: 'trailing audit race test',
      minContextSlot: 0,
      captureProgram: async () => {
        raceEvents.push('program');
        raceProgramCall += 1;
        return gateState(raceProgramCall === 3 ? 2 : 1).program;
      },
      inspectConfigs: async () => {
        raceEvents.push('config');
        return { slot: 100, configs: [] };
      },
    }),
    /Deployed program changed during final trailing audit race test config audit/,
  );
  assert.deepEqual(raceEvents, [
    'program',
    'config',
    'program',
    'config',
    'program',
  ]);

  const appearedConfig: SharedProgramConfigAudit = {
    dropId: 'appeared-between-reads',
    source: 'active-registry',
    configPda: TREASURY,
    size: 376,
    schema: 'legacy',
    dropSeed: '00'.repeat(32),
    bump: 1,
    collectionMint: COLLECTION,
    paymentRoute: legacyRoute(TREASURY),
  };
  let mutationAuditCall = 0;
  await assert.rejects(
    captureCoherentUpgradeGateState({
      stage: 'mutated final gate test',
      minContextSlot: 0,
      captureProgram: async () => gateState(1).program,
      inspectConfigs: async () => {
        mutationAuditCall += 1;
        return {
          slot: 100 + mutationAuditCall,
          configs:
            mutationAuditCall === 1
              ? []
              : [appearedConfig],
        };
      },
    }),
    /Shared program config audit changed/,
  );
});

test('a changed final snapshot prevents the deploy action from running', () => {
  let deployCalls = 0;
  assert.throws(
    () =>
      runAfterUnchangedUpgradeGate({
        before: gateState(1),
        after: gateState(2),
        stage: 'before deploy',
        action: () => {
          deployCalls += 1;
        },
      }),
    /Deployed program changed before deploy/,
  );
  assert.equal(deployCalls, 0);
});

test('deploy command errors still run finalized verification and classify the outcome', async () => {
  const events: string[] = [];
  const warnings: string[] = [];
  const verified = await runDeployAttemptWithVerification({
    deploy: async () => {
      events.push('deploy');
      throw new Error('RPC confirmation timed out');
    },
    verify: async () => {
      events.push('verify');
      return 'exact finalized image';
    },
    onWarning: (message) => warnings.push(message),
  });
  assert.equal(verified, 'exact finalized image');
  assert.deepEqual(events, ['deploy', 'verify']);
  assert.match(warnings.join('\n'), /verification|verifies the exact upgrade/i);

  await assert.rejects(
    runDeployAttemptWithVerification({
      deploy: async () => {
        throw new Error('RPC confirmation timed out');
      },
      verify: async () => {
        throw new Error('deployment slot did not advance');
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /outcome is ambiguous/i);
      assert.match(error.message, /do not retry blindly/i);
      assert.match(error.message, /RPC confirmation timed out/);
      assert.match(error.message, /deployment slot did not advance/);
      return true;
    },
  );
});

test('buffer write errors and cancellation never continue to program upgrade', async () => {
  const events: string[] = [];
  await assert.rejects(
    runBufferWriteAttemptWithVerification({
      write: async () => {
        events.push('write');
        throw new Error('write confirmation failed');
      },
      verify: async () => {
        events.push('verify');
        return 'exact buffer';
      },
    }),
    /program was not upgraded; rerun the complete recovery workflow/,
  );
  assert.deepEqual(events, ['write', 'verify']);

  const cancellation = new CommandCancellationController();
  await assert.rejects(
    runBufferWriteAttemptWithVerification({
      cancellation,
      write: async () => {},
      verify: async () => {
        cancellation.request('SIGTERM');
        return 'exact buffer';
      },
    }),
    (error: unknown) =>
      error instanceof CommandCancelledError && error.exitCode === 143,
  );

  await assert.rejects(
    runBufferWriteAttemptWithVerification({
      write: async () => {},
      verify: async () => {
        throw new Error('buffer remains partial');
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /BUFFER RECOVERY WRITE DID NOT VERIFY/);
      assert.match(error.message, /program was not upgraded/);
      assert.match(error.message, /buffer remains partial/);
      return true;
    },
  );
});

test('SIGTERM during failed finalized verification preserves the ambiguous exit code', async () => {
  const cancellation = new CommandCancellationController();
  await assert.rejects(
    runDeployAttemptWithVerification({
      cancellation,
      deploy: async () => {},
      verify: async () => {
        cancellation.request('SIGTERM');
        throw new Error('finalized verification failed');
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /outcome is ambiguous/i);
      assert.match(error.message, /reported success/);
      assert.equal((error as Error & { exitCode?: number }).exitCode, 143);
      return true;
    },
  );
});

test('SIGTERM cancels an active child command before the workflow settles', async () => {
  const cancellation = new CommandCancellationController();
  const command = runUpgradeCommand(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1_000)'],
    { cancellation },
  );
  const startedAt = Date.now();
  while (!cancellation.hasActiveChild && Date.now() - startedAt < 2_000) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(cancellation.hasActiveChild, true);
  cancellation.request('SIGTERM');

  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      assert.rejects(
        command,
        (error: unknown) =>
          error instanceof CommandCancelledError &&
          error.signal === 'SIGTERM' &&
          error.exitCode === 143,
      ),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          cancellation.request('SIGTERM');
          reject(new Error('cancelled command did not close'));
        }, 5_000);
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
  assert.equal(cancellation.hasActiveChild, false);
});

test('signals defer for active work but a repeated idle signal permits forced exit', () => {
  assert.equal(
    shouldDeferUpgradeSignalExit({
      childActive: false,
      deployVerificationPending: true,
      promptPending: false,
      repeatedSignal: false,
    }),
    true,
  );
  assert.equal(
    shouldDeferUpgradeSignalExit({
      childActive: false,
      deployVerificationPending: false,
      promptPending: true,
      repeatedSignal: false,
    }),
    true,
  );
  assert.equal(
    shouldDeferUpgradeSignalExit({
      childActive: false,
      deployVerificationPending: true,
      promptPending: true,
      repeatedSignal: true,
    }),
    false,
  );
  assert.equal(
    shouldDeferUpgradeSignalExit({
      childActive: true,
      deployVerificationPending: false,
      promptPending: false,
      repeatedSignal: true,
    }),
    true,
  );
});

test('raw Ctrl-C prompt cancellation carries the conventional exit code', () => {
  const error = createPromptCancelledError();
  assert.equal(error.message, 'Cancelled');
  assert.equal(error.exitCode, 130);
});

test('post-upgrade identity permits only an advancing deployment slot', () => {
  assert.doesNotThrow(() =>
    assertPostUpgradeProgramIdentity({
      before: showInfo(),
      after: showInfo({ lastDeploySlot: 101 }),
    }),
  );
  assert.throws(
    () =>
      assertPostUpgradeProgramIdentity({
        before: showInfo(),
        after: showInfo({ dataLen: 9, lastDeploySlot: 101 }),
      }),
    /dataLen changed/,
  );
  assert.throws(
    () =>
      assertPostUpgradeProgramIdentity({
        before: showInfo(),
        after: showInfo(),
      }),
    /lastDeploySlot did not advance/,
  );
});

test('post-upgrade config audits cannot read before the deployed program slot', () => {
  assert.equal(
    postUpgradeConfigMinContextSlot({
      previousAuditSlot: 900,
      lastDeploySlot: 1_000,
    }),
    1_000,
  );
  assert.equal(
    postUpgradeConfigMinContextSlot({
      previousAuditSlot: 1_100,
      lastDeploySlot: 1_000,
    }),
    1_100,
  );
  assert.throws(() =>
    postUpgradeConfigMinContextSlot({
      previousAuditSlot: -1,
      lastDeploySlot: 1_000,
    }),
  );
});

test('immutable artifact gate rejects permission, size, and hash changes', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'upgrade-artifact-test-'));
  const filePath = path.join(directory, 'program.so');
  try {
    const original = Buffer.from([1, 2, 3]);
    const digest = createHash('sha256').update(original).digest('hex');
    writeFileSync(filePath, original);
    chmodSync(filePath, 0o400);
    assert.doesNotThrow(() =>
      assertImmutableArtifactUnchanged({
        filePath,
        expectedBytes: 3,
        expectedSha256: digest,
        stage: 'test',
      }),
    );
    chmodSync(filePath, 0o600);
    assert.throws(
      () =>
        assertImmutableArtifactUnchanged({
          filePath,
          expectedBytes: 3,
          expectedSha256: digest,
          stage: 'test',
        }),
      /became writable/,
    );
    writeFileSync(filePath, Buffer.from([1, 2, 4]));
    chmodSync(filePath, 0o400);
    assert.throws(
      () =>
        assertImmutableArtifactUnchanged({
          filePath,
          expectedBytes: 3,
          expectedSha256: digest,
          stage: 'test',
        }),
      /hash changed/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cleanup reports sensitive-file and lock-release failures together', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'upgrade-cleanup-test-'));
  try {
    const errors = cleanupUpgradeResources({
      filePaths: [directory],
      releaseLock: () => false,
    });
    assert.equal(errors.length, 2);
    assert.match(errors[0].message, /Failed to remove sensitive temporary file/);
    assert.match(errors[1].message, /Failed to release the deployment-registry lock/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  'cleanup reports unlink failures caused by an inaccessible parent directory',
  {
    skip:
      process.platform === 'win32' ||
      (typeof process.getuid === 'function' && process.getuid() === 0),
  },
  () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'upgrade-cleanup-parent-'));
    const filePath = path.join(directory, 'authority.json');
    try {
      writeFileSync(filePath, 'secret');
      chmodSync(directory, 0o500);
      const errors = cleanupUpgradeResources({ filePaths: [filePath] });
      assert.equal(errors.length, 1);
      assert.match(errors[0].message, /Failed to remove sensitive temporary file/);
    } finally {
      chmodSync(directory, 0o700);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('RPC genesis validation pins devnet and mainnet', () => {
  assert.doesNotThrow(() =>
    assertUpgradeRpcGenesisHash({
      cluster: 'devnet',
      genesisHash: UPGRADE_CLUSTER_GENESIS_HASHES.devnet,
    }),
  );
  assert.doesNotThrow(() =>
    assertUpgradeRpcGenesisHash({
      cluster: 'mainnet-beta',
      genesisHash: UPGRADE_CLUSTER_GENESIS_HASHES['mainnet-beta'],
    }),
  );
  assert.throws(
    () =>
      assertUpgradeRpcGenesisHash({
        cluster: 'mainnet-beta',
        genesisHash: UPGRADE_CLUSTER_GENESIS_HASHES.devnet,
      }),
    /genesis hash mismatch/,
  );
});

test('custom RPC display redacts username, hostname, path, and query', () => {
  const rpcUrl = 'https://user:pass@secret-token.provider.example/private/key?api=secret';
  assert.equal(redactRpcUrl(rpcUrl), '<custom-rpc-url-redacted>');
  const childOutput = redactRpcDetailsInText(
    'failed at secret-token.provider.example for user pass /private/key secret',
    rpcUrl,
  );
  assert.doesNotMatch(childOutput, /secret-token|user|pass|private|secret/);
  assert.equal(
    validateRpcUrl(rpcUrl),
    'https://user:pass@secret-token.provider.example/private/key?api=secret',
  );
  assert.throws(() => validateRpcUrl('file:///secret'), /expected http or https/);
  assert.throws(() => validateRpcUrl('not a url'), /Invalid --rpc-url/);
});

test('custom RPC output redacts percent-decoded credentials, paths, and query values', () => {
  const rpcUrl =
    'https://user%40example.com:pass%3Aword@private-rpc.example/%70rivate%2Ftoken?api=query%2Fsecret';
  const childOutput = redactRpcDetailsInText(
    'user@example.com pass:word /private/token query/secret',
    rpcUrl,
  );
  for (const secret of [
    'user@example.com',
    'pass:word',
    '/private/token',
    'query/secret',
  ]) {
    assert.equal(childOutput.includes(secret), false, childOutput);
  }
});

test('custom RPC output redacts one-character secret components', () => {
  const rpcUrl = 'https://%75:%70@private-rpc.example/%78?api=%76';
  assert.equal(
    redactRpcDetailsInText('u|p|/x|v', rpcUrl),
    '<redacted>|<redacted>|<redacted>|<redacted>',
  );
});

test('scope gate supports only the two shared programs and requires explicit RPC only for mutation', () => {
  const mainnetDrop = DEPLOYMENT_DROPS.little_swag_hoodies;
  assert.doesNotThrow(() =>
    assertSupportedUpgradeTarget({
      drop: mainnetDrop,
      rpcUrlWasExplicit: false,
      isMutatingUpgrade: false,
    }),
  );
  assert.throws(
    () =>
      assertSupportedUpgradeTarget({
        drop: mainnetDrop,
        rpcUrlWasExplicit: false,
        isMutatingUpgrade: true,
      }),
    /require an explicit --rpc-url/,
  );
  assert.doesNotThrow(() =>
    assertSupportedUpgradeTarget({
      drop: mainnetDrop,
      rpcUrlWasExplicit: true,
      rpcUrl: 'https://private-rpc.example/',
      isMutatingUpgrade: true,
    }),
  );
  assert.throws(
    () =>
      assertSupportedUpgradeTarget({
        drop: mainnetDrop,
        rpcUrlWasExplicit: true,
        rpcUrl: 'https://api.mainnet-beta.solana.com/?ignored=query',
        isMutatingUpgrade: true,
      }),
    /public mainnet endpoint is audit-only/,
  );
  assert.throws(
    () =>
      assertSupportedUpgradeTarget({
        drop: mainnetDrop,
        rpcUrlWasExplicit: true,
        rpcUrl: 'https://api.mainnet-beta.solana.com./',
        isMutatingUpgrade: true,
      }),
    /public mainnet endpoint is audit-only/,
  );
  assert.throws(
    () =>
      assertSupportedUpgradeTarget({
        drop: mainnetDrop,
        rpcUrlWasExplicit: true,
        rpcUrl: 'http://api.mainnet-beta.solana.com/',
        isMutatingUpgrade: true,
      }),
    /require an HTTPS RPC URL/,
  );
  assert.throws(
    () =>
      assertSupportedUpgradeTarget({
        drop: DEPLOYMENT_DROPS.poncho_drifella,
        rpcUrlWasExplicit: true,
        isMutatingUpgrade: true,
      }),
    /unsupported program/,
  );
  assert.throws(
    () =>
      assertSupportedUpgradeTarget({
        drop: { ...mainnetDrop, boxMinterConfigPda: undefined },
        rpcUrlWasExplicit: true,
        isMutatingUpgrade: true,
      }),
    /missing boxMinterConfigPda/,
  );
});

test('program CLI arguments pin finalized and disable automatic extension', () => {
  const showArgs = buildProgramShowArgs({
    programId: DEVNET_PROGRAM_ID.toBase58(),
    solanaConfigPath: '/tmp/solana-config.yml',
  });
  assert.deepEqual(showArgs.slice(-2), ['--commitment', 'finalized']);
  const keypairIndex = showArgs.indexOf('--keypair');
  assert.ok(keypairIndex >= 0);
  assert.equal(showArgs[keypairIndex + 1], '-');
  const dumpArgs = buildProgramDumpArgs({
    programId: DEVNET_PROGRAM_ID.toBase58(),
    dumpPath: '/tmp/program.so',
    solanaConfigPath: '/tmp/solana-config.yml',
  });
  assert.deepEqual(dumpArgs.slice(-2), ['--commitment', 'finalized']);
  const deployArgs = buildProgramDeployArgs({
    programBinaryPath: '/tmp/verified.so',
    programId: DEVNET_PROGRAM_ID.toBase58(),
    solanaConfigPath: '/tmp/solana-config.yml',
    authorityKeypairPath: '/tmp/authority.json',
  });
  assert.ok(deployArgs.includes('--no-auto-extend'));
  assert.ok(deployArgs.includes('finalized'));
  assert.equal(deployArgs.includes('--buffer'), false);
  const writeArgs = buildProgramWriteBufferArgs({
    programBinaryPath: '/tmp/verified.so',
    bufferSignerPath: '/tmp/owned-buffer.json',
    solanaConfigPath: '/tmp/solana-config.yml',
    authorityKeypairPath: '/tmp/authority.json',
    useRpc: true,
    computeUnitPrice: '7',
    maxSignAttempts: '9',
  });
  assert.deepEqual(
    writeArgs.slice(writeArgs.indexOf('--buffer'), writeArgs.indexOf('--buffer') + 2),
    ['--buffer', '/tmp/owned-buffer.json'],
  );
  assert.ok(writeArgs.includes('--buffer-authority'));
  assert.ok(writeArgs.includes('--use-rpc'));
  assert.ok(writeArgs.includes('--with-compute-unit-price'));
  assert.ok(writeArgs.includes('--max-sign-attempts'));
  const upgradeArgs = buildProgramUpgradeArgs({
    bufferPubkey: TREASURY,
    programId: DEVNET_PROGRAM_ID.toBase58(),
    solanaConfigPath: '/tmp/solana-config.yml',
    authorityKeypairPath: '/tmp/authority.json',
  });
  assert.deepEqual(upgradeArgs.slice(0, 4), [
    'program',
    'upgrade',
    TREASURY,
    DEVNET_PROGRAM_ID.toBase58(),
  ]);
  assert.deepEqual(upgradeArgs.slice(-2), ['--commitment', 'finalized']);
  for (const args of [showArgs, dumpArgs, deployArgs, writeArgs, upgradeArgs]) {
    assert.equal(args.includes('--url'), false);
    assert.equal(args.includes('https://rpc.example'), false);
    assert.ok(args.includes('--config'));
  }
});

test('recovered-buffer CLI options are bound together and cannot bypass gates', () => {
  const buffer = Keypair.generate().publicKey.toBase58();
  const keypairPath = '/tmp/recovered-buffer.json';
  const hash = 'ab'.repeat(32);
  const parsed = parseArgs([
    'little_swag_hoodies',
    '--resume-buffer',
    buffer,
    '--resume-buffer-keypair',
    keypairPath,
    '--resume-elf-sha256',
    hash,
  ]);
  assert.equal(parsed.resumeBuffer, buffer);
  assert.equal(parsed.resumeBufferKeypair, keypairPath);
  assert.equal(parsed.resumeElfSha256, hash);
  assert.throws(
    () =>
      parseArgs([
        'little_swag_hoodies',
        '--resume-buffer',
        buffer,
      ]),
    /must be provided together/,
  );
  for (const forbidden of [
    '--audit-only',
    '--dry-run',
    '--yes',
    '--skip-tests',
    '--skip-typecheck',
    '--compute-unit-price',
  ]) {
    const value = forbidden === '--compute-unit-price' ? ['1'] : [];
    assert.throws(
      () =>
        parseArgs([
          'little_swag_hoodies',
          '--resume-buffer',
          buffer,
          '--resume-buffer-keypair',
          keypairPath,
          '--resume-elf-sha256',
          hash,
          forbidden,
          ...value,
        ]),
      /cannot be combined|require typecheck|final confirmation/,
    );
  }
  assert.throws(
    () =>
      parseArgs([
        'little_swag_hoodies',
        '--resume-buffer',
        buffer,
        '--resume-buffer-keypair',
        keypairPath,
        '--resume-elf-sha256',
        'not-a-hash',
      ]),
    /Invalid --resume-elf-sha256/,
  );
});

test('recovered buffer keypair files are private and bound to the expected address', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'resume-buffer-key-'));
  const filePath = path.join(directory, 'buffer.json');
  const keypair = Keypair.generate();
  try {
    chmodSync(directory, 0o700);
    writeFileSync(filePath, JSON.stringify(Array.from(keypair.secretKey)), {
      mode: 0o600,
      flag: 'wx',
    });
    assert.equal(
      loadResumeBufferKeypair(filePath, keypair.publicKey.toBase58())
        .publicKey.toBase58(),
      keypair.publicKey.toBase58(),
    );
    assert.throws(
      () => loadResumeBufferKeypair(filePath, Keypair.generate().publicKey.toBase58()),
      /private regular JSON keypair/,
    );
    chmodSync(filePath, 0o644);
    assert.throws(
      () => loadResumeBufferKeypair(filePath, keypair.publicKey.toBase58()),
      /private regular JSON keypair/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('recovered buffer validation accepts only zero-or-exact ELF overlays', () => {
  const bufferKey = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;
  const localBinary = Buffer.alloc(2_500);
  for (let index = 0; index < localBinary.length; index += 1) {
    localBinary[index] = (index % 251) + 1;
  }
  const accountData = Buffer.alloc(37 + localBinary.length);
  accountData.writeUInt32LE(1, 0);
  accountData[4] = 1;
  authority.toBuffer().copy(accountData, 5);
  localBinary.copy(accountData, 37);
  accountData.fill(0, 37 + 1_000, 37 + 1_500);
  const account = {
    data: accountData,
    executable: false,
    lamports: 123_456,
    owner: new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),
    rentEpoch: 0,
  };
  const partial = inspectResumeBufferAccount({
    contextSlot: 500,
    pubkey: bufferKey,
    account,
    expectedAuthority: authority.toBase58(),
    localBinary,
    minimumRentExemptLamports: 123_456,
  });
  assert.equal(partial.totalBytes, 2_500);
  assert.equal(partial.missingBytes, 500);
  assert.throws(
    () => assertResumeBufferComplete(partial, createHash('sha256').update(localBinary).digest('hex')),
    /not an exact finalized copy/,
  );

  const exactData = Buffer.from(accountData);
  localBinary.copy(exactData, 37);
  const exact = inspectResumeBufferAccount({
    contextSlot: 501,
    pubkey: bufferKey,
    account: { ...account, data: exactData },
    expectedAuthority: authority.toBase58(),
    localBinary,
    minimumRentExemptLamports: 123_456,
  });
  assertResumeBufferComplete(
    exact,
    createHash('sha256').update(localBinary).digest('hex'),
  );
  assert.doesNotThrow(() =>
    assertResumeBufferUnchanged(exact, { ...exact, contextSlot: 999 }),
  );
  assert.throws(
    () =>
      assertResumeBufferUnchanged(exact, {
        ...exact,
        dataSha256: '00'.repeat(32),
      }),
    /changed before the upgrade command/,
  );

  const mismatchedData = Buffer.from(accountData);
  mismatchedData[37 + 1_200] = 255;
  assert.throws(
    () =>
      inspectResumeBufferAccount({
        contextSlot: 502,
        pubkey: bufferKey,
        account: { ...account, data: mismatchedData },
        expectedAuthority: authority.toBase58(),
        localBinary,
        minimumRentExemptLamports: 123_456,
      }),
    /does not match the verified ELF/,
  );
  assert.throws(
    () =>
      inspectResumeBufferAccount({
        contextSlot: 503,
        pubkey: bufferKey,
        account: { ...account, lamports: 123_455 },
        expectedAuthority: authority.toBase58(),
        localBinary,
        minimumRentExemptLamports: 123_456,
      }),
    /not rent exempt/,
  );
});

test('recovered buffer must be consumed at or after the deployed slot', async () => {
  const pubkey = Keypair.generate().publicKey;
  await assert.doesNotReject(
    assertResumeBufferConsumed({
      connection: {
        getAccountInfoAndContext: async () => ({
          context: { slot: 700 },
          value: null,
        }),
      },
      pubkey,
      minContextSlot: 700,
    }),
  );
  await assert.rejects(
    assertResumeBufferConsumed({
      connection: {
        getAccountInfoAndContext: async () => ({
          context: { slot: 699 },
          value: null,
        }),
      },
      pubkey,
      minContextSlot: 700,
    }),
    /older than deployed slot/,
  );
  await assert.rejects(
    assertResumeBufferConsumed({
      connection: {
        getAccountInfoAndContext: async () => ({
          context: { slot: 701 },
          value: {} as never,
        }),
      },
      pubkey,
      minContextSlot: 700,
    }),
    /still exists after the finalized program upgrade/,
  );
});

test('recovered-buffer flow pins the audited Solana CLI version', () => {
  assert.doesNotThrow(() =>
    assertResumeSolanaCliVersion(
      'solana-cli 3.1.12 (src:6c1ba346; feat:4140108451, client:Agave)',
    ),
  );
  assert.throws(
    () =>
      assertResumeSolanaCliVersion(
        'solana-cli 3.1.13 (src:ffffffff; feat:0, client:Agave)',
      ),
    /require audited solana-cli 3.1.12/,
  );
});

test('config audit reconciles every active config and audit-only tombstone', async () => {
  const fixtures = devnetFixtures();
  let rpcConfig: Record<string, unknown> | undefined;
  const result = await inspect(
    mockConnection({
      rows: fixtures.map((fixture) => ({ fixture })),
      contextSlot: 901,
      onConfig: (value) => {
        rpcConfig = value;
      },
    }),
  );
  assert.equal(result.slot, 901);
  assert.deepEqual(
    result.configs.map(({ dropId, source, size, schema }) => ({
      dropId,
      source,
      size,
      schema,
    })),
    fixtures.map((fixture) => ({
      dropId: fixture.dropId,
      source: fixture.source,
      size: fixture.size,
      schema: fixture.size === 488 ? 'split-payments-v1' : 'legacy',
    })),
  );
  assert.ok(result.configs.some((config) => config.source === 'tombstone'));
  assert.equal(rpcConfig?.commitment, 'finalized');
  assert.equal(rpcConfig?.withContext, true);
  assert.equal(rpcConfig?.minContextSlot, 700);
  assert.equal(rpcConfig?.dataSlice, undefined);
  assert.deepEqual(rpcConfig?.filters, [
    {
      memcmp: {
        offset: 0,
        bytes: bs58.encode(Buffer.from(BOX_MINTER_CONFIG_DISCRIMINATOR)),
      },
    },
  ]);

  let chainedMinContextSlot: unknown;
  const chained = await inspect(
    mockConnection({
      rows: fixtures.map((fixture) => ({ fixture })),
      contextSlot: 902,
      onConfig: (value) => {
        chainedMinContextSlot = value.minContextSlot;
      },
    }),
    result.slot,
  );
  assert.equal(chainedMinContextSlot, 901);
  assert.equal(chained.slot, 902);
});

test('config audit accepts and exactly compares a 488-byte split route', async () => {
  const registry = await readDeploymentDropRegistry(REGISTRY_PATH);
  const template = registry.drops.clear_cards_devnet_v2;
  assert.ok(template);
  const splitDropId = 'upgrade_split_fixture';
  const splitDropSeed = createHash('sha256').update(splitDropId).digest();
  const [splitPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(BOX_MINTER_CONFIG_SEED), splitDropSeed],
    DEVNET_PROGRAM_ID,
  );
  const {
    treasury: _treasury,
    paymentRouting: _paymentRouting,
    ...templateWithoutRouting
  } = template;
  const splitDrop: DeploymentRegistryDrop = {
    ...templateWithoutRouting,
    dropId: splitDropId,
    boxMinterConfigPda: splitPda.toBase58(),
    paymentRouting: SPLIT_ROUTING,
  };
  const splitFixture = activeFixture(splitDrop);
  const tempRegistryPath = path.join(
    path.dirname(REGISTRY_PATH),
    `.deploymentRegistry-upgrade-${process.pid}-${Date.now()}.ts`,
  );
  writeFileSync(
    tempRegistryPath,
    renderDeploymentRegistryFileFromSource({
      filePath: REGISTRY_PATH,
      existingContent: registry.sourceContent,
      drops: { ...registry.drops, [splitDropId]: splitDrop },
      tombstones: registry.tombstones,
    }),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );

  const fixtures = [...devnetFixtures(), splitFixture].sort((left, right) =>
    left.dropId.localeCompare(right.dropId),
  );
  const inspectSplit = (data = configData(splitFixture)) =>
    inspectSharedProgramConfigs({
      connection: mockConnection({
        rows: fixtures.map((fixture) => ({
          fixture,
          ...(fixture === splitFixture ? { data } : {}),
        })),
      }),
      cluster: 'devnet',
      programId: DEVNET_PROGRAM_ID,
      registryPath: tempRegistryPath,
      minContextSlot: 700,
    });

  try {
    const valid = await inspectSplit();
    const audited = valid.configs.find(
      (config) => config.dropId === splitDropId,
    );
    assert.deepEqual(audited?.paymentRoute, routeFromPaymentRouting(SPLIT_ROUTING));
    assert.equal(audited?.size, 488);
    assert.equal(audited?.schema, 'split-payments-v1');

    const reordered = configData(splitFixture);
    const first = Buffer.from(reordered.subarray(386, 418));
    const second = Buffer.from(reordered.subarray(418, 450));
    second.copy(reordered, 386);
    first.copy(reordered, 418);
    await assert.rejects(inspectSplit(reordered), /payment route mismatch/);

    const changedShares = configData(splitFixture);
    changedShares[482] = 60;
    changedShares[483] = 30;
    await assert.rejects(inspectSplit(changedShares), /payment route mismatch/);

    const malformed = configData(splitFixture);
    malformed[376] ^= 1;
    await assert.rejects(inspectSplit(malformed), /Invalid split payment routing magic/);
  } finally {
    unlinkSync(tempRegistryPath);
  }
});

test('config audit rejects missing and unregistered canonical configs', async () => {
  const fixtures = devnetFixtures();
  const tombstone = fixtures.find((fixture) => fixture.source === 'tombstone');
  assert.ok(tombstone);
  await assert.rejects(
    inspect(
      mockConnection({
        rows: fixtures
          .filter((fixture) => fixture !== tombstone)
          .map((fixture) => ({ fixture })),
      }),
    ),
    /Missing expected: clear_cards_devnet:/,
  );

  const dropSeed = createHash('sha256').update('unknown_config').digest();
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from(BOX_MINTER_CONFIG_SEED), dropSeed],
    DEVNET_PROGRAM_ID,
  );
  const unknown: ConfigFixture = {
    dropId: 'unknown_config',
    pda,
    bump,
    dropSeed,
    collectionMint: COLLECTION,
    route: legacyRoute(TREASURY),
    size: 376,
    source: 'tombstone',
  };
  await assert.rejects(
    inspect(
      mockConnection({
        rows: [
          ...fixtures.map((fixture) => ({ fixture })),
          { fixture: unknown },
        ],
      }),
    ),
    /Unregistered on-chain:/,
  );
});

test('config audit rejects route, collection, PDA, schema-size, and executable mismatches', async () => {
  const fixtures = devnetFixtures();
  const target = fixtures.find((fixture) => fixture.source === 'tombstone');
  assert.ok(target);
  const rowFor = (data?: Buffer, executable?: boolean, pubkey?: PublicKey) =>
    fixtures.map((fixture) =>
      fixture === target
        ? { fixture, data, executable, pubkey }
        : { fixture },
    );

  await assert.rejects(
    inspect(
      mockConnection({
        rows: rowFor(configData(target, { treasury: COLLECTION })),
      }),
    ),
    /payment route mismatch/,
  );
  await assert.rejects(
    inspect(
      mockConnection({
        rows: rowFor(configData(target, { collectionMint: TREASURY })),
      }),
    ),
    /collection mismatch/,
  );
  await assert.rejects(
    inspect(
      mockConnection({
        rows: rowFor(undefined, false, PublicKey.default),
      }),
    ),
    /is not canonical for its embedded drop seed/,
  );
  await assert.rejects(
    inspect(
      mockConnection({
        rows: rowFor(Buffer.concat([configData(target), Buffer.from([0])])),
      }),
    ),
    /Unsupported discovered config layout/,
  );
  await assert.rejects(
    inspect(mockConnection({ rows: rowFor(undefined, true) })),
    /unexpectedly executable/,
  );
});

test('config audit rejects a response context older than minContextSlot', async () => {
  const fixtures = devnetFixtures();
  await assert.rejects(
    inspect(
      mockConnection({
        rows: fixtures.map((fixture) => ({ fixture })),
        contextSlot: 699,
      }),
      700,
    ),
    /older than required minContextSlot/,
  );
});

test('raw Node help exposes audit-only without requiring tsx', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(process.cwd(), 'scripts/upgrade-onchain.ts'),
      '--help',
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--audit-only/);
  assert.match(result.stdout, /required for mutating mainnet/);
});

test('audit-only returns before build preparation and never creates a read-only key file', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'scripts/upgrade-onchain.ts'),
    'utf8',
  );
  const auditReturn = source.indexOf('if (opts.auditOnly) {');
  const typecheck = source.indexOf('if (!opts.skipTypecheck)', auditReturn);
  const buildLock = source.indexOf(
    'acquireDeploymentRegistryMutationLock({',
    auditReturn,
  );
  const authorityKey = source.indexOf(
    'authorityKeypairPath = writeTempKeypairFile(',
    auditReturn,
  );
  assert.ok(auditReturn >= 0);
  assert.ok(typecheck > auditReturn);
  assert.ok(buildLock > auditReturn);
  assert.ok(authorityKey > auditReturn);
  assert.doesNotMatch(source, /upgrade-readonly/);
  assert.match(source, /Array\.from\(Keypair\.generate\(\)\.secretKey\)/);
  assert.match(source, /stdin: args\.signerInput/);
});

test('upgrade authority is validated before its secret is written to disk', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'scripts/upgrade-onchain.ts'),
    'utf8',
  );
  const authorityPubkey = source.indexOf(
    'const authorityPubkey = authority.publicKey.toBase58();',
  );
  const authorityCheck = source.indexOf(
    'buildBaseline.program.show.authority !== authorityPubkey',
    authorityPubkey,
  );
  const authorityKeyWrite = source.indexOf(
    'authorityKeypairPath = writeTempKeypairFile(',
    authorityPubkey,
  );
  assert.ok(authorityPubkey >= 0);
  assert.ok(authorityCheck > authorityPubkey);
  assert.ok(authorityKeyWrite > authorityCheck);
});

test('split lineages cannot bypass the exact-ELF suite during mutation', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'scripts/upgrade-onchain.ts'),
    'utf8',
  );
  assert.match(
    source,
    /opts\.skipTests[\s\S]*!opts\.dryRun[\s\S]*config\.schema === 'split-payments-v1'/,
  );
  assert.match(
    source,
    /--skip-tests is forbidden once a split-payments-v1 config exists/,
  );
});
