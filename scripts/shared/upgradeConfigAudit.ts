import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { clusterApiUrl, PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import type { DeploymentRegistryDrop, PaymentRoutingConfig } from '../../shared/deploymentRegistry.ts';
import { BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED, BOX_MINTER_CONFIG_ACCOUNT_SIZE_SPLIT_PAYMENTS_V1, BOX_MINTER_CONFIG_DISCRIMINATOR, decodeBoxMinterConfigData, type DecodedBoxMinterConfigData } from '../../shared/boxMinterConfigCodec.ts';
import { BOX_MINTER_CONFIG_SEED } from '../../shared/boxMinterProtocol.ts';
import { readDeploymentDropRegistry, type BoxMinterConfigTombstone, type DeploymentDropConfigSerialized } from './deploymentRegistry.ts';

export type SupportedUpgradeCluster = 'devnet' | 'mainnet-beta';

type PaymentRouteFingerprint = {
  deliveryPaymentReceiver: string;
  mintProceeds: ReadonlyArray<{
    address: string;
    percentage: number;
  }>;
};

export type SharedProgramConfigAudit = {
  dropId: string;
  source: 'active-registry' | 'tombstone';
  reason?: BoxMinterConfigTombstone['reason'];
  configPda: string;
  size: number;
  schema: 'legacy' | 'split-payments-v1';
  dropSeed: string;
  bump: number;
  collectionMint: string;
  paymentRoute: PaymentRouteFingerprint;
};

export type SharedProgramConfigAuditResult = {
  slot: number;
  configs: ReadonlyArray<SharedProgramConfigAudit>;
};

type ExpectedConfig = {
  dropId: string;
  source: SharedProgramConfigAudit['source'];
  reason?: BoxMinterConfigTombstone['reason'];
  dropSeed: Buffer;
  dropSeedHex: string;
  configPda: PublicKey;
  bump: number;
  accountSize: number;
  schema: SharedProgramConfigAudit['schema'];
  collectionMint: string;
  paymentRoute: PaymentRouteFingerprint;
};

export const UPGRADE_CLUSTER_GENESIS_HASHES: Readonly<
  Record<SupportedUpgradeCluster, string>
> = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

export const UPGRADE_PROGRAM_TARGETS: Readonly<
  Record<
    SupportedUpgradeCluster,
    { programId: string; buildFeature: string }
  >
> = {
  devnet: {
    programId: '8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6',
    buildFeature: 'shared-devnet-program-id',
  },
  'mainnet-beta': {
    programId: '7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU',
    buildFeature: 'mainnet-program-id',
  },
};

const PUBLIC_MAINNET_RPC_URL = clusterApiUrl('mainnet-beta');

export function assertUpgradeRpcGenesisHash(args: {
  cluster: SupportedUpgradeCluster;
  genesisHash: string;
}): void {
  const expected = UPGRADE_CLUSTER_GENESIS_HASHES[args.cluster];
  if (args.genesisHash !== expected) {
    throw new Error(
      `Upgrade RPC genesis hash mismatch for ${args.cluster}: expected ${expected}, got ${args.genesisHash}`,
    );
  }
}

export function assertSupportedUpgradeTarget(args: {
  drop: DeploymentDropConfigSerialized;
  requestedCluster?: SupportedUpgradeCluster;
  rpcUrlWasExplicit: boolean;
  rpcUrl?: string;
  isMutatingUpgrade: boolean;
}): { programId: string; buildFeature: string } {
  const cluster = args.drop.solanaCluster;
  if (cluster !== 'devnet' && cluster !== 'mainnet-beta') {
    throw new Error(
      `Upgrade tooling only supports the shared card_nft_2-generation programs on devnet and mainnet-beta; ${args.drop.dropId} targets ${cluster}`,
    );
  }
  if (args.requestedCluster && cluster !== args.requestedCluster) {
    throw new Error(
      `Drop ${args.drop.dropId} is configured for ${cluster}, not ${args.requestedCluster}`,
    );
  }
  const target = UPGRADE_PROGRAM_TARGETS[cluster];
  if (args.drop.boxMinterProgramId !== target.programId) {
    throw new Error(
      `Upgrade tooling only supports ${target.programId} on ${cluster}; ${args.drop.dropId} uses unsupported program ${args.drop.boxMinterProgramId}`,
    );
  }
  if (!args.drop.boxMinterConfigPda) {
    throw new Error(
      `Upgrade target ${args.drop.dropId} is missing boxMinterConfigPda`,
    );
  }
  if (
    cluster === 'mainnet-beta' &&
    args.isMutatingUpgrade &&
    (!args.rpcUrlWasExplicit || !args.rpcUrl)
  ) {
    throw new Error('Mainnet upgrades require an explicit --rpc-url');
  }
  if (
    cluster === 'mainnet-beta' &&
    args.isMutatingUpgrade &&
    args.rpcUrl &&
    new URL(args.rpcUrl).protocol !== 'https:'
  ) {
    throw new Error('Mutating mainnet upgrades require an HTTPS RPC URL');
  }
  if (
    cluster === 'mainnet-beta' &&
    args.isMutatingUpgrade &&
    args.rpcUrl &&
    new URL(args.rpcUrl).hostname.toLowerCase().replace(/\.+$/, '') ===
      new URL(PUBLIC_MAINNET_RPC_URL).hostname
        .toLowerCase()
        .replace(/\.+$/, '')
  ) {
    throw new Error(
      'Mutating mainnet upgrades require a private or provider RPC; the public mainnet endpoint is audit-only',
    );
  }
  return target;
}

function routeFromPaymentRouting(
  paymentRouting: PaymentRoutingConfig,
): PaymentRouteFingerprint {
  return {
    deliveryPaymentReceiver: paymentRouting.deliveryPaymentReceiver,
    mintProceeds: paymentRouting.mintProceeds.map((recipient) => ({
      address: recipient.address,
      percentage: recipient.percentage,
    })),
  };
}

function legacyPaymentRoute(treasury: string): PaymentRouteFingerprint {
  return {
    deliveryPaymentReceiver: treasury,
    mintProceeds: [{ address: treasury, percentage: 100 }],
  };
}

function expectedActiveConfig(
  drop: DeploymentRegistryDrop,
  programId: PublicKey,
): ExpectedConfig {
  if (!drop.boxMinterConfigPda) {
    throw new Error(
      `Active registry drop ${drop.dropId} is missing boxMinterConfigPda`,
    );
  }
  const dropSeed = createHash('sha256').update(drop.dropId).digest();
  const [derivedPda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from(BOX_MINTER_CONFIG_SEED), dropSeed],
    programId,
  );
  const configPda = new PublicKey(drop.boxMinterConfigPda);
  if (!configPda.equals(derivedPda)) {
    throw new Error(
      `Registry config PDA mismatch for ${drop.dropId}: expected ${derivedPda.toBase58()}, got ${configPda.toBase58()}`,
    );
  }
  const split = Boolean(drop.paymentRouting);
  return {
    dropId: drop.dropId,
    source: 'active-registry',
    dropSeed,
    dropSeedHex: dropSeed.toString('hex'),
    configPda,
    bump,
    accountSize: split
      ? BOX_MINTER_CONFIG_ACCOUNT_SIZE_SPLIT_PAYMENTS_V1
      : BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED,
    schema: split ? 'split-payments-v1' : 'legacy',
    collectionMint: drop.collectionMint,
    paymentRoute: drop.paymentRouting
      ? routeFromPaymentRouting(drop.paymentRouting)
      : legacyPaymentRoute(drop.treasury),
  };
}

function expectedTombstoneConfig(
  tombstone: BoxMinterConfigTombstone,
  programId: PublicKey,
): ExpectedConfig {
  const dropSeed = Buffer.from(tombstone.dropSeed, 'hex');
  const canonicalDropSeed = createHash('sha256')
    .update(tombstone.dropId)
    .digest();
  if (!dropSeed.equals(canonicalDropSeed)) {
    throw new Error(
      `Tombstone ${tombstone.dropId} drop seed does not match sha256(dropId)`,
    );
  }
  const [derivedPda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from(BOX_MINTER_CONFIG_SEED), dropSeed],
    programId,
  );
  const configPda = new PublicKey(tombstone.boxMinterConfigPda);
  if (!configPda.equals(derivedPda)) {
    throw new Error(
      `Tombstone config PDA mismatch for ${tombstone.dropId}: expected ${derivedPda.toBase58()}, got ${configPda.toBase58()}`,
    );
  }
  return {
    dropId: tombstone.dropId,
    source: 'tombstone',
    reason: tombstone.reason,
    dropSeed,
    dropSeedHex: tombstone.dropSeed,
    configPda,
    bump,
    accountSize: tombstone.accountSize,
    schema: tombstone.schema,
    collectionMint: tombstone.collectionMint,
    paymentRoute: tombstone.paymentRouting
      ? routeFromPaymentRouting(tombstone.paymentRouting)
      : legacyPaymentRoute(tombstone.treasury),
  };
}

function decodedPaymentRoute(
  decoded: DecodedBoxMinterConfigData,
): PaymentRouteFingerprint {
  if (!decoded.paymentRouting) {
    throw new Error('Missing decoded payment routing');
  }
  return {
    deliveryPaymentReceiver: new PublicKey(
      decoded.paymentRouting.deliveryPaymentReceiver,
    ).toBase58(),
    mintProceeds: decoded.paymentRouting.mintProceeds.map((recipient) => ({
      address: new PublicKey(recipient.address).toBase58(),
      percentage: recipient.percentage,
    })),
  };
}

function routeFingerprint(route: PaymentRouteFingerprint): string {
  return JSON.stringify(route);
}

type DiscoveredConfig = {
  pubkey: PublicKey;
  info: AccountInfo<Buffer>;
  decoded: DecodedBoxMinterConfigData;
};

export async function inspectSharedProgramConfigs(args: {
  connection: Connection;
  cluster: SupportedUpgradeCluster;
  programId: PublicKey;
  registryPath: string;
  minContextSlot: number;
}): Promise<SharedProgramConfigAuditResult> {
  if (!Number.isSafeInteger(args.minContextSlot) || args.minContextSlot < 0) {
    throw new Error(`Invalid config audit minContextSlot: ${args.minContextSlot}`);
  }
  const expectedProgramId = UPGRADE_PROGRAM_TARGETS[args.cluster].programId;
  if (args.programId.toBase58() !== expectedProgramId) {
    throw new Error(
      `Config audit only supports ${expectedProgramId} on ${args.cluster}`,
    );
  }
  const registry = await readDeploymentDropRegistry(args.registryPath);
  const active = Object.values(registry.drops)
    .filter(
      (drop) =>
        drop.solanaCluster === args.cluster &&
        drop.boxMinterProgramId === args.programId.toBase58(),
    )
    .flatMap((drop) => [
      expectedActiveConfig(drop, args.programId),
      ...(drop.operationsConfig ? [expectedActiveConfig({
        ...drop,
        dropId: drop.operationsConfig.configId,
        boxMinterConfigPda: drop.operationsConfig.boxMinterConfigPda,
        maxSupply: drop.operationsConfig.maxSupply,
        operationsConfig: undefined,
      }, args.programId)] : []),
    ]);
  const tombstones = Object.values(registry.tombstones)
    .filter(
      (tombstone) =>
        tombstone.solanaCluster === args.cluster &&
        tombstone.boxMinterProgramId === args.programId.toBase58(),
    )
    .map((tombstone) => expectedTombstoneConfig(tombstone, args.programId));
  const expected = [...active, ...tombstones].sort((left, right) =>
    left.dropId.localeCompare(right.dropId),
  );
  if (expected.length === 0) {
    throw new Error(
      `No active registry configs or tombstones reference ${args.programId.toBase58()} on ${args.cluster}`,
    );
  }
  const expectedByPda = new Map<string, ExpectedConfig>();
  for (const entry of expected) {
    const pda = entry.configPda.toBase58();
    if (expectedByPda.has(pda)) {
      throw new Error(`Duplicate expected config PDA ${pda}`);
    }
    expectedByPda.set(pda, entry);
  }

  const response = await args.connection.getProgramAccounts(
    args.programId,
    {
      commitment: 'finalized',
      minContextSlot: args.minContextSlot,
      withContext: true,
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: bs58.encode(Buffer.from(BOX_MINTER_CONFIG_DISCRIMINATOR)),
          },
        },
      ],
    },
  );
  if (
    !Number.isSafeInteger(response.context.slot) ||
    response.context.slot < args.minContextSlot
  ) {
    throw new Error(
      `Config audit RPC context slot ${response.context.slot} is older than required minContextSlot ${args.minContextSlot}`,
    );
  }
  const discoveredRows = response.value;
  const discoveredByPda = new Map<string, DiscoveredConfig>();
  for (const row of discoveredRows) {
    const pda = row.pubkey.toBase58();
    const info = row.account as AccountInfo<Buffer>;
    if (!info.owner.equals(args.programId)) {
      throw new Error(
        `Discovered config ${pda} is owned by ${info.owner.toBase58()}, expected ${args.programId.toBase58()}`,
      );
    }
    if (info.executable) {
      throw new Error(`Discovered config ${pda} is unexpectedly executable`);
    }
    if (
      info.data.length !== BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED &&
      info.data.length !== BOX_MINTER_CONFIG_ACCOUNT_SIZE_SPLIT_PAYMENTS_V1
    ) {
      throw new Error(
        `Unsupported discovered config layout at ${pda}: ${info.data.length} bytes`,
      );
    }
    let decoded: DecodedBoxMinterConfigData;
    try {
      decoded = decodeBoxMinterConfigData(info.data, {
        validateDiscriminator: true,
        validateItemsPerBox: true,
        decodeExtensions: true,
      });
    } catch (error) {
      throw new Error(
        `Could not decode discovered config ${pda}: ${errorMessage(error)}`,
      );
    }
    if (!decoded.dropSeed) {
      throw new Error(`Discovered config ${pda} is missing a drop seed`);
    }
    const [canonicalPda, canonicalBump] = PublicKey.findProgramAddressSync(
      [Buffer.from(BOX_MINTER_CONFIG_SEED), Buffer.from(decoded.dropSeed)],
      args.programId,
    );
    if (!row.pubkey.equals(canonicalPda)) {
      throw new Error(
        `Discovered config ${pda} is not canonical for its embedded drop seed; expected ${canonicalPda.toBase58()}`,
      );
    }
    if (decoded.bump !== canonicalBump) {
      throw new Error(
        `Discovered config ${pda} has bump ${decoded.bump}, expected ${canonicalBump}`,
      );
    }
    if (discoveredByPda.has(pda)) {
      throw new Error(`RPC returned duplicate config ${pda}`);
    }
    discoveredByPda.set(pda, { pubkey: row.pubkey, info, decoded });
  }

  const missing = expected
    .filter((entry) => !discoveredByPda.has(entry.configPda.toBase58()))
    .map((entry) => `${entry.dropId}:${entry.configPda.toBase58()}`);
  const unregistered = [...discoveredByPda.entries()]
    .filter(([pda]) => !expectedByPda.has(pda))
    .map(
      ([pda, row]) =>
        `${pda}:${Buffer.from(row.decoded.dropSeed || []).toString('hex')}`,
    );
  if (missing.length || unregistered.length) {
    throw new Error(
      `Shared program config reconciliation failed.\n` +
        `Missing expected: ${missing.length ? missing.join(', ') : '(none)'}\n` +
        `Unregistered on-chain: ${unregistered.length ? unregistered.join(', ') : '(none)'}`,
    );
  }

  const configs = expected.map((entry) => {
    const discovered = discoveredByPda.get(entry.configPda.toBase58());
    if (!discovered) {
      throw new Error(`Missing config after reconciliation: ${entry.dropId}`);
    }
    const { decoded, info } = discovered;
    if (info.data.length !== entry.accountSize) {
      throw new Error(
        `Config ${entry.dropId} has ${info.data.length} bytes, expected ${entry.accountSize}`,
      );
    }
    if (
      !decoded.dropSeed ||
      !Buffer.from(decoded.dropSeed).equals(entry.dropSeed)
    ) {
      throw new Error(`Config ${entry.dropId} has an unexpected drop seed`);
    }
    if (decoded.bump !== entry.bump) {
      throw new Error(
        `Config ${entry.dropId} has bump ${decoded.bump}, expected ${entry.bump}`,
      );
    }
    const schema = decoded.paymentRouting?.schema;
    if (schema !== entry.schema) {
      throw new Error(
        `Config ${entry.dropId} has payment schema ${String(schema)}, expected ${entry.schema}`,
      );
    }
    const collectionMint = new PublicKey(decoded.coreCollection).toBase58();
    if (collectionMint !== entry.collectionMint) {
      throw new Error(
        `Config ${entry.dropId} collection mismatch: expected ${entry.collectionMint}, got ${collectionMint}`,
      );
    }
    const paymentRoute = decodedPaymentRoute(decoded);
    if (routeFingerprint(paymentRoute) !== routeFingerprint(entry.paymentRoute)) {
      throw new Error(
        `Config ${entry.dropId} payment route mismatch.\n` +
          `Expected: ${routeFingerprint(entry.paymentRoute)}\n` +
          `Actual  : ${routeFingerprint(paymentRoute)}`,
      );
    }
    const baseTreasury = new PublicKey(decoded.treasury).toBase58();
    if (baseTreasury !== entry.paymentRoute.deliveryPaymentReceiver) {
      throw new Error(
        `Config ${entry.dropId} base treasury is ${baseTreasury}, expected delivery receiver ${entry.paymentRoute.deliveryPaymentReceiver}`,
      );
    }
    return {
      dropId: entry.dropId,
      source: entry.source,
      ...(entry.reason ? { reason: entry.reason } : {}),
      configPda: entry.configPda.toBase58(),
      size: info.data.length,
      schema: entry.schema,
      dropSeed: entry.dropSeedHex,
      bump: entry.bump,
      collectionMint,
      paymentRoute,
    };
  });
  return { slot: response.context.slot, configs };
}

export function assertLineageFingerprintUnchanged(
  before: ReadonlyArray<SharedProgramConfigAudit>,
  after: ReadonlyArray<SharedProgramConfigAudit>,
  stage: string,
): void {
  if (JSON.stringify(after) === JSON.stringify(before)) return;
  throw new Error(
    `Shared program config audit changed ${stage}.\n` +
      `Before: ${JSON.stringify(before)}\n` +
      `After : ${JSON.stringify(after)}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
