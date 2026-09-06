import {
  pendingPreparingTransactionExpired,
  samePendingPreparedTransaction,
  type PendingPreparedTransaction,
  type PendingPreparingTransaction,
  type PendingSubmittedTransaction,
} from '../lib/pendingPreparedTransactions';

export type BrowserLockManager = {
  request: <T>(
    name: string,
    options: { ifAvailable: true },
    callback: (lock: unknown | null) => Promise<T>,
  ) => Promise<T>;
};

function browserLockManager(): BrowserLockManager | null {
  if (typeof navigator === 'undefined' || typeof navigator.locks?.request !== 'function') return null;
  return navigator.locks as unknown as BrowserLockManager;
}
export async function withBrowserLock<T>(
  name: string,
  run: () => Promise<T>,
  lockManager: BrowserLockManager | null = browserLockManager(),
): Promise<T> {
  if (!lockManager) {
    throw new Error('This browser cannot safely coordinate wallet transactions. Update your browser and try again.');
  }
  return lockManager.request(name, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('Another wallet transaction is already in progress. Wait for it to finish and try again.');
    return run();
  });
}

type PreparedTransactionKind = PendingPreparingTransaction['kind'];

type PreparedTransactionCoordinatorOptions = {
  wallet: string;
  isCurrent: () => boolean;
  readPending: (wallet: string, sync?: boolean) => PendingPreparedTransaction | null;
  persistReservation: (reservation: PendingPreparingTransaction) => boolean;
  persistSubmission: (reservation: PendingPreparingTransaction, submission: PendingSubmittedTransaction) => boolean;
  forget: (entry: PendingPreparedTransaction) => boolean;
};

export function createPreparedTransactionCoordinator<Kind extends PreparedTransactionKind>(
  kind: Kind,
  options: PreparedTransactionCoordinatorOptions,
) {
  const action = kind === 'delivery' ? 'shipment' : 'claim';
  const title = kind === 'delivery' ? 'Shipment' : 'Claim';
  let activeReservation: PendingPreparingTransaction | null = null;
  let submitted: PendingSubmittedTransaction | null = null;

  function readPending(sync = true): PendingPreparedTransaction | null {
    let pending = options.readPending(options.wallet, sync);
    if (pending && pendingPreparingTransactionExpired(pending)) {
      if (activeReservation && samePendingPreparedTransaction(pending, activeReservation)) {
        throw new Error(`${title} preparation expired`);
      }
      if (options.forget(pending)) pending = null;
    }
    return pending;
  }

  function assertCurrent(): void {
    if (!options.isCurrent()) throw new Error(`Wallet changed while preparing ${action}`);
    const pending = readPending(false);
    if (pending && (!activeReservation || !samePendingPreparedTransaction(pending, activeReservation))) {
      throw new Error('Another wallet transaction is already pending');
    }
  }

  function reserve(reservation: Extract<PendingPreparingTransaction, { kind: Kind }>): void {
    submitted = null;
    activeReservation = reservation;
    try {
      if (!options.persistReservation(reservation)) throw new Error(`Unable to save ${action} reservation`);
    } catch (error) {
      activeReservation = null;
      throw error;
    }
  }

  function recordSubmitted(signature: string, transaction: { message: { recentBlockhash: string } }): void {
    const recentBlockhash = transaction.message.recentBlockhash;
    if (submitted) {
      if (submitted.signature !== signature || submitted.recentBlockhash !== recentBlockhash) {
        throw new Error(`${title} submission changed unexpectedly`);
      }
      return;
    }
    const reservation = activeReservation;
    if (!reservation) throw new Error(`${title} reservation is missing`);
    const submission: PendingSubmittedTransaction = {
      ...reservation,
      phase: 'submitted',
      signature,
      recentBlockhash,
    };
    if (!options.persistSubmission(reservation, submission)) {
      throw new Error(`Unable to save submitted ${action}`);
    }
    submitted = submission;
  }

  function getSubmitted(): Extract<PendingSubmittedTransaction, { kind: Kind }> | null {
    return submitted as Extract<PendingSubmittedTransaction, { kind: Kind }> | null;
  }

  function releaseReservation(): void {
    activeReservation = null;
  }

  function clearReservation(): void {
    const reservation = submitted || activeReservation;
    if (reservation && !options.forget(reservation)) {
      throw new Error(`Unable to clear ${action} reservation`);
    }
    releaseReservation();
  }

  return { readPending, assertCurrent, reserve, recordSubmitted, getSubmitted, releaseReservation, clearReservation };
}
