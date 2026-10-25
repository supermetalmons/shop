import assert from 'node:assert/strict';
import test from 'node:test';
import { logoutSolanaSessions } from '../src/lib/logoutSolanaSessions.ts';
import type { StaffWalletSession } from '../src/lib/staffWalletSession.ts';

const SESSION: StaffWalletSession = {
  wallet: 'staff-wallet', token: 'staff-token', refreshedAt: 1, expiresAt: 2,
};

test('logout attempts both sessions and preserves each revocation failure', async (t) => {
  for (const failed of ['anonymous', 'staff', 'both'] as const) {
    await t.test(failed, async () => {
      const anonymousError = new Error('Anonymous logout unavailable');
      const staffError = new Error('Staff logout unavailable');
      const calls: string[] = [];
      await assert.rejects(logoutSolanaSessions({
        readStaffWalletSession: () => SESSION,
        logoutAnonymousSession: async () => {
          calls.push('anonymous');
          if (failed !== 'staff') throw anonymousError;
        },
        logoutStaffWalletSession: async (session) => {
          calls.push('staff');
          assert.equal(session, SESSION);
          if (failed !== 'anonymous') throw staffError;
        },
      }), (error: unknown) => {
        if (failed === 'both') {
          assert.ok(error instanceof AggregateError);
          assert.deepEqual(error.errors, [anonymousError, staffError]);
        } else {
          assert.equal(error, failed === 'anonymous' ? anonymousError : staffError);
        }
        return true;
      });
      assert.deepEqual(calls, ['anonymous', 'staff']);
    });
  }
});

test('logout passes the captured staff session when another session replaces it', async () => {
  let current = SESSION;
  let revoked: StaffWalletSession | null = null;
  const replacement = { ...SESSION, token: 'replacement-token' };
  await logoutSolanaSessions({
    readStaffWalletSession: () => current,
    logoutAnonymousSession: async () => { current = replacement; },
    logoutStaffWalletSession: async (session) => { revoked = session ?? null; },
  });
  assert.equal(revoked, SESSION);
  assert.equal(current, replacement);
});

test('logout ends the anonymous session without requesting a nonexistent staff logout', async () => {
  let anonymousCalls = 0;
  await logoutSolanaSessions({
    readStaffWalletSession: () => null,
    logoutAnonymousSession: async () => { anonymousCalls += 1; },
    logoutStaffWalletSession: async () => { assert.fail('No staff session should be revoked'); },
  });
  assert.equal(anonymousCalls, 1);
});
