import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';

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

export const BPF_LOADER_UPGRADEABLE =
  'BPFLoaderUpgradeab1e11111111111111111111111';

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

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
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

function normalizeProgramShowInfo(
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
