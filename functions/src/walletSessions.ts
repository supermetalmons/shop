import { PublicKey } from '@solana/web3.js';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';

export const WALLET_SESSION_COLLECTION = 'authSessions';
export const WALLET_SESSION_COMPATIBILITY_EXPIRES_AT_MS = 253_402_300_799_999;

export class WalletSessionWriteSupersededError extends Error {
  constructor() {
    super('Wallet session write was superseded');
    this.name = 'WalletSessionWriteSupersededError';
  }
}

export type WalletSessionResolution =
  | { wallet: string; source: 'session' | 'legacy_uid' }
  | {
      wallet: null;
      reason:
        | 'legacy_uid_invalid'
        | 'missing_wallet'
        | 'invalid_wallet';
    };

export type WalletSessionBaseline = {
  uid: string;
  exists: boolean;
  updateTime: string | null;
};

function normalizeWalletMaybe(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const wallet = new PublicKey(value).toBase58();
    return wallet === value ? wallet : null;
  } catch {
    return null;
  }
}

export async function establishVerifiedWalletSession<Baseline>(deps: {
  readBaseline(): Promise<Baseline>;
  verifySignature(): boolean | Promise<boolean>;
  invalidSignatureError(): Error;
  writeSession(baseline: Baseline): Promise<void>;
}): Promise<void> {
  const baseline = await deps.readBaseline();
  if (!(await deps.verifySignature())) throw deps.invalidSignatureError();
  await deps.writeSession(baseline);
}

function snapshotUpdateTime(snapshot: { exists: boolean; updateTime?: unknown }): string | null {
  if (!snapshot.exists) return null;
  const value = snapshot.updateTime as { seconds?: unknown; nanoseconds?: unknown } | undefined;
  const seconds = Number(value?.seconds);
  const nanoseconds = Number(value?.nanoseconds);
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(nanoseconds)) return null;
  return `${seconds}:${nanoseconds}`;
}

export async function readWalletSessionBaseline(
  db: Firestore,
  uid: string,
): Promise<WalletSessionBaseline> {
  const snapshot = await db.doc(`${WALLET_SESSION_COLLECTION}/${uid}`).get();
  const updateTime = snapshotUpdateTime(snapshot);
  if (snapshot.exists && updateTime === null) {
    throw new Error('Wallet session snapshot is missing its update time');
  }
  return { uid, exists: snapshot.exists, updateTime };
}

function snapshotMatchesBaseline(
  snapshot: { exists: boolean; updateTime?: unknown },
  baseline: WalletSessionBaseline,
): boolean {
  if (snapshot.exists !== baseline.exists) return false;
  if (!snapshot.exists) return true;
  return baseline.updateTime !== null && snapshotUpdateTime(snapshot) === baseline.updateTime;
}

export async function writeWalletSessionAndProfileIfCurrent(params: {
  db: Firestore;
  uid: string;
  wallet: string;
  baseline: WalletSessionBaseline;
}): Promise<void> {
  if (params.baseline.uid !== params.uid) {
    throw new Error('Wallet session baseline does not match the authenticated user');
  }
  if (normalizeWalletMaybe(params.wallet) !== params.wallet) {
    throw new Error('Wallet session wallet must be canonical');
  }
  const sessionRef = params.db.doc(`${WALLET_SESSION_COLLECTION}/${params.uid}`);
  const profileRef = params.db.doc(`profiles/${params.wallet}`);
  await params.db.runTransaction(async (tx) => {
    const snapshot = await tx.get(sessionRef);
    const current = snapshot.exists ? snapshot.data() : undefined;
    const currentWallet = normalizeWalletMaybe(current?.wallet);
    if (!snapshotMatchesBaseline(snapshot, params.baseline) && currentWallet !== params.wallet) {
      throw new WalletSessionWriteSupersededError();
    }

    tx.set(
      sessionRef,
      {
        wallet: params.wallet,
        updatedAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(WALLET_SESSION_COMPATIBILITY_EXPIRES_AT_MS),
      },
      { merge: true },
    );
    tx.set(profileRef, { wallet: params.wallet }, { merge: true });
  });
}

export function resolveWalletSessionBinding(params: {
  uid: string;
  sessionExists: boolean;
  sessionData: unknown;
}): WalletSessionResolution {
  if (!params.sessionExists) {
    const wallet = normalizeWalletMaybe(params.uid);
    return wallet
      ? { wallet, source: 'legacy_uid' }
      : { wallet: null, reason: 'legacy_uid_invalid' };
  }

  const data = params.sessionData as any;
  if (typeof data?.wallet !== 'string' || !data.wallet) {
    return { wallet: null, reason: 'missing_wallet' };
  }
  const wallet = normalizeWalletMaybe(data.wallet);
  if (!wallet) return { wallet: null, reason: 'invalid_wallet' };
  return { wallet, source: 'session' };
}
