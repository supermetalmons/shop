import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { BPF_LOADER_UPGRADEABLE, sha256 } from './upgradeProgramSnapshot.ts';
import { CommandCancelledError, type CommandCancellationController } from './upgradeCommandRunner.ts';

const UPGRADEABLE_LOADER_BUFFER_METADATA_BYTES = 37;

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

export async function captureResumeBufferSnapshot(args: {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
