import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, type Connection } from '@solana/web3.js';
import type { SolanaCluster } from '../../shared/deploymentCore.ts';

const START_MINT = createHash('sha256').update('global:start_mint').digest().subarray(0, 8);
const STATUSES = ['signed', 'finalized', 'failed', 'expired', 'state-verified'] as const;

export type ActivationIdentity = {
  dropId: string;
  cluster: SolanaCluster;
  programId: string;
  mintConfig: string;
  operationsConfig?: string;
  authority: string;
  manifestSha256?: string;
};

export type ActivationAttempt = {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  transactionBase64: string;
  status: (typeof STATUSES)[number];
  signedAt?: string;
  resolvedAt?: string;
  finalizedSlot?: number;
};

export type ActivationJournal = ActivationIdentity & {
  version: 2;
  createdAt: string;
  status: 'prepared' | 'signed' | 'active';
  attempts: ActivationAttempt[];
  activeState?: { slot: number; verifiedAt: string };
  smoke?: { runId?: string; status: 'running' | 'passed' | 'cancelled' | 'recovery-required' | 'recovered' };
};

export type ActivationChainState = { started: boolean; minted: number; authority: string; slot: number };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function buildMintActivationTransaction(identity: ActivationIdentity, blockhash: string): VersionedTransaction {
  const authority = new PublicKey(identity.authority);
  const instruction = new TransactionInstruction({
    programId: new PublicKey(identity.programId),
    keys: [{ pubkey: new PublicKey(identity.mintConfig), isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false }],
    data: START_MINT,
  });
  return new VersionedTransaction(new TransactionMessage({
    payerKey: authority, recentBlockhash: blockhash, instructions: [instruction],
  }).compileToV0Message());
}

export function validateMintActivationAttempt(value: unknown, identity: ActivationIdentity): VersionedTransaction {
  if (!record(value) || typeof value.signature !== 'string' || typeof value.blockhash !== 'string' ||
    typeof value.transactionBase64 !== 'string' || !integer(value.lastValidBlockHeight) ||
    !STATUSES.includes(value.status as ActivationAttempt['status']) ||
    value.signedAt !== undefined && !timestamp(value.signedAt) ||
    value.resolvedAt !== undefined && !timestamp(value.resolvedAt) ||
    value.finalizedSlot !== undefined && !integer(value.finalizedSlot) ||
    Object.keys(value).some((key) => !['signature', 'blockhash', 'lastValidBlockHeight', 'transactionBase64', 'status',
      'signedAt', 'resolvedAt', 'finalizedSlot'].includes(key))) {
    throw new Error('Invalid saved mint activation attempt.');
  }
  const transaction = VersionedTransaction.deserialize(Buffer.from(value.transactionBase64, 'base64'));
  const expected = buildMintActivationTransaction(identity, value.blockhash);
  if (transaction.signatures.length !== 1 || transaction.message.header.numRequiredSignatures !== 1 ||
    Buffer.from(transaction.serialize()).toString('base64') !== value.transactionBase64 ||
    bs58.encode(transaction.signatures[0]) !== value.signature ||
    !Buffer.from(transaction.message.serialize()).equals(Buffer.from(expected.message.serialize())) ||
    !nacl.sign.detached.verify(transaction.message.serialize(), transaction.signatures[0], new PublicKey(identity.authority).toBytes())) {
    throw new Error('Saved activation is not the exact authority-signed start_mint transaction for mint configuration A.');
  }
  return transaction;
}

export function readMintActivationJournal(
  filePath: string, identity: ActivationIdentity, now: Date,
): { journal: ActivationJournal; source?: string; migrated: boolean } {
  const empty: ActivationJournal = { version: 2, ...identity, createdAt: now.toISOString(), status: 'prepared', attempts: [] };
  if (!existsSync(filePath)) return { journal: empty, migrated: false };
  const source = readFileSync(filePath, 'utf8');
  const value: unknown = JSON.parse(source);
  if (!record(value)) throw new Error('Invalid mint activation journal.');
  const identityKeys = ['dropId', 'cluster', 'programId', 'mintConfig', 'operationsConfig', 'manifestSha256'] as const;
  if (identityKeys.some((key) => value[key] !== identity[key])) throw new Error('Saved activation belongs to another drop, cluster, role, or manifest.');
  if (value.version === 1) {
    if (Object.keys(value).some((key) => !['version', ...identityKeys, 'signature', 'blockhash', 'lastValidBlockHeight',
      'transactionBase64', 'status', 'finalizedSlot', 'activatedAt'].includes(key))) throw new Error('Invalid legacy activation fields.');
    const attempt: ActivationAttempt = {
      signature: value.signature as string, blockhash: value.blockhash as string,
      lastValidBlockHeight: value.lastValidBlockHeight as number, transactionBase64: value.transactionBase64 as string,
      status: value.status as ActivationAttempt['status'],
      ...(value.finalizedSlot !== undefined ? { finalizedSlot: value.finalizedSlot as number } : {}),
      ...(value.activatedAt !== undefined ? { resolvedAt: value.activatedAt as string } : {}),
    };
    validateMintActivationAttempt(attempt, identity);
    return { journal: { ...empty, status: attempt.status === 'signed' ? 'signed' : 'prepared', attempts: [attempt] }, source, migrated: true };
  }
  const keys = ['version', ...identityKeys, 'authority', 'createdAt', 'status', 'attempts', 'activeState', 'smoke'];
  if (value.version !== 2 || value.authority !== identity.authority || !timestamp(value.createdAt) ||
    !['prepared', 'signed', 'active'].includes(String(value.status)) || !Array.isArray(value.attempts) ||
    Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Invalid mint activation journal.');
  const attempts = value.attempts;
  attempts.forEach((attempt) => validateMintActivationAttempt(attempt, identity));
  if (new Set(attempts.map((attempt) => attempt.signature)).size !== attempts.length ||
    attempts.some((attempt, index) => attempt.status === 'signed' && index !== attempts.length - 1)) {
    throw new Error('Activation journal has duplicate or multiple unresolved attempts.');
  }
  if (value.activeState !== undefined && (!record(value.activeState) || !integer(value.activeState.slot) ||
    !timestamp(value.activeState.verifiedAt) || Object.keys(value.activeState).length !== 2)) throw new Error('Invalid recorded active state.');
  const unresolved = attempts.at(-1)?.status === 'signed';
  if ((value.status === 'signed') !== unresolved || value.status === 'active' && value.activeState === undefined ||
    value.status !== 'active' && value.activeState !== undefined || value.status === 'prepared' &&
    attempts.some((attempt) => attempt.status === 'finalized' || attempt.status === 'state-verified')) {
    throw new Error('Activation journal state contradicts its attempt history.');
  }
  if (value.smoke !== undefined && (!record(value.smoke) ||
    !['running', 'passed', 'cancelled', 'recovery-required', 'recovered'].includes(String(value.smoke.status)) ||
    value.smoke.runId !== undefined && (typeof value.smoke.runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.smoke.runId)) ||
    Object.keys(value.smoke).some((key) => key !== 'runId' && key !== 'status'))) throw new Error('Invalid activation smoke record.');
  return { journal: value as ActivationJournal, source, migrated: false };
}

export function writeMintActivationJournal(filePath: string, journal: ActivationJournal, expectedSource?: string): string {
  const source = `${JSON.stringify(journal, null, 2)}\n`;
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  if (expectedSource !== undefined && (!existsSync(filePath) || readFileSync(filePath, 'utf8') !== expectedSource)) {
    throw new Error('Activation journal changed during use; preserve it and retry after review.');
  }
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(descriptor, source, 'utf8'); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  try {
    if (expectedSource === undefined) linkSync(temporary, filePath);
    else renameSync(temporary, filePath);
    const parent = openSync(directory, 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { rmSync(temporary, { force: true }); }
  if (readFileSync(filePath, 'utf8') !== source) throw new Error('Activation journal persistence could not be verified.');
  return source;
}

export async function inspectMintActivationAttempt(
  connection: Pick<Connection, 'getSignatureStatuses' | 'getEpochInfo' | 'isBlockhashValid'>,
  attempt: ActivationAttempt,
  readState: (minimumSlot: number) => Promise<ActivationChainState>,
  initial: ActivationChainState,
): Promise<{ status: 'pending' | Exclude<ActivationAttempt['status'], 'signed'>; state: ActivationChainState; slot: number }> {
  const signatureStatus = async (minimumSlot: number) => {
    const result = await connection.getSignatureStatuses([attempt.signature], { searchTransactionHistory: true });
    if (!integer(result.context.slot) || result.context.slot < minimumSlot || result.value.length !== 1) {
      throw new Error('Activation signature history is stale or incomplete; the saved attempt is retained.');
    }
    const status = result.value[0];
    if (status && (!integer(status.slot) || !['processed', 'confirmed', 'finalized'].includes(String(status.confirmationStatus)))) {
      throw new Error('Activation signature history is invalid; the saved attempt is retained.');
    }
    return status;
  };
  const finalized = async (status: NonNullable<Awaited<ReturnType<typeof signatureStatus>>>, minimumSlot: number) => {
    const state = await readState(Math.max(status.slot, minimumSlot));
    if (!status.err && !state.started) throw new Error('Finalized activation is missing its expected active state.');
    return { status: status.err ? 'failed' as const : 'finalized' as const, state, slot: status.slot };
  };
  const first = await signatureStatus(initial.slot);
  if (first?.confirmationStatus === 'finalized') return finalized(first, initial.slot);
  if (initial.started) return { status: 'state-verified', state: initial, slot: initial.slot };
  if (first) return { status: 'pending', state: initial, slot: initial.slot };
  const epoch = await connection.getEpochInfo('finalized');
  if (!integer(epoch.absoluteSlot) || epoch.absoluteSlot < initial.slot || !integer(epoch.blockHeight)) {
    throw new Error('Finalized activation expiry state is invalid; the saved attempt is retained.');
  }
  const state = await readState(epoch.absoluteSlot);
  if (state.started) return { status: 'state-verified', state, slot: state.slot };
  const valid = await connection.isBlockhashValid(attempt.blockhash, { commitment: 'finalized', minContextSlot: epoch.absoluteSlot });
  if (!integer(valid.context.slot) || valid.context.slot < epoch.absoluteSlot || typeof valid.value !== 'boolean') {
    throw new Error('Activation blockhash verification is stale; the saved attempt is retained.');
  }
  if (valid.value || epoch.blockHeight <= attempt.lastValidBlockHeight) return { status: 'pending', state, slot: state.slot };
  const second = await signatureStatus(epoch.absoluteSlot);
  if (second?.confirmationStatus === 'finalized') return finalized(second, epoch.absoluteSlot);
  if (second) return { status: 'pending', state, slot: state.slot };
  const absent = await readState(epoch.absoluteSlot);
  return { status: absent.started ? 'state-verified' : 'expired', state: absent, slot: absent.slot };
}
