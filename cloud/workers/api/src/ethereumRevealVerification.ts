import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import type { EthereumRevealTransactionInspection } from './ethereumRevealChain.js';
import type { RevealReceiptClaim } from './ethereumRevealRecoveryStore.js';
import { ProviderBudgetClient, ProviderBudgetUnavailable, type ProviderBudgetGrant, type ProviderName, type ProviderLane } from './ethereumProviderBudget.js';
import { raceWithSignal } from './boundedRequest.js';

export type RevealVerificationScope = Pick<EthereumRevealDeployment, 'chainId' | 'contractAddress' | 'deploymentBlock'>;
export type RevealVerificationWork = { kind: 'receipt' | 'overflow'; claim: RevealReceiptClaim; providerBudgetProtocol?: 1 };
export type RevealProviderPermit = { provider: ProviderName; lane: ProviderLane; grant: ProviderBudgetGrant };
export type RevealWorkAuthorization = { valid: boolean; permit?: RevealProviderPermit };
export type RevealPermitRequest = { requestId: string; provider: ProviderName; minimum: number; wanted: number };
type RevealPermitCoordinator = {
  requestReceiptPermit(scope: RevealVerificationScope, work: RevealVerificationWork,
    deadlineMs: number, request: RevealPermitRequest): Promise<RevealWorkAuthorization>;
  cancelReceiptPermit(scope: RevealVerificationScope, work: RevealVerificationWork, requestId: string): Promise<void>;
  reportReceiptThrottle(scope: RevealVerificationScope, provider: ProviderName, retryAfterMs: number): Promise<void>;
};
type PendingPermit = { requestId: string; cancellation: AbortController; promise: Promise<void>; waiters: number; settled: boolean };
export type RevealVerificationResult =
  | { kind: 'inspected'; inspection: EthereumRevealTransactionInspection }
  | { kind: 'throttled'; retryAfterMs: number }
  | { kind: 'budget-wait'; retryAfterMs: number }
  | { kind: 'failed' };

export class RevealProviderBudget {
  private readonly local = new ProviderBudgetClient({ getByName: () => ({
    async grant() { throw new Error('Reveal permits require coordinator authorization.'); },
    async reportThrottle() {},
  }) });
  private readonly initialized = new Set<ProviderName>();
  private readonly pending = new Map<ProviderName, PendingPermit>();
  private readonly cancellations = new Set<Promise<unknown>>();
  private readonly lane: ProviderLane;

  constructor(private readonly coordinator: RevealPermitCoordinator, private readonly scope: RevealVerificationScope,
    private readonly work: RevealVerificationWork, private readonly deadlineMs: number) {
    this.lane = work.claim.active ? 'reveal' : 'background';
  }

  seed(permit?: RevealProviderPermit): void {
    if (!permit || permit.lane !== this.lane) return;
    try {
      this.local.seed(permit.provider, permit.lane, permit.grant);
      this.initialized.add(permit.provider);
    } catch (error) { if (!(error instanceof ProviderBudgetUnavailable)) throw error; }
  }

  available(provider: ProviderName, lane: ProviderLane): number { return this.local.available(provider, lane); }

  private cancel(provider: ProviderName, pending: PendingPermit): void {
    if (pending.settled || pending.cancellation.signal.aborted) return;
    pending.cancellation.abort(new Error('Reveal permit request cancelled.'));
    if (this.pending.get(provider) === pending) this.pending.delete(provider);
    const cancellation = this.coordinator.cancelReceiptPermit(this.scope, this.work, pending.requestId).catch(() => undefined);
    this.cancellations.add(cancellation);
    void cancellation.finally(() => this.cancellations.delete(cancellation));
  }

  async ensure(provider: ProviderName, cost: number, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      if (this.local.available(provider, this.lane) >= cost) return;
      let pending = this.pending.get(provider);
      if (!pending) {
        const minimum = provider === 'quicknode' ? 1 : this.initialized.has(provider) ? cost : Math.max(cost, 55);
        const wanted = provider === 'quicknode' ? 4 : minimum;
        const entry: PendingPermit = { requestId: crypto.randomUUID(), cancellation: new AbortController(),
          promise: Promise.resolve(), waiters: 0, settled: false };
        entry.promise = raceWithSignal(this.coordinator.requestReceiptPermit(this.scope, this.work, this.deadlineMs,
          { requestId: entry.requestId, provider, minimum, wanted }), entry.cancellation.signal).then(authorization => {
          entry.cancellation.signal.throwIfAborted();
          if (!authorization.valid) throw new Error('Reveal permit authorization expired.');
          this.seed(authorization.permit);
        }).finally(() => {
          entry.settled = true;
          if (this.pending.get(provider) === entry) this.pending.delete(provider);
        });
        this.pending.set(provider, entry);
        pending = entry;
      }
      pending.waiters++;
      try { await raceWithSignal(pending.promise, signal); }
      finally {
        pending.waiters--;
        if (!pending.waiters) this.cancel(provider, pending);
      }
    }
  }

  async take(provider: ProviderName, lane: ProviderLane, cost: number, signal: AbortSignal): Promise<void> {
    if (lane !== this.lane) throw new Error('Invalid reveal provider lane.');
    for (;;) {
      await this.ensure(provider, cost, signal);
      if (this.local.available(provider, lane) < cost) continue;
      await this.local.take(provider, lane, cost, signal);
      return;
    }
  }

  async reportThrottle(provider: ProviderName, retryAfterMs: number): Promise<void> {
    await this.local.reportThrottle(provider, retryAfterMs);
    await this.coordinator.reportReceiptThrottle(this.scope, provider, retryAfterMs);
  }

  async dispose(): Promise<void> {
    for (const [provider, pending] of this.pending) this.cancel(provider, pending);
    await raceWithSignal(Promise.allSettled([...this.cancellations]), AbortSignal.timeout(250)).catch(() => undefined);
  }
}

export async function retryRevealProviderBudget<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (;;) {
    signal.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      if (!(error instanceof ProviderBudgetUnavailable)) throw error;
      try { await error.wait(signal); }
      catch { throw error; }
    }
  }
}
