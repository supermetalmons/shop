import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { captureNfcScan, readSavedNfcCode, readScannedCode, settleNfcScan } from '../src/ethereum/nfcScan.ts';
import { resolveNfcLink } from '../src/ethereum/tarotLink.ts';
import { resolveAppRoute, walletVisibleShopRoute } from '../src/routes.ts';
import { MAINNET_ADMIN_SHIPPER_WALLET_ADDRESSES } from '../shared/fulfillmentAccess.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

type Browser = Parameters<typeof captureNfcScan>[0];
const mainnetKey = 'mons.shop.tarot.claim:mainnet:1';
const sepoliaKey = 'mons.shop.tarot.claim:sepolia:1';

function browser(t: TestContext, href = 'https://mons.shop/nfc?tokenId=1'): Browser {
  const dom = new JSDOM('', { url: href });
  t.after(() => dom.window.close());
  return dom.window as unknown as Browser;
}

function snapshot(value: Browser) {
  return { href: value.location.href, state: value.history.state,
    local: Object.entries(value.localStorage), session: Object.entries(value.sessionStorage) };
}

function reload(t: TestContext, saved: ReturnType<typeof snapshot>): Browser {
  const value = browser(t, saved.href);
  for (const [key, code] of saved.local) value.localStorage.setItem(key, code);
  for (const [key, code] of saved.session) value.sessionStorage.setItem(key, code);
  value.history.replaceState(saved.state, '');
  return value;
}

function current(value: Browser) {
  return resolveNfcLink(value.location.search, (tokenId, testnet) => readScannedCode(value, tokenId, testnet));
}

test('NFC links default to mainnet, accept explicit false, and isolate Sepolia route identity', () => {
  const code = crypto.randomUUID();
  const mainnet = resolveNfcLink(`?tokenId=1&code=${code}`);
  const explicit = resolveNfcLink(`?tokenId=1&code=${code}&testnet=false`);
  const sepolia = resolveNfcLink(`?tokenId=1&code=${code}&testnet=true`);
  assert.equal(mainnet.kind, 'tarot');
  assert.equal(explicit.kind, 'tarot');
  assert.equal(sepolia.kind, 'tarot');
  if (mainnet.kind !== 'tarot' || explicit.kind !== 'tarot' || sepolia.kind !== 'tarot') assert.fail();
  assert.deepEqual(mainnet.request, { tokenId: 1, code, testnet: false });
  assert.deepEqual(explicit, mainnet);
  assert.deepEqual(sepolia.request, { tokenId: 1, code, testnet: true });
  assert.notEqual(sepolia.key, mainnet.key);
  const calls: Array<[number, boolean]> = [];
  for (const query of ['?tokenId=1', '?tokenId=1&testnet=false', '?tokenId=1&testnet=true']) {
    assert.equal(resolveAppRoute({ pathname: '/nfc', search: query }, (tokenId, testnet) => {
      calls.push([tokenId, testnet]);
      return code;
    }).nfcLink?.kind, 'tarot');
  }
  assert.deepEqual(calls, [[1, false], [1, false], [1, true]]);
});

test('malformed and repeated flags never fall through to a saved mainnet or Sepolia claim', () => {
  const code = crypto.randomUUID();
  let reads = 0;
  const saved = () => { reads++; return code; };
  for (const flag of ['', 'TRUE', 'False', '0', '1', 'true&testnet=true', 'false&testnet=false', 'true&testnet=false']) {
    for (const credential of ['', `&code=${code}`]) {
      assert.equal(resolveNfcLink(`?tokenId=1&testnet=${flag}${credential}`, saved).kind, 'artwork');
    }
  }
  for (const credential of ['code=', 'code=invalid', `code=${code}&code=${code}`]) {
    assert.equal(resolveNfcLink(`?tokenId=1&${credential}`, saved).kind, 'artwork');
  }
  assert.equal(reads, 0);
  assert.equal(resolveNfcLink('?code=basel').kind, 'placeholder');
  assert.equal(resolveNfcLink('?code=basel&testnet=false').kind, 'invalid');
});

test('scanning either network saves before validation, scrubs the URL, and survives reload without crossing networks', t => {
  for (const [suffix, testnet] of [['', false], ['&testnet=false', false], ['&testnet=true', true]] as const) {
    const code = crypto.randomUUID();
    const other = crypto.randomUUID();
    const value = browser(t, `https://mons.shop/nfc?code=${code}&tokenId=1${suffix}`);
    value.localStorage.setItem(testnet ? mainnetKey : sepoliaKey, other);
    value.history.replaceState({ retained: true }, '');
    captureNfcScan(value);
    assert.equal(value.location.search, `?tokenId=1${suffix}`);
    assert.equal(value.localStorage.getItem(testnet ? sepoliaKey : mainnetKey), code);
    assert.equal(readSavedNfcCode(value, 1, !testnet), other);
    assert.equal(JSON.stringify(value.history.state).includes(code), false);
    const restored = reload(t, snapshot(value));
    const link = current(restored);
    assert.ok(link.kind === 'tarot');
    assert.deepEqual(link.request, { tokenId: 1, code, testnet });
    assert.equal(readScannedCode(restored, 1, !testnet), other);
    assert.equal(restored.history.state.retained, true);
  }
});

test('a first mainnet scan survives local quota failures through network-scoped session storage', t => {
  const code = crypto.randomUUID();
  const value = browser(t, `https://mons.shop/nfc?tokenId=1&code=${code}`);
  const local = value.localStorage;
  const prototype: Storage = Object.getPrototypeOf(local);
  const setItem = prototype.setItem;
  const blocked = t.mock.method(prototype, 'setItem', function (this: Storage, key: string, stored: string) {
    if (this === local) throw new DOMException('Full', 'QuotaExceededError');
    setItem.call(this, key, stored);
  });
  captureNfcScan(value);
  assert.equal(local.getItem(mainnetKey), null);
  assert.equal(readScannedCode(value, 1, false), code);
  assert.equal(readScannedCode(value, 1, true), null);
  const saved = snapshot(value);
  blocked.mock.restore();
  const restored = reload(t, saved);
  assert.equal(readScannedCode(restored, 1, false), code);
  assert.equal(readScannedCode(restored, 1, true), null);
});

test('in-memory scan fallback keeps the two networks separate when both stores are unavailable', t => {
  const value = browser(t);
  t.mock.getter(value, 'localStorage', () => { throw new DOMException('Blocked', 'SecurityError'); });
  t.mock.getter(value, 'sessionStorage', () => { throw new DOMException('Blocked', 'SecurityError'); });
  const codes = [crypto.randomUUID(), crypto.randomUUID()];
  for (const [index, suffix] of ['', '&testnet=true'].entries()) {
    value.history.replaceState(null, '', `/nfc?tokenId=1&code=${codes[index]}${suffix}`);
    captureNfcScan(value);
  }
  assert.equal(readSavedNfcCode(value, 1, false), codes[0]);
  assert.equal(readSavedNfcCode(value, 1, true), codes[1]);
  assert.equal(readScannedCode(value, 1, false), codes[0]);
  assert.equal(readScannedCode(value, 1, true), codes[1]);
  assert.equal(value.nfcUnsavedCodes?.size, 2);
});

test('mainnet rescans promote or roll back only their own network credentials', t => {
  for (const accepted of [false, true]) {
    const old = crypto.randomUUID();
    const replacement = crypto.randomUUID();
    const sepolia = crypto.randomUUID();
    const value = browser(t, `https://mons.shop/nfc?tokenId=1&code=${replacement}`);
    value.localStorage.setItem(mainnetKey, old);
    value.localStorage.setItem(sepoliaKey, sepolia);
    captureNfcScan(value);
    assert.equal(readSavedNfcCode(value, 1, false), old);
    assert.equal(readScannedCode(value, 1, false), replacement);
    assert.equal(readScannedCode(value, 1, true), sepolia);
    settleNfcScan(value, { tokenId: 1, code: replacement, testnet: false }, accepted);
    assert.equal(readScannedCode(value, 1, false), accepted ? replacement : null);
    assert.equal(readSavedNfcCode(value, 1, false), accepted ? replacement : old);
    assert.equal(readScannedCode(value, 1, true), sepolia);
    assert.equal(value.sessionStorage.length, 0);
    const restored = reload(t, snapshot(value));
    assert.equal(readScannedCode(restored, 1, false), accepted ? replacement : old);
    assert.equal(readScannedCode(restored, 1, true), sepolia);
  }
});

test('a mainnet rescan survives encrypted history fallback and cannot replay on Sepolia', t => {
  const old = crypto.randomUUID();
  const replacement = crypto.randomUUID();
  const sepolia = crypto.randomUUID();
  const value = browser(t, `https://mons.shop/nfc?tokenId=1&code=${replacement}`);
  value.localStorage.setItem(mainnetKey, old);
  value.localStorage.setItem(sepoliaKey, sepolia);
  const blocked = t.mock.getter(value, 'sessionStorage', () => { throw new DOMException('Blocked', 'SecurityError'); });
  captureNfcScan(value);
  assert.match(value.history.state.nfcScan, /^sealed2\./);
  assert.equal(readScannedCode(value, 1, false), replacement);
  assert.equal(readScannedCode(value, 1, true), sepolia);
  assert.equal(JSON.stringify([value.history.state, Object.entries(value.localStorage)]).includes(replacement), false);
  assert.equal(value.nfcUnsavedCodes?.size, 0);
  blocked.mock.restore();
  const restored = reload(t, snapshot(value));
  assert.equal(readScannedCode(restored, 1, false), replacement);
  assert.equal(readScannedCode(restored, 1, true), sepolia);
  restored.history.replaceState(restored.history.state, '', '/nfc?tokenId=1&testnet=true');
  const link = current(restored);
  assert.ok(link.kind === 'tarot');
  assert.deepEqual(link.request, { tokenId: 1, code: sepolia, testnet: true });
});

test('a late response from the other network cannot replace or discard the active rescan', t => {
  const mainnet = crypto.randomUUID();
  const old = crypto.randomUUID();
  const replacement = crypto.randomUUID();
  const value = browser(t, `https://mons.shop/nfc?tokenId=1&testnet=true&code=${replacement}`);
  value.localStorage.setItem(mainnetKey, mainnet);
  value.localStorage.setItem(sepoliaKey, old);
  captureNfcScan(value);
  const entry = value.history.state.nfcScan;
  settleNfcScan(value, { tokenId: 1, code: mainnet, testnet: false }, true);
  assert.equal(value.history.state.nfcScan, entry);
  assert.equal(readScannedCode(value, 1, true), replacement);
  settleNfcScan(value, { tokenId: 1, code: mainnet, testnet: false }, false);
  assert.equal(value.history.state.nfcScan, entry);
  assert.equal(readScannedCode(value, 1, true), replacement);
  assert.equal(readSavedNfcCode(value, 1, true), old);
  assert.equal(readSavedNfcCode(value, 1, false), null);
});

test('mainnet-only staff can open mainnet NFC credentials while Sepolia credentials remain excluded', () => {
  const code = crypto.randomUUID();
  for (const staff of MAINNET_ADMIN_SHIPPER_WALLET_ADDRESSES) {
    for (const suffix of ['', '&testnet=false']) {
      const route = resolveAppRoute({ pathname: '/nfc', search: `?tokenId=1&code=${code}${suffix}` });
      assert.equal(walletVisibleShopRoute(route, staff, staff), route);
    }
    const route = resolveAppRoute({ pathname: '/nfc', search: `?tokenId=1&code=${code}&testnet=true` });
    assert.equal(walletVisibleShopRoute(route, staff, staff).kind, 'home');
  }
});

test('useAppRoute reuses saved mainnet credentials and changes identity when the same card switches networks', async t => {
  const { dom } = setupFrontendDom();
  const { act, cleanup, renderHook } = await import('@testing-library/react');
  const { useAppRoute } = await import('../src/hooks/useAppRoute.ts');
  t.after(() => { cleanup(); dom.window.close(); });
  const code = crypto.randomUUID();
  window.localStorage.setItem(mainnetKey, code);
  window.localStorage.setItem(sepoliaKey, code);
  window.history.replaceState(null, '', '/nfc?tokenId=1');
  const view = renderHook(useAppRoute);
  const original = view.result.current;
  assert.ok(original.nfcLink?.kind === 'tarot');
  assert.equal(original.nfcLink.request.testnet, false);
  act(() => {
    window.history.replaceState(null, '', '/nfc?tokenId=1&testnet=false');
    window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  });
  assert.equal(view.result.current, original);
  act(() => {
    window.history.replaceState(null, '', '/nfc?tokenId=1&testnet=true');
    window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  });
  assert.notEqual(view.result.current, original);
  const sepolia = view.result.current.nfcLink;
  assert.ok(sepolia?.kind === 'tarot');
  assert.equal(sepolia.request.testnet, true);
});
