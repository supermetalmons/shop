import { createTimedAbortScope, raceWithSignal, sleepWithSignal } from './boundedRequest.js';

export type ProviderName = 'alchemy' | 'quicknode';
export type ProviderLane = 'public' | 'reveal' | 'background';
type PoolName = 'shared' | 'reveal' | 'background';

export const PROVIDER_BUDGETS = {
  alchemy: { rates: { shared: 4400, reveal: 2000, background: 500 },
    bursts: { shared: 250, reveal: 150, background: 100 }, maxGrant: 250, leaseMs: 1000 },
  quicknode: { rates: { shared: 6, reveal: 12, background: 4 },
    bursts: { shared: 3, reveal: 1, background: 1 }, maxGrant: 4, leaseMs: 1000 },
} as const;

export type ProviderBudgetRequest = {
  provider: ProviderName;
  lane: ProviderLane;
  minimum: number;
  wanted: number;
  requestId?: string;
};

export type ProviderBudgetGrant = {
  granted: number;
  issuedAtMs: number;
  expiresAtMs: number;
  retryAfterMs: number;
  grantId?: string;
};

export type ProviderPublicBudgetRequest = {
  provider: ProviderName;
  minimum: number;
  deadlineMs: number;
  requestId: string;
};

export interface ProviderBudgetNamespace {
  getByName(name: string): {
    grant(request: ProviderBudgetRequest): Promise<ProviderBudgetGrant>;
    reportThrottle(request: { provider: ProviderName; retryAfterMs: number }): Promise<void>;
    acquirePublic?(request: ProviderPublicBudgetRequest): Promise<ProviderBudgetGrant>;
    cancelPublic?(request: ProviderPublicBudgetRequest): Promise<void>;
  };
}

export class ProviderBudgetUnavailable extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs = 100, private readonly retry?: (signal: AbortSignal) => Promise<void>) {
    super('Ethereum provider capacity is temporarily unavailable.');
    this.name = 'ProviderBudgetUnavailable';
    this.retryAfterMs = Number.isFinite(retryAfterMs) ? Math.max(1, Math.ceil(retryAfterMs)) : 100;
  }

  wait(signal: AbortSignal): Promise<void> {
    return this.retry ? this.retry(signal) : sleepWithSignal(Math.min(this.retryAfterMs, 2_147_483_647), signal);
  }
}

export interface ProviderBudgetSql {
  exec<T extends Record<string, string | number | null>>(query: string, ...bindings: Array<string | number | null>): { toArray(): T[] };
}

type BudgetControl = { provider: ProviderName; updated_at_ms: number; pause_until_ms: number };
type BudgetPool = { pool: PoolName; credits: number; demanded_at_ms: number };
const POOLS: PoolName[] = ['shared', 'reveal', 'background'];
const RESERVE_IDLE_MS = 500;
const PUBLIC_ADMISSION_MS = 1000;
const PUBLIC_QUEUE_LIMIT = 64;

function requireProvider(provider: ProviderName): void {
  if (provider !== 'alchemy' && provider !== 'quicknode') throw new TypeError('Invalid Ethereum provider.');
}

function requireRequest(request: ProviderBudgetRequest): void {
  requireProvider(request.provider);
  if (!['public', 'reveal', 'background'].includes(request.lane) ||
    !Number.isSafeInteger(request.minimum) || !Number.isSafeInteger(request.wanted) || request.minimum < 1 ||
    request.wanted < request.minimum || request.wanted > PROVIDER_BUDGETS[request.provider].maxGrant ||
    request.requestId !== undefined && (typeof request.requestId !== 'string' || request.requestId.length < 1 || request.requestId.length > 128)) {
    throw new TypeError('Invalid Ethereum provider budget request.');
  }
}

function publicRequest(request: ProviderPublicBudgetRequest): ProviderBudgetRequest {
  const value: ProviderBudgetRequest = { provider: request.provider, lane: 'public', minimum: request.minimum,
    wanted: request.minimum, requestId: request.requestId };
  requireRequest(value);
  if (!request.requestId || !Number.isSafeInteger(request.deadlineMs) || request.deadlineMs < 0) {
    throw new TypeError('Invalid public Ethereum provider budget request.');
  }
  return value;
}

function requestIdentity(request: ProviderBudgetRequest): string {
  return JSON.stringify([request.provider, request.lane, request.minimum, request.wanted]);
}

export class EthereumProviderBudgetStore {
  constructor(private readonly sql: ProviderBudgetSql, private readonly atomic: <T>(action: () => T) => T) {
    this.atomic(() => {
      sql.exec('CREATE TABLE IF NOT EXISTS provider_budget_control (id INTEGER PRIMARY KEY CHECK(id=1), provider TEXT NOT NULL, updated_at_ms INTEGER NOT NULL, pause_until_ms INTEGER NOT NULL)');
      sql.exec('CREATE TABLE IF NOT EXISTS provider_budget_pools (pool TEXT PRIMARY KEY, credits INTEGER NOT NULL, demanded_at_ms INTEGER NOT NULL)');
      sql.exec('CREATE TABLE IF NOT EXISTS provider_budget_grants (request_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, result_json TEXT NOT NULL, retain_until_ms INTEGER NOT NULL)');
      sql.exec('CREATE INDEX IF NOT EXISTS provider_budget_grants_expiry ON provider_budget_grants(retain_until_ms)');
    });
  }

  private read(provider: ProviderName, observedNow: number): { control: BudgetControl; pools: BudgetPool[]; now: number } {
    if (!Number.isSafeInteger(observedNow) || observedNow < 0) throw new TypeError('Invalid provider budget clock.');
    let control = this.sql.exec<BudgetControl>('SELECT provider,updated_at_ms,pause_until_ms FROM provider_budget_control WHERE id=1').toArray()[0];
    const config = PROVIDER_BUDGETS[provider];
    if (!control) {
      control = { provider, updated_at_ms: observedNow, pause_until_ms: 0 };
      this.sql.exec('INSERT INTO provider_budget_control VALUES(1,?,?,0)', provider, observedNow);
      for (const pool of POOLS) this.sql.exec('INSERT INTO provider_budget_pools VALUES(?,?,?)', pool, config.bursts[pool] * 1000, observedNow);
    }
    if (control.provider !== provider) throw new TypeError('Ethereum provider budget identity mismatch.');
    const now = Math.max(observedNow, control.updated_at_ms);
    const elapsed = Math.min(1000, now - control.updated_at_ms);
    const pools = this.sql.exec<BudgetPool>('SELECT pool,credits,demanded_at_ms FROM provider_budget_pools').toArray();
    for (const pool of pools) pool.credits = Math.min(config.bursts[pool.pool] * 1000, pool.credits + elapsed * config.rates[pool.pool]);
    control.updated_at_ms = now;
    return { control, pools, now };
  }

  private save(control: BudgetControl, pools: BudgetPool[]): void {
    this.sql.exec('UPDATE provider_budget_control SET updated_at_ms=?,pause_until_ms=? WHERE id=1', control.updated_at_ms, control.pause_until_ms);
    for (const pool of pools) this.sql.exec('UPDATE provider_budget_pools SET credits=?,demanded_at_ms=? WHERE pool=?', pool.credits, pool.demanded_at_ms, pool.pool);
  }

  private ordered(pools: BudgetPool[], lane: ProviderLane, now: number): BudgetPool[] {
    const own = lane === 'public' ? [] : pools.filter(pool => pool.pool === lane);
    return [...own, ...pools.filter(pool => pool.pool === 'shared'),
      ...pools.filter(pool => pool.pool !== 'shared' && pool.pool !== lane && now - pool.demanded_at_ms >= RESERVE_IDLE_MS)];
  }

  private retryAt(request: ProviderBudgetRequest, pools: BudgetPool[], now: number, pauseUntil: number): number {
    const config = PROVIDER_BUDGETS[request.provider];
    const available = (delay: number) => this.ordered(pools, request.lane, now + delay).reduce((total, pool) =>
      total + Math.min(config.bursts[pool.pool] * 1000, pool.credits + delay * config.rates[pool.pool]), 0);
    let low = Math.max(0, pauseUntil - now);
    let high = Math.max(low, RESERVE_IDLE_MS + 1000);
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (available(middle) >= request.minimum * 1000) high = middle;
      else low = middle + 1;
    }
    return low;
  }

  private cached(request: ProviderBudgetRequest, now: number): ProviderBudgetGrant | undefined {
    this.sql.exec('DELETE FROM provider_budget_grants WHERE retain_until_ms<?', now);
    if (!request.requestId) return;
    const previous = this.sql.exec<{ request_json: string; result_json: string }>('SELECT request_json,result_json FROM provider_budget_grants WHERE request_id=?', request.requestId).toArray()[0];
    if (!previous) return;
    if (previous.request_json !== requestIdentity(request)) throw new TypeError('Ethereum provider budget request identity mismatch.');
    return JSON.parse(previous.result_json) as ProviderBudgetGrant;
  }

  replay(request: ProviderBudgetRequest, observedNow: number): ProviderBudgetGrant | undefined {
    requireRequest(request);
    if (!Number.isSafeInteger(observedNow) || observedNow < 0) throw new TypeError('Invalid provider budget clock.');
    return this.atomic(() => this.cached(request, observedNow));
  }

  grant(request: ProviderBudgetRequest, observedNow: number): ProviderBudgetGrant {
    return this.allocate(request, observedNow, true);
  }

  tryGrant(request: ProviderBudgetRequest, observedNow: number): ProviderBudgetGrant {
    return this.allocate(request, observedNow, false);
  }

  deny(request: ProviderBudgetRequest, observedNow: number, retryAfterMs = 1000): ProviderBudgetGrant {
    requireRequest(request);
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) throw new TypeError('Invalid provider budget retry delay.');
    return this.atomic(() => {
      const { control, pools, now } = this.read(request.provider, observedNow);
      const previous = this.cached(request, now);
      if (previous) { this.save(control, pools); return previous; }
      pools.find(pool => pool.pool === (request.lane === 'public' ? 'shared' : request.lane))!.demanded_at_ms = now;
      const result: ProviderBudgetGrant = { granted: 0, issuedAtMs: now,
        expiresAtMs: now + PROVIDER_BUDGETS[request.provider].leaseMs, grantId: crypto.randomUUID(),
        retryAfterMs: Math.max(retryAfterMs, this.retryAt(request, pools, now, control.pause_until_ms)) };
      this.save(control, pools);
      if (request.requestId) this.sql.exec('INSERT INTO provider_budget_grants VALUES(?,?,?,?)', request.requestId,
        requestIdentity(request), JSON.stringify(result), now + 60_000);
      return result;
    });
  }

  private allocate(request: ProviderBudgetRequest, observedNow: number, cacheDenials: boolean): ProviderBudgetGrant {
    requireRequest(request);
    return this.atomic(() => {
      const { control, pools, now } = this.read(request.provider, observedNow);
      const previous = this.cached(request, now);
      if (previous) { this.save(control, pools); return previous; }
      const demand = pools.find(pool => pool.pool === (request.lane === 'public' ? 'shared' : request.lane))!;
      demand.demanded_at_ms = now;
      const ordered = this.ordered(pools, request.lane, now);
      const available = Math.floor(ordered.reduce((sum, pool) => sum + pool.credits, 0) / 1000);
      const granted = control.pause_until_ms > now || available < request.minimum ? 0 : Math.min(request.wanted, available);
      let remaining = granted * 1000;
      for (const pool of ordered) {
        const used = Math.min(pool.credits, remaining);
        pool.credits -= used;
        remaining -= used;
      }
      const result = { granted, issuedAtMs: now, expiresAtMs: now + PROVIDER_BUDGETS[request.provider].leaseMs, grantId: crypto.randomUUID(),
        retryAfterMs: this.retryAt(request, pools, now, control.pause_until_ms) };
      this.save(control, pools);
      if (request.requestId && (granted || cacheDenials)) this.sql.exec('INSERT INTO provider_budget_grants VALUES(?,?,?,?)', request.requestId,
        requestIdentity(request), JSON.stringify(result), now + 60_000);
      return result;
    });
  }

  reportThrottle(provider: ProviderName, retryAfterMs: number, observedNow: number): void {
    requireProvider(provider);
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) throw new TypeError('Invalid Ethereum provider retry delay.');
    this.atomic(() => {
      const { control, pools, now } = this.read(provider, observedNow);
      control.pause_until_ms = Math.max(control.pause_until_ms, Math.min(Number.MAX_SAFE_INTEGER - 1000, now + Math.max(1, Math.ceil(retryAfterMs))));
      this.save(control, pools);
    });
  }
}

type PublicBudgetWaiter = {
  request: ProviderPublicBudgetRequest;
  budget: ProviderBudgetRequest;
  deadlineMs: number;
  promise: Promise<ProviderBudgetGrant>;
  resolve(grant: ProviderBudgetGrant): void;
  reject(error: unknown): void;
};

export class EthereumProviderBudgetController {
  private readonly pending = new Map<string, PublicBudgetWaiter>();
  private timer?: ReturnType<typeof setTimeout>;
  private retryAtMs = 0;

  constructor(private readonly store: EthereumProviderBudgetStore, private readonly now: () => number = Date.now) {}

  grant(request: ProviderBudgetRequest): ProviderBudgetGrant {
    requireRequest(request);
    const now = this.now();
    if (request.lane === 'public') {
      const previous = this.store.replay(request, now);
      if (previous) return previous;
      if (this.pending.size && (this.retryAtMs <= now || [...this.pending.values()].some(entry => entry.deadlineMs <= now))) this.pump();
      if (this.pending.size) return this.store.deny(request, now);
    }
    return this.store.grant(request, now);
  }

  acquirePublic(request: ProviderPublicBudgetRequest): Promise<ProviderBudgetGrant> {
    const budget = publicRequest(request);
    const now = this.now();
    const previous = this.store.replay(budget, now);
    if (previous) return Promise.resolve(previous);
    const existing = this.pending.get(request.requestId);
    if (existing) {
      if (requestIdentity(existing.budget) !== requestIdentity(budget) || existing.request.deadlineMs !== request.deadlineMs) {
        throw new TypeError('Ethereum provider budget request identity mismatch.');
      }
      return existing.promise;
    }
    if (request.deadlineMs <= now || this.pending.size >= PUBLIC_QUEUE_LIMIT) return Promise.resolve(this.store.deny(budget, now));
    let resolve!: PublicBudgetWaiter['resolve'], reject!: PublicBudgetWaiter['reject'];
    const promise = new Promise<ProviderBudgetGrant>((done, fail) => { resolve = done; reject = fail; });
    const empty = this.pending.size === 0;
    this.pending.set(request.requestId, { request: { ...request }, budget,
      deadlineMs: Math.min(request.deadlineMs, now + PUBLIC_ADMISSION_MS), promise, resolve, reject });
    if (empty) this.pump();
    else this.schedule();
    return promise;
  }

  cancelPublic(request: ProviderPublicBudgetRequest): void {
    const budget = publicRequest(request);
    const entry = this.pending.get(request.requestId);
    if (entry && (requestIdentity(entry.budget) !== requestIdentity(budget) || entry.request.deadlineMs !== request.deadlineMs)) {
      throw new TypeError('Ethereum provider budget request identity mismatch.');
    }
    const result = this.store.deny(budget, this.now());
    if (!entry) return;
    const head = this.pending.values().next().value === entry;
    this.pending.delete(request.requestId);
    entry.resolve(result);
    if (head) this.pump();
    else this.schedule();
  }

  reportThrottle(provider: ProviderName, retryAfterMs: number): void {
    this.store.reportThrottle(provider, retryAfterMs, this.now());
    if (this.pending.size) this.pump();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending.size) { this.retryAtMs = 0; return; }
    const wakeAt = Math.min(this.retryAtMs, ...[...this.pending.values()].map(entry => entry.deadlineMs));
    this.timer = setTimeout(() => this.pump(), Math.max(1, Math.ceil(wakeAt - this.now())));
  }

  private pump(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const [id, entry] of this.pending) {
      if (entry.deadlineMs > this.now()) continue;
      this.pending.delete(id);
      try { entry.resolve(this.store.deny(entry.budget, this.now())); }
      catch (error) { entry.reject(error); }
    }
    while (this.pending.size) {
      const entry = this.pending.values().next().value!;
      const now = this.now();
      try {
        if (entry.deadlineMs <= now) {
          this.pending.delete(entry.request.requestId);
          entry.resolve(this.store.deny(entry.budget, now));
          continue;
        }
        const previous = this.store.replay(entry.budget, now);
        const result = previous ?? this.store.tryGrant(entry.budget, now);
        if (!previous && !result.granted) {
          this.retryAtMs = now + Math.max(1, result.retryAfterMs);
          break;
        }
        this.pending.delete(entry.request.requestId);
        entry.resolve(result);
      } catch (error) {
        this.pending.delete(entry.request.requestId);
        entry.reject(error);
      }
    }
    this.schedule();
  }
}

type LocalBudget = { credits: number; wallExpiry: number; monotonicExpiry: number; refill?: Promise<void>;
  retryWallExpiry: number; retryMonotonicExpiry: number; retryMinimum: number; waiters: RetryWaiter[];
  retryTimer?: ReturnType<typeof setTimeout>; nextRetryWall: number; nextRetryMonotonic: number; acquisition?: PublicAcquisition };
type LocalProvider = { generation: number; wallPause: number; monotonicPause: number; lanes: Map<ProviderLane, LocalBudget> };
type RetryWaiter = { minimum: number; wallReady: number; monotonicReady: number; signal: AbortSignal;
  resolve(): void; reject(reason: unknown): void; abort(): void };
type PublicAcquisition = { request: ProviderPublicBudgetRequest; cancellation: AbortController;
  promise: Promise<void>; waiters: number; settled: boolean; expired: boolean; cancellationResult?: Promise<void> };

export class ProviderBudgetClient {
  private readonly providers = new Map<ProviderName, LocalProvider>();
  private readonly seededGrants = new Map<string, number>();
  constructor(private readonly namespace: ProviderBudgetNamespace | undefined, private readonly maxQuantum?: number) {
    if (maxQuantum !== undefined && (!Number.isSafeInteger(maxQuantum) || maxQuantum < 1)) throw new TypeError('Invalid provider budget quantum.');
  }

  private provider(name: ProviderName): LocalProvider {
    let value = this.providers.get(name);
    if (!value) {
      value = { generation: 0, wallPause: 0, monotonicPause: 0, lanes: new Map() };
      this.providers.set(name, value);
    }
    return value;
  }

  private remainingCredits(state: LocalBudget): number {
    if (Date.now() >= state.wallExpiry || performance.now() >= state.monotonicExpiry) state.credits = 0;
    return state.credits;
  }

  private addCredits(state: LocalBudget, credits: number, wallExpiry: number, monotonicExpiry: number): void {
    const previous = this.remainingCredits(state);
    if (!credits || Date.now() >= wallExpiry || performance.now() >= monotonicExpiry) return;
    state.credits = previous + credits;
    state.wallExpiry = previous ? Math.min(state.wallExpiry, wallExpiry) : wallExpiry;
    state.monotonicExpiry = previous ? Math.min(state.monotonicExpiry, monotonicExpiry) : monotonicExpiry;
  }

  available(provider: ProviderName, lane: ProviderLane): number {
    requireRequest({ provider, lane, minimum: 1, wanted: 1 });
    const parent = this.provider(provider);
    if (parent.wallPause > Date.now() || parent.monotonicPause > performance.now()) return 0;
    const state = parent.lanes.get(lane);
    return state ? this.remainingCredits(state) : 0;
  }

  private lane(parent: LocalProvider, lane: ProviderLane): LocalBudget {
    let state = parent.lanes.get(lane);
    if (!state) {
      state = { credits: 0, wallExpiry: 0, monotonicExpiry: 0, retryWallExpiry: 0, retryMonotonicExpiry: 0,
        retryMinimum: 1, waiters: [], nextRetryWall: 0, nextRetryMonotonic: 0 };
      parent.lanes.set(lane, state);
    }
    return state;
  }

  private scheduleRetry(provider: ProviderName, parent: LocalProvider, state: LocalBudget): void {
    clearTimeout(state.retryTimer);
    state.retryTimer = undefined;
    const waiter = state.waiters[0];
    if (!waiter) return;
    const delay = Math.max(waiter.wallReady - Date.now(), waiter.monotonicReady - performance.now(),
      parent.wallPause - Date.now(), parent.monotonicPause - performance.now(),
      state.nextRetryWall - Date.now(), state.nextRetryMonotonic - performance.now(), 0);
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined;
      const remaining = Math.max(waiter.wallReady - Date.now(), waiter.monotonicReady - performance.now(),
        parent.wallPause - Date.now(), parent.monotonicPause - performance.now(),
        state.nextRetryWall - Date.now(), state.nextRetryMonotonic - performance.now(), 0);
      if (remaining > 0) { this.scheduleRetry(provider, parent, state); return; }
      state.waiters.shift();
      waiter.signal.removeEventListener('abort', waiter.abort);
      const rate = Object.values(PROVIDER_BUDGETS[provider].rates).reduce((sum, value) => sum + value, 0);
      const spacing = Math.max(1, Math.ceil(waiter.minimum * 1000 / rate));
      state.nextRetryWall = Date.now() + spacing;
      state.nextRetryMonotonic = performance.now() + spacing;
      waiter.resolve();
      this.scheduleRetry(provider, parent, state);
    }, Math.min(2_147_483_647, Math.max(1, Math.ceil(delay))));
  }

  private unavailable(provider: ProviderName, parent: LocalProvider, state: LocalBudget, minimum: number, delay: number): ProviderBudgetUnavailable {
    const wallReady = Date.now() + Math.max(1, delay), monotonicReady = performance.now() + Math.max(1, delay);
    return new ProviderBudgetUnavailable(delay, signal => {
      signal.throwIfAborted();
      return new Promise<void>((resolve, reject) => {
        const waiter: RetryWaiter = { minimum, wallReady, monotonicReady, signal, resolve, reject, abort: () => {
          const index = state.waiters.indexOf(waiter);
          if (index >= 0) state.waiters.splice(index, 1);
          reject(signal.reason);
          this.scheduleRetry(provider, parent, state);
        } };
        state.waiters.push(waiter);
        signal.addEventListener('abort', waiter.abort, { once: true });
        if (signal.aborted) waiter.abort();
        else this.scheduleRetry(provider, parent, state);
      });
    });
  }

  private validateGrant(provider: ProviderName, value: ProviderBudgetGrant): void {
    const config = PROVIDER_BUDGETS[provider];
    if (!Number.isSafeInteger(value.granted) || value.granted < 0 || value.granted > config.maxGrant ||
      !Number.isSafeInteger(value.issuedAtMs) || !Number.isSafeInteger(value.expiresAtMs) ||
      value.expiresAtMs <= value.issuedAtMs || value.expiresAtMs - value.issuedAtMs > config.leaseMs ||
      !Number.isFinite(value.retryAfterMs) || value.retryAfterMs < 0) throw new ProviderBudgetUnavailable();
  }

  seed(provider: ProviderName, lane: ProviderLane, value: ProviderBudgetGrant): void {
    requireRequest({ provider, lane, minimum: 1, wanted: 1 });
    this.validateGrant(provider, value);
    if (!value.grantId || value.grantId.length > 128) throw new ProviderBudgetUnavailable();
    const now = Date.now(), monotonic = performance.now();
    for (const [id, expires] of this.seededGrants) if (expires <= now) this.seededGrants.delete(id);
    if (this.seededGrants.has(value.grantId)) throw new ProviderBudgetUnavailable();
    const remaining = Math.min(PROVIDER_BUDGETS[provider].leaseMs, value.expiresAtMs - now);
    if (remaining <= 0) throw new ProviderBudgetUnavailable(1);
    this.seededGrants.set(value.grantId, value.expiresAtMs);
    const parent = this.provider(provider);
    if (parent.wallPause > now || parent.monotonicPause > monotonic) return;
    const state = this.lane(parent, lane);
    this.addCredits(state, value.granted, now + remaining, monotonic + remaining);
  }

  async acquirePublic(provider: ProviderName, minimum: number, deadlineMs: number, signal: AbortSignal): Promise<void> {
    requireRequest({ provider, lane: 'public', minimum, wanted: minimum });
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0) throw new TypeError('Invalid public provider admission deadline.');
    signal.throwIfAborted();
    const deadline = Math.min(deadlineMs, Date.now() + PUBLIC_ADMISSION_MS);
    const monotonicDeadline = performance.now() + Math.max(0, deadline - Date.now());
    const parent = this.provider(provider), state = this.lane(parent, 'public');
    for (;;) {
      signal.throwIfAborted();
      const remaining = Math.min(deadline - Date.now(), monotonicDeadline - performance.now());
      if (remaining <= 0) throw new ProviderBudgetUnavailable(1000);
      const pause = Math.max(parent.wallPause - Date.now(), parent.monotonicPause - performance.now());
      if (pause > 0) throw this.unavailable(provider, parent, state, minimum, pause);
      if (this.remainingCredits(state) >= minimum) return;
      let pending = state.acquisition;
      if (!pending) {
        let stub: ReturnType<ProviderBudgetNamespace['getByName']> | undefined;
        try { stub = this.namespace?.getByName(provider); }
        catch { throw new ProviderBudgetUnavailable(1000); }
        if (!stub?.acquirePublic || !stub.cancelPublic) throw new ProviderBudgetUnavailable(1000);
        const target = stub;
        const generation = parent.generation;
        const wallStart = Date.now(), monotonicStart = performance.now();
        const request: ProviderPublicBudgetRequest = { provider, minimum, deadlineMs: deadline, requestId: crypto.randomUUID() };
        const entry: PublicAcquisition = { request, cancellation: new AbortController(), promise: Promise.resolve(),
          waiters: 0, settled: false, expired: false };
        const timeout = createTimedAbortScope(entry.cancellation.signal, { timeoutMs: Math.max(1, remaining),
          timeoutMessage: 'Public provider admission timed out.' });
        const cancel = () => {
          entry.cancellationResult ??= raceWithSignal((async () => target.cancelPublic!(request))(), AbortSignal.timeout(100))
            .then(() => undefined, () => undefined);
        };
        timeout.signal.addEventListener('abort', cancel, { once: true });
        let received = false;
        entry.promise = raceWithSignal((async () => target.acquirePublic!(request))(), timeout.signal).then(result => {
          received = true;
          if (generation !== parent.generation) throw new ProviderBudgetUnavailable(Math.max(parent.wallPause - Date.now(), 1000));
          this.validateGrant(provider, result);
          if (result.granted !== 0 && result.granted !== minimum) throw new ProviderBudgetUnavailable(1000);
          if (!result.granted) {
            entry.expired = result.issuedAtMs >= deadline;
            throw new ProviderBudgetUnavailable(Math.max(result.retryAfterMs, 1000));
          }
          const wallNow = Date.now(), monotonicNow = performance.now();
          if (wallNow >= deadline || monotonicNow >= monotonicDeadline) {
            entry.expired = true;
            throw new ProviderBudgetUnavailable(1000);
          }
          const pause = Math.max(parent.wallPause - wallNow, parent.monotonicPause - monotonicNow);
          if (pause > 0) throw new ProviderBudgetUnavailable(pause);
          const observedNow = Math.max(wallNow, wallStart + Math.max(0, monotonicNow - monotonicStart));
          const lifetime = Math.floor(Math.min(PROVIDER_BUDGETS[provider].leaseMs, result.expiresAtMs - observedNow));
          if (lifetime <= 0) throw new ProviderBudgetUnavailable(1000);
          this.addCredits(state, result.granted, wallNow + lifetime, monotonicNow + lifetime);
        }).catch(error => {
          entry.expired ||= timeout.timedOut();
          if (!received) entry.cancellation.abort(new Error('Public provider admission stopped.'));
          throw error instanceof ProviderBudgetUnavailable ? error : new ProviderBudgetUnavailable(1000);
        }).finally(() => {
          entry.settled = true;
          timeout.dispose();
          timeout.signal.removeEventListener('abort', cancel);
          if (state.acquisition === entry) state.acquisition = undefined;
        });
        state.acquisition = entry;
        pending = entry;
      }
      pending.waiters++;
      const timeout = createTimedAbortScope(signal, { timeoutMs: Math.max(1, remaining),
        timeoutMessage: 'Public provider admission timed out.' });
      try { await raceWithSignal(pending.promise, timeout.signal); }
      catch (error) {
        signal.throwIfAborted();
        if (timeout.timedOut()) throw new ProviderBudgetUnavailable(1000);
        if (!pending.expired || pending.request.deadlineMs >= deadline) throw error;
      } finally {
        timeout.dispose();
        pending.waiters--;
        if (!pending.waiters && !pending.settled) pending.cancellation.abort(new Error('Public provider admission cancelled.'));
        if (!pending.waiters) await pending.cancellationResult;
      }
    }
  }

  async take(provider: ProviderName, lane: ProviderLane, cost: number, signal: AbortSignal): Promise<void> {
    await this.grant(provider, lane, cost, cost, signal);
  }

  async grant(provider: ProviderName, lane: ProviderLane, minimum: number, wanted: number, signal: AbortSignal): Promise<ProviderBudgetGrant> {
    requireRequest({ provider, lane, minimum, wanted });
    signal.throwIfAborted();
    if (!this.namespace) {
      const now = Date.now();
      return { granted: wanted, issuedAtMs: now, expiresAtMs: now + PROVIDER_BUDGETS[provider].leaseMs, retryAfterMs: 0, grantId: crypto.randomUUID() };
    }
    const parent = this.provider(provider);
    const pause = Math.max(parent.wallPause - Date.now(), parent.monotonicPause - performance.now());
    const state = this.lane(parent, lane);
    if (pause > 0) throw this.unavailable(provider, parent, state, minimum, pause);
    const retryRemaining = () => minimum >= state.retryMinimum
      ? Math.max(state.retryWallExpiry - Date.now(), state.retryMonotonicExpiry - performance.now(), 0) : 0;
    if (this.remainingCredits(state) < minimum && retryRemaining() > 0) throw this.unavailable(provider, parent, state, minimum, retryRemaining());
    if (this.remainingCredits(state) < minimum && !state.refill) {
      const target = state;
      const generation = parent.generation;
      const wallStart = Date.now(), monotonicStart = performance.now();
      const config = PROVIDER_BUDGETS[provider];
      const requested = Math.max(minimum, Math.min(this.maxQuantum ?? config.maxGrant, config.maxGrant));
      const operation = (async () => this.namespace!.getByName(provider).grant({ provider, lane, minimum, wanted: requested, requestId: crypto.randomUUID() }))();
      const refill = raceWithSignal(operation, AbortSignal.timeout(1000))
        .then(result => {
          if (generation !== parent.generation) throw new ProviderBudgetUnavailable(Math.max(parent.wallPause - Date.now(), 1));
          this.validateGrant(provider, result);
          const wallNow = Date.now(), monotonicNow = performance.now();
          const observedNow = Math.max(wallNow, wallStart + Math.max(0, monotonicNow - monotonicStart));
          const lifetime = Math.floor(Math.min(config.leaseMs, result.expiresAtMs - observedNow));
          this.addCredits(target, result.granted, wallNow + lifetime, monotonicNow + lifetime);
          target.retryMinimum = minimum;
          target.retryWallExpiry = result.retryAfterMs > 0 ? result.issuedAtMs + result.retryAfterMs : 0;
          target.retryMonotonicExpiry = result.retryAfterMs > 0
            ? performance.now() + Math.max(0, target.retryWallExpiry - Date.now()) : 0;
        }).catch(error => {
          throw error instanceof ProviderBudgetUnavailable ? error : new ProviderBudgetUnavailable();
        }).finally(() => { if (target.refill === refill) target.refill = undefined; });
      state.refill = refill;
    }
    if (this.remainingCredits(state) < minimum && state.refill) {
      try { await raceWithSignal(state.refill, signal); }
      catch (error) {
        signal.throwIfAborted();
        if (this.remainingCredits(state) < minimum) throw error;
      }
    }
    signal.throwIfAborted();
    if (this.remainingCredits(state) < minimum) throw this.unavailable(provider, parent, state, minimum, retryRemaining());
    const granted = Math.min(wanted, state.credits);
    const now = Date.now();
    const expiresAtMs = Math.min(state.wallExpiry, now + Math.floor(state.monotonicExpiry - performance.now()));
    if (expiresAtMs <= now) throw this.unavailable(provider, parent, state, minimum, 1);
    state.credits -= granted;
    return { granted, issuedAtMs: now, expiresAtMs,
      retryAfterMs: 0, grantId: crypto.randomUUID() };
  }

  async reportThrottle(provider: ProviderName, retryAfterMs: number): Promise<void> {
    requireProvider(provider);
    const delay = new ProviderBudgetUnavailable(retryAfterMs).retryAfterMs;
    const state = this.provider(provider);
    state.generation++;
    state.wallPause = Math.max(state.wallPause, Date.now() + delay);
    state.monotonicPause = Math.max(state.monotonicPause, performance.now() + delay);
    for (const lane of state.lanes.values()) {
      lane.credits = 0;
      lane.acquisition?.cancellation.abort(new Error('Public provider admission superseded by cooldown.'));
    }
    if (!this.namespace) return;
    try { await this.namespace.getByName(provider).reportThrottle({ provider, retryAfterMs: delay }); }
    catch { throw new ProviderBudgetUnavailable(delay); }
  }
}
