import { DurableObject } from 'cloudflare:workers';
import type { TarotBackendClaim } from '../../../../shared/ethereum/tarot.js';
import { createTarotClaimChain } from './tarotClaimChain.js';
import { EthereumApiError } from './ethereumError.js';
import { TarotClaimRelayer, tarotClaimRelayerName, validateTarotClaimScope,
  type TarotClaimInput, type TarotClaimScope } from './tarotClaimRelayer.js';
import { TarotClaimRelayerStore } from './tarotClaimRelayerStore.js';
import { TarotClaimRejected, type TarotClaimRejection, type TarotClaimRejectionInput } from './tarotClaimRejection.js';

export class TarotClaimRelayerObject extends DurableObject<Env> {
  private readonly relayer: TarotClaimRelayer;
  private readonly store: TarotClaimRelayerStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new TarotClaimRelayerStore(ctx.storage.sql, action => ctx.storage.transactionSync(action));
    this.relayer = new TarotClaimRelayer(this.store,
      createTarotClaimChain(env), at => this.schedule(at));
    ctx.blockConcurrencyWhile(async () => {
      if (this.store.unresolved().length) await this.schedule(Date.now() + 15_000);
    });
  }

  async claim(input: TarotClaimInput): Promise<TarotBackendClaim | TarotClaimRejection> {
    this.requireScope(input);
    try { return await this.relayer.claim(input); }
    catch (error) {
      if (error instanceof TarotClaimRejected) return { rejection: error.rejection };
      throw error;
    }
  }

  async reject(input: TarotClaimRejectionInput): Promise<TarotBackendClaim | TarotClaimRejection> {
    this.requireScope(input);
    const result = this.store.reject(input, Date.now());
    return 'rejection' in result ? result : this.relayer.status(result)!;
  }

  async status(scope: TarotClaimScope & { requestId?: string }): Promise<TarotBackendClaim | null> {
    this.requireScope(scope);
    const result = this.relayer.status(scope);
    if (this.store.unresolved().length) await this.schedule(Date.now() + 15_000);
    return result;
  }

  async alarm(): Promise<void> { await this.relayer.tick(); }

  private async schedule(at: number | null): Promise<void> {
    if (at === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  private requireScope(scope: TarotClaimScope): void {
    validateTarotClaimScope(scope);
    if (!this.ctx.id.equals(this.env.TAROT_CLAIM_RELAYER.idFromName(tarotClaimRelayerName(scope.chainId)))) {
      throw new EthereumApiError('invalid-argument', 'The claim network does not match its relayer.');
    }
  }
}
