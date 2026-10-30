import { DurableObject } from 'cloudflare:workers';
import { EthereumRevealThrottleError, inspectRevealTransaction } from './ethereumRevealChain.js';
import type { RevealVerificationResult, RevealVerificationScope, RevealVerificationWork } from './ethereumRevealVerification.js';
import { createTimedAbortScope, raceWithSignal } from './boundedRequest.js';

export class EthereumRevealVerifierObject extends DurableObject<Env> {
  private readonly inspections = new Map<string, Promise<RevealVerificationResult>>();

  inspect(scope: RevealVerificationScope, work: RevealVerificationWork, deadlineMs: number): Promise<RevealVerificationResult> {
    const key = `${scope.chainId}:${scope.contractAddress}:${work.kind}:${work.claim.hash}:${work.claim.claimId}`;
    const existing = this.inspections.get(key);
    if (existing) return existing;
    const inspection = this.verify(scope, work, deadlineMs).finally(() => { this.inspections.delete(key); });
    this.inspections.set(key, inspection);
    this.ctx.waitUntil(inspection);
    return inspection;
  }

  private async verify(scope: RevealVerificationScope, work: RevealVerificationWork, deadlineMs: number): Promise<RevealVerificationResult> {
    const deadline = Math.min(deadlineMs, work.claim.leaseUntilMs, Date.now() + 20_000);
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) return { kind: 'failed' };
    const cancellation = new AbortController();
    const timeout = createTimedAbortScope(cancellation.signal, { timeoutMs: Math.max(1, deadline - Date.now()),
      timeoutMessage: 'Reveal inspection timed out.' });
    const signal = timeout.signal;
    try {
      const coordinator = this.env.ETHEREUM_REVEAL.getByName(`${scope.chainId}:${scope.contractAddress}`);
      if (!await raceWithSignal(coordinator.validateReceiptWork(scope, work), signal)) return { kind: 'failed' };
      signal.throwIfAborted();
      const inspection = await inspectRevealTransaction(this.env, scope, work.claim.hash, signal, fetch, async () => {
        if (!await raceWithSignal(coordinator.recordReceiptPresence(scope, work), signal)) throw new Error('Reveal inspection expired.');
      });
      signal.throwIfAborted();
      return { kind: 'inspected', inspection };
    } catch (error) {
      if (error instanceof EthereumRevealThrottleError) return { kind: 'throttled', retryAfterMs: error.retryAfterMs };
      return { kind: 'failed' };
    } finally { cancellation.abort(); timeout.dispose(); }
  }
}
