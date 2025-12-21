import { Connection, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
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

export function isBlockhashExpiredError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as any;
  if (anyErr?.cause) return isBlockhashExpiredError(anyErr.cause);
  const msg = unwrapTxErrorMessage(err);
  return /blockhash not found|blockhash expired|transaction expired|expired blockhash|signature has expired|block height exceeded|TransactionExpiredBlockheightExceededError/i.test(
    msg,
  );
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

export function lamportsToSol(lamports = 0): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(3);
}

export function normalizeCountryCode(country?: string) {
  const normalized = (country || '').trim().toUpperCase();
  if (!normalized) return '';
  if (normalized.length === 2) return normalized;
  const compact = normalized.replace(/[\s.]/g, '');
  if (compact === 'UNITEDSTATES' || compact === 'UNITEDSTATESOFAMERICA') return 'US';
  return '';
}

export async function sendPreparedTransaction(
  encodedTx: string,
  connection: Connection,
  signer: (tx: VersionedTransaction) => Promise<string>,
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

  try {
    const signature = await signer(tx);
    // Confirm by signature to avoid mismatched blockhash strategy (backend pre-signs v0 txs).
    await connection.confirmTransaction(signature, 'confirmed');
    return signature;
  } catch (err) {
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
    throw new Error(
      'Missing address encryption public key (set src/config/deployment.ts `addressEncryptionPublicKey` to a base64 Curve25519 public key)',
    );
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

export function buildSignInMessage(wallet: string): string {
  const domain = window?.location?.hostname || 'mons.shop';
  const ts = new Date().toISOString();
  return `Sign in to mons.shop as ${wallet}\nDomain: ${domain}\nTimestamp: ${ts}`;
}
