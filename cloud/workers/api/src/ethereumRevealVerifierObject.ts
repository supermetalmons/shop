import { DurableObject } from 'cloudflare:workers';
import { EthereumRevealThrottleError, inspectRevealTransaction } from './ethereumRevealChain.js';
import { retryRevealProviderBudget, RevealProviderBudget, type RevealVerificationResult,
  type RevealVerificationScope, type RevealVerificationWork } from './ethereumRevealVerification.js';
import { createTimedAbortScope, raceWithSignal } from './boundedRequest.js';
import { ethereumProviderBudget } from './ethereumProvider.js';
import { ProviderBudgetUnavailable, type ProviderBudgetClient } from './ethereumProviderBudget.js';

export class EthereumRevealVerifierObject extends DurableObject<Env> {
  private readonly inspections = new Map<string, Promise<RevealVerificationResult>>();
  private readonly cancellations = new Map<string, AbortController>();
  private providerBudgetClient: ProviderBudgetClient | null = null;

  inspect(scope: RevealVerificationScope, work: RevealVerificationWork, deadlineMs: number): Promise<RevealVerificationResult> {
    const key = `${scope.chainId}:${scope.contractAddress}:${work.kind}:${work.claim.hash}:${work.claim.claimId}`;
    const existing = this.inspections.get(key);
    if (existing) return existing;
    const cancellation = new AbortController();
    this.cancellations.set(key, cancellation);
    const inspection = this.verify(scope, work, deadlineMs, cancellation.signal).finally(() => {
      cancellation.abort();
      this.inspections.delete(key);
      this.cancellations.delete(key);
    });
    this.inspections.set(key, inspection);
    this.ctx.waitUntil(inspection);
    return inspection;
  }

  async cancelInspection(scope: RevealVerificationScope, work: RevealVerificationWork): Promise<void> {
    const key = `${scope.chainId}:${scope.contractAddress}:${work.kind}:${work.claim.hash}:${work.claim.claimId}`;
    this.cancellations.get(key)?.abort(new Error('Reveal inspection cancelled.'));
    await this.inspections.get(key)?.catch(() => undefined);
  }

  private async verify(scope: RevealVerificationScope, work: RevealVerificationWork, deadlineMs: number,
    cancellation: AbortSignal): Promise<RevealVerificationResult> {
    const deadline = Math.min(deadlineMs, work.claim.leaseUntilMs, Date.now() + 20_000);
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) return { kind: 'failed' };
    const timeout = createTimedAbortScope(cancellation, { timeoutMs: Math.max(1, deadline - Date.now()),
      timeoutMessage: 'Reveal inspection timed out.' });
    const signal = timeout.signal;
    let coordinatedBudget: RevealProviderBudget | undefined;
    try {
      const coordinator = this.env.ETHEREUM_REVEAL.getByName(`${scope.chainId}:${scope.contractAddress}`);
      const controlled = work.providerBudgetProtocol === 1 && scope.chainId !== 31337 &&
        this.env.ETHEREUM_PROVIDER_CONTROL_ENABLED === 'true';
      const budget = controlled
        ? coordinatedBudget = new RevealProviderBudget(coordinator, scope, work, deadline)
        : this.providerBudgetClient ??= ethereumProviderBudget(this.env, scope.chainId, 55);
      const permitId = crypto.randomUUID();
      if (!controlled && !await raceWithSignal(coordinator.validateReceiptWork(scope, work), signal)) return { kind: 'failed' };
      signal.throwIfAborted();
      const inspection = await retryRevealProviderBudget(() => inspectRevealTransaction(this.env, scope, work.claim.hash, signal, fetch, async (needed, attemptSignal) => {
        if (controlled) {
          const lane = work.claim.active ? 'reveal' : 'background';
          const refill = needed.provider !== 'local' && budget.available(needed.provider, lane) < needed.cost ? needed : undefined;
          const presence = await raceWithSignal(coordinator.recordReceiptPresenceWithBudget(scope, work, deadline, permitId, refill), attemptSignal);
          if (!presence.valid) throw new Error('Reveal inspection expired.');
          coordinatedBudget!.seed(presence.permit);
          if (needed.provider !== 'local') await coordinatedBudget!.ensure(needed.provider,
            needed.provider === 'quicknode' ? 1 : needed.cost, attemptSignal);
        } else if (!await raceWithSignal(coordinator.recordReceiptPresence(scope, work), attemptSignal)) throw new Error('Reveal inspection expired.');
      }, { active: work.claim.active, budgetClient: budget }), signal);
      signal.throwIfAborted();
      return { kind: 'inspected', inspection };
    } catch (error) {
      if (error instanceof ProviderBudgetUnavailable) return { kind: 'budget-wait', retryAfterMs: error.retryAfterMs };
      if (error instanceof EthereumRevealThrottleError) return { kind: 'throttled', retryAfterMs: error.retryAfterMs };
      return { kind: 'failed' };
    } finally { await coordinatedBudget?.dispose(); timeout.dispose(); }
  }
}
