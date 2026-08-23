import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import bs58 from 'bs58';
import {
  clusterApiUrl,
  Connection,
  Keypair,
  PublicKey,
  type AccountInfo,
} from '@solana/web3.js';
import type {
  DeploymentRegistryDrop,
  PaymentRoutingConfig,
} from '../shared/deploymentRegistry.ts';
import {
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED,
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_SPLIT_PAYMENTS_V1,
  BOX_MINTER_CONFIG_DISCRIMINATOR,
  decodeBoxMinterConfigData,
  type DecodedBoxMinterConfigData,
} from '../shared/boxMinterConfigCodec.ts';
import { BOX_MINTER_CONFIG_SEED } from '../shared/boxMinterProtocol.ts';
import {
  parsePrivateKeyInput,
  promptMaskedInput,
  promptYConfirmation,
} from './shared/interactive.ts';
import {
  acquireDeploymentRegistryMutationLock,
  readDeploymentDropRegistry,
  type BoxMinterConfigTombstone,
  type DeploymentDropConfigSerialized,
  type DeploymentDropRegistry,
} from './shared/deploymentRegistry.ts';

export type SupportedUpgradeCluster = 'devnet' | 'mainnet-beta';

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
type ToolEnv = Record<string, string | undefined>;
export type CommandOptions = {
  cwd?: string;
  env?: ToolEnv;
  stdin?: string;
  sensitiveRpcUrl?: string;
  cancellation?: CommandCancellationController;
  allowAfterCancellation?: boolean;
};

type UpgradeSignal = 'SIGINT' | 'SIGTERM';

export class CommandCancelledError extends Error {
  readonly signal: UpgradeSignal;
  readonly exitCode: number;

  constructor(signal: UpgradeSignal, message = `Upgrade interrupted by ${signal}`) {
    super(message);
    this.name = 'CommandCancelledError';
    this.signal = signal;
    this.exitCode = signal === 'SIGINT' ? 130 : 143;
  }
}

export class CommandCancellationController {
  private requestedSignal?: UpgradeSignal;
  private activeChild?: ChildProcess;
  private activeAllowsRecovery = false;
  private killTimer?: NodeJS.Timeout;

  get signal(): UpgradeSignal | undefined {
    return this.requestedSignal;
  }

  get hasActiveChild(): boolean {
    return Boolean(this.activeChild);
  }

  request(signal: UpgradeSignal): void {
    const repeated = Boolean(this.requestedSignal);
    if (!this.requestedSignal) this.requestedSignal = signal;
    if (!this.activeChild) return;
    if (repeated) {
      this.signalChild(this.activeChild, 'SIGKILL');
      return;
    }
    if (this.activeAllowsRecovery) return;
    this.terminateActiveChild(signal);
  }

  throwIfCancelled(allowAfterCancellation = false): void {
    if (this.requestedSignal && !allowAfterCancellation) {
      throw new CommandCancelledError(this.requestedSignal);
    }
  }

  attach(child: ChildProcess, allowAfterCancellation = false): void {
    this.activeChild = child;
    this.activeAllowsRecovery = allowAfterCancellation;
    if (this.requestedSignal && !allowAfterCancellation) {
      this.terminateActiveChild(this.requestedSignal);
    }
  }

  detach(child: ChildProcess): void {
    if (this.activeChild !== child) return;
    this.activeChild = undefined;
    this.activeAllowsRecovery = false;
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = undefined;
  }

  private signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    if (process.platform !== 'win32') {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      }
    }
    try {
      child.kill(signal);
    } catch {}
  }

  private terminateActiveChild(signal: UpgradeSignal): void {
    const child = this.activeChild;
    if (!child) return;
    this.signalChild(child, signal);
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = setTimeout(() => {
      if (this.activeChild === child) this.signalChild(child, 'SIGKILL');
    }, 5_000);
    this.killTimer.unref();
  }
}

export function shouldDeferUpgradeSignalExit(args: {
  childActive: boolean;
  deployVerificationPending: boolean;
  promptPending: boolean;
  repeatedSignal: boolean;
}): boolean {
  if (args.childActive) return true;
  if (args.repeatedSignal) return false;
  return args.deployVerificationPending || args.promptPending;
}

export type ProgramShowInfo = {
  programId: string;
  owner: string;
  programdataAddress: string;
  authority: string;
  lastDeploySlot: number;
  dataLen: number;
  lamports?: number;
  balance?: number;
};

export type StableProgramSnapshot = {
  show: ProgramShowInfo;
  image: Buffer;
  imageSha256: string;
};

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

export type UpgradeGateState = {
  program: StableProgramSnapshot;
  configs: ReadonlyArray<SharedProgramConfigAudit>;
  minContextSlot: number;
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

const BPF_LOADER_UPGRADEABLE =
  'BPFLoaderUpgradeab1e11111111111111111111111';
const UPGRADEABLE_LOADER_BUFFER_METADATA_BYTES = 37;

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

export function assertProgramBinaryFitsProgramData(args: {
  programId: string;
  binaryBytes: number;
  programDataBytes?: number;
}): number {
  if (
    !Number.isSafeInteger(args.programDataBytes) ||
    Number(args.programDataBytes) <= 0
  ) {
    throw new Error(
      `Could not determine ProgramData payload capacity for ${args.programId}; refusing to upgrade`,
    );
  }
  const capacity = Number(args.programDataBytes);
  if (!Number.isSafeInteger(args.binaryBytes) || args.binaryBytes <= 0) {
    throw new Error(`Invalid local program binary size: ${args.binaryBytes}`);
  }
  if (args.binaryBytes > capacity) {
    const additionalBytes = args.binaryBytes - capacity;
    throw new Error(
      `Local program binary does not fit the deployed ProgramData account.\n` +
        `- program          : ${args.programId}\n` +
        `- binary bytes     : ${args.binaryBytes}\n` +
        `- payload capacity : ${capacity}\n` +
        `- additional bytes : ${additionalBytes}\n` +
        `Extend it explicitly before upgrading:\n` +
        `solana program extend ${args.programId} ${additionalBytes}`,
    );
  }
  return capacity;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export type ResumeBufferSnapshot = {
  contextSlot: number;
  pubkey: string;
  authority: string;
  lamports: number;
  dataLength: number;
  dataSha256: string;
  payloadSha256: string;
  totalBytes: number;
  exactBytes: number;
  missingBytes: number;
};

export function assertResumeSolanaCliVersion(version: string): void {
  if (
    !/^solana-cli 3\.1\.12 \(src:6c1ba346; .*client:Agave\)$/.test(
      version.trim(),
    )
  ) {
    throw new Error(
      `Recovered-buffer upgrades require audited solana-cli 3.1.12 src:6c1ba346; got ${version.trim() || '(empty)'}`,
    );
  }
}

export function loadResumeBufferKeypair(
  filePath: string,
  expectedPubkey: string,
): Keypair {
  if (!path.isAbsolute(filePath)) {
    throw new Error('--resume-buffer-keypair must be an absolute path');
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      filePath,
      fsConstants.O_RDONLY |
        (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW),
    );
    const file = fstatSync(descriptor);
    if (!file.isFile()) {
      throw new Error('invalid file type');
    }
    if (process.platform !== 'win32' && (file.mode & 0o077) !== 0) {
      throw new Error('insecure permissions');
    }
    if (
      process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      file.uid !== process.getuid()
    ) {
      throw new Error('wrong owner');
    }
    if (file.size <= 0 || file.size > 4_096) {
      throw new Error('invalid size');
    }
    const parsed = JSON.parse(readFileSync(descriptor, 'utf8')) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      parsed.some(
        (value) =>
          !Number.isInteger(value) || Number(value) < 0 || Number(value) > 255,
      )
    ) {
      throw new Error('invalid keypair');
    }
    const keypair = Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
    if (keypair.publicKey.toBase58() !== expectedPubkey) {
      throw new Error('wrong public key');
    }
    return keypair;
  } catch {
    throw new Error(
      `Recovered buffer keypair must be a private regular JSON keypair deriving ${expectedPubkey}`,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function inspectResumeBufferAccount(args: {
  contextSlot: number;
  pubkey: PublicKey;
  account: AccountInfo<Buffer> | null;
  expectedAuthority: string;
  localBinary: Buffer;
  minimumRentExemptLamports: number;
}): ResumeBufferSnapshot {
  const account = args.account;
  const pubkey = args.pubkey.toBase58();
  if (!account) throw new Error(`Resume buffer account does not exist: ${pubkey}`);
  if (account.owner.toBase58() !== BPF_LOADER_UPGRADEABLE) {
    throw new Error(`Resume buffer ${pubkey} has an unexpected owner`);
  }
  if (account.executable) {
    throw new Error(`Resume buffer ${pubkey} is unexpectedly executable`);
  }
  if (account.lamports < args.minimumRentExemptLamports) {
    throw new Error(
      `Resume buffer ${pubkey} is not rent exempt: expected at least ${args.minimumRentExemptLamports}, got ${account.lamports}`,
    );
  }
  const data = Buffer.from(account.data);
  const expectedLength =
    UPGRADEABLE_LOADER_BUFFER_METADATA_BYTES + args.localBinary.length;
  if (data.length !== expectedLength) {
    throw new Error(
      `Resume buffer ${pubkey} has ${data.length} bytes, expected ${expectedLength}`,
    );
  }
  if (data.readUInt32LE(0) !== 1 || data[4] !== 1) {
    throw new Error(`Resume buffer ${pubkey} has an invalid loader state`);
  }
  const authority = new PublicKey(data.subarray(5, 37)).toBase58();
  if (authority !== args.expectedAuthority) {
    throw new Error(
      `Resume buffer authority mismatch: expected ${args.expectedAuthority}, got ${authority}`,
    );
  }
  const payload = data.subarray(UPGRADEABLE_LOADER_BUFFER_METADATA_BYTES);
  let exactBytes = 0;
  let missingBytes = 0;
  for (let index = 0; index < args.localBinary.length; index += 1) {
    if (payload[index] === args.localBinary[index]) {
      exactBytes += 1;
    } else if (payload[index] === 0) {
      missingBytes += 1;
    } else {
      throw new Error(
        `Resume buffer ${pubkey} contains data that does not match the verified ELF`,
      );
    }
  }
  return {
    contextSlot: args.contextSlot,
    pubkey,
    authority,
    lamports: account.lamports,
    dataLength: data.length,
    dataSha256: sha256(data),
    payloadSha256: sha256(payload),
    totalBytes: payload.length,
    exactBytes,
    missingBytes,
  };
}

async function captureResumeBufferSnapshot(args: {
  connection: Connection;
  pubkey: PublicKey;
  expectedAuthority: string;
  localBinary: Buffer;
  minContextSlot: number;
}): Promise<ResumeBufferSnapshot> {
  const expectedDataLength =
    UPGRADEABLE_LOADER_BUFFER_METADATA_BYTES + args.localBinary.length;
  const [result, minimumRentExemptLamports] = await Promise.all([
    args.connection.getAccountInfoAndContext(args.pubkey, {
      commitment: 'finalized',
      minContextSlot: args.minContextSlot,
    }),
    args.connection.getMinimumBalanceForRentExemption(
      expectedDataLength,
      'finalized',
    ),
  ]);
  if (result.context.slot < args.minContextSlot) {
    throw new Error(
      `Resume buffer context slot ${result.context.slot} is older than required ${args.minContextSlot}`,
    );
  }
  return inspectResumeBufferAccount({
    contextSlot: result.context.slot,
    pubkey: args.pubkey,
    account: result.value,
    expectedAuthority: args.expectedAuthority,
    localBinary: args.localBinary,
    minimumRentExemptLamports,
  });
}

export function assertResumeBufferComplete(
  snapshot: ResumeBufferSnapshot,
  expectedElfSha256: string,
): void {
  if (
    snapshot.missingBytes !== 0 ||
    snapshot.exactBytes !== snapshot.totalBytes ||
    snapshot.payloadSha256 !== expectedElfSha256
  ) {
    throw new Error(
      `Recovered buffer ${snapshot.pubkey} is not an exact finalized copy of the verified ELF`,
    );
  }
}

export function assertResumeBufferUnchanged(
  before: ResumeBufferSnapshot,
  after: ResumeBufferSnapshot,
): void {
  const fingerprint = (value: ResumeBufferSnapshot) =>
    JSON.stringify({
      pubkey: value.pubkey,
      authority: value.authority,
      lamports: value.lamports,
      dataLength: value.dataLength,
      dataSha256: value.dataSha256,
      payloadSha256: value.payloadSha256,
      totalBytes: value.totalBytes,
      exactBytes: value.exactBytes,
      missingBytes: value.missingBytes,
    });
  if (fingerprint(before) !== fingerprint(after)) {
    throw new Error('Resume buffer changed before the upgrade command');
  }
}

export async function assertResumeBufferConsumed(args: {
  connection: Pick<Connection, 'getAccountInfoAndContext'>;
  pubkey: PublicKey;
  minContextSlot: number;
}): Promise<void> {
  const result = await args.connection.getAccountInfoAndContext(args.pubkey, {
    commitment: 'finalized',
    minContextSlot: args.minContextSlot,
  });
  if (result.context.slot < args.minContextSlot) {
    throw new Error(
      `Consumed-buffer context slot ${result.context.slot} is older than deployed slot ${args.minContextSlot}`,
    );
  }
  if (result.value !== null) {
    throw new Error(
      `Recovered buffer ${args.pubkey.toBase58()} still exists after the finalized program upgrade`,
    );
  }
}

export function assertProgramImageEquivalent(args: {
  localBinary: Uint8Array;
  deployedImage: Uint8Array;
  payloadCapacity: number;
  label?: string;
}): void {
  const label = args.label || 'deployed program image';
  assertProgramBinaryFitsProgramData({
    programId: label,
    binaryBytes: args.localBinary.length,
    programDataBytes: args.payloadCapacity,
  });
  if (args.deployedImage.length !== args.payloadCapacity) {
    throw new Error(
      `${label} has ${args.deployedImage.length} bytes, expected exact ProgramData payload capacity ${args.payloadCapacity}`,
    );
  }
  const binaryEnd = args.localBinary.length;
  if (
    !Buffer.from(args.deployedImage.subarray(0, binaryEnd)).equals(
      Buffer.from(args.localBinary),
    )
  ) {
    throw new Error(`${label} does not match the local ELF bytes`);
  }
  for (let index = binaryEnd; index < args.deployedImage.length; index += 1) {
    if (args.deployedImage[index] !== 0) {
      throw new Error(
        `${label} has non-zero data after the local ELF at byte ${index}`,
      );
    }
  }
}

export function programImagesAreEquivalent(args: {
  localBinary: Uint8Array;
  deployedImage: Uint8Array;
  payloadCapacity: number;
}): boolean {
  try {
    assertProgramImageEquivalent(args);
    return true;
  } catch {
    return false;
  }
}

export function expectedPaddedProgramImageSha256(args: {
  localBinary: Uint8Array;
  payloadCapacity: number;
}): string {
  assertProgramBinaryFitsProgramData({
    programId: 'expected padded program image',
    binaryBytes: args.localBinary.length,
    programDataBytes: args.payloadCapacity,
  });
  const hash = createHash('sha256').update(args.localBinary);
  let remaining = args.payloadCapacity - args.localBinary.length;
  const zeroes = Buffer.alloc(Math.min(remaining, 64 * 1024));
  while (remaining > 0) {
    const bytes = Math.min(remaining, zeroes.length);
    hash.update(zeroes.subarray(0, bytes));
    remaining -= bytes;
  }
  return hash.digest('hex');
}

function requirePublicKeyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Program show returned invalid ${label}`);
  }
  const normalized = new PublicKey(value).toBase58();
  if (normalized === PublicKey.default.toBase58()) {
    throw new Error(`Program show returned default ${label}`);
  }
  return normalized;
}

function requireSafeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`Program show returned invalid ${label}: ${String(value)}`);
  }
  return Number(value);
}

export function normalizeProgramShowInfo(
  value: unknown,
  expectedProgramId: string,
): ProgramShowInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Program show returned invalid JSON');
  }
  const row = value as Record<string, unknown>;
  const programId = requirePublicKeyString(row.programId, 'programId');
  if (programId !== expectedProgramId) {
    throw new Error(
      `Program show returned ${programId}, expected ${expectedProgramId}`,
    );
  }
  if (row.owner !== BPF_LOADER_UPGRADEABLE) {
    throw new Error(
      `Program ${expectedProgramId} is not upgradeable.\n` +
        `Expected owner: ${BPF_LOADER_UPGRADEABLE}\n` +
        `Actual owner  : ${String(row.owner)}`,
    );
  }
  const programdataAddress = requirePublicKeyString(
    row.programdataAddress,
    'programdataAddress',
  );
  const authority = requirePublicKeyString(row.authority, 'authority');
  const lastDeploySlot = requireSafeInteger(
    row.lastDeploySlot,
    'lastDeploySlot',
  );
  const dataLen = requireSafeInteger(row.dataLen, 'dataLen', 1);
  const normalized: ProgramShowInfo = {
    programId,
    owner: BPF_LOADER_UPGRADEABLE,
    programdataAddress,
    authority,
    lastDeploySlot,
    dataLen,
  };
  if (row.lamports !== undefined) {
    normalized.lamports = requireSafeInteger(row.lamports, 'lamports');
  }
  if (row.balance !== undefined) {
    if (typeof row.balance !== 'number' || !Number.isFinite(row.balance)) {
      throw new Error(`Program show returned invalid balance: ${String(row.balance)}`);
    }
    normalized.balance = row.balance;
  }
  return normalized;
}

function programShowFingerprint(show: ProgramShowInfo): string {
  return JSON.stringify({
    programId: show.programId,
    owner: show.owner,
    programdataAddress: show.programdataAddress,
    authority: show.authority,
    lastDeploySlot: show.lastDeploySlot,
    dataLen: show.dataLen,
  });
}

function finishStableProgramSnapshot(args: {
  first: ProgramShowInfo;
  second: ProgramShowInfo;
  image: Buffer;
  stage: string;
}): StableProgramSnapshot {
  if (
    programShowFingerprint(args.first) !== programShowFingerprint(args.second)
  ) {
    throw new Error(
      `Program state changed during ${args.stage} show-dump-show snapshot.\n` +
        `Before: ${programShowFingerprint(args.first)}\n` +
        `After : ${programShowFingerprint(args.second)}`,
    );
  }
  if (args.image.length !== args.first.dataLen) {
    throw new Error(
      `Program dump during ${args.stage} has ${args.image.length} bytes, expected exact ProgramData payload capacity ${args.first.dataLen}`,
    );
  }
  return {
    show: args.first,
    image: args.image,
    imageSha256: sha256(args.image),
  };
}

export function captureStableProgramSnapshot(args: {
  expectedProgramId: string;
  readShow: () => unknown;
  dumpImage: () => Buffer;
  stage: string;
}): StableProgramSnapshot {
  const first = normalizeProgramShowInfo(
    args.readShow(),
    args.expectedProgramId,
  );
  const image = args.dumpImage();
  const second = normalizeProgramShowInfo(
    args.readShow(),
    args.expectedProgramId,
  );
  return finishStableProgramSnapshot({ first, second, image, stage: args.stage });
}

export async function captureStableProgramSnapshotAsync(args: {
  expectedProgramId: string;
  readShow: () => Promise<unknown>;
  dumpImage: () => Promise<Buffer>;
  stage: string;
}): Promise<StableProgramSnapshot> {
  const first = normalizeProgramShowInfo(
    await args.readShow(),
    args.expectedProgramId,
  );
  const image = await args.dumpImage();
  const second = normalizeProgramShowInfo(
    await args.readShow(),
    args.expectedProgramId,
  );
  return finishStableProgramSnapshot({ first, second, image, stage: args.stage });
}

export function assertProgramSnapshotUnchanged(
  before: StableProgramSnapshot,
  after: StableProgramSnapshot,
  stage: string,
): void {
  if (
    programShowFingerprint(before.show) === programShowFingerprint(after.show) &&
    before.imageSha256 === after.imageSha256 &&
    before.image.length === after.image.length
  ) {
    return;
  }
  throw new Error(
    `Deployed program changed ${stage}.\n` +
      `Before show: ${programShowFingerprint(before.show)}\n` +
      `After show : ${programShowFingerprint(after.show)}\n` +
      `Before dump: ${before.imageSha256}\n` +
      `After dump : ${after.imageSha256}`,
  );
}

export function assertPostUpgradeProgramIdentity(args: {
  before: ProgramShowInfo;
  after: ProgramShowInfo;
}): void {
  const stableKeys = [
    'programId',
    'owner',
    'programdataAddress',
    'authority',
    'dataLen',
  ] as const;
  for (const key of stableKeys) {
    if (args.before[key] !== args.after[key]) {
      throw new Error(
        `Program ${key} changed during upgrade: ${String(args.before[key])} -> ${String(args.after[key])}`,
      );
    }
  }
  if (args.after.lastDeploySlot <= args.before.lastDeploySlot) {
    throw new Error(
      `Program lastDeploySlot did not advance: ${args.before.lastDeploySlot} -> ${args.after.lastDeploySlot}`,
    );
  }
}

export function assertImmutableArtifactUnchanged(args: {
  filePath: string;
  expectedBytes: number;
  expectedSha256: string;
  stage: string;
}): void {
  const stat = lstatSync(args.filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Verified program artifact is not a regular file ${args.stage}`);
  }
  if ((stat.mode & 0o222) !== 0) {
    throw new Error(`Verified program artifact became writable ${args.stage}`);
  }
  if (stat.size !== args.expectedBytes) {
    throw new Error(
      `Verified program artifact size changed ${args.stage}: expected ${args.expectedBytes}, got ${stat.size}`,
    );
  }
  const actualSha256 = sha256(readFileSync(args.filePath));
  if (actualSha256 !== args.expectedSha256) {
    throw new Error(
      `Verified program artifact hash changed ${args.stage}: expected ${args.expectedSha256}, got ${actualSha256}`,
    );
  }
}

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

export function validateRpcUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid --rpc-url');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Invalid --rpc-url protocol; expected http or https');
  }
  if (parsed.hash) {
    throw new Error('Invalid --rpc-url; fragments are not allowed');
  }
  return parsed.toString();
}

export function redactRpcUrl(value: string): string {
  void value;
  return '<custom-rpc-url-redacted>';
}

export function redactRpcDetailsInText(value: string, rpcUrl: string): string {
  let redacted = value.split(rpcUrl).join(redactRpcUrl(rpcUrl));
  try {
    const parsed = new URL(rpcUrl);
    const broadParts = [
      parsed.href,
      parsed.origin,
      parsed.host,
      parsed.hostname,
      parsed.search,
    ];
    const secretParts = [
      parsed.username,
      parsed.password,
      parsed.pathname === '/' ? '' : parsed.pathname,
      ...parsed.searchParams.values(),
    ];
    const sensitive = new Set<string>();
    const shortSensitive = new Set<string>();
    const addVariants = (part: string, allowShort: boolean) => {
      if (!part) return;
      sensitive.add(part);
      if (allowShort) shortSensitive.add(part);
      try {
        const decoded = decodeURIComponent(part);
        sensitive.add(decoded);
        if (allowShort) shortSensitive.add(decoded);
      } catch {}
    };
    for (const part of broadParts) addVariants(part, false);
    for (const part of secretParts) addVariants(part, true);
    for (const part of [...sensitive]
      .filter(
        (candidate) =>
          candidate.length >= 3 || shortSensitive.has(candidate),
      )
      .sort((left, right) => right.length - left.length)) {
      redacted = redacted.split(part).join('<redacted>');
    }
  } catch {}
  return redacted;
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
    .map((drop) => expectedActiveConfig(drop, args.programId));
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

export function buildProgramShowArgs(args: {
  programId: string;
  solanaConfigPath: string;
}): string[] {
  return [
    'program',
    'show',
    args.programId,
    '--config',
    args.solanaConfigPath,
    '--keypair',
    '-',
    '--output',
    'json',
    '--commitment',
    'finalized',
  ];
}

export function buildProgramDumpArgs(args: {
  programId: string;
  dumpPath: string;
  solanaConfigPath: string;
}): string[] {
  return [
    'program',
    'dump',
    args.programId,
    args.dumpPath,
    '--config',
    args.solanaConfigPath,
    '--commitment',
    'finalized',
  ];
}

export function buildProgramDeployArgs(args: {
  programBinaryPath: string;
  programId: string;
  solanaConfigPath: string;
  authorityKeypairPath: string;
  useRpc?: boolean;
  computeUnitPrice?: string;
  maxSignAttempts?: string;
}): string[] {
  const deployArgs = [
    'program',
    'deploy',
    args.programBinaryPath,
    '--program-id',
    args.programId,
    '--config',
    args.solanaConfigPath,
    '--keypair',
    args.authorityKeypairPath,
    '--upgrade-authority',
    args.authorityKeypairPath,
    '--commitment',
    'finalized',
    '--no-auto-extend',
  ];
  if (args.useRpc) deployArgs.push('--use-rpc');
  if (args.computeUnitPrice) {
    deployArgs.push('--with-compute-unit-price', args.computeUnitPrice);
  }
  if (args.maxSignAttempts) {
    deployArgs.push('--max-sign-attempts', args.maxSignAttempts);
  }
  return deployArgs;
}

export function buildProgramWriteBufferArgs(args: {
  programBinaryPath: string;
  bufferSignerPath: string;
  solanaConfigPath: string;
  authorityKeypairPath: string;
  useRpc?: boolean;
  computeUnitPrice?: string;
  maxSignAttempts?: string;
}): string[] {
  const writeArgs = [
    'program',
    'write-buffer',
    args.programBinaryPath,
    '--buffer',
    args.bufferSignerPath,
    '--buffer-authority',
    args.authorityKeypairPath,
    '--config',
    args.solanaConfigPath,
    '--keypair',
    args.authorityKeypairPath,
    '--commitment',
    'finalized',
  ];
  if (args.useRpc) writeArgs.push('--use-rpc');
  if (args.computeUnitPrice) {
    writeArgs.push('--with-compute-unit-price', args.computeUnitPrice);
  }
  if (args.maxSignAttempts) {
    writeArgs.push('--max-sign-attempts', args.maxSignAttempts);
  }
  return writeArgs;
}

export function buildProgramUpgradeArgs(args: {
  bufferPubkey: string;
  programId: string;
  solanaConfigPath: string;
  authorityKeypairPath: string;
}): string[] {
  return [
    'program',
    'upgrade',
    args.bufferPubkey,
    args.programId,
    '--config',
    args.solanaConfigPath,
    '--keypair',
    args.authorityKeypairPath,
    '--upgrade-authority',
    args.authorityKeypairPath,
    '--commitment',
    'finalized',
  ];
}

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

function commandEnv(env: ToolEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, NO_DNA: '1', ...env };
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

function displayedCommand(cmd: string, args: string[]): string {
  const displayed = [...args];
  const urlIndex = displayed.indexOf('--url');
  if (urlIndex >= 0 && displayed[urlIndex + 1]) {
    displayed[urlIndex + 1] = redactRpcUrl(displayed[urlIndex + 1]);
  }
  return `${cmd} ${displayed.join(' ')}`;
}

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
};

async function executeCommand(
  cmd: string,
  args: string[],
  opts: CommandOptions,
  captureOutput: boolean,
): Promise<CommandResult> {
  const urlIndex = args.indexOf('--url');
  const rpcUrl =
    opts.sensitiveRpcUrl || (urlIndex >= 0 ? args[urlIndex + 1] : undefined);
  const shouldBuffer = captureOutput || Boolean(rpcUrl);
  opts.cancellation?.throwIfCancelled(opts.allowAfterCancellation);
  const spawnOptions: SpawnOptions = {
    cwd: opts.cwd,
    env: commandEnv(opts.env),
    detached: process.platform !== 'win32',
    stdio: [
      opts.stdin === undefined
        ? captureOutput
          ? 'ignore'
          : 'inherit'
        : 'pipe',
      shouldBuffer ? 'pipe' : 'inherit',
      shouldBuffer ? 'pipe' : 'inherit',
    ],
  };
  const child = spawn(cmd, args, spawnOptions);
  opts.cancellation?.attach(child, opts.allowAfterCancellation);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdout.push(Buffer.from(chunk));
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr.push(Buffer.from(chunk));
  });
  if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
  let spawnError: Error | undefined;
  const result = await new Promise<CommandResult>((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code, signal) => {
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code,
        signal,
      });
    });
  }).finally(() => {
    opts.cancellation?.detach(child);
  });
  if (!captureOutput && shouldBuffer) {
    const safeStdout = rpcUrl
      ? redactRpcDetailsInText(result.stdout, rpcUrl)
      : result.stdout;
    const safeStderr = rpcUrl
      ? redactRpcDetailsInText(result.stderr, rpcUrl)
      : result.stderr;
    if (safeStdout) process.stdout.write(safeStdout);
    if (safeStderr) process.stderr.write(safeStderr);
  }
  if (opts.cancellation?.signal && !opts.allowAfterCancellation) {
    throw new CommandCancelledError(opts.cancellation.signal);
  }
  if (spawnError) {
    throw new Error(
      `Command failed to start: ${displayedCommand(cmd, args)}\n${spawnError.message}`,
    );
  }
  if (result.code !== 0) {
    const safeStderr = rpcUrl
      ? redactRpcDetailsInText(result.stderr.trim(), rpcUrl)
      : result.stderr.trim();
    throw new Error(
      `Command failed: ${displayedCommand(cmd, args)}` +
        `${result.signal ? ` (signal ${result.signal})` : ''}` +
        `${safeStderr ? `\n${safeStderr}` : ''}`,
    );
  }
  return result;
}

export async function runUpgradeCommand(
  cmd: string,
  args: string[],
  opts: CommandOptions = {},
): Promise<void> {
  await executeCommand(cmd, args, opts, false);
}

async function runCapture(
  cmd: string,
  args: string[],
  opts: CommandOptions = {},
): Promise<string> {
  return (await executeCommand(cmd, args, opts, true)).stdout;
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

function removeStaleAnchorGeneratedArtifacts(onchainDir: string): void {
  for (const relativePath of ['target/idl', 'target/types']) {
    const artifactPath = path.join(onchainDir, relativePath);
    if (!existsSync(artifactPath)) continue;
    rmSync(artifactPath, { recursive: true, force: true });
    console.log(`Removed stale Anchor generated artifacts: ${artifactPath}`);
  }
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

async function readProgramShow(args: {
  programId: string;
  solanaUrl: string;
  solanaConfigPath: string;
  signerInput: string;
  cwd: string;
  env: ToolEnv;
  cancellation?: CommandCancellationController;
  allowAfterCancellation?: boolean;
}): Promise<unknown> {
  const output = await runCapture(
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

export async function captureCoherentUpgradeGateState(args: {
  stage: string;
  minContextSlot: number;
  captureProgram: (stage: string) => Promise<StableProgramSnapshot>;
  inspectConfigs: (minContextSlot: number) => Promise<SharedProgramConfigAuditResult>;
}): Promise<UpgradeGateState> {
  const beforeAuditProgram = await args.captureProgram(
    `${args.stage} before config audit`,
  );
  const firstAudit = await args.inspectConfigs(
    postUpgradeConfigMinContextSlot({
      previousAuditSlot: args.minContextSlot,
      lastDeploySlot: beforeAuditProgram.show.lastDeploySlot,
    }),
  );
  const afterAuditProgram = await args.captureProgram(
    `${args.stage} after config audit`,
  );
  assertProgramSnapshotUnchanged(
    beforeAuditProgram,
    afterAuditProgram,
    `during ${args.stage}`,
  );
  const finalAudit = await args.inspectConfigs(
    postUpgradeConfigMinContextSlot({
      previousAuditSlot: firstAudit.slot,
      lastDeploySlot: afterAuditProgram.show.lastDeploySlot,
    }),
  );
  assertLineageFingerprintUnchanged(
    firstAudit.configs,
    finalAudit.configs,
    `during ${args.stage}`,
  );
  const finalProgram = await args.captureProgram(
    `${args.stage} after final config audit`,
  );
  assertProgramSnapshotUnchanged(
    afterAuditProgram,
    finalProgram,
    `during final ${args.stage} config audit`,
  );
  return {
    program: finalProgram,
    configs: finalAudit.configs,
    minContextSlot: finalAudit.slot,
  };
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

export function postUpgradeConfigMinContextSlot(args: {
  previousAuditSlot: number;
  lastDeploySlot: number;
}): number {
  if (
    !Number.isSafeInteger(args.previousAuditSlot) ||
    args.previousAuditSlot < 0 ||
    !Number.isSafeInteger(args.lastDeploySlot) ||
    args.lastDeploySlot < 0
  ) {
    throw new Error('Invalid post-upgrade context slot');
  }
  return Math.max(args.previousAuditSlot, args.lastDeploySlot);
}

async function capturePostUpgradeGateState(
  args: Parameters<typeof captureUpgradeGateState>[0],
): Promise<UpgradeGateState> {
  return captureUpgradeGateState(args);
}

function assertUpgradeGateUnchanged(
  before: UpgradeGateState,
  after: UpgradeGateState,
  stage: string,
): void {
  assertProgramSnapshotUnchanged(before.program, after.program, stage);
  assertLineageFingerprintUnchanged(before.configs, after.configs, stage);
}

export function runAfterUnchangedUpgradeGate<Result>(args: {
  before: UpgradeGateState;
  after: UpgradeGateState;
  stage: string;
  action: () => Result;
}): Result {
  assertUpgradeGateUnchanged(args.before, args.after, args.stage);
  return args.action();
}

export async function runDeployAttemptWithVerification<Result>(args: {
  deploy: () => Promise<void>;
  verify: () => Promise<Result>;
  onWarning?: (message: string) => void;
  cancellation?: CommandCancellationController;
}): Promise<Result> {
  let deployError: unknown;
  try {
    await args.deploy();
  } catch (error) {
    deployError = error;
  }

  let verified: Result | undefined;
  let verificationError: unknown;
  try {
    verified = await args.verify();
  } catch (error) {
    verificationError = error;
  }

  if (verificationError) {
    const error = new Error(
      `PROGRAM UPGRADE OUTCOME IS AMBIGUOUS; do not retry blindly.\n` +
        `Deploy command: ${deployError ? errorMessage(deployError) : 'reported success'}\n` +
        `Finalized verification: ${errorMessage(verificationError)}`,
    ) as Error & { exitCode?: number };
    const cancellationSignal =
      deployError instanceof CommandCancelledError
        ? deployError.signal
        : args.cancellation?.signal;
    if (cancellationSignal) {
      error.exitCode = cancellationSignal === 'SIGINT' ? 130 : 143;
    }
    throw error;
  }
  if (deployError instanceof CommandCancelledError) {
    throw new CommandCancelledError(
      deployError.signal,
      `${deployError.message}; finalized verification confirms the upgrade landed`,
    );
  }
  if (deployError) {
    const message =
      `Deploy command reported an error, but finalized state verifies the exact upgrade: ` +
      errorMessage(deployError);
    if (args.onWarning) args.onWarning(message);
    else console.warn(message);
  }
  return verified as Result;
}

export async function runBufferWriteAttemptWithVerification<Result>(args: {
  write: () => Promise<void>;
  verify: () => Promise<Result>;
  cancellation?: CommandCancellationController;
}): Promise<Result> {
  let writeError: unknown;
  try {
    await args.write();
  } catch (error) {
    writeError = error;
  }

  let verified: Result | undefined;
  let verificationError: unknown;
  try {
    verified = await args.verify();
  } catch (error) {
    verificationError = error;
  }

  const cancellationSignal =
    writeError instanceof CommandCancelledError
      ? writeError.signal
      : args.cancellation?.signal;
  if (verificationError) {
    const error = new Error(
      `BUFFER RECOVERY WRITE DID NOT VERIFY; the program was not upgraded. ` +
        `Do not retry until the original blockhash has expired and a finalized audit is complete.\n` +
        `Write command: ${writeError ? errorMessage(writeError) : 'reported success'}\n` +
        `Finalized verification: ${errorMessage(verificationError)}`,
    ) as Error & { exitCode?: number };
    if (cancellationSignal) {
      error.exitCode = cancellationSignal === 'SIGINT' ? 130 : 143;
    }
    throw error;
  }
  if (cancellationSignal) {
    throw new CommandCancelledError(
      cancellationSignal,
      `Buffer recovery interrupted by ${cancellationSignal}; finalized verification completed and the program was not upgraded`,
    );
  }
  if (writeError) {
    throw new Error(
      `Buffer write reported an error even though the finalized buffer is exact. ` +
        `The program was not upgraded; rerun the complete recovery workflow.\n` +
        errorMessage(writeError),
    );
  }
  return verified as Result;
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

async function executeUpgrade(args: {
  opts: ParsedCliOptions;
  drop: DeploymentDropConfigSerialized;
  target: { programId: string; buildFeature: string };
  root: string;
  onchainDir: string;
  registryPath: string;
  programBinary: string;
  solanaUrl: string;
  toolEnv: ToolEnv;
}): Promise<void> {
  const {
    opts,
    drop,
    target,
    root,
    onchainDir,
    registryPath,
    programBinary,
    solanaUrl,
    toolEnv,
  } = args;
  const programId = new PublicKey(target.programId);
  const connection = new Connection(solanaUrl, { commitment: 'finalized' });
  const cliCompatibilitySignerInput = JSON.stringify(
    Array.from(Keypair.generate().secretKey),
  );
  const cancellation = new CommandCancellationController();
  let solanaConfigPath: string | undefined;
  let authorityKeypairPath: string | undefined;
  let resumeBufferKeypairPath: string | undefined;
  let resumeBufferKeypairBytes: number | undefined;
  let resumeBufferKeypairSha256: string | undefined;
  let verifiedProgramBinaryPath: string | undefined;
  let releaseRegistryLock: (() => boolean) | undefined;
  let deployVerificationPending = false;
  let authorityPromptAbort: AbortController | undefined;
  let primaryError: unknown;
  const cleanup = (): Error[] => {
    const errors = cleanupUpgradeResources({
      filePaths: [
        solanaConfigPath,
        authorityKeypairPath,
        resumeBufferKeypairPath,
        verifiedProgramBinaryPath,
      ],
      releaseLock: releaseRegistryLock,
    });
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
    solanaConfigPath = writeTempSolanaConfigFile(solanaUrl);
    console.log('--- upgrade box_minter program ---');
    console.log('drop    :', drop.dropId);
    console.log('cluster :', drop.solanaCluster);
    console.log('rpc url :', redactRpcUrl(solanaUrl));
    console.log('program :', programId.toBase58());
    if (drop.boxMinterConfigPda) console.log('config  :', drop.boxMinterConfigPda);
    console.log('');

    const initialState = await captureUpgradeGateState({
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
      await runUpgradeCommand('npm', ['run', 'typecheck'], {
        cwd: root,
        env: toolEnv,
        cancellation,
      });
    }
    if (!opts.skipTests) {
      await runUpgradeCommand('cargo', ['test', '--lib', '--locked'], {
        cwd: onchainDir,
        env: toolEnv,
        cancellation,
      });
    }

    releaseRegistryLock = acquireDeploymentRegistryMutationLock({
      root,
      operation: `build upgrade ${drop.dropId}`,
    });
    const preBuildState = await captureUpgradeGateState({
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

    removeStaleAnchorGeneratedArtifacts(onchainDir);
    const buildFeatures = [
      'no-idl',
      'no-log-ix-name',
      target.buildFeature,
    ].join(',');
    await runUpgradeCommand(
      'anchor',
      [
        'build',
        '--no-idl',
        '--arch',
        'sbf',
        '--',
        '--features',
        buildFeatures,
        '--',
        '--locked',
      ],
      { cwd: onchainDir, env: toolEnv, cancellation },
    );
    if (!existsSync(programBinary)) {
      throw new Error(`Missing program binary after build: ${programBinary}`);
    }
    verifiedProgramBinaryPath = path.join(
      tmpdir(),
      `mons-shop-verified-program-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.so`,
    );
    copyFileSync(
      programBinary,
      verifiedProgramBinaryPath,
      fsConstants.COPYFILE_EXCL,
    );
    chmodSync(verifiedProgramBinaryPath, 0o400);
    const binaryBytes = statSync(verifiedProgramBinaryPath).size;
    const localBinary = readFileSync(verifiedProgramBinaryPath);
    const localHash = sha256(localBinary);
    if (!opts.skipTests) {
      await runUpgradeCommand(
        'cargo',
        [
          'test',
          '--locked',
          '--features',
          `sbf-tests,${target.buildFeature}`,
          '--test',
          'split_payments_sbf',
        ],
        {
          cwd: onchainDir,
          env: {
            ...toolEnv,
            BOX_MINTER_SBF_PATH: verifiedProgramBinaryPath,
          },
          cancellation,
        },
      );
    }
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

    const buildBaseline = await captureUpgradeGateState({
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
    const authority = parsePrivateKeyInput(authorityInput);
    const authorityPubkey = authority.publicKey.toBase58();
    if (buildBaseline.program.show.authority !== authorityPubkey) {
      throw new Error(
        `Private key does not match the deployed upgrade authority.\n` +
          `Expected: ${buildBaseline.program.show.authority}\n` +
        `Got     : ${authorityPubkey}`,
      );
    }
    authorityKeypairPath = writeTempKeypairFile(
      authority,
      'mons-shop-upgrade-authority',
    );
    if (resumeBufferSigner) {
      resumeBufferKeypairPath = writeTempKeypairFile(
        resumeBufferSigner,
        'mons-shop-resume-buffer',
      );
      chmodSync(resumeBufferKeypairPath, 0o400);
      resumeBufferKeypairBytes = statSync(resumeBufferKeypairPath).size;
      resumeBufferKeypairSha256 = sha256(
        readFileSync(resumeBufferKeypairPath),
      );
    }

    releaseRegistryLock = acquireDeploymentRegistryMutationLock({
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
    const lockedState = await captureUpgradeGateState({
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
    const finalPreDeployState = await captureUpgradeGateState({
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
      deployVerificationPending = true;
      try {
        const recovered = await runBufferWriteAttemptWithVerification({
          cancellation,
          write: () =>
            runUpgradeCommand(
              'solana',
              buildProgramWriteBufferArgs({
                programBinaryPath: verifiedProgramBinaryPath,
                bufferSignerPath: resumeBufferKeypairPath,
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
            const stateAfterWrite = await captureUpgradeGateState({
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
          return runUpgradeCommand('solana', commandArgs, {
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
      programBinary: path.join(
        onchainDir,
        'target',
        'deploy',
        'box_minter.so',
      ),
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
