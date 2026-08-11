import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clusterApiUrl,
  Connection,
  type AccountInfo,
  PublicKey,
} from '@solana/web3.js';
import {
  parsePrivateKeyInput,
  promptMaskedInput,
  promptYConfirmation,
} from './shared/interactive.ts';
import { acquireDeploymentRegistryMutationLock } from './shared/deploymentRegistry.ts';
import { startSolanaSignerPipe } from './shared/solanaSignerPipe.ts';

const DEVNET_GENESIS_HASH =
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PROGRAM_ID = new PublicKey(
  '8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6',
);
const PROGRAM_DATA = new PublicKey(
  'F6axngB3Xv6FxRxoTV37qpDzzApZev5VnDLwvVrBYJB3',
);
const AUTHORITY = new PublicKey(
  'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx',
);
const UPGRADEABLE_LOADER = new PublicKey(
  'BPFLoaderUpgradeab1e11111111111111111111111',
);
const PROGRAM_DATA_HEADER_BYTES = 45;
const EXPECTED_INITIAL_CAPACITY = 482_520;
const EXPECTED_INITIAL_PAYLOAD_SHA256 =
  '194596c2c11bbdb1f06d61d4876e4143a6e7fceab6dcf8cd07dfe94aa23abab4';
const EXPECTED_EXTENDED_PAYLOAD_SHA256 =
  '134a580efa9d435faf53590de5ddf3289e8001a2e6e0f006f1128c7efcabca6a';
export const SHARED_DEVNET_TARGET_CAPACITY = 518_720;
const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const RPC_TIMEOUT_MS = 30_000;

export type ProgramSnapshot = {
  authority: PublicKey;
  contextSlot: number;
  programData: Buffer;
  programDataLamports: number;
  slot: bigint;
};

function parseArgs(argv: string[]): { auditOnly: boolean } {
  if (argv.length === 0) return { auditOnly: false };
  if (argv.length === 1 && argv[0] === '--audit-only') {
    return { auditOnly: true };
  }
  throw new Error(
    'Usage: npm run extend:shared-devnet [-- --audit-only]',
  );
}

export function extensionBytesForCapacity(
  currentCapacity: number,
  targetCapacity = SHARED_DEVNET_TARGET_CAPACITY,
): number {
  if (!Number.isSafeInteger(currentCapacity) || currentCapacity <= 0) {
    throw new Error(`Invalid current ProgramData capacity: ${currentCapacity}`);
  }
  if (!Number.isSafeInteger(targetCapacity) || targetCapacity <= 0) {
    throw new Error(`Invalid target ProgramData capacity: ${targetCapacity}`);
  }
  if (currentCapacity > targetCapacity) {
    throw new Error(
      `ProgramData capacity ${currentCapacity} already exceeds expected target ${targetCapacity}`,
    );
  }
  return targetCapacity - currentCapacity;
}

export function buildExtendProgramArgs(args: {
  additionalBytes: number;
  rpcUrl: string;
  signerPath: string;
}): string[] {
  return [
    'program',
    'extend',
    PROGRAM_ID.toBase58(),
    String(args.additionalBytes),
    '--url',
    args.rpcUrl,
    '--keypair',
    args.signerPath,
    '--commitment',
    'finalized',
    '--output',
    'json',
  ];
}

function requireAccount(
  account: AccountInfo<Buffer> | null,
  label: string,
): AccountInfo<Buffer> {
  if (!account) throw new Error(`Missing ${label} account`);
  return account;
}

async function readProgramSnapshot(
  connection: Connection,
  minContextSlot?: number,
): Promise<ProgramSnapshot> {
  const [genesisHash, accounts] = await withTimeout(Promise.all([
    connection.getGenesisHash(),
    connection.getMultipleAccountsInfoAndContext(
      [PROGRAM_ID, PROGRAM_DATA],
      { commitment: 'finalized', minContextSlot },
    ),
  ]), 'reading finalized program state');
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error(`Refusing unexpected genesis hash: ${genesisHash}`);
  }

  const program = requireAccount(accounts.value[0], 'program');
  if (!program.executable || !program.owner.equals(UPGRADEABLE_LOADER)) {
    throw new Error('Program executable or owner mismatch');
  }
  if (
    program.data.length !== 36 ||
    program.data.readUInt32LE(0) !== 2 ||
    !new PublicKey(program.data.subarray(4, 36)).equals(PROGRAM_DATA)
  ) {
    throw new Error('Program account state mismatch');
  }

  const programData = requireAccount(accounts.value[1], 'ProgramData');
  if (!programData.owner.equals(UPGRADEABLE_LOADER)) {
    throw new Error('ProgramData owner mismatch');
  }
  if (
    programData.data.length < PROGRAM_DATA_HEADER_BYTES ||
    programData.data.readUInt32LE(0) !== 3 ||
    programData.data[12] !== 1
  ) {
    throw new Error('ProgramData state mismatch');
  }
  const authority = new PublicKey(programData.data.subarray(13, 45));
  if (!authority.equals(AUTHORITY)) {
    throw new Error(
      `Upgrade authority is ${authority.toBase58()}, expected ${AUTHORITY.toBase58()}`,
    );
  }

  return {
    authority,
    contextSlot: accounts.context.slot,
    programData: Buffer.from(programData.data),
    programDataLamports: programData.lamports,
    slot: programData.data.readBigUInt64LE(4),
  };
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out ${label}`)),
          RPC_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function assertProgramSnapshotUnchanged(args: {
  before: ProgramSnapshot;
  after: ProgramSnapshot;
}): void {
  if (!args.after.authority.equals(args.before.authority)) {
    throw new Error('Upgrade authority changed before extension');
  }
  if (args.after.slot !== args.before.slot) {
    throw new Error('ProgramData deployment slot changed before extension');
  }
  if (args.after.programDataLamports !== args.before.programDataLamports) {
    throw new Error('ProgramData balance changed before extension');
  }
  if (!args.after.programData.equals(args.before.programData)) {
    throw new Error('ProgramData account changed before extension');
  }
}

export function assertExtensionResult(args: {
  before: ProgramSnapshot;
  after: ProgramSnapshot;
  minimumLamports?: number;
}): void {
  const beforeCapacity =
    args.before.programData.length - PROGRAM_DATA_HEADER_BYTES;
  const afterCapacity =
    args.after.programData.length - PROGRAM_DATA_HEADER_BYTES;
  if (afterCapacity !== SHARED_DEVNET_TARGET_CAPACITY) {
    throw new Error(
      `Final ProgramData capacity is ${afterCapacity}, expected ${SHARED_DEVNET_TARGET_CAPACITY}`,
    );
  }
  if (!args.after.authority.equals(args.before.authority)) {
    throw new Error('Upgrade authority changed during extension');
  }
  if (args.after.slot <= args.before.slot) {
    throw new Error('ProgramData deployment slot did not advance');
  }
  if (BigInt(args.after.contextSlot) < args.after.slot) {
    throw new Error('Finalized snapshot predates the ProgramData deployment slot');
  }
  if (
    args.minimumLamports !== undefined &&
    args.after.programDataLamports < args.minimumLamports
  ) {
    throw new Error('Extended ProgramData account is not rent exempt');
  }

  const beforePayload = args.before.programData.subarray(
    PROGRAM_DATA_HEADER_BYTES,
  );
  const afterPayload = args.after.programData.subarray(
    PROGRAM_DATA_HEADER_BYTES,
  );
  if (!afterPayload.subarray(0, beforeCapacity).equals(beforePayload)) {
    throw new Error('Deployed program payload changed during extension');
  }
  if (afterPayload.subarray(beforeCapacity).some((byte) => byte !== 0)) {
    throw new Error('ProgramData extension contains unexpected nonzero bytes');
  }
}

async function runSolanaExtend(args: {
  additionalBytes: number;
  rpcUrl: string;
  signerPath: string;
  signerServer: ChildProcess;
  onChild: (child: ChildProcess | undefined) => void;
}): Promise<void> {
  const child = spawn(
    'solana',
    buildExtendProgramArgs(args),
    {
      env: { ...process.env, NO_DNA: '1' },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  args.onChild(child);
  let timedOut = false;
  let signerError: Error | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const onSignerClose = (code: number | null, signal: NodeJS.Signals | null) => {
    signerError = new Error(
      `Private signer process exited unexpectedly with ${signal || code}`,
    );
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    killTimer.unref();
  };
  args.signerServer.once('close', onSignerClose);
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    killTimer.unref();
  }, 180_000);
  timeout.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      let spawnError: Error | undefined;
      child.once('error', (error) => {
        spawnError = error;
      });
      child.once('close', (code, signal) => {
        if (signerError) {
          reject(signerError);
          return;
        }
        if (spawnError) {
          reject(spawnError);
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            timedOut
              ? 'solana program extend timed out'
              : `solana program extend exited with ${signal || code}`,
          ),
        );
      });
    });
  } finally {
    args.signerServer.removeListener('close', onSignerClose);
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    args.onChild(undefined);
  }
}

async function stopSignerServer(server: ChildProcess | undefined): Promise<void> {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const closed = new Promise<void>((resolve) =>
    server.once('close', () => resolve()),
  );
  server.kill('SIGTERM');
  let timer: NodeJS.Timeout | undefined;
  const stopped = await Promise.race([
    closed.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), 2_000);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (stopped) return;
  server.kill('SIGKILL');
  await withTimeout(closed, 'stopping the private signer process');
}

function cancellationError(
  signal: 'SIGINT' | 'SIGTERM',
): Error & { exitCode: number } {
  const error = new Error(`Cancelled by ${signal}`) as Error & {
    exitCode: number;
  };
  error.exitCode = signal === 'SIGINT' ? 130 : 143;
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function combineErrors(
  primary: unknown,
  secondary: unknown,
  secondaryLabel: string,
): Error {
  if (!primary) return new Error(`${secondaryLabel}: ${errorMessage(secondary)}`);
  const combined = new Error(
    `${errorMessage(primary)}; ${secondaryLabel}: ${errorMessage(secondary)}`,
  ) as Error & { exitCode?: number };
  const exitCode = (primary as { exitCode?: unknown })?.exitCode;
  if (typeof exitCode === 'number') combined.exitCode = exitCode;
  return combined;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rpcUrl = clusterApiUrl('devnet');
  const connection = new Connection(rpcUrl, 'finalized');
  const before = await readProgramSnapshot(connection);
  const currentCapacity =
    before.programData.length - PROGRAM_DATA_HEADER_BYTES;
  if (
    currentCapacity !== EXPECTED_INITIAL_CAPACITY &&
    currentCapacity !== SHARED_DEVNET_TARGET_CAPACITY
  ) {
    throw new Error(
      `Refusing unexpected ProgramData capacity ${currentCapacity}; expected ${EXPECTED_INITIAL_CAPACITY} or ${SHARED_DEVNET_TARGET_CAPACITY}`,
    );
  }
  const payloadHash = createHash('sha256')
    .update(before.programData.subarray(PROGRAM_DATA_HEADER_BYTES))
    .digest('hex');
  const expectedPayloadHash =
    currentCapacity === EXPECTED_INITIAL_CAPACITY
      ? EXPECTED_INITIAL_PAYLOAD_SHA256
      : EXPECTED_EXTENDED_PAYLOAD_SHA256;
  if (payloadHash !== expectedPayloadHash) {
    throw new Error(
      `Refusing unexpected deployed program payload ${payloadHash}`,
    );
  }
  const additionalBytes = extensionBytesForCapacity(currentCapacity);
  const targetRent = await connection.getMinimumBalanceForRentExemption(
    PROGRAM_DATA_HEADER_BYTES + SHARED_DEVNET_TARGET_CAPACITY,
    'finalized',
  );
  const rentDelta = Math.max(0, targetRent - before.programDataLamports);
  const authorityBalance = await connection.getBalance(AUTHORITY, 'finalized');

  console.log('--- extend shared devnet ProgramData ---');
  console.log('cluster          : devnet');
  console.log('rpc              :', rpcUrl);
  console.log('program          :', PROGRAM_ID.toBase58());
  console.log('program data     :', PROGRAM_DATA.toBase58());
  console.log('authority/payer  :', AUTHORITY.toBase58());
  console.log('current capacity :', currentCapacity);
  console.log('target capacity  :', SHARED_DEVNET_TARGET_CAPACITY);
  console.log('additional bytes :', additionalBytes);
  console.log('rent delta       :', `${rentDelta} lamports`);
  console.log('authority balance:', `${authorityBalance} lamports`);
  console.log('preflight        : enabled');
  console.log('program code     : unchanged');

  if (additionalBytes === 0) {
    console.log('ProgramData already has the target capacity. Nothing to send.');
    return;
  }
  if (authorityBalance < rentDelta + 5_000) {
    throw new Error('Upgrade authority balance is insufficient');
  }
  if (options.auditOnly) {
    console.log('Audit-only complete; no credential prompt or transaction.');
    return;
  }

  const confirmed = await promptYConfirmation(
    "Type 'y' to extend devnet ProgramData: ",
  );
  if (!confirmed) {
    console.log('Cancelled.');
    return;
  }

  console.log('Enter the upgrade authority private key (input is hidden).');
  console.log('Accepted formats: base58 secret key or a JSON byte array.');
  const promptAbort = new AbortController();
  const abortPromptForSigint = () =>
    promptAbort.abort(cancellationError('SIGINT'));
  const abortPromptForSigterm = () =>
    promptAbort.abort(cancellationError('SIGTERM'));
  process.once('SIGINT', abortPromptForSigint);
  process.once('SIGTERM', abortPromptForSigterm);
  let keyInput: string;
  try {
    keyInput = await promptMaskedInput('upgrade authority private key: ', {
      signal: promptAbort.signal,
    });
  } finally {
    process.removeListener('SIGINT', abortPromptForSigint);
    process.removeListener('SIGTERM', abortPromptForSigterm);
  }
  let authority: ReturnType<typeof parsePrivateKeyInput>;
  try {
    authority = parsePrivateKeyInput(keyInput);
  } finally {
    keyInput = '';
  }
  if (!authority.publicKey.equals(AUTHORITY)) {
    authority.secretKey.fill(0);
    throw new Error(
      `Private key address is ${authority.publicKey.toBase58()}, expected ${AUTHORITY.toBase58()}`,
    );
  }
  console.log('Private key address verified:', authority.publicKey.toBase58());

  let signerDirectory: string | undefined;
  let signerServer: ChildProcess | undefined;
  let activeChild: ChildProcess | undefined;
  let activeChildKillTimer: NodeJS.Timeout | undefined;
  let requestedSignal: 'SIGINT' | 'SIGTERM' | undefined;
  let repeatedSignal = false;
  const handleSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    if (requestedSignal) repeatedSignal = true;
    else requestedSignal = signal;
    if (!activeChild) return;
    activeChild.kill(repeatedSignal ? 'SIGKILL' : signal);
    if (!repeatedSignal && !activeChildKillTimer) {
      const child = activeChild;
      activeChildKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      activeChildKillTimer.unref();
    }
  };
  const onSigint = () => handleSignal('SIGINT');
  const onSigterm = () => handleSignal('SIGTERM');
  let releaseLock: (() => boolean) | undefined;
  try {
    releaseLock = acquireDeploymentRegistryMutationLock({
      root: ROOT_DIR,
      operation: 'extend-shared-devnet-program',
    });
  } catch (error) {
    authority.secretKey.fill(0);
    throw error;
  }
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  let commandError: unknown;
  let resultError: unknown;
  let sendAttempted = false;
  try {
    const preSend = await readProgramSnapshot(connection, before.contextSlot);
    assertProgramSnapshotUnchanged({ before, after: preSend });
    const preSendCapacity =
      preSend.programData.length - PROGRAM_DATA_HEADER_BYTES;
    if (extensionBytesForCapacity(preSendCapacity) !== additionalBytes) {
      throw new Error('ProgramData extension amount changed before send; rerun');
    }
    if (requestedSignal) throw cancellationError(requestedSignal);

    signerDirectory = mkdtempSync(
      path.join(tmpdir(), 'mons-shared-devnet-extend-'),
    );
    const signerPath = path.join(signerDirectory, 'authority.pipe');
    signerServer = await startSolanaSignerPipe(
      signerPath,
      authority.secretKey,
    );
    authority.secretKey.fill(0);
    if (requestedSignal) throw cancellationError(requestedSignal);
    try {
      sendAttempted = true;
      await runSolanaExtend({
        additionalBytes,
        rpcUrl,
        signerPath,
        signerServer,
        onChild: (child) => {
          if (activeChildKillTimer) clearTimeout(activeChildKillTimer);
          activeChildKillTimer = undefined;
          activeChild = child;
          if (child && requestedSignal) {
            child.kill(repeatedSignal ? 'SIGKILL' : requestedSignal);
          }
        },
      });
    } catch (error) {
      commandError = error;
    }
    let preVerificationCleanupError: unknown;
    try {
      await stopSignerServer(signerServer);
      signerServer = undefined;
    } catch (error) {
      preVerificationCleanupError = error;
    }
    if (!signerServer) {
      try {
        rmSync(signerDirectory, { force: true, recursive: true });
        signerDirectory = undefined;
      } catch (error) {
        preVerificationCleanupError = combineErrors(
          preVerificationCleanupError,
          error,
          'failed to remove private signer directory',
        );
      }
    }

    let after: ProgramSnapshot;
    try {
      after = await readProgramSnapshot(connection, preSend.contextSlot);
    } catch (error) {
      throw new Error(
        `PROGRAMDATA EXTENSION OUTCOME IS AMBIGUOUS. DO NOT RETRY THIS COMMAND. Return this output for operator review; retry is forbidden until the original recent blockhash has expired and a finalized audit confirms the exact initial state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      assertExtensionResult({
        before: preSend,
        after,
        minimumLamports: targetRent,
      });
    } catch (verificationError) {
      throw new Error(
        `PROGRAMDATA EXTENSION OUTCOME IS AMBIGUOUS. DO NOT RETRY THIS COMMAND. Return this output for operator review; retry is forbidden until the original recent blockhash has expired and a finalized audit confirms the exact initial state: ${commandError ? `${commandError instanceof Error ? commandError.message : String(commandError)}; ` : ''}${verificationError instanceof Error ? verificationError.message : String(verificationError)}`,
      );
    }

    if (commandError) {
      console.warn(
        'ProgramData extension finalized despite the CLI confirmation error:',
        commandError instanceof Error ? commandError.message : String(commandError),
      );
    }
    console.log('ProgramData extension verified at finalized commitment.');
    console.log(
      'new capacity:',
      after.programData.length - PROGRAM_DATA_HEADER_BYTES,
    );
    console.log('new slot    :', after.slot.toString());
    if (preVerificationCleanupError) {
      throw combineErrors(
        undefined,
        preVerificationCleanupError,
        'extension landed but private signer cleanup failed',
      );
    }
    if (requestedSignal) throw cancellationError(requestedSignal);
  } catch (error) {
    resultError = requestedSignal
      ? sendAttempted
        ? combineErrors(
            cancellationError(requestedSignal),
            error,
            'finalized extension outcome',
          )
        : cancellationError(requestedSignal)
      : error;
  } finally {
    authority.secretKey.fill(0);
    if (activeChildKillTimer) clearTimeout(activeChildKillTimer);
    try {
      await stopSignerServer(signerServer);
    } catch (error) {
      resultError = combineErrors(
        resultError,
        error,
        'failed to stop private signer process',
      );
    }
    if (signerDirectory) {
      try {
        rmSync(signerDirectory, { force: true, recursive: true });
      } catch (error) {
        resultError = combineErrors(
          resultError,
          error,
          'failed to remove private signer directory',
        );
      }
    }
    if (!releaseLock()) {
      resultError = combineErrors(
        resultError,
        new Error('lock removal returned false'),
        'failed to release deployment-registry lock',
      );
    }
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
  if (resultError) throw resultError;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return Boolean(
    entry && path.resolve(entry) === fileURLToPath(import.meta.url),
  );
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode =
      typeof (error as { exitCode?: unknown })?.exitCode === 'number'
        ? Number((error as { exitCode: number }).exitCode)
        : 1;
  });
}
