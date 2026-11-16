import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clusterApiUrl, Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createSolanaBuildWorkspace } from './shared/solanaBuild.ts';
import { parsePrivateKeyInput, promptMaskedInput, promptYConfirmation } from './shared/interactive.ts';
import { acquireDeploymentRegistryMutationLock, readDeploymentDropRegistry, type DeploymentDropConfigSerialized, type DeploymentDropRegistry } from './shared/deploymentRegistry.ts';
import {
  type ToolEnv,
  type UpgradeSignal,
  CommandCancelledError,
  CommandCancellationController,
  shouldDeferUpgradeSignalExit,
  validateRpcUrl,
  redactRpcUrl,
  redactRpcDetailsInText,
  buildProgramShowArgs,
  buildProgramDumpArgs,
  buildProgramDeployArgs,
  buildProgramWriteBufferArgs,
  buildProgramUpgradeArgs,
  runUpgradeCommand,
  runCapture,
} from './shared/upgradeCommandRunner.ts';
import {
  type StableProgramSnapshot,
  assertProgramBinaryFitsProgramData,
  sha256,
  assertProgramImageEquivalent,
  programImagesAreEquivalent,
  expectedPaddedProgramImageSha256,
  captureStableProgramSnapshotAsync,
  assertPostUpgradeProgramIdentity,
  assertImmutableArtifactUnchanged,
} from './shared/upgradeProgramSnapshot.ts';
import {
  type ResumeBufferSnapshot,
  assertResumeSolanaCliVersion,
  loadResumeBufferKeypair,
  captureResumeBufferSnapshot,
  assertResumeBufferComplete,
  assertResumeBufferUnchanged,
  assertResumeBufferConsumed,
  runBufferWriteAttemptWithVerification,
} from './shared/upgradeResumeBuffer.ts';
import {
  type SupportedUpgradeCluster,
  type SharedProgramConfigAudit,
  assertUpgradeRpcGenesisHash,
  assertSupportedUpgradeTarget,
  inspectSharedProgramConfigs,
  assertLineageFingerprintUnchanged,
} from './shared/upgradeConfigAudit.ts';
import {
  type UpgradeGateState,
  captureCoherentUpgradeGateState,
  assertUpgradeGateUnchanged,
  runDeployAttemptWithVerification,
} from './shared/upgradeGate.ts';

type CliOptions = {
  dropId?: string;
  cluster?: SupportedUpgradeCluster;
  rpcUrl?: string;
  skipTests: boolean;
  skipTypecheck: boolean;
  dryRun: boolean;
  auditOnly: boolean;
  yes: boolean;
  useRpc: boolean;
  computeUnitPrice?: string;
  maxSignAttempts?: string;
  resumeBuffer?: string;
  resumeBufferKeypair?: string;
  resumeElfSha256?: string;
};

type ParsedCliOptions = CliOptions & { dropId: string };

function usage(): string {
  return [
    'Usage:',
    '  npm run upgrade-onchain -- <dropId> [options]',
    '',
    'Examples:',
    '  npm run upgrade-onchain -- little_swag_hoodies_devnet',
    '  npm run upgrade-onchain -- little_swag_hoodies --rpc-url https://private-rpc.example',
    '',
    'Options:',
    '  --cluster <devnet|mainnet-beta>          Assert the registry target cluster.',
    '  --rpc-url <url>                          Override RPC; required for mutating mainnet upgrades.',
    '  --skip-tests                            Skip tests only before any split config exists.',
    '  --skip-typecheck                        Skip npm run typecheck.',
    '  --dry-run                               Build and audit, but do not prompt or deploy.',
    '  --audit-only                            Audit without build, credential prompt, key file, or deploy.',
    '  --yes                                   Skip the final y/N deploy confirmation.',
    '  --use-rpc                               Send deploy transactions through RPC.',
    '  --compute-unit-price <micro-lamports>   Forward to solana program deploy.',
    '  --max-sign-attempts <count>             Forward to solana program deploy.',
    '  --resume-buffer <address>               Expected failed-upload buffer address.',
    '  --resume-buffer-keypair <absolute-path> Recovered signer for --resume-buffer.',
    '  --resume-elf-sha256 <hash>              ELF hash printed by the failed attempt.',
    '  -h, --help                              Show this help.',
  ].join('\n');
}

export function parseArgs(argv: string[]): ParsedCliOptions {
  const opts: CliOptions = {
    skipTests: false,
    skipTypecheck: false,
    dryRun: false,
    auditOnly: false,
    yes: false,
    useRpc: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--cluster') {
      opts.cluster = requireCluster(argv[++index], '--cluster');
      continue;
    }
    if (arg === '--rpc-url') {
      opts.rpcUrl = validateRpcUrl(requireValue(argv[++index], '--rpc-url'));
      continue;
    }
    if (arg === '--compute-unit-price') {
      opts.computeUnitPrice = requireValue(
        argv[++index],
        '--compute-unit-price',
      );
      continue;
    }
    if (arg === '--max-sign-attempts') {
      opts.maxSignAttempts = requireValue(
        argv[++index],
        '--max-sign-attempts',
      );
      continue;
    }
    if (arg === '--resume-buffer-keypair') {
      opts.resumeBufferKeypair = requireValue(
        argv[++index],
        '--resume-buffer-keypair',
      );
      if (!path.isAbsolute(opts.resumeBufferKeypair)) {
        throw new Error('--resume-buffer-keypair must be an absolute path');
      }
      continue;
    }
    if (arg === '--resume-buffer') {
      const value = requireValue(argv[++index], '--resume-buffer');
      let pubkey: PublicKey;
      try {
        pubkey = new PublicKey(value);
      } catch {
        throw new Error('Invalid --resume-buffer address');
      }
      if (pubkey.equals(PublicKey.default)) {
        throw new Error('Invalid --resume-buffer address');
      }
      opts.resumeBuffer = pubkey.toBase58();
      continue;
    }
    if (arg === '--resume-elf-sha256') {
      const value = requireValue(argv[++index], '--resume-elf-sha256').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(value)) {
        throw new Error('Invalid --resume-elf-sha256');
      }
      opts.resumeElfSha256 = value;
      continue;
    }
    if (arg === '--skip-tests') {
      opts.skipTests = true;
      continue;
    }
    if (arg === '--skip-typecheck') {
      opts.skipTypecheck = true;
      continue;
    }
    if (arg === '--dry-run') {
      opts.dryRun = true;
      continue;
    }
    if (arg === '--audit-only') {
      opts.auditOnly = true;
      continue;
    }
    if (arg === '--yes') {
      opts.yes = true;
      continue;
    }
    if (arg === '--use-rpc') {
      opts.useRpc = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
    if (opts.dropId) {
      throw new Error(
        `Unexpected extra positional argument: ${arg}\n\n${usage()}`,
      );
    }
    opts.dropId = arg;
  }
  if (!opts.dropId) throw new Error(`Missing dropId.\n\n${usage()}`);
  if (opts.auditOnly && opts.dryRun) {
    throw new Error('--audit-only and --dry-run are mutually exclusive');
  }
  if (opts.resumeBufferKeypair && (opts.auditOnly || opts.dryRun)) {
    throw new Error(
      '--resume-buffer-keypair cannot be combined with --audit-only or --dry-run',
    );
  }
  const resumeOptionCount = [
    opts.resumeBuffer,
    opts.resumeBufferKeypair,
    opts.resumeElfSha256,
  ].filter(Boolean).length;
  if (resumeOptionCount !== 0 && resumeOptionCount !== 3) {
    throw new Error(
      '--resume-buffer, --resume-buffer-keypair, and --resume-elf-sha256 must be provided together',
    );
  }
  if (
    opts.resumeBuffer &&
    (opts.yes ||
      opts.skipTests ||
      opts.skipTypecheck ||
      opts.computeUnitPrice !== undefined)
  ) {
    throw new Error(
      'Recovered-buffer upgrades require typecheck, tests, the final confirmation, and no unsupported compute-unit-price override',
    );
  }
  if (
    opts.auditOnly &&
    (opts.yes ||
      opts.useRpc ||
      opts.computeUnitPrice !== undefined ||
      opts.maxSignAttempts !== undefined ||
      opts.resumeBuffer !== undefined ||
      opts.resumeBufferKeypair !== undefined ||
      opts.resumeElfSha256 !== undefined)
  ) {
    throw new Error(
      '--audit-only cannot be combined with deploy transaction options',
    );
  }
  return { ...opts, dropId: opts.dropId };
}

function requireValue(value: string | undefined, optionName: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) throw new Error(`Missing value for ${optionName}`);
  return trimmed;
}

function requireCluster(
  value: string | undefined,
  optionName: string,
): SupportedUpgradeCluster {
  const trimmed = requireValue(value, optionName);
  if (trimmed !== 'devnet' && trimmed !== 'mainnet-beta') {
    throw new Error(`Invalid ${optionName}: ${trimmed}`);
  }
  return trimmed;
}

function removeFileIfExists(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

export function cleanupUpgradeResources(args: {
  filePaths: ReadonlyArray<string | undefined>;
  releaseLock?: () => boolean;
}): Error[] {
  const errors: Error[] = [];
  for (const filePath of args.filePaths) {
    if (!filePath) continue;
    try {
      removeFileIfExists(filePath);
    } catch (error) {
      errors.push(
        new Error(
          `Failed to remove sensitive temporary file ${filePath}: ${errorMessage(error)}`,
        ),
      );
    }
  }
  try {
    if (args.releaseLock && !args.releaseLock()) {
      errors.push(new Error('Failed to release the deployment-registry lock'));
    }
  } catch (error) {
    errors.push(
      new Error(`Failed to release the deployment-registry lock: ${errorMessage(error)}`),
    );
  }
  return errors;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readSolanaActiveReleaseBinDir(): string | undefined {
  const userHome = process.env.HOME;
  if (!userHome) return undefined;
  const configPath = path.join(
    userHome,
    '.config',
    'solana',
    'install',
    'config.yml',
  );
  if (existsSync(configPath)) {
    const config = readFileSync(configPath, 'utf8');
    const match = config.match(/^\s*active_release_dir:\s*(.+)\s*$/m);
    if (match?.[1]) return path.join(match[1].trim(), 'bin');
  }
  return path.join(
    userHome,
    '.local',
    'share',
    'solana',
    'install',
    'active_release',
    'bin',
  );
}

function writeTempKeypairFile(keypair: Keypair, prefix: string): string {
  const filePath = path.join(
    tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(Array.from(keypair.secretKey)), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return filePath;
}

export function writeVerifiedUpgradeAuthority({
  input,
  expectedAuthority,
  writeKeypair = writeTempKeypairFile,
}: {
  input: string;
  expectedAuthority: string;
  writeKeypair?: typeof writeTempKeypairFile;
}): { authorityPubkey: string; keypairPath: string } {
  const authority = parsePrivateKeyInput(input);
  const authorityPubkey = authority.publicKey.toBase58();
  if (expectedAuthority !== authorityPubkey) {
    throw new Error(
      `Private key does not match the deployed upgrade authority.\n` +
        `Expected: ${expectedAuthority}\n` +
        `Got     : ${authorityPubkey}`,
    );
  }
  const keypairPath = writeKeypair(authority, 'mons-shop-upgrade-authority');
  return { authorityPubkey, keypairPath };
}

function writeTempSolanaConfigFile(rpcUrl: string): string {
  const filePath = path.join(
    tmpdir(),
    `mons-shop-solana-config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.yml`,
  );
  const contents =
    `---\n` +
    `json_rpc_url: ${JSON.stringify(rpcUrl)}\n` +
    `websocket_url: ''\n` +
    `keypair_path: ''\n` +
    `commitment: finalized\n`;
  writeFileSync(filePath, contents, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return filePath;
}

export async function readProgramShow(args: {
  programId: string;
  solanaUrl: string;
  solanaConfigPath: string;
  signerInput: string;
  cwd: string;
  env: ToolEnv;
  cancellation?: CommandCancellationController;
  allowAfterCancellation?: boolean;
}, capture: typeof runCapture = runCapture): Promise<unknown> {
  const output = await capture(
    'solana',
    buildProgramShowArgs(args),
    {
      cwd: args.cwd,
      env: args.env,
      stdin: args.signerInput,
      sensitiveRpcUrl: args.solanaUrl,
      cancellation: args.cancellation,
      allowAfterCancellation: args.allowAfterCancellation,
    },
  );
  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new Error(`solana program show returned invalid JSON for ${args.programId}`);
  }
}

async function dumpDeployedProgram(args: {
  programId: string;
  solanaUrl: string;
  solanaConfigPath: string;
  cwd: string;
  env: ToolEnv;
  cancellation?: CommandCancellationController;
  allowAfterCancellation?: boolean;
}): Promise<Buffer> {
  const dumpPath = path.join(
    tmpdir(),
    `mons-shop-program-dump-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.so`,
  );
  try {
    await runCapture(
      'solana',
      buildProgramDumpArgs({ ...args, dumpPath }),
      {
        cwd: args.cwd,
        env: args.env,
        sensitiveRpcUrl: args.solanaUrl,
        cancellation: args.cancellation,
        allowAfterCancellation: args.allowAfterCancellation,
      },
    );
    if (!existsSync(dumpPath)) {
      throw new Error(`solana program dump did not create ${dumpPath}`);
    }
    return readFileSync(dumpPath);
  } finally {
    removeFileIfExists(dumpPath);
  }
}

async function captureCliProgramSnapshot(args: {
  programId: string;
  solanaUrl: string;
  solanaConfigPath: string;
  signerInput: string;
  cwd: string;
  env: ToolEnv;
  stage: string;
  cancellation?: CommandCancellationController;
  allowAfterCancellation?: boolean;
}): Promise<StableProgramSnapshot> {
  return captureStableProgramSnapshotAsync({
    expectedProgramId: args.programId,
    stage: args.stage,
    readShow: () => readProgramShow(args),
    dumpImage: () =>
      dumpDeployedProgram({
        programId: args.programId,
        solanaUrl: args.solanaUrl,
        solanaConfigPath: args.solanaConfigPath,
        cwd: args.cwd,
        env: args.env,
        cancellation: args.cancellation,
        allowAfterCancellation: args.allowAfterCancellation,
      }),
  });
}

async function assertRpcTarget(
  connection: Connection,
  cluster: SupportedUpgradeCluster,
): Promise<void> {
  const genesisHash = await connection.getGenesisHash();
  assertUpgradeRpcGenesisHash({ cluster, genesisHash });
}

async function captureUpgradeGateState(args: {
  connection: Connection;
  cluster: SupportedUpgradeCluster;
  programId: PublicKey;
  registryPath: string;
  solanaUrl: string;
  solanaConfigPath: string;
  signerInput: string;
  cwd: string;
  env: ToolEnv;
  stage: string;
  minContextSlot: number;
  cancellation?: CommandCancellationController;
  allowAfterCancellation?: boolean;
}): Promise<UpgradeGateState> {
  await assertRpcTarget(args.connection, args.cluster);
  args.cancellation?.throwIfCancelled(args.allowAfterCancellation);
  return captureCoherentUpgradeGateState({
    stage: args.stage,
    minContextSlot: args.minContextSlot,
    captureProgram: (stage) =>
      captureCliProgramSnapshot({
        ...args,
        programId: args.programId.toBase58(),
        stage,
      }),
    inspectConfigs: (minContextSlot) =>
      inspectSharedProgramConfigs({
        connection: args.connection,
        cluster: args.cluster,
        programId: args.programId,
        registryPath: args.registryPath,
        minContextSlot,
      }),
  });
}

async function capturePostUpgradeGateState(
  args: Parameters<typeof captureUpgradeGateState>[0],
): Promise<UpgradeGateState> {
  return captureUpgradeGateState(args);
}

function formatSol(lamports?: number): string {
  if (typeof lamports !== 'number') return '(unknown)';
  return `${(lamports / 1_000_000_000).toFixed(9)} SOL`;
}

function printSharedConfigAudit(
  configs: ReadonlyArray<SharedProgramConfigAudit>,
): void {
  const tombstoneCount = configs.filter(
    (config) => config.source === 'tombstone',
  ).length;
  console.log(
    `Shared config audit: ${configs.length} total, ${tombstoneCount} audit-only tombstone${tombstoneCount === 1 ? '' : 's'}`,
  );
  for (const config of configs) {
    const source =
      config.source === 'tombstone'
        ? `tombstone:${config.reason}`
        : 'active';
    const mintRoute = config.paymentRoute.mintProceeds
      .map((recipient) => `${recipient.address}:${recipient.percentage}%`)
      .join(',');
    console.log(
      `  [${source}] ${config.dropId} pda=${config.configPda} size=${config.size} schema=${config.schema}`,
    );
    console.log(
      `    collection=${config.collectionMint} delivery=${config.paymentRoute.deliveryPaymentReceiver} mint=${mintRoute}`,
    );
  }
}

type UpgradePreflightEffects = {
  captureGateState: typeof captureUpgradeGateState;
  runCommand: typeof runUpgradeCommand;
  acquireRegistryLock: typeof acquireDeploymentRegistryMutationLock;
};

const upgradePreflightEffects: UpgradePreflightEffects = {
  captureGateState: captureUpgradeGateState,
  runCommand: runUpgradeCommand,
  acquireRegistryLock: acquireDeploymentRegistryMutationLock,
};

export async function executeUpgrade(args: {
  opts: ParsedCliOptions;
  drop: DeploymentDropConfigSerialized;
  target: { programId: string; buildFeature: string };
  root: string;
  onchainDir: string;
  registryPath: string;
  solanaUrl: string;
  toolEnv: ToolEnv;
}, effects: UpgradePreflightEffects = upgradePreflightEffects): Promise<void> {
  const { captureGateState, runCommand, acquireRegistryLock } = effects;
  const {
    opts,
    drop,
    target,
    root,
    onchainDir,
    registryPath,
    solanaUrl,
    toolEnv,
  } = args;
  const programId = new PublicKey(target.programId);
  const connection = new Connection(solanaUrl, { commitment: 'finalized' });
  const cliCompatibilitySignerInput = JSON.stringify(
    Array.from(Keypair.generate().secretKey),
  );
  const cancellation = new CommandCancellationController();
  const temporaryFiles: string[] = [];
  const retainTemporaryFile = (filePath: string) => { temporaryFiles.push(filePath); return filePath; };
  let buildWorkspace: ReturnType<typeof createSolanaBuildWorkspace> | undefined;
  let resumeBufferKeypairPath: string | undefined;
  let resumeBufferKeypairBytes: number | undefined;
  let resumeBufferKeypairSha256: string | undefined;
  let releaseRegistryLock: (() => boolean) | undefined;
  let deployVerificationPending = false;
  let authorityPromptAbort: AbortController | undefined;
  let primaryError: unknown;
  const cleanup = (): Error[] => {
    const errors: Error[] = [];
    try { buildWorkspace?.cleanup(); } catch (error) {
      errors.push(new Error(`Could not clean up the isolated Solana build: ${errorMessage(error)}`));
    }
    errors.push(...cleanupUpgradeResources({ filePaths: temporaryFiles, releaseLock: releaseRegistryLock }));
    releaseRegistryLock = undefined;
    return errors;
  };
  const handleSignal = (signal: UpgradeSignal) => {
    const repeatedSignal = Boolean(cancellation.signal);
    const childWasActive = cancellation.hasActiveChild;
    cancellation.request(signal);
    authorityPromptAbort?.abort(new CommandCancelledError(signal));
    if (
      shouldDeferUpgradeSignalExit({
        childActive: childWasActive,
        deployVerificationPending,
        promptPending: Boolean(authorityPromptAbort),
        repeatedSignal,
      })
    ) {
      return;
    }
    const cleanupErrors = cleanup();
    for (const error of cleanupErrors) console.error(error.message);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const handleSigint = () => handleSignal('SIGINT');
  const handleSigterm = () => handleSignal('SIGTERM');
  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);
  try {
    const solanaConfigPath = retainTemporaryFile(writeTempSolanaConfigFile(solanaUrl));
    console.log('--- upgrade box_minter program ---');
    console.log('drop    :', drop.dropId);
    console.log('cluster :', drop.solanaCluster);
    console.log('rpc url :', redactRpcUrl(solanaUrl));
    console.log('program :', programId.toBase58());
    if (drop.boxMinterConfigPda) console.log('config  :', drop.boxMinterConfigPda);
    console.log('');

    const initialState = await captureGateState({
      connection,
      cluster: drop.solanaCluster as SupportedUpgradeCluster,
      programId,
      registryPath,
      solanaUrl,
      solanaConfigPath,
      signerInput: cliCompatibilitySignerInput,
      cwd: onchainDir,
      env: toolEnv,
      cancellation,
      stage: 'initial preflight',
      minContextSlot: 0,
    });
    console.log('Current deployed program:');
    console.log('  authority      :', initialState.program.show.authority);
    console.log('  program data   :', initialState.program.show.programdataAddress);
    console.log('  last slot      :', initialState.program.show.lastDeploySlot);
    console.log('  payload capacity:', initialState.program.show.dataLen);
    console.log('  rent balance   :', formatSol(initialState.program.show.lamports));
    printSharedConfigAudit(initialState.configs);
    console.log('');

    if (opts.auditOnly) {
      console.log(
        '--audit-only complete; no build, test, credential prompt, key file, or deploy action was performed.',
      );
      return;
    }

    if (
      opts.skipTests &&
      !opts.dryRun &&
      initialState.configs.some(
        (config) => config.schema === 'split-payments-v1',
      )
    ) {
      throw new Error(
        '--skip-tests is forbidden once a split-payments-v1 config exists; the exact ELF must pass the split-payment SBF suite before every upgrade',
      );
    }

    if (!opts.skipTypecheck) {
      await runCommand('npm', ['run', 'typecheck'], {
        cwd: root,
        env: toolEnv,
        cancellation,
      });
    }
    buildWorkspace = createSolanaBuildWorkspace({ onchainDirectory: onchainDir, buildFeature: target.buildFeature, env: toolEnv });
    const runBuildCommand: Parameters<typeof buildWorkspace.build>[0] = (command, commandArgs, options) =>
      runCommand(command, commandArgs, { ...options, cancellation });
    if (!opts.skipTests) await buildWorkspace.testHost(runBuildCommand);

    releaseRegistryLock = acquireRegistryLock({
      root,
      operation: `build upgrade ${drop.dropId}`,
    });
    const preBuildState = await captureGateState({
      connection,
      cluster: drop.solanaCluster as SupportedUpgradeCluster,
      programId,
      registryPath,
      solanaUrl,
      solanaConfigPath,
      signerInput: cliCompatibilitySignerInput,
      cwd: onchainDir,
      env: toolEnv,
      cancellation,
      stage: 'pre-build gate',
      minContextSlot: initialState.minContextSlot,
    });
    assertUpgradeGateUnchanged(
      initialState,
      preBuildState,
      'before the upgrade build',
    );

    const artifact = await buildWorkspace.build(runBuildCommand, { test: !opts.skipTests });
    const verifiedProgramBinaryPath = artifact.path;
    const binaryBytes = artifact.bytes;
    const localHash = artifact.sha256;
    const localBinary = readFileSync(verifiedProgramBinaryPath);
    assertImmutableArtifactUnchanged({
      filePath: verifiedProgramBinaryPath,
      expectedBytes: binaryBytes,
      expectedSha256: localHash,
      stage: 'after exact-ELF tests',
    });
    if (opts.resumeElfSha256 && localHash !== opts.resumeElfSha256) {
      throw new Error(
        `Recovered-buffer ELF hash mismatch: expected ${opts.resumeElfSha256}, rebuilt ${localHash}`,
      );
    }

    const buildBaseline = await captureGateState({
      connection,
      cluster: drop.solanaCluster as SupportedUpgradeCluster,
      programId,
      registryPath,
      solanaUrl,
      solanaConfigPath,
      signerInput: cliCompatibilitySignerInput,
      cwd: onchainDir,
      env: toolEnv,
      cancellation,
      stage: 'post-build baseline',
      minContextSlot: preBuildState.minContextSlot,
    });
    assertUpgradeGateUnchanged(
      preBuildState,
      buildBaseline,
      'during the upgrade build',
    );
    const payloadCapacity = assertProgramBinaryFitsProgramData({
      programId: programId.toBase58(),
      binaryBytes,
      programDataBytes: buildBaseline.program.show.dataLen,
    });
    const expectedPaddedHash = expectedPaddedProgramImageSha256({
      localBinary,
      payloadCapacity,
    });
    console.log('ProgramData capacity:');
    console.log('  binary bytes    :', binaryBytes);
    console.log('  payload capacity:', payloadCapacity);
    console.log('  remaining bytes :', payloadCapacity - binaryBytes);
    console.log('Binary comparison:');
    console.log('  local ELF sha256   :', localHash);
    console.log('  expected image sha :', expectedPaddedHash);
    console.log('  deployed image sha :', buildBaseline.program.imageSha256);
    console.log('');

    if (!releaseRegistryLock()) {
      throw new Error('Could not release the upgrade build lock');
    }
    releaseRegistryLock = undefined;

    if (
      programImagesAreEquivalent({
        localBinary,
        deployedImage: buildBaseline.program.image,
        payloadCapacity,
      })
    ) {
      console.log('Program already matches the local build; skipping upgrade.');
      return;
    }
    if (opts.dryRun) {
      console.log('--dry-run set; not prompting for authority and not deploying.');
      return;
    }

    let resumeBufferSigner: Keypair | undefined;
    let resumeBufferBaseline: ResumeBufferSnapshot | undefined;
    if (
      opts.resumeBuffer &&
      opts.resumeBufferKeypair &&
      opts.resumeElfSha256
    ) {
      assertResumeSolanaCliVersion(
        await runCapture('solana', ['--version'], {
          cwd: onchainDir,
          env: toolEnv,
          cancellation,
        }),
      );
      resumeBufferSigner = loadResumeBufferKeypair(
        opts.resumeBufferKeypair,
        opts.resumeBuffer,
      );
      resumeBufferBaseline = await captureResumeBufferSnapshot({
        connection,
        pubkey: resumeBufferSigner.publicKey,
        expectedAuthority: buildBaseline.program.show.authority,
        localBinary,
        minContextSlot: buildBaseline.minContextSlot,
      });
      console.log('Recovered upload buffer:');
      console.log('  address       :', resumeBufferBaseline.pubkey);
      console.log('  rent balance  :', formatSol(resumeBufferBaseline.lamports));
      console.log('  payload bytes :', resumeBufferBaseline.totalBytes);
      console.log('  differing     :', resumeBufferBaseline.missingBytes, 'zero bytes');
      console.log('');
    }

    console.log('Enter the upgrade authority private key (input is hidden).');
    console.log(
      'Accepted formats: base58 secret key, or JSON array (like ~/.config/solana/id.json contents).',
    );
    authorityPromptAbort = new AbortController();
    let authorityInput: string;
    try {
      authorityInput = await promptMaskedInput(
        'upgrade authority private key: ',
        { signal: authorityPromptAbort.signal },
      );
    } finally {
      authorityPromptAbort = undefined;
    }
    const verifiedAuthority = writeVerifiedUpgradeAuthority({
      input: authorityInput,
      expectedAuthority: buildBaseline.program.show.authority,
    });
    const authorityKeypairPath = retainTemporaryFile(verifiedAuthority.keypairPath);
    const { authorityPubkey } = verifiedAuthority;
    if (resumeBufferSigner) {
      resumeBufferKeypairPath = retainTemporaryFile(writeTempKeypairFile(
        resumeBufferSigner,
        'mons-shop-resume-buffer',
      ));
      chmodSync(resumeBufferKeypairPath, 0o400);
      resumeBufferKeypairBytes = statSync(resumeBufferKeypairPath).size;
      resumeBufferKeypairSha256 = sha256(
        readFileSync(resumeBufferKeypairPath),
      );
    }

    releaseRegistryLock = acquireRegistryLock({
      root,
      operation: `upgrade ${drop.dropId}`,
    });
    assertImmutableArtifactUnchanged({
      filePath: verifiedProgramBinaryPath,
      expectedBytes: binaryBytes,
      expectedSha256: localHash,
      stage: 'after reacquiring the deployment lock',
    });
    if (
      resumeBufferKeypairPath &&
      resumeBufferKeypairBytes !== undefined &&
      resumeBufferKeypairSha256
    ) {
      assertImmutableArtifactUnchanged({
        filePath: resumeBufferKeypairPath,
        expectedBytes: resumeBufferKeypairBytes,
        expectedSha256: resumeBufferKeypairSha256,
        stage: 'after reacquiring the deployment lock',
      });
    }
    const lockedState = await captureGateState({
      connection,
      cluster: drop.solanaCluster as SupportedUpgradeCluster,
      programId,
      registryPath,
      solanaUrl,
      solanaConfigPath,
      signerInput: cliCompatibilitySignerInput,
      cwd: onchainDir,
      env: toolEnv,
      cancellation,
      stage: 'locked pre-upgrade gate',
      minContextSlot: buildBaseline.minContextSlot,
    });
    assertUpgradeGateUnchanged(
      buildBaseline,
      lockedState,
      'while upgrade authorization was being prepared',
    );
    let lockedResumeBuffer: ResumeBufferSnapshot | undefined;
    if (resumeBufferBaseline && resumeBufferSigner) {
      lockedResumeBuffer = await captureResumeBufferSnapshot({
        connection,
        pubkey: resumeBufferSigner.publicKey,
        expectedAuthority: authorityPubkey,
        localBinary,
        minContextSlot: lockedState.minContextSlot,
      });
      assertResumeBufferUnchanged(resumeBufferBaseline, lockedResumeBuffer);
    }

    console.log('');
    console.log('Upgrade summary:');
    console.log('  drop     :', drop.dropId);
    console.log('  cluster  :', drop.solanaCluster);
    console.log('  rpc url  :', redactRpcUrl(solanaUrl));
    console.log('  program  :', programId.toBase58());
    console.log('  authority:', authorityPubkey);
    console.log('  binary   :', verifiedProgramBinaryPath);
    console.log('  local sha:', localHash);
    if (lockedResumeBuffer) {
      console.log('  buffer   :', lockedResumeBuffer.pubkey);
      console.log(
        '  resume   :',
        `${lockedResumeBuffer.missingBytes} differing zero bytes`,
      );
    }
    printSharedConfigAudit(lockedState.configs);
    console.log('');

    if (!opts.yes) {
      const prefix = drop.solanaCluster === 'mainnet-beta' ? 'MAINNET ' : '';
      const confirmed = await promptYConfirmation(
        lockedResumeBuffer
          ? `Repair recovered buffer and proceed with ${prefix}program upgrade? [y/N] `
          : `Proceed with ${prefix}program upgrade? [y/N] `,
      );
      if (!confirmed) {
        console.log('Cancelled before deploy.');
        return;
      }
    }

    assertImmutableArtifactUnchanged({
      filePath: verifiedProgramBinaryPath,
      expectedBytes: binaryBytes,
      expectedSha256: localHash,
      stage: 'immediately before deploy',
    });
    let resumeBufferBeforeFinalGate: ResumeBufferSnapshot | undefined;
    if (lockedResumeBuffer && resumeBufferSigner) {
      resumeBufferBeforeFinalGate = await captureResumeBufferSnapshot({
        connection,
        pubkey: resumeBufferSigner.publicKey,
        expectedAuthority: authorityPubkey,
        localBinary,
        minContextSlot: lockedState.minContextSlot,
      });
      assertResumeBufferUnchanged(
        lockedResumeBuffer,
        resumeBufferBeforeFinalGate,
      );
    }
    const finalPreDeployState = await captureGateState({
      connection,
      cluster: drop.solanaCluster as SupportedUpgradeCluster,
      programId,
      registryPath,
      solanaUrl,
      solanaConfigPath,
      signerInput: cliCompatibilitySignerInput,
      cwd: onchainDir,
      env: toolEnv,
      cancellation,
      stage: 'final pre-deploy gate',
      minContextSlot: lockedState.minContextSlot,
    });
    assertUpgradeGateUnchanged(
      lockedState,
      finalPreDeployState,
      'before the upgrade transaction',
    );
    assertProgramBinaryFitsProgramData({
      programId: programId.toBase58(),
      binaryBytes,
      programDataBytes: finalPreDeployState.program.show.dataLen,
    });
    assertImmutableArtifactUnchanged({
      filePath: verifiedProgramBinaryPath,
      expectedBytes: binaryBytes,
      expectedSha256: localHash,
      stage: 'at the deploy command boundary',
    });
    let resumeBufferAtWriteBoundary: ResumeBufferSnapshot | undefined;
    if (resumeBufferBeforeFinalGate && resumeBufferSigner) {
      resumeBufferAtWriteBoundary = await captureResumeBufferSnapshot({
        connection,
        pubkey: resumeBufferSigner.publicKey,
        expectedAuthority: authorityPubkey,
        localBinary,
        minContextSlot: finalPreDeployState.minContextSlot,
      });
      assertResumeBufferUnchanged(
        resumeBufferBeforeFinalGate,
        resumeBufferAtWriteBoundary,
      );
    }

    let programStateBeforeUpgrade = finalPreDeployState;
    if (
      resumeBufferAtWriteBoundary &&
      resumeBufferSigner &&
      resumeBufferKeypairPath &&
      resumeBufferKeypairBytes !== undefined &&
      resumeBufferKeypairSha256
    ) {
      assertImmutableArtifactUnchanged({
        filePath: resumeBufferKeypairPath,
        expectedBytes: resumeBufferKeypairBytes,
        expectedSha256: resumeBufferKeypairSha256,
        stage: 'at the recovered-buffer write boundary',
      });
      const bufferSignerPath = resumeBufferKeypairPath;
      deployVerificationPending = true;
      try {
        const recovered = await runBufferWriteAttemptWithVerification({
          cancellation,
          write: () =>
            runCommand(
              'solana',
              buildProgramWriteBufferArgs({
                programBinaryPath: verifiedProgramBinaryPath,
                bufferSignerPath,
                solanaConfigPath,
                authorityKeypairPath,
                useRpc: opts.useRpc,
                computeUnitPrice: opts.computeUnitPrice,
                maxSignAttempts: opts.maxSignAttempts,
              }),
              {
                cwd: onchainDir,
                env: toolEnv,
                sensitiveRpcUrl: solanaUrl,
                cancellation,
              },
            ),
          verify: async () => {
            const bufferAfterWrite = await captureResumeBufferSnapshot({
              connection,
              pubkey: resumeBufferSigner.publicKey,
              expectedAuthority: authorityPubkey,
              localBinary,
              minContextSlot: finalPreDeployState.minContextSlot,
            });
            assertResumeBufferComplete(bufferAfterWrite, localHash);
            const stateAfterWrite = await captureGateState({
              connection,
              cluster: drop.solanaCluster as SupportedUpgradeCluster,
              programId,
              registryPath,
              solanaUrl,
              solanaConfigPath,
              signerInput: cliCompatibilitySignerInput,
              cwd: onchainDir,
              env: toolEnv,
              cancellation,
              allowAfterCancellation: true,
              stage: 'post-buffer-write verification',
              minContextSlot: Math.max(
                finalPreDeployState.minContextSlot,
                bufferAfterWrite.contextSlot,
              ),
            });
            assertUpgradeGateUnchanged(
              finalPreDeployState,
              stateAfterWrite,
              'during recovered-buffer repair',
            );
            const stableBuffer = await captureResumeBufferSnapshot({
              connection,
              pubkey: resumeBufferSigner.publicKey,
              expectedAuthority: authorityPubkey,
              localBinary,
              minContextSlot: stateAfterWrite.minContextSlot,
            });
            assertResumeBufferComplete(stableBuffer, localHash);
            assertResumeBufferUnchanged(bufferAfterWrite, stableBuffer);
            return { state: stateAfterWrite, buffer: stableBuffer };
          },
        });
        programStateBeforeUpgrade = recovered.state;
        resumeBufferAtWriteBoundary = recovered.buffer;
      } finally {
        deployVerificationPending = false;
      }
      cancellation.throwIfCancelled();
      assertImmutableArtifactUnchanged({
        filePath: verifiedProgramBinaryPath,
        expectedBytes: binaryBytes,
        expectedSha256: localHash,
        stage: 'after recovered-buffer verification',
      });
      assertImmutableArtifactUnchanged({
        filePath: resumeBufferKeypairPath,
        expectedBytes: resumeBufferKeypairBytes,
        expectedSha256: resumeBufferKeypairSha256,
        stage: 'after recovered-buffer verification',
      });
    }

    let postUpgradeState: UpgradeGateState;
    deployVerificationPending = true;
    try {
      postUpgradeState = await runDeployAttemptWithVerification({
        cancellation,
        deploy: () => {
          const commandArgs = resumeBufferAtWriteBoundary
            ? buildProgramUpgradeArgs({
                bufferPubkey: resumeBufferAtWriteBoundary.pubkey,
                programId: programId.toBase58(),
                solanaConfigPath,
                authorityKeypairPath,
              })
            : buildProgramDeployArgs({
                programBinaryPath: verifiedProgramBinaryPath,
                programId: programId.toBase58(),
                solanaConfigPath,
                authorityKeypairPath,
                useRpc: opts.useRpc,
                computeUnitPrice: opts.computeUnitPrice,
                maxSignAttempts: opts.maxSignAttempts,
              });
          return runCommand('solana', commandArgs, {
            cwd: onchainDir,
            env: toolEnv,
            sensitiveRpcUrl: solanaUrl,
            cancellation,
          });
        },
        verify: async () => {
          const state = await capturePostUpgradeGateState({
            connection,
            cluster: drop.solanaCluster as SupportedUpgradeCluster,
            programId,
            registryPath,
            solanaUrl,
            solanaConfigPath,
            signerInput: cliCompatibilitySignerInput,
            cwd: onchainDir,
            env: toolEnv,
            cancellation,
            allowAfterCancellation: true,
            stage: 'post-upgrade verification',
            minContextSlot: programStateBeforeUpgrade.minContextSlot,
          });
          assertPostUpgradeProgramIdentity({
            before: programStateBeforeUpgrade.program.show,
            after: state.program.show,
          });
          assertProgramImageEquivalent({
            localBinary,
            deployedImage: state.program.image,
            payloadCapacity,
            label: 'post-upgrade deployed program image',
          });
          assertLineageFingerprintUnchanged(
            programStateBeforeUpgrade.configs,
            state.configs,
            'during the program upgrade',
          );
          if (resumeBufferAtWriteBoundary) {
            await assertResumeBufferConsumed({
              connection,
              pubkey: new PublicKey(resumeBufferAtWriteBoundary.pubkey),
              minContextSlot: state.program.show.lastDeploySlot,
            });
          }
          return state;
        },
      });
    } finally {
      deployVerificationPending = false;
    }
    console.log('Post-upgrade verification:');
    console.log('  last slot:', postUpgradeState.program.show.lastDeploySlot);
    console.log('  expected image sha:', expectedPaddedHash);
    console.log('  deployed image sha:', postUpgradeState.program.imageSha256);
    console.log('Program upgrade verified.');
    if (cancellation.signal) {
      throw new CommandCancelledError(
        cancellation.signal,
        `Upgrade interrupted by ${cancellation.signal}; finalized verification confirms the upgrade landed`,
      );
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    process.removeListener('SIGINT', handleSigint);
    process.removeListener('SIGTERM', handleSigterm);
    const cleanupErrors = cleanup();
    if (cleanupErrors.length) {
      const cleanupError = new Error(
        cleanupErrors.map((error) => error.message).join('\n'),
      );
      if (primaryError) console.error(cleanupError.message);
      else throw cleanupError;
    }
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(scriptDir, '..');
  const onchainDir = path.join(root, 'onchain');
  const registryPath = path.join(
    root,
    'shared',
    'deploymentRegistry.ts',
  );
  const registry: DeploymentDropRegistry =
    await readDeploymentDropRegistry(registryPath);
  const drop = registry.drops[opts.dropId];
  if (!drop) {
    throw new Error(
      `Unknown active dropId: ${opts.dropId}\nKnown drops: ${Object.keys(registry.drops).sort().join(', ')}`,
    );
  }
  const target = assertSupportedUpgradeTarget({
    drop,
    requestedCluster: opts.cluster,
    rpcUrlWasExplicit: Boolean(opts.rpcUrl),
    rpcUrl: opts.rpcUrl,
    isMutatingUpgrade: !opts.auditOnly && !opts.dryRun,
  });
  const solanaUrl = opts.rpcUrl || clusterApiUrl(drop.solanaCluster);
  const solanaBinDir = readSolanaActiveReleaseBinDir();
  const toolEnv: ToolEnv = {
    ...(solanaBinDir
      ? { PATH: `${solanaBinDir}:${process.env.PATH || ''}` }
      : {}),
  };
  try {
    await executeUpgrade({
      opts,
      drop,
      target,
      root,
      onchainDir,
      registryPath,
      solanaUrl,
      toolEnv,
    });
  } catch (error) {
    const redacted = new Error(
      redactRpcDetailsInText(errorMessage(error), solanaUrl),
    ) as Error & { exitCode?: number };
    const exitCode = (error as { exitCode?: unknown })?.exitCode;
    if (typeof exitCode === 'number') redacted.exitCode = exitCode;
    throw redacted;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && path.resolve(entry) === fileURLToPath(import.meta.url));
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(errorMessage(error));
    const exitCode =
      typeof (error as { exitCode?: unknown })?.exitCode === 'number'
        ? Number((error as { exitCode: number }).exitCode)
        : 1;
    process.exitCode = exitCode;
  });
}
