import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCommerceD1,
  createCommerceD1Harness,
  decodeLegacyFirestoreFixtureFields,
  seedCommerceDocument,
} from './commerceD1Harness.ts';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  PROFILE_RECONCILE_PATH,
  SOLANA_AUTH_PATH,
  handleProfileLifecycleRequest,
  type ProfileLifecyclePath,
} from '../src/profileLifecycle.ts';
import {
  AuthWalletBindingD1BusyError,
  AuthWalletBindingD1SupersededError,
} from '../src/authWalletBindingD1.ts';
import {
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceKeys,
  isCommerceDeleteField,
  isCommerceServerTimestamp,
  type CommerceDocumentRecord,
  type CommerceQuery,
  type CommerceUpdateValue,
} from '../src/commerceRepository.ts';

const UID = 'auth-lifecycle-user';
const NOW_MS = Date.parse('2026-08-20T12:00:00.000Z');
const KEYPAIR = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const OWNER = bs58.encode(KEYPAIR.publicKey);
const OTHER = 'So11111111111111111111111111111111111111112';
const DOCUMENT_PREFIX = 'projects/mons-shop/databases/(default)/documents/';

type StoredDocument = {
  fields: Record<string, unknown>;
  name: string;
  updateTime: string;
};

function commerceValue(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number') return { integerValue: String(value) };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(commerceValue) } };
  if (value && typeof value === 'object') {
    return {
      mapValue: {
        fields: Object.fromEntries(Object.entries(value as Record<string, unknown>).map(
          ([key, entry]) => [key, commerceValue(entry)],
        )),
      },
    };
  }
  return { nullValue: null };
}

function document(path: string, fields: Record<string, unknown>, version: number): StoredDocument {
  return {
    name: `${DOCUMENT_PREFIX}${path}`,
    fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, commerceValue(value)])),
    updateTime: `2026-08-20T12:00:${String(version).padStart(2, '0')}.000Z`,
  };
}

function decodedFields(value: unknown): Record<string, unknown> {
  const fields = (value as { fields?: Record<string, Record<string, unknown>> }).fields || {};
  return Object.fromEntries(Object.entries(fields).map(([key, entry]) => {
    if (typeof entry.stringValue === 'string') return [key, entry.stringValue];
    if (typeof entry.integerValue === 'string') return [key, Number(entry.integerValue)];
    return [key, entry];
  }));
}

class LegacyFirestoreCommerceHarness {
  session: StoredDocument | null = document(`authSessions/${UID}`, { wallet: OWNER }, 1);
  orders: StoredDocument[] = [];
  transactions = new Map<string, { session: StoredDocument | null; orders: StoredDocument[] }>();
  transactionCounter = 0;
  version = 2;
  transactionConflicts = 0;
  authConflicts = 0;
  rebindAfterMergeCommits = 0;
  sessionChangeBeforeAuthCommit: string | null = null;
  rollbackCount = 0;
  sessionReads = 0;

  snapshotDocument(entry: StoredDocument | null): StoredDocument | null {
    return entry ? structuredClone(entry) : null;
  }

  responseDocument(entry: StoredDocument): Response {
    return Response.json(entry);
  }

  applyUpdate(write: Record<string, unknown>): void {
    const update = write.update as { name: string; fields: Record<string, unknown> };
    const path = update.name.slice(DOCUMENT_PREFIX.length);
    const fields = decodedFields(update);
    if (path === `authSessions/${UID}`) {
      this.session = document(path, { ...(this.session ? decodedFields(this.session) : {}), ...fields }, this.version++);
      return;
    }
    const index = this.orders.findIndex((entry) => entry.name === update.name);
    if (index < 0) throw new Error('missing order');
    this.orders[index] = document(path, { ...decodedFields(this.orders[index]), ...fields }, this.version++);
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.pathname.endsWith('/documents:beginTransaction')) {
      const id = `transaction-${++this.transactionCounter}`;
      this.transactions.set(id, {
        session: this.snapshotDocument(this.session),
        orders: structuredClone(this.orders),
      });
      return Response.json({ transaction: id });
    }
    if (url.pathname.endsWith('/documents:rollback')) {
      this.transactions.delete(String(body.transaction));
      this.rollbackCount += 1;
      return Response.json({});
    }
    if (url.pathname.endsWith(`/authSessions/${UID}`)) {
      this.sessionReads += 1;
      const transaction = url.searchParams.get('transaction');
      const value = transaction ? this.transactions.get(transaction)?.session ?? null : this.session;
      return value ? this.responseDocument(value) : Response.json({ error: 'missing' }, { status: 404 });
    }
    if (url.pathname.endsWith('/documents:runQuery')) {
      const transaction = typeof body.transaction === 'string' ? body.transaction : null;
      const source = transaction ? this.transactions.get(transaction)?.orders || [] : this.orders;
      const queryText = JSON.stringify(body);
      const ownerMatch = queryText.match(/"stringValue":"([^"]+)"/);
      const owner = ownerMatch?.[1] || '';
      let matches = source.filter((entry) => decodedFields(entry).owner === owner);
      if (queryText.includes('processing') && queryText.includes('prepared')) {
        matches = matches.filter((entry) => ['processing', 'prepared'].includes(String(decodedFields(entry).status)));
      } else {
        matches = matches.slice(0, 450);
      }
      return Response.json(matches.length ? matches.map((entry) => ({ document: entry })) : [{ readTime: '2026-08-20T12:00:00Z' }]);
    }
    if (url.pathname.endsWith('/documents:commit')) {
      const writes = Array.isArray(body.writes) ? body.writes as Record<string, unknown>[] : [];
      if (typeof body.transaction === 'string') {
        if (this.transactionConflicts > 0) {
          this.transactionConflicts -= 1;
          return Response.json({ error: { status: 'ABORTED' } }, { status: 409 });
        }
        writes.forEach((write) => this.applyUpdate(write));
        this.transactions.delete(body.transaction);
        if (writes.length && this.rebindAfterMergeCommits > 0) {
          this.rebindAfterMergeCommits -= 1;
          this.session = document(`authSessions/${UID}`, { wallet: OTHER }, this.version++);
        }
        return Response.json({ writeResults: writes.map(() => ({})), commitTime: '2026-08-20T12:00:00Z' });
      }
      if (this.sessionChangeBeforeAuthCommit) {
        this.session = document(`authSessions/${UID}`, { wallet: this.sessionChangeBeforeAuthCommit }, this.version++);
        this.sessionChangeBeforeAuthCommit = null;
        return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 409 });
      }
      if (this.authConflicts > 0) {
        this.authConflicts -= 1;
        return Response.json({ error: { status: 'ABORTED' } }, { status: 409 });
      }
      const sessionWrite = writes.find((write) => String((write.update as { name?: string })?.name).includes('/authSessions/'));
      const precondition = sessionWrite?.currentDocument as { exists?: boolean; updateTime?: string } | undefined;
      if (
        (precondition?.exists === false && this.session) ||
        (precondition?.updateTime && precondition.updateTime !== this.session?.updateTime)
      ) {
        return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 409 });
      }
      writes.forEach((write) => this.applyUpdate(write));
      return Response.json({ writeResults: writes.map(() => ({})), commitTime: '2026-08-20T12:00:00Z' });
    }
    throw new Error(`Unexpected Commerce request: ${url}`);
  }
}

function legacyFirestoreFixtureRepository(harness: LegacyFirestoreCommerceHarness) {
  const record = (entry: StoredDocument): CommerceDocumentRecord => {
    const path = entry.name.slice(DOCUMENT_PREFIX.length);
    const match = path.match(/^drops\/([^/]+)\/deliveryOrders\/([^/]+)$/);
    const key = match
      ? commerceKeys.deliveryOrder(match[1], match[2])
      : { ...commerceKeys.deliveryOrder('invalid', 'invalid'), path };
    return {
      createTime: entry.updateTime,
      data: (decodeLegacyFirestoreFixtureFields(entry.fields) || {}) as never,
      key,
      processedAt: null,
      updateTime: entry.updateTime,
      version: 1,
    };
  };
  const matches = (entry: CommerceDocumentRecord, query: CommerceQuery) =>
    (query.filters || []).every((filter) => {
      const value = entry.data[filter.field];
      return filter.op === 'equal'
        ? value === filter.value
        : Array.isArray(filter.value) && filter.value.includes(value as never);
    });
  return {
    query: async (query: CommerceQuery) => harness.orders.map(record).filter((entry) => matches(entry, query)),
    run: async <T>(_nowMs: number, operation: (unit: unknown) => Promise<T>) => {
      const staged = new Map<string, Record<string, CommerceUpdateValue>>();
      const unit = {
        query: async (query: CommerceQuery) => harness.orders.map(record)
          .filter((entry) => matches(entry, query)).slice(0, query.limit),
        update: async (key: { path: string }, updates: Record<string, CommerceUpdateValue>) => {
          staged.set(key.path, updates);
        },
      };
      const result = await operation(unit as never);
      if (harness.transactionConflicts > 0) {
        harness.transactionConflicts -= 1;
        throw new CommerceWriteConflict();
      }
      for (const [path, updates] of staged) {
        const index = harness.orders.findIndex((entry) => entry.name === `${DOCUMENT_PREFIX}${path}`);
        if (index < 0) throw new Error('missing order');
        const fields = decodeLegacyFirestoreFixtureFields(harness.orders[index].fields) || {};
        for (const [fieldPath, update] of Object.entries(updates)) {
          if (isCommerceServerTimestamp(update)) {
            fields[fieldPath] = NOW_MS;
            continue;
          }
          if (isCommerceDeleteField(update)) {
            delete fields[fieldPath];
            continue;
          }
          fields[fieldPath] = update;
        }
        harness.orders[index] = document(path, fields, harness.version++);
      }
      if (staged.size && harness.rebindAfterMergeCommits > 0) {
        harness.rebindAfterMergeCommits -= 1;
        harness.session = document(`authSessions/${UID}`, { wallet: OTHER }, harness.version++);
      }
      return result;
    },
  };
}

function dependencies(
  harness: LegacyFirestoreCommerceHarness,
  timeoutMs = 500,
  overrides: Partial<Parameters<typeof handleProfileLifecycleRequest>[3]> = {},
): Parameters<typeof handleProfileLifecycleRequest>[3] {
  const d1Session = () => harness.session
    ? {
        authSubject: UID,
        wallet: String(decodedFields(harness.session).wallet || ''),
        updatedAtMs: NOW_MS,
        revision: harness.version,
        reconcileLeaseId: null,
        reconcileLeaseExpiresAtMs: null,
      }
    : null;
  return {
    createCommerceRepository: () => legacyFirestoreFixtureRepository(harness) as never,
    acquireAuthWalletBindingReconcileLease: async () => {
      const session = d1Session();
      return session ? {
        id: '00000000-0000-4000-8000-000000000001',
        wallet: session.wallet,
        expiresAtMs: NOW_MS + 120_000,
      } : null;
    },
    establishD1AuthWalletBinding: async (args) => {
      harness.session = document(`authSessions/${UID}`, { wallet: args.wallet }, harness.version++);
      return d1Session()!;
    },
    loadD1AuthWalletBinding: async () => d1Session(),
    nowMs: () => NOW_MS,
    providerFetch: harness.fetch.bind(harness),
    releaseAuthWalletBindingReconcileLease: async () => undefined,
    resolveD1AuthWalletBinding: async () => {
      const session = d1Session();
      return session
        ? { wallet: session.wallet, source: 'binding' as const }
        : { wallet: null, reason: 'missing-binding' as const };
    },
    timeoutMs,
    upsertProfile: async () => undefined,
    verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: UID }),
    ...overrides,
  };
}

function request(path: ProfileLifecyclePath, body: unknown, origin = 'https://mons.shop'): Request {
  return new Request(`https://api.mons.shop${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer token',
      'Content-Type': 'application/json',
      Origin: origin,
    },
    body: JSON.stringify(body),
  });
}

function signInBody(args: { domain?: string; keypair?: nacl.SignKeyPair; timestamp?: string } = {}) {
  const keypair = args.keypair || KEYPAIR;
  const wallet = bs58.encode(keypair.publicKey);
  const message = `Sign in to mons.shop as ${wallet}\nDomain: ${args.domain || 'mons.shop'}\nTimestamp: ${args.timestamp || '2026-08-20T12:00:00.000Z'}\nSession: ${UID}`;
  return {
    wallet,
    message,
    signature: Array.from(nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey)),
  };
}

function env(): Pick<Env, 'COMMERCE_DB' | 'OPS_DB'> {
  return {
    COMMERCE_DB: createCommerceD1(),
    OPS_DB: {} as D1Database,
  };
}

test('Solana auth validates origin-bound signatures and persists the D1 session and profile', async () => {
  const harness = new LegacyFirestoreCommerceHarness();
  let profile: Record<string, unknown> | undefined;
  const result = await handleProfileLifecycleRequest(
    request(SOLANA_AUTH_PATH, signInBody()),
    env(),
    SOLANA_AUTH_PATH,
    dependencies(harness, 500, {
      upsertProfile: async (_db, input) => {
        profile = input;
      },
    }),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), { wallet: OWNER });
  assert.equal(decodedFields(harness.session!).wallet, OWNER);
  assert.deepEqual(profile, {
    wallet: OWNER,
    createdAtMs: NOW_MS,
    updatedAtMs: NOW_MS,
  });

  for (const authRequest of [
    request(SOLANA_AUTH_PATH, signInBody({ domain: 'www.mons.shop' })),
    request(SOLANA_AUTH_PATH, signInBody(), ''),
    request(SOLANA_AUTH_PATH, { ...signInBody(), signature: Array(64).fill(0) }),
  ]) {
    const rejected = await handleProfileLifecycleRequest(authRequest, env(), SOLANA_AUTH_PATH, dependencies(new LegacyFirestoreCommerceHarness()));
    assert.ok([401, 403].includes(rejected.response.status));
  }
});

test('Solana auth keeps its committed session retryable when D1 profile persistence fails', async () => {
  const harness = new LegacyFirestoreCommerceHarness();
  const result = await handleProfileLifecycleRequest(
    request(SOLANA_AUTH_PATH, signInBody()),
    env(),
    SOLANA_AUTH_PATH,
    dependencies(harness, 500, {
      upsertProfile: async () => {
        throw new Error('private D1 failure');
      },
    }),
  );
  assert.equal(result.response.status, 503);
  assert.deepEqual(await result.response.json(), {
    ok: false,
    error: { code: 'unavailable', message: 'Profile data is temporarily unavailable.' },
  });
  assert.equal(decodedFields(harness.session!).wallet, OWNER);
});

test('Solana auth applies the request deadline to D1 profile persistence', async () => {
  const result = await handleProfileLifecycleRequest(
    request(SOLANA_AUTH_PATH, signInBody()),
    env(),
    SOLANA_AUTH_PATH,
    dependencies(new LegacyFirestoreCommerceHarness(), 5, {
      upsertProfile: async (_db, _profile, signal) => new Promise((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    }),
  );
  assert.equal(result.response.status, 504);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'deadline-exceeded');
});

test('D1 wallet-session mode persists without Commerce session access', async () => {
  const d1Harness = new LegacyFirestoreCommerceHarness();
  let establishedWallet = '';
  const d1 = await handleProfileLifecycleRequest(
    request(SOLANA_AUTH_PATH, signInBody()),
    { ...env(), OPS_DB: {} as D1Database },
    SOLANA_AUTH_PATH,
    dependencies(d1Harness, 500, {
      establishD1AuthWalletBinding: async (args) => {
        establishedWallet = args.wallet;
        return {
          authSubject: args.authSubject,
          wallet: args.wallet,
          updatedAtMs: args.nowMs,
          revision: 1,
          reconcileLeaseId: null,
          reconcileLeaseExpiresAtMs: null,
        };
      },
      loadD1AuthWalletBinding: async () => null,
    }),
  );
  assert.equal(d1.response.status, 200);
  assert.equal(establishedWallet, OWNER);
  assert.equal(d1Harness.sessionReads, 0);
});

test('Solana auth preserves D1 superseded and busy response contracts', async () => {
  const superseded = await handleProfileLifecycleRequest(
    request(SOLANA_AUTH_PATH, signInBody()),
    env(),
    SOLANA_AUTH_PATH,
    dependencies(new LegacyFirestoreCommerceHarness(), 500, {
      establishD1AuthWalletBinding: async () => { throw new AuthWalletBindingD1SupersededError(); },
    }),
  );
  assert.equal(superseded.response.status, 409);
  assert.deepEqual(await superseded.response.json(), {
    ok: false,
    error: {
      code: 'failed-precondition',
      message: 'A newer wallet sign-in superseded this request. Sign in again.',
      details: { reason: 'wallet-session-superseded' },
    },
  });

  const busy = await handleProfileLifecycleRequest(
    request(SOLANA_AUTH_PATH, signInBody()),
    env(),
    SOLANA_AUTH_PATH,
    dependencies(new LegacyFirestoreCommerceHarness(), 500, {
      establishD1AuthWalletBinding: async () => { throw new AuthWalletBindingD1BusyError(); },
    }),
  );
  assert.equal(busy.response.status, 409);
  assert.deepEqual(await busy.response.json(), {
    ok: false,
    error: { code: 'aborted', message: 'Wallet session is busy. Try again.' },
  });
});

test('D1 reconciliation holds and releases its lease without reading Commerce sessions', async () => {
  const identityHarness = new LegacyFirestoreCommerceHarness();
  const commerceHarness = createCommerceD1Harness();
  const orderKey = commerceKeys.deliveryOrder('drop', '1');
  seedCommerceDocument(commerceHarness, {
    key: orderKey,
    data: {
      authSubject: UID,
      mergedAuthSubject: UID,
      owner: `anonymous:${UID}`,
      status: 'ready_to_ship',
    },
    version: 3,
  });
  let released = false;
  const result = await handleProfileLifecycleRequest(
    request(PROFILE_RECONCILE_PATH, { mergeStripeDeliveryOrders: true, includeDeliveryRecovery: false }),
    { ...env(), COMMERCE_DB: commerceHarness.db, OPS_DB: {} as D1Database },
    PROFILE_RECONCILE_PATH,
    dependencies(identityHarness, 500, {
      acquireAuthWalletBindingReconcileLease: async () => ({
        id: '00000000-0000-4000-8000-000000000001',
        wallet: OWNER,
        expiresAtMs: NOW_MS + 120_000,
      }),
      createCommerceRepository: (database) => new D1CommerceRepository(database),
      releaseAuthWalletBindingReconcileLease: async () => {
        released = true;
      },
    }),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), { mergedStripeDeliveryOrders: 1 });
  assert.equal(identityHarness.sessionReads, 0);
  assert.equal(released, true);
  assert.deepEqual((await new D1CommerceRepository(commerceHarness.db).get(orderKey))?.data, {
    authSubject: UID,
    mergedAuthSubject: UID,
    owner: OWNER,
    ownerKind: 'wallet',
    ownerMergedAt: NOW_MS,
    previousOwner: `anonymous:${UID}`,
    status: 'ready_to_ship',
  });
});

test('staff reconciliation uses its wallet directly and skips legacy Auth order merging', async () => {
  const result = await handleProfileLifecycleRequest(
    request(PROFILE_RECONCILE_PATH, { mergeStripeDeliveryOrders: true, includeDeliveryRecovery: false }),
    env(),
    PROFILE_RECONCILE_PATH,
    dependencies(new LegacyFirestoreCommerceHarness(), 500, {
      acquireAuthWalletBindingReconcileLease: async () => assert.fail('staff identity acquired a Auth reconciliation lease'),
      resolveD1AuthWalletBinding: async () => assert.fail('staff identity resolved a Auth wallet session'),
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: OWNER }),
    }),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), { mergedStripeDeliveryOrders: 0 });
});

test('staff principals cannot enter the Auth wallet-binding route', async () => {
  const result = await handleProfileLifecycleRequest(
    request(SOLANA_AUTH_PATH, signInBody()),
    env(),
    SOLANA_AUTH_PATH,
    dependencies(new LegacyFirestoreCommerceHarness(), 500, {
      loadD1AuthWalletBinding: async () => assert.fail('staff identity reached Auth wallet-session loading'),
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: OWNER }),
    }),
  );
  assert.equal(result.response.status, 403);
  assert.deepEqual(await result.response.json(), {
    ok: false,
    error: { code: 'permission-denied', message: 'Staff wallets use staff authentication.' },
  });
});

test('anonymous principals cannot bind an allowlisted staff wallet', async () => {
  const result = await handleProfileLifecycleRequest(
    request(SOLANA_AUTH_PATH, signInBody()),
    env(),
    SOLANA_AUTH_PATH,
    dependencies(new LegacyFirestoreCommerceHarness(), 500, {
      isStaffWallet: (wallet) => wallet === OWNER,
      loadD1AuthWalletBinding: async () => assert.fail('allowlisted staff wallet reached Auth wallet-session loading'),
    }),
  );
  assert.equal(result.response.status, 403);
  assert.deepEqual(await result.response.json(), {
    ok: false,
    error: { code: 'permission-denied', message: 'Staff wallets use staff authentication.' },
  });
});

test('profile reconciliation merges multiple session-validated batches and is idempotent', async () => {
  const identityHarness = new LegacyFirestoreCommerceHarness();
  let authorityReads = 0;
  const commerceHarness = createCommerceD1Harness({
    observeStatement: ({ method, sql }) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (
        method === 'first' &&
        normalized.includes('FROM commerce_authority_control')
      ) authorityReads += 1;
    },
  });
  for (let index = 1; index <= 451; index += 1) {
    seedCommerceDocument(commerceHarness, {
      key: commerceKeys.deliveryOrder('drop', String(index)),
      data: { owner: `anonymous:${UID}`, status: 'ready_to_ship' },
    });
  }
  const otherKey = commerceKeys.deliveryOrder('drop', '999');
  seedCommerceDocument(commerceHarness, {
    key: otherKey,
    data: { owner: 'anonymous:another-user', status: 'ready_to_ship' },
  });
  let releases = 0;
  const d1Dependencies = dependencies(identityHarness, 2_000, {
    acquireAuthWalletBindingReconcileLease: async () => ({
      id: '00000000-0000-4000-8000-000000000001',
      wallet: OWNER,
      expiresAtMs: NOW_MS + 120_000,
    }),
    createCommerceRepository: (database) => new D1CommerceRepository(database),
    releaseAuthWalletBindingReconcileLease: async () => {
      releases += 1;
    },
  });
  const d1Env = { ...env(), COMMERCE_DB: commerceHarness.db, OPS_DB: {} as D1Database };
  const first = await handleProfileLifecycleRequest(
    request(PROFILE_RECONCILE_PATH, { mergeStripeDeliveryOrders: true, includeDeliveryRecovery: false }),
    d1Env,
    PROFILE_RECONCILE_PATH,
    d1Dependencies,
  );
  assert.equal(first.response.status, 200);
  assert.deepEqual(await first.response.json(), { mergedStripeDeliveryOrders: 451 });
  assert.equal(authorityReads, 2);
  assert.equal(releases, 1);
  assert.equal(
    commerceHarness.database.prepare('SELECT COUNT(*) AS count FROM commerce_documents WHERE owner = ?').get(OWNER)!.count,
    451,
  );
  assert.equal((await new D1CommerceRepository(commerceHarness.db).get(otherKey))?.data.owner, 'anonymous:another-user');
  authorityReads = 0;
  const second = await handleProfileLifecycleRequest(
    request(PROFILE_RECONCILE_PATH, { mergeStripeDeliveryOrders: true, includeDeliveryRecovery: false }),
    d1Env,
    PROFILE_RECONCILE_PATH,
    d1Dependencies,
  );
  assert.deepEqual(await second.response.json(), { mergedStripeDeliveryOrders: 0 });
  assert.equal(authorityReads, 2);
  assert.equal(releases, 2);
});

test('profile reconciliation retries transaction conflicts', async () => {
  const retry = new LegacyFirestoreCommerceHarness();
  retry.orders.push(document('drops/drop/deliveryOrders/1', { owner: `anonymous:${UID}`, status: 'ready_to_ship' }, 3));
  retry.transactionConflicts = 1;
  const retryResult = await handleProfileLifecycleRequest(
    request(PROFILE_RECONCILE_PATH, { mergeStripeDeliveryOrders: true, includeDeliveryRecovery: false }),
    env(),
    PROFILE_RECONCILE_PATH,
    dependencies(retry),
  );
  assert.deepEqual(await retryResult.response.json(), { mergedStripeDeliveryOrders: 1 });
});

test('profile reconciliation rejects invalid collection-group paths before writes and returns recovery timing', async () => {
  const invalid = new LegacyFirestoreCommerceHarness();
  invalid.orders.push(document('archives/drop/deliveryOrders/1', { owner: `anonymous:${UID}`, status: 'processing' }, 3));
  const invalidResult = await handleProfileLifecycleRequest(
    request(PROFILE_RECONCILE_PATH, { mergeStripeDeliveryOrders: true }),
    env(),
    PROFILE_RECONCILE_PATH,
    dependencies(invalid),
  );
  assert.equal(invalidResult.response.status, 409);
  assert.equal(invalid.rollbackCount, 0);
  assert.equal(decodedFields(invalid.orders[0]).owner, `anonymous:${UID}`);

  const recovery = new LegacyFirestoreCommerceHarness();
  recovery.orders.push(document('drops/drop/deliveryOrders/1', {
    owner: OWNER,
    status: 'processing',
    createdAt: NOW_MS - 1_000,
    receiptRecovery: { lastAttemptAt: NOW_MS - 10_000 },
  }, 4));
  const recoveryResult = await handleProfileLifecycleRequest(
    request(PROFILE_RECONCILE_PATH, {}),
    env(),
    PROFILE_RECONCILE_PATH,
    dependencies(recovery),
  );
  assert.deepEqual(await recoveryResult.response.json(), {
    mergedStripeDeliveryOrders: 0,
    deliveryRecovery: { nextCheckAt: NOW_MS + 20_000 },
  });
});

test('profile lifecycle responses never expose credentials or bearer tokens', async () => {
  const response = await handleProfileLifecycleRequest(
    request(PROFILE_RECONCILE_PATH, {}),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_RECONCILE_PATH,
    {
      ...dependencies(new LegacyFirestoreCommerceHarness()),
      verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: UID }),
    },
  );
  const body = JSON.stringify(await response.response.json());
  assert.equal(response.response.status, 503);
  assert.equal(body.includes('Bearer token'), false);
  assert.equal(body.includes('private_key'), false);
});

test('profile lifecycle enforces exact bodies and stable deadlines', async () => {
  const malformed = await handleProfileLifecycleRequest(
    request(PROFILE_RECONCILE_PATH, { includeDeliveryRecovery: true, extra: true }),
    env(),
    PROFILE_RECONCILE_PATH,
    dependencies(new LegacyFirestoreCommerceHarness()),
  );
  assert.equal(malformed.response.status, 400);

  const timedOut = await handleProfileLifecycleRequest(
    request(PROFILE_RECONCILE_PATH, {}),
    env(),
    PROFILE_RECONCILE_PATH,
    {
      ...dependencies(new LegacyFirestoreCommerceHarness()),
      timeoutMs: 5,
      verifyIdentity: async (_authorization, _providerFetch, signal) => new Promise((_resolve, reject) => {
        const fail = () => reject(signal.reason);
        signal.addEventListener('abort', fail, { once: true });
        if (signal.aborted) fail();
      }),
    },
  );
  assert.equal(timedOut.response.status, 504);
  assert.equal((await timedOut.response.json() as { error: { code: string } }).error.code, 'deadline-exceeded');
});
