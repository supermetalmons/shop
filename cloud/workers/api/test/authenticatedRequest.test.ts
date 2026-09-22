import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAuthenticatedRequestError, withAuthenticatedRequest } from '../src/authenticatedRequest.ts';
import { ProfileReadError, type ApiErrorCode } from '../src/dataAccess.ts';
import { DeliveryPrepareError } from '../src/deliveryPrepareErrors.ts';
import { RequestIdentityError, verifyRequestIdentity } from '../src/requestIdentity.ts';

type RequestOptions = Parameters<typeof withAuthenticatedRequest>[1];

type ClassificationOptions = Parameters<typeof classifyAuthenticatedRequestError>[1];

function classificationOptions(overrides: Partial<ClassificationOptions> = {}): ClassificationOptions {
  return {
    authenticated: true,
    timedOut: false,
    timeoutPrecedence: 'after-known-errors',
    timeoutMessage: 'Request timed out.',
    internalMessage: 'Request failed.',
    mapDomainError: (error) => error instanceof DeliveryPrepareError ? { error } : undefined,
    ...overrides,
  };
}

test('request errors preserve domain and profile details with their auth classification', () => {
  const cases: readonly [ApiErrorCode, 'rejected' | 'provider-failure'][] = [
    ['invalid-argument', 'rejected'],
    ['unauthenticated', 'rejected'],
    ['permission-denied', 'rejected'],
    ['not-found', 'rejected'],
    ['failed-precondition', 'rejected'],
    ['resource-exhausted', 'rejected'],
    ['aborted', 'provider-failure'],
    ['deadline-exceeded', 'provider-failure'],
    ['unavailable', 'provider-failure'],
    ['internal', 'provider-failure'],
  ];
  for (const [code, authOutcome] of cases) {
    const details = { itemId: 'item-1' };
    for (const error of [
      new DeliveryPrepareError(code, 'Original failure.', details),
      new ProfileReadError(code, 503, 'Original failure.', details),
    ]) {
      for (const authenticated of [true, false]) {
        const result = classifyAuthenticatedRequestError(error, classificationOptions({ authenticated }));
        assert.equal(result.error.code, code);
        assert.equal(result.error.message, 'Original failure.');
        assert.equal(result.error.details, details);
        assert.equal(result.authOutcome, authenticated ? authOutcome : 'rejected');
        assert.equal(result.unexpected, false);
      }
    }
  }
});

test('identity failures preserve provider classification before authentication finishes', () => {
  const cases = [
    ['invalid-token', 'unauthenticated', 'Authentication is required.', 'rejected'],
    ['provider-timeout', 'deadline-exceeded', 'Request timed out.', 'provider-failure'],
    ['provider-unavailable', 'unavailable', 'Authentication is temporarily unavailable.', 'provider-failure'],
  ] as const;
  for (const [kind, code, message, authOutcome] of cases) {
    for (const authenticated of [true, false]) {
      assert.deepEqual(
        classifyAuthenticatedRequestError(new RequestIdentityError(kind), classificationOptions({ authenticated })),
        { error: { code, message }, authOutcome, unexpected: false },
      );
    }
  }
});

test('request error classification preserves both timeout precedence policies', () => {
  for (const error of [
    new DeliveryPrepareError('not-found', 'Item missing.', { itemId: 'item-1' }),
    new ProfileReadError('unavailable', 503, 'Data unavailable.'),
    new RequestIdentityError('provider-unavailable'),
  ]) {
    for (const authenticated of [true, false]) {
      const baseOptions = classificationOptions({ authenticated });
      const expected = classifyAuthenticatedRequestError(error, baseOptions);
      assert.deepEqual(classifyAuthenticatedRequestError(error, {
        ...baseOptions,
        timedOut: true,
      }), expected);
      assert.deepEqual(classifyAuthenticatedRequestError(error, {
        ...baseOptions,
        timedOut: true,
        timeoutPrecedence: 'before-known-errors',
      }), {
        error: { code: 'deadline-exceeded', message: 'Request timed out.' },
        authOutcome: authenticated ? 'provider-failure' : 'rejected',
        unexpected: false,
      });
    }
  }
});

test('domain adapters can mark write conflicts rejected without changing other aborted errors', () => {
  const error = new DeliveryPrepareError('aborted', 'Write conflicted.');
  assert.equal(classifyAuthenticatedRequestError(error, classificationOptions()).authOutcome, 'provider-failure');
  assert.deepEqual(classifyAuthenticatedRequestError(error, classificationOptions({
    mapDomainError: (failure) => failure === error ? { error, authOutcome: 'rejected' } : undefined,
  })), { error, authOutcome: 'rejected', unexpected: false });
});

test('only unexpected failures request logging and expose the safe internal message', () => {
  for (const error of [new Error('Private provider details'), { code: 'permission-denied', message: 'Untrusted shape' }, null]) {
    for (const authenticated of [true, false]) {
      const authOutcome = authenticated ? 'provider-failure' : 'rejected';
      assert.deepEqual(classifyAuthenticatedRequestError(error, classificationOptions({ authenticated })), {
        error: { code: 'internal', message: 'Request failed.' },
        authOutcome,
        unexpected: true,
      });
      assert.deepEqual(classifyAuthenticatedRequestError(error, classificationOptions({ authenticated, timedOut: true })), {
        error: { code: 'deadline-exceeded', message: 'Request timed out.' },
        authOutcome,
        unexpected: false,
      });
    }
  }
});

function options(overrides: Partial<RequestOptions['dependencies']> = {}): RequestOptions {
  return {
    opsDb: undefined,
    timeoutMessage: 'Authenticated request timed out',
    dependencies: {
      nowMs: () => 1_700_000_000_000,
      providerFetch: async () => assert.fail('Unexpected provider fetch'),
      timeoutMs: 100,
      verifyIdentity: async () => ({ kind: 'anonymous', authSubject: 'subject' }),
      ...overrides,
    },
  };
}

test('authenticated requests verify identity and read the clock only when requested', async () => {
  const request = new Request('https://api.mons.shop/test');
  let clockReads = 0;
  let verificationCalls = 0;
  let requestSignal: AbortSignal | undefined;
  const identity = { kind: 'anonymous' as const, authSubject: 'subject' };
  const result = await withAuthenticatedRequest(request, options({
    nowMs: () => {
      clockReads += 1;
      return 123;
    },
    verifyIdentity: async (input, db, signal, nowMs) => {
      verificationCalls += 1;
      assert.equal(input, request);
      assert.equal(db, undefined);
      assert.equal(signal, requestSignal);
      assert.equal(nowMs, 123);
      return identity;
    },
  }), async ({ deadline, authenticate }) => {
    requestSignal = deadline.signal;
    assert.equal(clockReads, 0);
    assert.equal(verificationCalls, 0);
    return authenticate();
  });
  assert.equal(result, identity);
  assert.equal(clockReads, 1);
  assert.equal(verificationCalls, 1);

  await withAuthenticatedRequest(request, options({
    nowMs: () => assert.fail('Unused authentication read the clock'),
    verifyIdentity: async () => assert.fail('Unused authentication ran'),
  }), async () => undefined);
});

test('authenticated requests pass trusted staff context only when authentication is requested', async () => {
  const request = new Request('https://api.mons.shop/admin/profile', {
    headers: { Authorization: 'Bearer staff-session' },
  });
  const identity = { kind: 'staff-wallet' as const, wallet: 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz' };
  const authContext = { verifiedStaffIdentity: identity };
  let verificationCalls = 0;
  const result = await withAuthenticatedRequest(request, {
    ...options({
      verifyIdentity: async (input, database, signal, nowMs, context) => {
        verificationCalls += 1;
        assert.equal(input, request);
        assert.equal(context, authContext);
        return verifyRequestIdentity(input, database, signal, nowMs, context);
      },
    }),
    authContext,
  }, async ({ authenticate }) => {
    assert.equal(verificationCalls, 0);
    return authenticate();
  });
  assert.equal(result, identity);
  assert.equal(verificationCalls, 1);
  assert.equal(request.headers.get('Authorization'), 'Bearer staff-session');
});

test('authenticated request metrics include successful and throwing provider calls', async (context) => {
  let elapsed = 0;
  context.mock.method(performance, 'now', () => elapsed);
  const response = new Response('ok');
  const failure = new Error('Provider failed');
  let calls = 0;
  const metrics = await withAuthenticatedRequest(new Request('https://api.mons.shop/test'), options({
    providerFetch: () => {
      calls += 1;
      elapsed += calls === 1 ? 5 : 9;
      if (calls === 2) throw failure;
      return Promise.resolve(response);
    },
  }), async ({ trackedFetch, metrics }) => {
    assert.equal(await trackedFetch('https://provider.example/first'), response);
    await assert.rejects(trackedFetch('https://provider.example/second'), (error) => error === failure);
    return metrics;
  });
  assert.deepEqual(metrics, { upstreamCalls: 2, providerDurationMs: 14 });
});

test('authenticated requests dispose deadlines after success and failure', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const request = new Request('https://api.mons.shop/test');
  const signals: AbortSignal[] = [];
  const failure = new Error('Handler failed');
  const result = await withAuthenticatedRequest(request, options(), async ({ deadline }) => {
    signals.push(deadline.signal);
    return 'done';
  });
  assert.equal(result, 'done');
  await assert.rejects(withAuthenticatedRequest(request, options(), async ({ deadline }) => {
    signals.push(deadline.signal);
    throw failure;
  }), (error) => error === failure);
  context.mock.timers.tick(100);
  assert.equal(signals.length, 2);
  assert.equal(signals.every((signal) => !signal.aborted), true);
});

test('authenticated request deadlines signal the callback without racing its result', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: () => void;
  const operation = new Promise<void>((resolve) => { release = resolve; });
  let signal: AbortSignal | undefined;
  let settled = false;
  const pending = withAuthenticatedRequest(new Request('https://api.mons.shop/test'), options(), async ({ deadline }) => {
    signal = deadline.signal;
    await operation;
    return 'finished';
  });
  void pending.then(() => { settled = true; });
  context.mock.timers.tick(100);
  await Promise.resolve();
  assert.ok(signal?.aborted);
  assert.equal((signal.reason as Error).message, 'Authenticated request timed out');
  assert.equal(settled, false);
  release();
  assert.equal(await pending, 'finished');
});
