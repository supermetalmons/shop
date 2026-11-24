import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { openNfcHistoryCode, sealNfcHistoryCode } from '../src/ethereum/nfcHistoryCode.ts';

function browser(t: TestContext) {
  const dom = new JSDOM('', { url: 'https://shop.example' });
  t.after(() => dom.window.close());
  return { crypto, localStorage: dom.window.localStorage };
}

test('independent rescan entries recover only their authenticated card codes using one local key', t => {
  const original = browser(t);
  const codes = [crypto.randomUUID(), crypto.randomUUID()];
  const entries = codes.map(code => sealNfcHistoryCode(original, 10, code));
  assert.equal(original.localStorage.length, 1);
  const reloaded = browser(t);
  for (const [name, value] of Object.entries(original.localStorage)) reloaded.localStorage.setItem(name, value);
  for (const [i, entry] of entries.entries()) {
    assert.ok(entry);
    assert.equal(entry.includes(codes[i]), false);
    assert.equal(JSON.stringify(original.localStorage).includes(codes[i]), false);
    assert.equal(openNfcHistoryCode(reloaded, 10, entry), codes[i]);
    assert.equal(openNfcHistoryCode(reloaded, 11, entry), null);
    assert.equal(openNfcHistoryCode(browser(t), 10, entry), null);
    const tampered = entry.replace(/([^.]+)$/, box => (box[0] === 'A' ? 'B' : 'A') + box.slice(1));
    assert.equal(openNfcHistoryCode(reloaded, 10, tampered), null);
  }
});

test('concurrent first rescan entries can recover after both tabs created a wrapping key', t => {
  const secondTab = browser(t);
  const firstCode = crypto.randomUUID();
  const secondCode = crypto.randomUUID();
  let secondEntry: string | null = null;
  const firstTab = {
    crypto,
    localStorage: new Proxy(secondTab.localStorage, {
      ownKeys(storage) {
        const keys = Reflect.ownKeys(storage);
        secondEntry = sealNfcHistoryCode(secondTab, 10, secondCode);
        return keys;
      },
    }),
  };
  const firstEntry = sealNfcHistoryCode(firstTab, 10, firstCode);
  assert.equal(secondTab.localStorage.length, 2);
  assert.equal(openNfcHistoryCode(secondTab, 10, firstEntry), firstCode);
  assert.equal(openNfcHistoryCode(secondTab, 10, secondEntry), secondCode);
  assert.ok(sealNfcHistoryCode(secondTab, 11, crypto.randomUUID()));
  assert.equal(secondTab.localStorage.length, 2);
});

test('history fallback fails closed if no key can be persisted', t => {
  const restricted = browser(t);
  t.mock.method(Object.getPrototypeOf(restricted.localStorage), 'setItem', () => {});
  assert.equal(sealNfcHistoryCode(restricted, 10, crypto.randomUUID()), null);
  assert.equal(openNfcHistoryCode(restricted, 10, 'sealed1.invalid'), null);
});
