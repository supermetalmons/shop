import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import type { MiNoteEthereumSession } from '../shared/miNoteAuth.ts';
import type { miNoteAuthApi } from '../src/lib/miNoteAuthApi.ts';
import type { EIP1193Provider } from '../src/wallet/injectedEthereumProviders.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { useMiNoteVerification } = await import('../src/hooks/useMiNoteVerification.ts');
const STORAGE_KEY = 'mons.shop.mi-note.ethereum-session';
const ADDRESS = '0x000533f50ddd7f2fc4efd06137b0c1a12cfb7bb9';
const OTHER_ADDRESS = '0x1111111111111111111111111111111111111111';
const PREORDER = 'mi_note_cards_devnet';
const SIGNATURE = `0x${'12'.repeat(65)}`;
type Api = typeof miNoteAuthApi;
type Props = { active: boolean; preorderId: string; address: string | null; provider: EIP1193Provider | null };

afterEach(() => { cleanup(); window.sessionStorage.clear(); });
after(() => dom.window.close());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const session: MiNoteEthereumSession = {
    address: ADDRESS, token: 'verified-session', preorderId: PREORDER, expiresAtMs: Date.now() + 3_600_000,
  };
  const challenge = { challengeId: 'challenge-1', message: 'Verify Mi Note ownership.\nNonce: café 📝', expiresAtMs: Date.now() + 300_000 };
  const state = {
    chain: '0x1' as unknown, signature: SIGNATURE as unknown, accounts: [ADDRESS] as unknown,
    sign: null as null | (() => Promise<unknown>),
  };
  const calls = {
    wallet: [] as Parameters<EIP1193Provider['request']>[0][],
    challenge: [] as Parameters<Api['challenge']>[],
    verify: [] as Parameters<Api['verify']>[],
    logout: [] as string[],
  };
  const provider: EIP1193Provider = {
    request: async (request) => {
      calls.wallet.push(request);
      if (request.method === 'eth_chainId') return state.chain;
      if (request.method === 'personal_sign') return state.sign ? state.sign() : state.signature;
      if (request.method === 'eth_accounts') return state.accounts;
      throw new Error(`Unexpected wallet method ${request.method}`);
    },
  };
  const api: Api = {
    challenge: async (...args) => { calls.challenge.push(args); return challenge; },
    verify: async (...args) => { calls.verify.push(args); return session; },
    logout: async (token) => { calls.logout.push(token); },
  };
  const initial: Props = { active: true, preorderId: PREORDER, address: ADDRESS, provider };
  return { session, challenge, state, calls, provider, api, initial,
    render: (props = initial) => renderHook((value: Props) => useMiNoteVerification(value.active, value.preorderId, value, api), { initialProps: props }) };
}

test('verification signs the exact UTF-8 challenge and persists only the matching session', async () => {
  const h = fixture();
  h.state.accounts = ['0x000533f50ddd7f2fc4EfD06137b0c1A12CfB7Bb9'];
  const { result } = h.render();
  assert.deepEqual(h.calls.wallet, []);
  await act(async () => { await result.current.verify(); });
  assert.deepEqual(h.calls.challenge, [[PREORDER, ADDRESS, 1]]);
  assert.deepEqual(h.calls.wallet, [
    { method: 'eth_chainId' },
    { method: 'personal_sign', params: [`0x${Buffer.from(h.challenge.message).toString('hex')}`, ADDRESS] },
    { method: 'eth_accounts' },
  ]);
  assert.deepEqual(h.calls.verify, [[h.challenge.challengeId, SIGNATURE]]);
  assert.deepEqual(result.current.session, h.session);
  assert.deepEqual(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY)!), h.session);
  assert.equal(result.current.verifying, false);
  assert.equal(result.current.error, null);
});

test('inactive or disconnected verification cannot prompt or call the authentication API', async () => {
  const h = fixture();
  const { result, rerender } = h.render({ ...h.initial, active: false });
  await act(async () => { await result.current.verify(); });
  rerender({ ...h.initial, address: null });
  await act(async () => { await result.current.verify(); });
  rerender({ ...h.initial, provider: null });
  await act(async () => { await result.current.verify(); });
  assert.deepEqual(h.calls.wallet, []);
  assert.deepEqual(h.calls.challenge, []);
  assert.equal(result.current.session, null);
});

for (const mismatch of ['address', 'collection'] as const) {
  test(`the server cannot attach a session for a different ${mismatch} to this wallet`, async () => {
    const h = fixture();
    h.api.verify = async () => mismatch === 'address'
      ? { ...h.session, address: OTHER_ADDRESS } : { ...h.session, preorderId: 'mi_note_cards' };
    const { result } = h.render();
    await act(async () => { await result.current.verify(); });
    assert.equal(result.current.session, null);
    assert.equal(window.sessionStorage.getItem(STORAGE_KEY), null);
    assert.match(result.current.error!, /does not match this wallet/);
  });
}

for (const [code, message] of [[4001, /Signature cancelled/], [-32002, /request is already open/]] as const) {
  test(`wallet signature error ${code} leaves verification retryable`, async () => {
    const h = fixture();
    h.state.sign = async () => { throw { code }; };
    const { result } = h.render();
    await act(async () => { await result.current.verify(); });
    assert.match(result.current.error!, message);
    assert.equal(result.current.verifying, false);
    assert.equal(result.current.session, null);
    assert.equal(h.calls.verify.length, 0);
    assert.equal(window.sessionStorage.getItem(STORAGE_KEY), null);
    h.state.sign = null;
    await act(async () => { await result.current.verify(); });
    assert.deepEqual(result.current.session, h.session);
    assert.equal(result.current.error, null);
  });
}

for (const chain of [null, 1, '1', '0x0', '0xzz', '0x20000000000000']) {
  test(`invalid Ethereum chain ${String(chain)} cannot request a challenge or signature`, async () => {
    const h = fixture();
    h.state.chain = chain;
    const { result } = h.render();
    await act(async () => { await result.current.verify(); });
    assert.match(result.current.error!, /wallet network/);
    assert.deepEqual(h.calls.wallet, [{ method: 'eth_chainId' }]);
    assert.equal(h.calls.challenge.length, 0);
  });
}

test('a valid non-mainnet wallet chain is bound to the challenge without a network switch', async () => {
  const h = fixture();
  h.state.chain = '0xaa36a7';
  const { result } = h.render();
  await act(async () => { await result.current.verify(); });
  assert.equal(h.calls.challenge[0][2], 11155111);
  assert.deepEqual(result.current.session, h.session);
  assert.equal(h.calls.wallet.some((request) => request.method === 'wallet_switchEthereumChain'), false);
});

test('invalid signatures and a changed current account cannot verify server ownership', async () => {
  const h = fixture();
  const { result } = h.render();
  h.state.signature = '0x12';
  await act(async () => { await result.current.verify(); });
  assert.match(result.current.error!, /invalid signature/);
  h.state.signature = SIGNATURE;
  h.state.accounts = [OTHER_ADDRESS];
  await act(async () => { await result.current.verify(); });
  assert.match(result.current.error!, /account changed/);
  assert.equal(h.calls.verify.length, 0);
  assert.equal(result.current.session, null);
});

test('reload restores verification only after a matching connected wallet is available and never prompts', () => {
  const h = fixture();
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(h.session));
  const { result, rerender } = h.render({ ...h.initial, address: null, provider: null });
  assert.equal(result.current.session, null);
  rerender({ ...h.initial, address: null });
  assert.equal(result.current.session, null);
  rerender(h.initial);
  assert.deepEqual(result.current.session, h.session);
  assert.deepEqual(h.calls.wallet, []);
  assert.deepEqual(h.calls.challenge, []);
});

test('a remembered account without its connected provider cannot restore verification', () => {
  const h = fixture();
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(h.session));
  const { result } = h.render({ ...h.initial, provider: null });
  assert.equal(result.current.session, null);
  assert.deepEqual(h.calls.wallet, []);
});

for (const scenario of ['address', 'collection', 'expired', 'malformed'] as const) {
  test(`a ${scenario} saved session cannot be restored for the connected wallet`, () => {
    const h = fixture();
    const stored = scenario === 'address' ? { ...h.session, address: OTHER_ADDRESS }
      : scenario === 'collection' ? { ...h.session, preorderId: 'mi_note_cards' }
        : scenario === 'expired' ? { ...h.session, expiresAtMs: Date.now() - 1 } : { token: 'invalid' };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    const { result } = h.render();
    assert.equal(result.current.session, null);
    assert.deepEqual(h.calls.wallet, []);
  });
}

test('explicit invalidation clears storage and logs out even when the logout request fails', async () => {
  const h = fixture();
  h.api.logout = async (token) => { h.calls.logout.push(token); throw new Error('Offline'); };
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(h.session));
  const { result } = h.render();
  await act(async () => { result.current.invalidate(); });
  assert.equal(result.current.session, null);
  assert.equal(window.sessionStorage.getItem(STORAGE_KEY), null);
  assert.deepEqual(h.calls.logout, [h.session.token]);
});

for (const failure of ['unavailable', 'write rejected'] as const) {
  for (const change of ['invalidate', 'disconnect', 'account', 'provider'] as const) {
    test(`${change} revokes in-memory verification when session storage is ${failure}`, async (context) => {
      const h = fixture();
      const stale = { ...h.session, token: 'stale-session' };
      if (failure === 'write rejected') window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stale));
      const blocked = failure === 'unavailable'
        ? context.mock.getter(window, 'sessionStorage', () => { throw new Error('Storage blocked'); })
        : context.mock.method(dom.window.Storage.prototype, 'setItem', () => { throw new Error('Storage full'); });
      try {
        const { result, rerender } = h.render();
        await act(async () => { await result.current.verify(); });
        assert.deepEqual(result.current.session, h.session);
        if (change === 'invalidate' || change === 'disconnect') act(() => result.current.invalidate());
        if (change === 'disconnect') rerender({ ...h.initial, address: null, provider: null });
        if (change === 'account') rerender({ ...h.initial, address: OTHER_ADDRESS });
        if (change === 'provider') rerender({ ...h.initial, provider: { request: h.provider.request } });
        assert.equal(result.current.session, null);
        assert.deepEqual([...h.calls.logout].sort(), (failure === 'unavailable' ? [h.session.token] : [h.session.token, stale.token]).sort());
        if (failure === 'write rejected') assert.equal(window.sessionStorage.getItem(STORAGE_KEY), null);
      } finally { blocked.mock.restore(); }
    });
  }
}

for (const change of ['account', 'provider'] as const) {
  test(`stale invalidation after a ${change} switch cannot revoke the new verification`, async () => {
    const h = fixture();
    const { result, rerender } = h.render();
    await act(async () => { await result.current.verify(); });
    const invalidate = result.current.invalidate;
    const address = change === 'account' ? OTHER_ADDRESS : ADDRESS;
    const next = { ...h.session, address, token: 'new-session' };
    h.state.accounts = [address];
    h.api.verify = async () => next;
    rerender({ ...h.initial, address, provider: { request: h.provider.request } });
    await act(async () => { await result.current.verify(); });
    act(() => invalidate());
    assert.deepEqual(result.current.session, next);
    assert.deepEqual(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY)!), next);
    assert.deepEqual(h.calls.logout, [h.session.token]);
  });
}

test('invalidation preserves a stored session belonging to another collection', async (context) => {
  const h = fixture();
  const other = { ...h.session, preorderId: 'mi_note_cards', token: 'other-session' };
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(other));
  context.mock.method(dom.window.Storage.prototype, 'setItem', () => { throw new Error('Storage full'); });
  const { result } = h.render();
  await act(async () => { await result.current.verify(); });
  act(() => result.current.invalidate());
  assert.equal(result.current.session, null);
  assert.deepEqual(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY)!), other);
  assert.deepEqual(h.calls.logout, [h.session.token]);
});

for (const blockedStorage of [false, true]) {
  for (const change of ['disconnect', 'account', 'provider'] as const) {
    test(`${change} after a collection change revokes the earlier session with storage ${blockedStorage ? 'blocked' : 'available'}`, async (context) => {
      const h = fixture();
      const blocked = blockedStorage
        ? context.mock.getter(window, 'sessionStorage', () => { throw new Error('Storage blocked'); }) : null;
      try {
        const { result, rerender } = h.render();
        await act(async () => { await result.current.verify(); });
        const mainnet = { ...h.initial, preorderId: 'mi_note_cards' };
        rerender(mainnet);
        assert.equal(result.current.session, null);
        assert.deepEqual(h.calls.logout, []);
        if (change === 'disconnect') act(() => result.current.invalidate());
        rerender(change === 'disconnect' ? { ...mainnet, address: null, provider: null }
          : change === 'account' ? { ...mainnet, address: OTHER_ADDRESS }
            : { ...mainnet, provider: { request: h.provider.request } });
        assert.equal(result.current.session, null);
        assert.deepEqual(h.calls.logout, [h.session.token]);
        if (!blockedStorage) assert.equal(window.sessionStorage.getItem(STORAGE_KEY), null);
        rerender(h.initial);
        assert.equal(result.current.session, null);
        assert.equal(h.calls.verify.length, 1);
        assert.equal(h.calls.wallet.filter(request => request.method === 'personal_sign').length, 1);
      } finally { blocked?.mock.restore(); }
    });
  }

  test(`disconnect revokes both verified collections with storage ${blockedStorage ? 'blocked' : 'available'}`, async (context) => {
    const h = fixture();
    const blocked = blockedStorage
      ? context.mock.getter(window, 'sessionStorage', () => { throw new Error('Storage blocked'); }) : null;
    try {
      const { result, rerender } = h.render();
      await act(async () => { await result.current.verify(); });
      const mainnet = { ...h.initial, preorderId: 'mi_note_cards' };
      const next = { ...h.session, preorderId: mainnet.preorderId, token: 'mainnet-session' };
      h.api.verify = async () => next;
      rerender(mainnet);
      await act(async () => { await result.current.verify(); });
      assert.deepEqual(result.current.session, next);
      act(() => result.current.invalidate());
      rerender({ ...mainnet, address: null, provider: null });
      assert.deepEqual([...h.calls.logout].sort(), [h.session.token, next.token].sort());
      if (!blockedStorage) assert.equal(window.sessionStorage.getItem(STORAGE_KEY), null);
      rerender(h.initial);
      assert.equal(result.current.session, null);
      rerender(mainnet);
      assert.equal(result.current.session, null);
    } finally { blocked?.mock.restore(); }
  });
}

test('a stale collection invalidation cannot revoke the newly verified collection', async () => {
  const h = fixture();
  const { result, rerender } = h.render();
  await act(async () => { await result.current.verify(); });
  const invalidate = result.current.invalidate;
  const mainnet = { ...h.initial, preorderId: 'mi_note_cards' };
  const next = { ...h.session, preorderId: mainnet.preorderId, token: 'mainnet-session' };
  h.api.verify = async () => next;
  rerender(mainnet);
  await act(async () => { await result.current.verify(); });
  act(() => invalidate());
  assert.deepEqual(result.current.session, next);
  assert.deepEqual(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY)!), next);
  assert.deepEqual(h.calls.logout, []);
  act(() => result.current.invalidate());
  assert.equal(result.current.session, null);
  assert.deepEqual(h.calls.logout, [next.token]);
});

test('disconnect after a collection change preserves storage for an unrelated wallet', async () => {
  const h = fixture();
  const { result, rerender } = h.render();
  await act(async () => { await result.current.verify(); });
  const other = { ...h.session, address: OTHER_ADDRESS, preorderId: 'mi_note_cards', token: 'other-session' };
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(other));
  const mainnet = { ...h.initial, preorderId: 'mi_note_cards' };
  rerender(mainnet);
  act(() => result.current.invalidate());
  rerender({ ...mainnet, address: null, provider: null });
  assert.deepEqual(h.calls.logout, [h.session.token]);
  assert.deepEqual(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY)!), other);
});

test('disconnect revokes a saved same-wallet session from another collection without restoring it', () => {
  const h = fixture();
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(h.session));
  const mainnet = { ...h.initial, preorderId: 'mi_note_cards' };
  const { result, rerender } = h.render(mainnet);
  assert.equal(result.current.session, null);
  act(() => result.current.invalidate());
  rerender({ ...mainnet, address: null, provider: null });
  assert.deepEqual(h.calls.logout, [h.session.token]);
  assert.equal(window.sessionStorage.getItem(STORAGE_KEY), null);
});

for (const trigger of ['timer', 'focus'] as const) {
  test(`verification expires through ${trigger} and clears persisted credentials`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
    const h = fixture();
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(h.session));
    const { result } = h.render();
    assert.deepEqual(result.current.session, h.session);
    await act(async () => {
      if (trigger === 'timer') context.mock.timers.tick(3_600_000);
      else {
        context.mock.timers.setTime(h.session.expiresAtMs + 1);
        window.dispatchEvent(new dom.window.Event('focus'));
      }
    });
    assert.equal(result.current.session, null);
    assert.equal(window.sessionStorage.getItem(STORAGE_KEY), null);
    assert.deepEqual(h.calls.logout, [h.session.token]);
  });
}

for (const change of ['account', 'provider', 'collection', 'inactive'] as const) {
  for (const stage of ['signature', 'verification'] as const) {
    test(`${change} change during ${stage} ignores the late result and revokes an unused server session`, async () => {
      const h = fixture();
      const signed = deferred<unknown>();
      const verified = deferred<MiNoteEthereumSession>();
      if (stage === 'signature') h.state.sign = () => signed.promise;
      else h.api.verify = async (...args) => { h.calls.verify.push(args); return verified.promise; };
      const { result, rerender } = h.render();
      let completing!: Promise<void>;
      act(() => { completing = result.current.verify(); });
      await waitFor(() => assert.equal(stage === 'signature'
        ? h.calls.wallet.some((request) => request.method === 'personal_sign') : h.calls.verify.length === 1, true));
      const next = change === 'account' ? { ...h.initial, address: OTHER_ADDRESS }
        : change === 'provider' ? { ...h.initial, provider: { request: h.provider.request } }
          : change === 'collection' ? { ...h.initial, preorderId: 'mi_note_cards' } : { ...h.initial, active: false };
      rerender(next);
      if (change === 'inactive') rerender(h.initial);
      await act(async () => {
        if (stage === 'signature') signed.resolve(SIGNATURE);
        else verified.resolve(h.session);
        await completing;
      });
      assert.equal(result.current.session, null);
      assert.equal(window.sessionStorage.getItem(STORAGE_KEY), null);
      assert.equal(result.current.verifying, false);
      assert.deepEqual(h.calls.logout, stage === 'verification' ? [h.session.token] : []);
      assert.equal(h.calls.verify.length, stage === 'verification' ? 1 : 0);
    });
  }
}

test('account and provider changes revoke existing verification without prompting the new wallet', async () => {
  const h = fixture();
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(h.session));
  const { result, rerender } = h.render();
  rerender({ ...h.initial, address: OTHER_ADDRESS });
  assert.equal(result.current.session, null);
  assert.equal(window.sessionStorage.getItem(STORAGE_KEY), null);
  assert.deepEqual(h.calls.logout, [h.session.token]);
  rerender(h.initial);
  await act(async () => { await result.current.verify(); });
  const callsBeforeSwitch = h.calls.wallet.length;
  rerender({ ...h.initial, provider: { request: h.provider.request } });
  assert.equal(result.current.session, null);
  assert.equal(h.calls.wallet.length, callsBeforeSwitch);
  assert.deepEqual(h.calls.logout, [h.session.token, h.session.token]);
});

test('unmount during API verification revokes the late session without saving it', async () => {
  const h = fixture();
  const response = deferred<MiNoteEthereumSession>();
  h.api.verify = async (...args) => { h.calls.verify.push(args); return response.promise; };
  const { result, unmount } = h.render();
  let completing!: Promise<void>;
  act(() => { completing = result.current.verify(); });
  await waitFor(() => assert.equal(h.calls.verify.length, 1));
  unmount();
  await act(async () => { response.resolve(h.session); await completing; });
  assert.equal(window.sessionStorage.getItem(STORAGE_KEY), null);
  assert.deepEqual(h.calls.logout, [h.session.token]);
});
