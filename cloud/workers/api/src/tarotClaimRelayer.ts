import type { TarotBackendClaim } from '../../../../shared/ethereum/tarot.js';
import { EthereumApiError } from './ethereumError.js';
import type { TarotClaimRejection, TarotClaimRejectionInput } from './tarotClaimRejection.js';
import { TAROT_SPONSORSHIP_LIMIT_MESSAGE, type TarotClaimRelayerStore } from './tarotClaimRelayerStore.js';

export type TarotClaimScope = { chainId: 1 | 11155111; contractAddress: string; tokenId: number };
export type TarotClaimInput = TarotClaimScope & { requestId: string; recipient: string; codeHash: string };
export type TarotSignedClaim = {
  rawTransaction: string; transactionHash: string; nonce: string; authorizationDeadline: number;
  maximumFeeWei: string; relayerAddress: string;
};
export type TarotClaimAttempt = TarotClaimInput & {
  id: number; state: TarotBackendClaim['state']; createdAtMs: number; updatedAtMs: number;
  signed: TarotSignedClaim | null; lastBroadcastAtMs: number | null; lastCheckedAtMs: number | null;
  broadcastAccepted: boolean; error: string | null;
  receiptBlockNumber: number | null; receiptBlockHash: string | null; finalized: boolean; revision: number;
};
export type TarotSignedAttempt = TarotClaimAttempt & { signed: TarotSignedClaim };
export type TarotClaimInspection = {
  status: 'pending' | 'confirmed' | 'failed'; blockNumber: number | null; blockHash: string | null; finalized: boolean;
};
export interface TarotClaimChain {
  relayerAddress(chainId: 1 | 11155111): string;
  nonce(scope: TarotClaimScope): Promise<{ latest: string; pending: string }>;
  validate(input: TarotClaimInput): Promise<void>;
  prepare(input: TarotClaimInput, nonce: string, outstandingFeeWei: string): Promise<TarotSignedClaim>;
  inspect(attempt: TarotSignedAttempt): Promise<TarotClaimInspection>;
  broadcast(attempt: TarotSignedAttempt): Promise<void>;
}
export interface TarotClaimRelayerNamespace {
  getByName(name: string): {
    claim(input: TarotClaimInput): Promise<TarotBackendClaim | TarotClaimRejection>;
    reject(input: TarotClaimRejectionInput): Promise<TarotBackendClaim | TarotClaimRejection>;
    status(scope: TarotClaimScope & { requestId?: string }): Promise<TarotBackendClaim | null>;
  };
}

const POLL_MS = 15_000;
const REPLAY_MS = 30_000;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

export function tarotClaimRelayerName(chainId: number): string { return `tarot-claims:${chainId}`; }

export function validateTarotClaimScope(scope: TarotClaimScope): void {
  if (!scope || ![1, 11155111].includes(scope.chainId) || !ADDRESS.test(scope.contractAddress) || /^0x0{40}$/.test(scope.contractAddress) ||
    !Number.isInteger(scope.tokenId) || scope.tokenId < 1 || scope.tokenId > 777) {
    throw new EthereumApiError('invalid-argument', 'Invalid sponsored claim scope.');
  }
}

function validateInput(input: TarotClaimInput): void {
  validateTarotClaimScope(input);
  if (!ADDRESS.test(input.recipient) || /^0x0{40}$/.test(input.recipient) || !/^[0-9a-f]{64}$/.test(input.codeHash) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) {
    throw new EthereumApiError('invalid-argument', 'Invalid sponsored claim request.');
  }
}

function presentation(attempt: TarotClaimAttempt): TarotBackendClaim {
  const state = attempt.signed && attempt.state === 'failed' && !attempt.finalized ? 'pending' : attempt.state;
  return { requestId: attempt.requestId, state, recipient: attempt.recipient,
    transactionHash: attempt.signed?.transactionHash ?? null, revision: attempt.revision, finalized: attempt.finalized,
    ...(attempt.error && state !== 'pending' ? { error: attempt.error } : {}) };
}

function failureMessage(error: unknown): string {
  return error instanceof EthereumApiError ? error.message : 'The claim could not be submitted. Please try again.';
}

export class TarotClaimRelayer {
  private running: Promise<void> | null = null;

  constructor(private readonly store: TarotClaimRelayerStore, private readonly chain: TarotClaimChain,
    private readonly schedule: (at: number | null) => Promise<void>, private readonly now: () => number = Date.now,
    private readonly report: (event: { event: string; chainId: number; attemptId: number; reason: string }) => void = entry => console.error(entry)) {}

  async claim(input: TarotClaimInput): Promise<TarotBackendClaim> {
    validateInput(input);
    await this.schedule(this.now() + POLL_MS);
    const attempt = this.store.admit(input, this.now());
    if (attempt.finalized || !attempt.signed && attempt.state === 'failed') return presentation(attempt);
    await this.tick();
    return presentation(this.store.get(attempt.id));
  }

  status(scope: TarotClaimScope & { requestId?: string }): TarotBackendClaim | null {
    validateTarotClaimScope(scope);
    const attempt = this.store.status(scope);
    return attempt ? presentation(attempt) : null;
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    const running = this.run().finally(() => { if (this.running === running) this.running = null; });
    this.running = running;
    return running;
  }

  private async run(): Promise<void> {
    const reconcileStopAt = this.now() + 20_000;
    const signingBlocked = (now = this.now()): boolean => this.store.unresolved().some(attempt =>
      attempt.state === 'recovery-required' || attempt.signed &&
      attempt.receiptBlockHash === null && (!attempt.broadcastAccepted || attempt.signed.authorizationDeadline * 1000 <= now));
    try {
      const pending = this.store.unresolved().filter((attempt): attempt is TarotSignedAttempt => attempt.signed !== null)
        .sort((left, right) => (left.lastCheckedAtMs ?? 0) - (right.lastCheckedAtMs ?? 0) || left.id - right.id);
      for (const attempt of pending) {
        if (this.now() >= reconcileStopAt) break;
        await this.reconcile(attempt);
      }
      if (this.store.unresolved().some(attempt => attempt.state === 'recovery-required')) {
        for (const attempt of this.store.unresolved()) {
          if (!attempt.signed) this.store.settle(attempt.id, 'failed', 'Backend claiming is temporarily unavailable. Please try again later.', this.now());
        }
        return;
      }
      if (signingBlocked()) return;
      const signingStopAt = this.now() + 20_000;
      for (const attempt of this.store.unresolved()) {
        if (this.now() >= signingStopAt || signingBlocked()) break;
        if (attempt.signed || attempt.state !== 'submitting') continue;
        if (this.store.hasUnfinalizedClaim(attempt, attempt.id)) continue;
        try {
          if (this.store.sponsorshipExhausted(attempt)) {
            throw new EthereumApiError('failed-precondition', TAROT_SPONSORSHIP_LIMIT_MESSAGE);
          }
          this.store.pinAccount(attempt.chainId, this.chain.relayerAddress(attempt.chainId));
          await this.chain.validate(attempt);
          if (signingBlocked()) return;
          const network = await this.chain.nonce(attempt);
          if (signingBlocked()) return;
          const account = this.store.account()!;
          const nextNonce = account.nextNonce ?? network.latest;
          if (!this.nonceReady(network, nextNonce)) return;
          const signed = await this.chain.prepare(attempt, nextNonce, this.store.outstandingFeeWei());
          if (signingBlocked()) return;
          if (!this.nonceReady(await this.chain.nonce(attempt), nextNonce)) return;
          const preparedAt = this.now();
          if (signingBlocked(preparedAt)) return;
          if (!/^0x(?:[0-9a-f]{2})+$/i.test(signed.rawTransaction) || !HASH.test(signed.transactionHash) ||
            signed.nonce !== nextNonce || signed.relayerAddress !== account.address || !DECIMAL.test(signed.maximumFeeWei) ||
            BigInt(signed.maximumFeeWei) <= 0n || !Number.isSafeInteger(signed.authorizationDeadline) ||
            signed.authorizationDeadline * 1000 <= preparedAt) throw new Error('Invalid prepared Tarot claim.');
          this.store.persistSigned(attempt.id, signed, preparedAt);
        } catch (error) {
          this.store.settle(attempt.id, 'failed', failureMessage(error), this.now());
          continue;
        }
        await this.send(this.store.get(attempt.id) as TarotSignedAttempt);
        if (!this.store.get(attempt.id).broadcastAccepted) return;
      }
    } finally {
      await this.schedule(this.store.unresolved().length ? this.now() + POLL_MS : null);
    }
  }

  private nonceReady(network: { latest: string; pending: string }, nextNonce: string): boolean {
    if (!DECIMAL.test(network.latest) || !DECIMAL.test(network.pending) || !DECIMAL.test(nextNonce) ||
      BigInt(network.pending) < BigInt(network.latest)) {
      throw new EthereumApiError('unavailable', 'The claim relayer nonce is unavailable.');
    }
    if (BigInt(network.latest) > BigInt(nextNonce) || BigInt(network.pending) > BigInt(nextNonce)) {
      throw new EthereumApiError('unavailable', 'The claim relayer account needs attention.');
    }
    return network.pending === nextNonce;
  }

  private async reconcile(attempt: TarotSignedAttempt): Promise<void> {
    if (attempt.lastCheckedAtMs === null || this.now() - attempt.lastCheckedAtMs >= POLL_MS) {
      this.store.checked(attempt.id, this.now());
      try {
        const inspection = await this.chain.inspect(attempt);
        if (!['pending', 'confirmed', 'failed'].includes(inspection.status) || typeof inspection.finalized !== 'boolean' ||
          (inspection.blockNumber === null ? inspection.blockHash !== null || inspection.status !== 'pending' || inspection.finalized
            : !Number.isSafeInteger(inspection.blockNumber) || inspection.blockNumber < 0 ||
              typeof inspection.blockHash !== 'string' || !HASH.test(inspection.blockHash)) ||
          inspection.finalized && inspection.status === 'pending') throw new Error('Invalid Tarot claim receipt.');
        this.store.observe(attempt.id, inspection, this.now());
      } catch {}
    }
    attempt = this.store.get(attempt.id) as TarotSignedAttempt;
    if (attempt.finalized || attempt.receiptBlockHash !== null) return;
    if (attempt.signed.authorizationDeadline * 1000 <= this.now()) {
      this.recovery(attempt, 'The claim transaction needs attention. Its status will continue to be checked.');
      return;
    }
    if (attempt.state !== 'recovery-required' && (attempt.lastBroadcastAtMs === null || this.now() - attempt.lastBroadcastAtMs >= REPLAY_MS)) {
      await this.send(attempt);
    }
  }

  private async send(attempt: TarotSignedAttempt): Promise<void> {
    if (attempt.signed.authorizationDeadline * 1000 <= this.now()) {
      this.recovery(attempt, 'The claim transaction needs attention. Its status will continue to be checked.');
      return;
    }
    this.store.recordBroadcast(attempt.id, this.now());
    try {
      await this.chain.broadcast(attempt);
      this.store.acceptBroadcast(attempt.id, this.now());
    } catch (error) {
      if (error instanceof EthereumApiError && ['unauthenticated', 'permission-denied', 'invalid-argument', 'failed-precondition'].includes(error.code)) {
        this.recovery(attempt, failureMessage(error));
      }
    }
  }

  private recovery(attempt: TarotClaimAttempt, error: string): void {
    if (attempt.state === 'recovery-required') return;
    this.store.settle(attempt.id, 'recovery-required', error, this.now());
    this.report({ event: 'tarot_claim_recovery_required', chainId: attempt.chainId, attemptId: attempt.id, reason: error });
  }
}
