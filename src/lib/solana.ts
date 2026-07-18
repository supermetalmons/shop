import bs58 from 'bs58';
import { Connection, PublicKey, VersionedTransaction, type SignatureStatus } from '@solana/web3.js';
import nacl from 'tweetnacl';

function unwrapTxErrorMessage(err: unknown): string {
  if (!err) return 'Unexpected error';
  if (typeof err === 'string') return err;
  if (err instanceof Error && err.message) return err.message;
  const anyErr = err as any;
  if (typeof anyErr?.message === 'string' && anyErr.message) return anyErr.message;
  if (typeof anyErr?.error?.message === 'string' && anyErr.error.message) return anyErr.error.message;
  if (typeof anyErr?.error === 'string' && anyErr.error) return anyErr.error;
  return 'Unexpected error';
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const ALREADY_PROCESSED_ERROR_RE = /this transaction has already been processed|already been processed/i;

export function isBlockhashExpiredError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as any;
  if (anyErr?.cause) return isBlockhashExpiredError(anyErr.cause);
  const msg = unwrapTxErrorMessage(err);
  return /blockhash not found|blockhash expired|transaction expired|expired blockhash|signature has expired|block height exceeded|TransactionExpiredBlockheightExceededError/i.test(
    msg,
  );
}

function isAlreadyProcessedError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as any;
  const msg = unwrapTxErrorMessage(err);
  if (ALREADY_PROCESSED_ERROR_RE.test(msg)) return true;
  if (anyErr?.cause) return isAlreadyProcessedError(anyErr.cause);
  return false;
}

function isLikelyBase58Signature(value: string): boolean {
  return value.length >= 64 && value.length <= 88 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value);
}

type WaitForConditionOptions = {
  attempts?: number;
  delayMs?: number;
};

// Only the duplicate-submit recovery path uses this longer window.
// That keeps normal failures fast while giving devnet/load-balanced RPCs
// enough time to surface a transaction we already know was accepted elsewhere.
const ALREADY_PROCESSED_RECOVERY_WAIT: WaitForConditionOptions = {
  attempts: 15,
  delayMs: 1_000,
};

// Keep post-submit confirmation bounded and explicit. This is one status RPC call
// per interval for a single active transaction, plus one history lookup at the end.
const SUBMITTED_SIGNATURE_WAIT: WaitForConditionOptions = {
  attempts: 20,
  delayMs: 500,
};

async function waitForCondition(check: () => Promise<boolean>, opts: WaitForConditionOptions = {}): Promise<boolean> {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 6));
  const delayMs = Math.max(0, Math.floor(opts.delayMs ?? 500));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await check()) return true;
    } catch {
      // Ignore transient RPC issues and keep polling briefly.
    }
    if (attempt < attempts - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return false;
}

async function extractSendTransactionLogs(err: unknown): Promise<string[] | undefined> {
  if (!err) return undefined;
  const anyErr = err as any;

  const directLogs = anyErr?.logs;
  if (Array.isArray(directLogs) && directLogs.every((l: any) => typeof l === 'string')) {
    return directLogs as string[];
  }

  const getLogs = anyErr?.getLogs;
  if (typeof getLogs === 'function') {
    try {
      const result = await getLogs.call(anyErr);
      if (Array.isArray(result) && result.every((l: any) => typeof l === 'string')) {
        return result as string[];
      }
    } catch {
      // Ignore getLogs failures; we'll fall back to message-only errors.
    }
  }

  // Some adapters wrap the underlying SendTransactionError under `cause`.
  if (anyErr?.cause) return extractSendTransactionLogs(anyErr.cause);
  return undefined;
}

function isZeroSignature(sig: Uint8Array | null | undefined): boolean {
  if (!sig || !(sig instanceof Uint8Array)) return true;
  for (let i = 0; i < sig.length; i += 1) {
    if (sig[i] !== 0) return false;
  }
  return true;
}

function extractTransactionSignature(tx: VersionedTransaction): string | null {
  const signature = tx.signatures[0];
  if (isZeroSignature(signature)) return null;
  return bs58.encode(signature);
}

function extractSignatureCandidate(value: unknown, seen = new Set<unknown>(), depth = 0): string | null {
  if (!value || depth > 4) return null;
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);

  const anyValue = value as any;
  const directSignature = anyValue?.signature;
  if (typeof directSignature === 'string' && isLikelyBase58Signature(directSignature)) {
    return directSignature;
  }
  if (directSignature instanceof Uint8Array && !isZeroSignature(directSignature)) {
    return bs58.encode(directSignature);
  }

  const candidateKeys = ['cause', 'error', 'transactionError', 'data'];
  for (const key of candidateKeys) {
    const nested = anyValue?.[key];
    const nestedSignature = extractSignatureCandidate(nested, seen, depth + 1);
    if (nestedSignature) return nestedSignature;
  }

  return null;
}

function describeSignatureStatusError(err: unknown): string {
  if (!err) return 'Unknown transaction error';
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export class SubmittedTransactionFailureError extends Error {
  readonly signature: string;
  readonly transactionError: unknown;

  constructor(signature: string, transactionError: unknown) {
    super(`Transaction failed: ${describeSignatureStatusError(transactionError)}`);
    this.name = 'SubmittedTransactionFailureError';
    this.signature = signature;
    this.transactionError = transactionError;
  }
}

export function isSubmittedTransactionFailureError(err: unknown): err is SubmittedTransactionFailureError {
  if (err instanceof SubmittedTransactionFailureError) return true;
  const anyErr = err as any;
  return anyErr?.name === 'SubmittedTransactionFailureError' && typeof anyErr?.signature === 'string';
}

async function getSignatureStatusValue(
  connection: Connection,
  signature: string,
  searchTransactionHistory: boolean,
): Promise<SignatureStatus | null> {
  const status = await connection.getSignatureStatus(signature, { searchTransactionHistory });
  return status.value ?? null;
}

function isConfirmedSignatureStatus(status: SignatureStatus | null): boolean {
  if (!status || status.err) return false;
  return (
    status.confirmationStatus === 'confirmed' ||
    status.confirmationStatus === 'finalized' ||
    status.confirmations === null ||
    (typeof status.confirmations === 'number' && status.confirmations > 0)
  );
}

function assertSignatureStatusSucceeded(signature: string, status: SignatureStatus | null) {
  if (status?.err) {
    throw new SubmittedTransactionFailureError(signature, status.err);
  }
}

async function waitForSuccessfulSignature(
  connection: Connection,
  signature: string,
  opts: WaitForConditionOptions = {},
): Promise<boolean> {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 6));
  const delayMs = Math.max(0, Math.floor(opts.delayMs ?? 500));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await getSignatureStatusValue(connection, signature, false).catch(() => null);
    assertSignatureStatusSucceeded(signature, status);
    if (isConfirmedSignatureStatus(status)) return true;

    if (attempt < attempts - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  const historicalStatus = await getSignatureStatusValue(connection, signature, true).catch(() => null);
  assertSignatureStatusSucceeded(signature, historicalStatus);
  return isConfirmedSignatureStatus(historicalStatus);
}

export async function recoverAlreadyProcessedSignature(
  tx: VersionedTransaction | null,
  connection: Connection,
  err: unknown,
): Promise<string | null> {
  if (!isAlreadyProcessedError(err)) return null;
  const signature = (tx ? extractTransactionSignature(tx) : null) || extractSignatureCandidate(err);
  if (!signature) return null;
  const confirmed = await waitForSuccessfulSignature(connection, signature, ALREADY_PROCESSED_RECOVERY_WAIT);
  if (!confirmed) return null;
  console.warn('[mons/solana] transaction was already processed; treating existing signature as success', {
    signature,
    error: unwrapTxErrorMessage(err),
  });
  return signature;
}

async function waitForAccounts(
  connection: Connection,
  accounts: readonly PublicKey[],
  opts: WaitForConditionOptions = {},
): Promise<boolean> {
  return waitForCondition(async () => {
    const infos = await connection.getMultipleAccountsInfo([...accounts], { commitment: 'confirmed' });
    return infos.length === accounts.length && infos.every(Boolean);
  }, opts);
}

export async function recoverAlreadyProcessedAccounts(
  connection: Connection,
  accounts: readonly PublicKey[],
  err: unknown,
): Promise<boolean> {
  if (!isAlreadyProcessedError(err)) return false;
  if (!accounts.length) return false;
  const confirmed = await waitForAccounts(connection, accounts, ALREADY_PROCESSED_RECOVERY_WAIT);
  if (!confirmed) return false;
  console.warn('[mons/solana] transaction was already processed; treating confirmed account changes as success', {
    accounts: accounts.map((account) => account.toBase58()),
    error: unwrapTxErrorMessage(err),
  });
  return true;
}

function describeRequiredSigners(tx: VersionedTransaction): { required: string[]; missingNonPayer: string[] } | null {
  const msg: any = (tx as any).message;
  const header = msg?.header;
  const staticKeys = msg?.staticAccountKeys;
  const num = header?.numRequiredSignatures;
  if (!Array.isArray(staticKeys) || typeof num !== 'number' || num <= 0) return null;

  const required = staticKeys.slice(0, num).map((k: any) => (typeof k?.toBase58 === 'function' ? k.toBase58() : String(k)));
  const missingNonPayer: string[] = [];
  for (let i = 1; i < Math.min(required.length, tx.signatures.length); i += 1) {
    if (isZeroSignature(tx.signatures[i])) missingNonPayer.push(required[i]);
  }
  return { required, missingNonPayer };
}

export function normalizeCountryCode(country?: string) {
  const normalized = (country || '').trim().toUpperCase();
  if (!normalized) return '';
  if (normalized.length === 2) return normalized;
  const compact = normalized.replace(/[\s._-]/g, '');
  if (compact === 'UNITEDSTATES' || compact === 'UNITEDSTATESOFAMERICA' || compact === 'USA' || compact === 'US') {
    return 'US';
  }
  return '';
}

type SendPreparedTransactionOptions = {
  onSubmitted?: (signature: string, tx: VersionedTransaction) => void | Promise<void>;
};

export async function sendPreparedTransaction(
  encodedTx: string,
  connection: Connection,
  signer: (tx: VersionedTransaction) => Promise<string>,
  options: SendPreparedTransactionOptions = {},
): Promise<string> {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(encodedTx, 'base64'));
  } catch (err) {
    throw new Error(`Invalid transaction payload (decode failed): ${unwrapTxErrorMessage(err)}`);
  }

  // If the backend forgot to include a required non-wallet signature, preflight will fail with
  // "Transaction signature verification failure" before any program logs exist. Surface this up-front.
  const signerInfo = describeRequiredSigners(tx);
  if (signerInfo?.missingNonPayer?.length) {
    console.error('[mons/solana] prepared transaction is missing required server signatures', signerInfo);
  }

  let submittedNotified = false;
  const notifySubmitted = async (signature: string) => {
    if (submittedNotified) return;
    submittedNotified = true;
    await options.onSubmitted?.(signature, tx);
  };

  try {
    const signature = await signer(tx);
    await notifySubmitted(signature);
    const submitted = await waitForSuccessfulSignature(connection, signature, SUBMITTED_SIGNATURE_WAIT);
    if (!submitted) {
      throw new Error(
        `Transaction was submitted, but confirmation timed out (${signature}). It may still complete; wait a moment before retrying.`,
      );
    }
    return signature;
  } catch (err) {
    const recoveredSignature = await recoverAlreadyProcessedSignature(tx, connection, err);
    if (recoveredSignature) {
      await notifySubmitted(recoveredSignature);
      return recoveredSignature;
    }
    if (isSubmittedTransactionFailureError(err)) {
      console.error('[mons/solana] transaction failed', {
        signature: err.signature,
        error: err.transactionError,
        ...(signerInfo ? { signerInfo } : {}),
      });
      throw err;
    }
    const logs = await extractSendTransactionLogs(err);
    let msg = unwrapTxErrorMessage(err);
    if (logs?.length) {
      const idx = msg.indexOf('Logs:');
      if (idx !== -1) msg = msg.slice(0, idx).trim();
    }
    if (logs?.length) {
      // Keep this noisy output limited to failures; these logs are essential for diagnosing on-chain issues.
      console.error('[mons/solana] transaction failed', { message: msg, logs, ...(signerInfo ? { signerInfo } : {}) });
    } else {
      console.error('[mons/solana] transaction failed', { error: err, ...(signerInfo ? { signerInfo } : {}) });
    }
    const hint = isBlockhashExpiredError(err)
      ? ' (try again; also ensure your wallet network matches the app cluster)'
      : '';
    const logHint = logs?.length ? ' (see console for full program logs)' : '';
    throw new Error(`${msg || 'Transaction failed'}${hint}${logHint}`);
  }
}

export function encryptAddressPayload(
  plaintext: string,
  recipientPublicKey: string,
): { cipherText: string; hint: string } {
  const rawKey = (recipientPublicKey || '').trim();
  if (!rawKey) {
    throw new Error('Missing address encryption public key (set `ADDRESS_ENCRYPTION_PUBLIC_KEY` in src/App.tsx)');
  }

  let remoteKey: Uint8Array;
  try {
    remoteKey = Buffer.from(rawKey, 'base64');
  } catch {
    remoteKey = new Uint8Array();
  }

  if (remoteKey.length !== nacl.box.publicKeyLength) {
    const looksBase58 = /^[1-9A-HJ-NP-Za-km-z]+$/.test(rawKey);
    const hint = looksBase58
      ? ' It looks like you pasted a base58 Solana address. This must be a TweetNaCl box (Curve25519) public key encoded in base64.'
      : '';
    throw new Error(
      `Invalid address encryption public key: expected base64 Curve25519 public key (${nacl.box.publicKeyLength} bytes), got ${remoteKey.length} bytes after base64 decode.${hint}`,
    );
  }
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const message = new TextEncoder().encode(plaintext);
  const cipher = nacl.box(message, nonce, remoteKey, ephemeral.secretKey);
  const payload = [nonce, ephemeral.publicKey, cipher]
    .map((arr) => Buffer.from(arr).toString('base64'))
    .join('.');

  // Very small hint to display in UI without leaking full address
  const hint = plaintext.slice(0, 1) + '...' + plaintext.slice(-2);

  return { cipherText: payload, hint };
}

export function shortAddress(addr: string, chars = 4) {
  return addr.length <= chars * 2 ? addr : `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

export function buildSignInMessage(wallet: string, uid: string): string {
  const domain = window?.location?.hostname || 'mons.shop';
  const ts = new Date().toISOString();
  return `Sign in to mons.shop as ${wallet}\nDomain: ${domain}\nTimestamp: ${ts}\nSession: ${uid}`;
}
