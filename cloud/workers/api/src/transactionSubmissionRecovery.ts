import type { Connection } from '@solana/web3.js';

export type TransactionSubmissionOutcome = 'confirmed' | 'expired' | 'unresolved';

export function hasConfirmedSignatureCommitment(status: {
  confirmationStatus?: string | null;
  confirmations: number | null;
} | null | undefined): boolean {
  if (!status) return false;
  if (status.confirmationStatus != null) {
    return status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized';
  }
  return status.confirmations === null || (
    Number.isSafeInteger(status.confirmations) && Number(status.confirmations) > 0
  );
}

export async function probeTransactionSubmission(args: {
  connection: Pick<Connection, 'getSignatureStatuses' | 'isBlockhashValid'>;
  signature: string;
  blockhash: string;
  hasLanded: () => Promise<boolean>;
}): Promise<TransactionSubmissionOutcome> {
  const status = (await args.connection.getSignatureStatuses(
    [args.signature],
    { searchTransactionHistory: true },
  )).value[0];
  if (status?.err) return 'expired';
  if (hasConfirmedSignatureCommitment(status)) return 'confirmed';
  if (status) return 'unresolved';
  if (await args.hasLanded()) return 'confirmed';
  const validity = await args.connection.isBlockhashValid(args.blockhash, { commitment: 'confirmed' });
  return validity.value ? 'unresolved' : 'expired';
}
