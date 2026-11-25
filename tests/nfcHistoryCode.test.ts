import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import nacl from 'tweetnacl';
import { openNfcHistoryCode, sealNfcHistoryCode } from '../src/ethereum/nfcHistoryCode.ts';

function browser(t: TestContext) {
  const dom = new JSDOM('', { url: 'https://shop.example' });
  t.after(() => dom.window.close());
  return { crypto, localStorage: dom.window.localStorage };
}

test('independent rescan entries recover only their authenticated card codes using one local key', t => {
  const original = browser(t);
  const codes = [crypto.randomUUID(), crypto.randomUUID()];
  const entries = codes.map(code => sealNfcHistoryCode(original, 10, code, true));
  assert.equal(original.localStorage.length, 1);
  const reloaded = browser(t);
  for (const [name, value] of Object.entries(original.localStorage)) reloaded.localStorage.setItem(name, value);
  for (const [i, entry] of entries.entries()) {
    assert.ok(entry);
    assert.equal(entry.includes(codes[i]), false);
    assert.equal(JSON.stringify(original.localStorage).includes(codes[i]), false);
    assert.equal(openNfcHistoryCode(reloaded, 10, entry, true), codes[i]);
    assert.equal(openNfcHistoryCode(reloaded, 11, entry, true), null);
    assert.equal(openNfcHistoryCode(reloaded, 10, entry, false), null);
    assert.equal(openNfcHistoryCode(browser(t), 10, entry, true), null);
    const tampered = entry.replace(/([^.]+)$/, box => (box[0] === 'A' ? 'B' : 'A') + box.slice(1));
    assert.equal(openNfcHistoryCode(reloaded, 10, tampered, true), null);
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
        secondEntry = sealNfcHistoryCode(secondTab, 10, secondCode, false);
        return keys;
      },
    }),
  };
  const firstEntry = sealNfcHistoryCode(firstTab, 10, firstCode, false);
  assert.equal(secondTab.localStorage.length, 2);
  assert.equal(openNfcHistoryCode(secondTab, 10, firstEntry, false), firstCode);
  assert.equal(openNfcHistoryCode(secondTab, 10, secondEntry, false), secondCode);
  assert.ok(sealNfcHistoryCode(secondTab, 11, crypto.randomUUID(), true));
  assert.equal(secondTab.localStorage.length, 2);
});

test('history fallback fails closed if no key can be persisted', t => {
  const restricted = browser(t);
  t.mock.method(Object.getPrototypeOf(restricted.localStorage), 'setItem', () => {});
  assert.equal(sealNfcHistoryCode(restricted, 10, crypto.randomUUID(), false), null);
  assert.equal(openNfcHistoryCode(restricted, 10, 'sealed1.invalid', true), null);
});

test('sealed history binds the network and card even when both networks use the same code', t => {
  const original = browser(t);
  const code = crypto.randomUUID();
  for (const testnet of [false, true]) {
    const entry = sealNfcHistoryCode(original, 777, code, testnet);
    assert.ok(entry);
    assert.match(entry, /^sealed2\./);
    assert.equal(openNfcHistoryCode(original, 777, entry, testnet), code);
    assert.equal(openNfcHistoryCode(original, 777, entry, !testnet), null);
    assert.equal(openNfcHistoryCode(original, 776, entry, testnet), null);
    assert.equal(openNfcHistoryCode(original, 777, entry.replace('sealed2.', 'sealed1.'), testnet), null);
  }
  assert.equal(original.localStorage.length, 1);
});

test('legacy sealed1 histories remain readable only on Sepolia', t => {
  const original = browser(t);
  const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
  const id = encode(new Uint8Array(16).fill(1));
  const key = new Uint8Array(nacl.secretbox.keyLength).fill(2);
  const nonce = new Uint8Array(nacl.secretbox.nonceLength).fill(3);
  const code = crypto.randomUUID();
  original.localStorage.setItem(`mons.shop.tarot.history-key:v1:${id}`, encode(key));
  const legacy = `sealed1.${id}.${encode(nonce)}.${encode(nacl.secretbox(new TextEncoder().encode(`10:${code}`), nonce, key))}`;
  assert.equal(openNfcHistoryCode(original, 10, legacy, true), code);
  assert.equal(openNfcHistoryCode(original, 10, legacy, false), null);
  assert.equal(openNfcHistoryCode(original, 11, legacy, true), null);
});
