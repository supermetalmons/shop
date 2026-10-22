import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { build } from 'esbuild';
import { parseConfigFileTextToJson } from 'typescript';
import { PublicKey, TransactionInstruction, VersionedTransaction, type Connection, type SimulatedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';
import { createScriptSolanaConnection } from '../../shared/solanaRpcEnvironment.ts';
import { createWorkerVersionClient, type WorkerSnapshot, type TemporaryWorkerVersion, type SourceRestoration } from './cloudflare.ts';
import { assertSignedTransaction, buildTransaction } from './transaction.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const GENESIS = { 'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' };

export type WorkerTransactionOperation = {
  id: string;
  cluster: keyof typeof GENESIS;
  authority: string;
  instructions: TransactionInstruction[];
  simulationAccounts: string[];
  maxFeeLamports?: number;
  preflight: (connection: Connection) => Promise<void>;
  validateSimulation: (result: SimulatedTransactionResponse) => void | Promise<void>;
  verify: (connection: Connection, finalizedSlot: number) => Promise<void>;
};

export type WorkerTransactionOptions = {
  write?: boolean;
  root?: string;
  cloudflare?: { accountId: string; workerName: string };
  signerBinding?: string;
};

type Client = ReturnType<typeof createWorkerVersionClient>;
type Cleanup = Awaited<ReturnType<Client['verifyRemoved']>>;
type Prepared = { transactionBase64: string; blockhash: string; lastValidBlockHeight: number; slot: number };
export type WorkerTransactionJournal = {
  version: 1;
  operationId: string;
  intentHash: string;
  attemptId: string;
  target: { accountId: string; workerName: string };
  signerBinding: string;
  snapshot: WorkerSnapshot;
  prepared: Prepared;
  uploadStarted: boolean;
  workerVersion?: TemporaryWorkerVersion;
  restoration?: SourceRestoration;
  signed?: { transactionBase64: string; signature: string };
  finalized?: { slot: number; feeLamports: number };
  cleanup?: Cleanup;
};

type Dependencies = {
  connection?: Connection;
  client?: Client;
  bundle?: typeof signerBundle;
  fetch?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
};

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function operationIntent(operation: WorkerTransactionOperation) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(operation.id) || !Object.hasOwn(GENESIS, operation.cluster)) throw new Error('Invalid operation ID or cluster.');
  const maxFeeLamports = operation.maxFeeLamports ?? 10_000;
  if (!Number.isSafeInteger(maxFeeLamports) || maxFeeLamports <= 0 || operation.simulationAccounts.length > 20 ||
    !['preflight', 'validateSimulation', 'verify'].every(key => typeof operation[key] === 'function')) throw new Error('Operation checks, simulation accounts, or fee limit are invalid.');
  buildTransaction(operation.authority, operation.instructions, '11111111111111111111111111111111');
  return { id: operation.id, cluster: operation.cluster, authority: operation.authority, maxFeeLamports,
    simulationAccounts: operation.simulationAccounts,
    instructions: operation.instructions.map(instruction => ({ programId: instruction.programId.toBase58(),
      keys: instruction.keys.map(key => ({ address: key.pubkey.toBase58(), isSigner: key.isSigner, isWritable: key.isWritable })),
      data: instruction.data.toString('base64') })),
  };
}

function save(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = openSync(temporary, 'w', 0o600);
  try { writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(handle); } finally { closeSync(handle); }
  renameSync(temporary, file);
  const directory = openSync(path.dirname(file), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function cloudflareToken(root: string): string {
  if (process.env.CLOUDFLARE_API_TOKEN?.trim()) return process.env.CLOUDFLARE_API_TOKEN.trim();
  for (const name of ['.env.local', '.env']) {
    const file = path.join(root, name);
    if (existsSync(file)) {
      const token = parseEnv(readFileSync(file, 'utf8')).CLOUDFLARE_API_TOKEN?.trim();
      if (token) return token;
    }
  }
  throw new Error('CLOUDFLARE_API_TOKEN is unavailable.');
}

function workerTarget(root: string): NonNullable<WorkerTransactionOptions['cloudflare']> {
  const file = path.join(root, 'cloud/workers/api/wrangler.jsonc');
  const parsed = parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));
  if (parsed.error || typeof parsed.config?.account_id !== 'string' || typeof parsed.config?.name !== 'string') throw new Error('Invalid API Worker configuration.');
  return { accountId: parsed.config.account_id, workerName: parsed.config.name };
}

function acquireWorkerTransactionLock(file: string): number {
  mkdirSync(path.dirname(file), { recursive: true });
  try { return openSync(file, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let pid = 'unknown';
    try { const value = readFileSync(file, 'utf8').trim(); if (/^\d+$/.test(value)) pid = value; } catch {}
    throw new Error(`Worker transaction locked by PID ${pid}. Verify it has stopped before removing only ${file}; preserve all journals and retry.`);
  }
}

function assertNoPendingWorkerCleanup(root: string, operationId: string, target: NonNullable<WorkerTransactionOptions['cloudflare']>): void {
  const directory = path.join(root, '.cache/worker-transactions');
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === operationId) continue;
    const file = path.join(directory, entry.name, 'journal.json');
    if (!existsSync(file)) continue;
    let pending: WorkerTransactionJournal;
    try { pending = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new Error(`Cannot inspect Worker cleanup journal ${file}; preserve it and resolve it before starting another operation.`); }
    if (pending?.version !== 1 || typeof pending.target?.accountId !== 'string' || typeof pending.target?.workerName !== 'string') {
      throw new Error(`Invalid Worker cleanup journal ${file}; preserve it for inspection.`);
    }
    if (pending.target.accountId.toLowerCase() === target.accountId.toLowerCase() && pending.target.workerName === target.workerName &&
      pending.cleanup?.absent !== true &&
      (pending.uploadStarted !== false || pending.workerVersion || pending.signed || pending.restoration?.started)) {
      throw new Error(`Operation ${entry.name} has unresolved Worker cleanup. Resume that operation before starting another for ${target.workerName}.`);
    }
  }
}

async function signerBundle(config: { messageBase64: string; authority: string; signerBinding: string; tokenHash: string; expiresAt: number }): Promise<string> {
  const result = await build({
    stdin: { contents: `import { createWorkerTransactionSigner } from './scripts/ops/worker-transaction/signer.ts';\nexport default createWorkerTransactionSigner(${JSON.stringify(config)});`,
      resolveDir: ROOT, sourcefile: 'worker-transaction-entry.ts', loader: 'ts' },
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false, external: ['node:*'], logLevel: 'silent',
  });
  if (result.outputFiles.length !== 1) throw new Error('Unexpected signer bundle output.');
  return result.outputFiles[0].text;
}

async function simulate(operation: WorkerTransactionOperation, connection: Connection, transaction: VersionedTransaction, slot: number, signed: boolean) {
  const result = await connection.simulateTransaction(transaction, { commitment: 'finalized', minContextSlot: slot, sigVerify: signed,
    ...(operation.simulationAccounts.length ? { accounts: { encoding: 'base64' as const, addresses: operation.simulationAccounts } } : {}),
  });
  if (result.value.err || result.context.slot < slot) throw new Error('Transaction simulation failed or returned stale state.');
  await operation.validateSimulation(result.value);
  const fee = (await connection.getFeeForMessage(transaction.message, 'finalized')).value;
  if (!Number.isSafeInteger(fee) || fee! < 0 || fee! > (operation.maxFeeLamports ?? 10_000)) throw new Error('Transaction fee is unavailable or exceeds the operation limit.');
  return { feeLamports: fee!, unitsConsumed: result.value.unitsConsumed };
}

async function prepare(operation: WorkerTransactionOperation, connection: Connection) {
  await operation.preflight(connection);
  const block = await connection.getLatestBlockhashAndContext('finalized');
  const transaction = buildTransaction(operation.authority, operation.instructions, block.value.blockhash);
  const simulation = await simulate(operation, connection, transaction, block.context.slot, false);
  return { prepared: { transactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
    ...block.value, slot: block.context.slot }, simulation };
}

async function cleanupWorkerTransaction(client: Client, journal: WorkerTransactionJournal, persist: () => void): Promise<void> {
  if (journal.uploadStarted === false && !journal.workerVersion && !journal.signed) return;
  const versions = journal.workerVersion ? [journal.workerVersion] : await client.findOperation({ operationId: journal.attemptId, snapshot: journal.snapshot });
  if (versions.length !== 1) throw new Error('Worker upload outcome is unresolved. Preserve the journal and retry recovery.');
  const version = versions[0];
  journal.workerVersion = version;
  persist();
  await client.remove({ snapshot: journal.snapshot, version, restoration: journal.restoration,
    onRestorationChange: state => { journal.restoration = state; persist(); } });
  journal.cleanup = await client.verifyRemoved({ snapshot: journal.snapshot, version });
  persist();
}

async function settleWorkerTransaction(operation: WorkerTransactionOperation, connection: Connection, journal: WorkerTransactionJournal,
  persist: () => void, wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds))) {
  if (!journal.signed) throw new Error('No signed transaction is recorded.');
  const expected = buildTransaction(operation.authority, operation.instructions, journal.prepared.blockhash).message.serialize();
  const transaction = VersionedTransaction.deserialize(Buffer.from(journal.signed.transactionBase64, 'base64'));
  if (assertSignedTransaction(transaction, expected, operation.authority) !== journal.signed.signature) throw new Error('Recorded transaction identity mismatch.');
  const status = async () => (await connection.getSignatureStatuses([journal.signed!.signature], { searchTransactionHistory: true })).value[0];
  let observed = await status();
  if (!observed) {
    if (await connection.getBlockHeight('finalized') > journal.prepared.lastValidBlockHeight) throw new Error('Recorded transaction expired without confirmation. Inspect its signature and chain state before retiring this journal; no new transaction was created.');
    await operation.preflight(connection);
    await simulate(operation, connection, transaction, journal.prepared.slot, true);
    try {
      const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, preflightCommitment: 'finalized', maxRetries: 3 });
      if (signature !== journal.signed.signature) throw new Error('Unexpected submission signature.');
    } catch {}
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    if (observed?.err) throw new Error('Recorded transaction failed on-chain. Preserve its journal for inspection.');
    if (observed?.confirmationStatus === 'finalized') {
      await operation.verify(connection, observed.slot);
      const details = await connection.getTransaction(journal.signed.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
      if (!details?.meta || details.meta.err) throw new Error('Finalized transaction details are unavailable.');
      journal.finalized = { slot: observed.slot, feeLamports: details.meta.fee };
      persist();
      return;
    }
    await wait(1000);
    observed = await status();
  }
  throw new Error('Finalization is not established. Preserve the journal and retry the same operation.');
}

export async function runWorkerTransaction(operation: WorkerTransactionOperation, options: WorkerTransactionOptions = {}, dependencies: Dependencies = {}) {
  operation = {
    ...operation,
    instructions: operation.instructions.map(instruction => new TransactionInstruction({
      programId: new PublicKey(instruction.programId.toBytes()),
      keys: instruction.keys.map(key => ({ ...key, pubkey: new PublicKey(key.pubkey.toBytes()) })),
      data: Buffer.from(instruction.data),
    })),
    simulationAccounts: [...operation.simulationAccounts],
    preflight: operation.preflight.bind(operation),
    validateSimulation: operation.validateSimulation.bind(operation),
    verify: operation.verify.bind(operation),
  };
  options = { ...options, ...(options.cloudflare ? { cloudflare: { ...options.cloudflare } } : {}) };
  const intent = operationIntent(operation);
  const intentHash = hash(JSON.stringify(intent));
  const root = path.resolve(options.root ?? ROOT);
  const directory = path.join(root, '.cache/worker-transactions', operation.id);
  const journalPath = path.join(directory, 'journal.json');
  let journal: WorkerTransactionJournal | undefined = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : undefined;
  const connect = () => dependencies.connection ?? createScriptSolanaConnection({ cluster: operation.cluster, root });
  if (!options.write) {
    const connection = connect();
    if (await connection.getGenesisHash() !== GENESIS[operation.cluster]) throw new Error('RPC cluster mismatch.');
    if (journal && journal.intentHash !== intentHash) throw new Error('Operation input differs from its recorded journal.');
    if (journal?.finalized) {
      if (!journal.signed) throw new Error('Finalized journal has no signed transaction.');
      const transaction = VersionedTransaction.deserialize(Buffer.from(journal.signed.transactionBase64, 'base64'));
      const expected = buildTransaction(operation.authority, operation.instructions, journal.prepared.blockhash).message.serialize();
      if (assertSignedTransaction(transaction, expected, operation.authority) !== journal.signed.signature) throw new Error('Recorded transaction identity mismatch.');
      const status = (await connection.getSignatureStatuses([journal.signed.signature], { searchTransactionHistory: true })).value[0];
      if (status?.err || status?.confirmationStatus !== 'finalized' || status.slot !== journal.finalized.slot) throw new Error('Recorded finalization is not confirmed.');
      await operation.verify(connection, status.slot);
      return { mode: 'verified' as const, signature: journal.signed!.signature, ...journal.finalized, cleanupComplete: Boolean(journal.cleanup) };
    }
    return { mode: 'preflight' as const, intent, ...(await prepare(operation, connection)).simulation, pendingAttempt: journal?.attemptId };
  }
  const operationLockPath = path.join(directory, 'operation.lock');
  const operationLock = acquireWorkerTransactionLock(operationLockPath);
  let lockPath: string | undefined;
  let lock: number | undefined;
  let client: Client | undefined;
  const persist = () => save(journalPath, journal);
  try {
    writeFileSync(operationLock, String(process.pid));
    journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : undefined;
    const selectedTarget = journal?.target ?? options.cloudflare ?? workerTarget(root);
    const target = { ...selectedTarget, accountId: selectedTarget.accountId.toLowerCase() };
    const signerBinding = journal?.signerBinding ?? options.signerBinding ?? 'COSIGNER_SECRET';
    if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(signerBinding)) throw new Error('Invalid signer binding name.');
    client = dependencies.client ?? createWorkerVersionClient({ token: cloudflareToken(root), target, signerBinding });
    lockPath = path.join(root, '.cache/worker-transactions/locks', `${target.accountId}-${target.workerName}.lock`);
    lock = acquireWorkerTransactionLock(lockPath);
    writeFileSync(lock, String(process.pid));
    if (journal) {
      if (journal.version !== 1 || journal.operationId !== operation.id) throw new Error('Invalid operation journal.');
      if (!journal.cleanup) await cleanupWorkerTransaction(client, journal, persist);
      if ((options.cloudflare && (options.cloudflare.accountId.toLowerCase() !== target.accountId || options.cloudflare.workerName !== target.workerName)) ||
        (options.signerBinding && options.signerBinding !== signerBinding)) throw new Error('Worker target or signer binding differs from the recorded journal.');
      if (journal.intentHash !== intentHash) throw new Error('Operation input differs from its recorded journal; cleanup completed before refusing submission.');
      if (!journal.signed) {
        renameSync(journalPath, path.join(directory, `${journal.attemptId}.json`));
        journal = undefined;
      }
    }
    if (!journal) assertNoPendingWorkerCleanup(root, operation.id, target);
    const connection = connect();
    if (await connection.getGenesisHash() !== GENESIS[operation.cluster]) throw new Error('RPC cluster mismatch.');
    if (!journal) {
      const snapshot = await client.snapshot();
      const { prepared } = await prepare(operation, connection);
      const unsigned = VersionedTransaction.deserialize(Buffer.from(prepared.transactionBase64, 'base64'));
      const token = randomBytes(32).toString('hex');
      const bundle = await (dependencies.bundle ?? signerBundle)({ messageBase64: Buffer.from(unsigned.message.serialize()).toString('base64'),
        authority: operation.authority, signerBinding, tokenHash: hash(token), expiresAt: Date.now() + 15 * 60_000 });
      journal = { version: 1, operationId: operation.id, intentHash, attemptId: randomUUID(), target, signerBinding, snapshot, prepared, uploadStarted: false };
      persist();
      journal.workerVersion = await client.upload({ snapshot, bundle, operationId: journal.attemptId,
        onUploadChange: started => { journal!.uploadStarted = started; persist(); } });
      persist();
      await client.assertUnchanged(snapshot);
      const response = await (dependencies.fetch ?? fetch)(`${journal.workerVersion.url}/sign`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`Temporary signer returned HTTP ${response.status}.`);
      const result = await response.json() as { signature?: string };
      if (typeof result.signature !== 'string' || result.signature.length > 100) throw new Error('Invalid signer response.');
      unsigned.signatures[0] = bs58.decode(result.signature);
      const signature = assertSignedTransaction(unsigned, unsigned.message.serialize(), operation.authority);
      journal.signed = { transactionBase64: Buffer.from(unsigned.serialize()).toString('base64'), signature };
      persist();
    }
    await settleWorkerTransaction(operation, connection, journal, persist, dependencies.wait);
    if (!journal.cleanup) await cleanupWorkerTransaction(client, journal, persist);
    const receipt = { operationId: operation.id, intentHash, intent, signature: journal.signed!.signature, finalizedSlot: journal.finalized!.slot,
      feeLamports: journal.finalized!.feeLamports, worker: { target, sourceVersion: journal.snapshot.versionId, previousLatestVersion: journal.snapshot.latestVersionId,
        temporaryVersion: journal.workerVersion?.id, ...journal.cleanup } };
    save(path.join(directory, 'receipt.json'), receipt);
    return { mode: 'complete' as const, ...receipt };
  } finally {
    try { if (journal && !journal.cleanup && client && lock !== undefined) await cleanupWorkerTransaction(client, journal, persist); }
    finally {
      if (lock !== undefined) { closeSync(lock); rmSync(lockPath!, { force: true }); }
      closeSync(operationLock); rmSync(operationLockPath, { force: true });
    }
  }
}
