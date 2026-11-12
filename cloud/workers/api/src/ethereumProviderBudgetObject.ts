import { DurableObject } from 'cloudflare:workers';
import { EthereumProviderBudgetController, EthereumProviderBudgetStore, type ProviderBudgetGrant, type ProviderBudgetRequest,
  type ProviderName, type ProviderPublicBudgetRequest } from './ethereumProviderBudget.js';

export class EthereumProviderBudgetObject extends DurableObject {
  private readonly budget: EthereumProviderBudgetController;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.budget = new EthereumProviderBudgetController(new EthereumProviderBudgetStore(ctx.storage.sql, action => ctx.storage.transactionSync(action)));
  }

  async grant(request: ProviderBudgetRequest): Promise<ProviderBudgetGrant> {
    return this.budget.grant(request);
  }

  async acquirePublic(request: ProviderPublicBudgetRequest): Promise<ProviderBudgetGrant> {
    return this.budget.acquirePublic(request);
  }

  async cancelPublic(request: ProviderPublicBudgetRequest): Promise<void> {
    this.budget.cancelPublic(request);
  }

  async reportThrottle(request: { provider: ProviderName; retryAfterMs: number }): Promise<void> {
    this.budget.reportThrottle(request.provider, request.retryAfterMs);
  }
}
