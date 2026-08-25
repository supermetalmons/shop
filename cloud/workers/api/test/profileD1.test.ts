import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ensureD1Profile,
  loadD1Profile,
  profileD1TestHooks,
} from '../src/profileD1.ts';

const WALLET = '11111111111111111111111111111111';

test('D1 writes retry recognized transient failures once', async () => {
  let attempts = 0;
  const result = await profileD1TestHooks.runD1Write(undefined, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('D1_ERROR: Network connection lost');
    return 'saved';
  });
  assert.equal(result, 'saved');
  assert.equal(attempts, 2);
});

test('D1 writes do not retry permanent failures', async () => {
  let attempts = 0;
  await assert.rejects(
    profileD1TestHooks.runD1Write(undefined, async () => {
      attempts += 1;
      throw new Error('D1_ERROR: constraint failed');
    }),
    /constraint failed/,
  );
  assert.equal(attempts, 1);
});

test('an aborted request never starts a D1 write', async () => {
  let attempts = 0;
  await assert.rejects(
    profileD1TestHooks.runD1Write(AbortSignal.abort(new Error('stopped')), async () => {
      attempts += 1;
    }),
    /stopped/,
  );
  assert.equal(attempts, 0);
});

test('an in-flight D1 write reaches a definite outcome after the request deadline', async () => {
  const controller = new AbortController();
  const result = profileD1TestHooks.runD1Write(controller.signal, async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return 'saved';
  });
  setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), 5);
  assert.equal(await result, 'saved');
});

test('an in-flight transient D1 write retries after the request deadline', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const result = profileD1TestHooks.runD1Write(controller.signal, async () => {
    attempts += 1;
    if (attempts === 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error('D1_ERROR: storage caused object to be reset');
    }
    return 'saved';
  });
  setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), 5);
  assert.equal(await result, 'saved');
  assert.equal(attempts, 2);
});

test('profile creation does not perform a post-write read', async () => {
  let prepares = 0;
  const statement: D1PreparedStatement = {
    bind() {
      return this;
    },
    async first() {
      return assert.fail('profile creation performed a read');
    },
    async run() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return undefined as never;
    },
    async all() {
      return assert.fail('profile creation listed rows');
    },
    async raw() {
      return assert.fail('profile creation loaded raw rows');
    },
  };
  const db: D1Database = {
    prepare() {
      prepares += 1;
      return statement;
    },
    async batch() {
      return assert.fail('profile creation used a batch');
    },
    async exec() {
      return assert.fail('profile creation used exec');
    },
    withSession() {
      return assert.fail('profile creation used a session');
    },
    async dump() {
      return assert.fail('profile creation used dump');
    },
  };
  const controller = new AbortController();
  const result = ensureD1Profile(db, { wallet: WALLET, createdAtMs: 1, updatedAtMs: 1 }, controller.signal);
  setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), 5);
  await result;
  assert.equal(prepares, 1);
});

test('an in-flight D1 read is awaited after the request deadline', async () => {
  const row = { wallet: WALLET, email: null, created_at_ms: 1, updated_at_ms: 1 };
  const statement: D1PreparedStatement = {
    bind() {
      return this;
    },
    async first() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return row as never;
    },
    async run() {
      return assert.fail('profile read performed a write');
    },
    async all() {
      return assert.fail('profile read listed rows');
    },
    async raw() {
      return assert.fail('profile read loaded raw rows');
    },
  };
  const db: D1Database = {
    prepare: () => statement,
    async batch() {
      return assert.fail('profile read used a batch');
    },
    async exec() {
      return assert.fail('profile read used exec');
    },
    withSession() {
      return assert.fail('profile read used a session');
    },
    async dump() {
      return assert.fail('profile read used dump');
    },
  };
  const controller = new AbortController();
  const result = loadD1Profile(db, WALLET, controller.signal);
  setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), 5);
  assert.deepEqual(await result, { wallet: WALLET, createdAtMs: 1, updatedAtMs: 1 });
});
