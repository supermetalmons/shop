import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach } from 'node:test';
import { createElement } from 'react';
import miNoteCollections from '../mi_note_eth.json';
import { MI_NOTE_2_CONTRACT_ADDRESS, MI_NOTE_3_CONTRACT_ADDRESS } from '../shared/miNoteCards.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render, renderHook } = await import('@testing-library/react');
const { useMiNoteCards } = await import('../src/hooks/useMiNoteCards.ts');
const cssImports = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : nextLoad(url, context);
  },
});
const { default: MiNoteCardsGallery } = await import('../src/components/MiNoteCardsGallery.tsx');
cssImports.deregister();

const ADDRESS = '0x000533f50ddd7f2fc4EfD06137b0c1A12CfB7Bb9';
const OTHER_ADDRESS = '0x1111111111111111111111111111111111111111';
const COLLECTION = miNoteCollections.find((collection) => collection.contractAddress === MI_NOTE_2_CONTRACT_ADDRESS)!;
const COLLECTION_3 = miNoteCollections.find((collection) => collection.contractAddress === MI_NOTE_3_CONTRACT_ADDRESS)!;
const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState(null, '', '/mi_note_cards');
});
after(() => dom.window.close());

function setSearch(search: string) {
  window.history.replaceState(null, '', `/mi_note_cards${search}`);
}

function navigateSearch(search: string, event = 'popstate') {
  act(() => {
    setSearch(search);
    window.dispatchEvent(new dom.window.Event(event));
  });
}

function holdings(miNote2: string[] = [], miNote3: string[] = []) {
  return {
    ok: true,
    tokenIdsByContract: {
      [MI_NOTE_2_CONTRACT_ADDRESS]: miNote2,
      [MI_NOTE_3_CONTRACT_ADDRESS]: miNote3,
    },
  };
}

function captureRequests(ignoreAborts = false) {
  const requests: Array<{
    url: string;
    signal: AbortSignal;
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
  }> = [];
  globalThis.fetch = ((input, init) => new Promise<Response>((resolve, reject) => {
    assert.ok(init?.signal);
    const signal = init.signal;
    requests.push({ url: String(input), signal, resolve, reject });
    if (!ignoreAborts) {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
  })) as typeof fetch;
  return requests;
}

test('no address preserves 300 unique random cards without an ownership request', () => {
  const requests = captureRequests();
  const { result, rerender } = renderHook(useMiNoteCards);
  assert.equal(result.current.length, 300);
  assert.equal(new Set(result.current.map((card) => card.mid)).size, 300);
  const initialCards = result.current;
  rerender();
  assert.equal(result.current, initialCards);
  assert.equal(requests.length, 0);
});

test('address mode starts empty and returns only catalogued holdings in collection and catalog order', async () => {
  setSearch(`?address=${ADDRESS}`);
  const requests = captureRequests();
  const { result } = renderHook(useMiNoteCards);
  assert.deepEqual(result.current, []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `https://api.mons.shop/mi-note-cards?address=${ADDRESS.toLowerCase()}&version=2`);
  await act(async () => {
    requests[0].resolve(Response.json(holdings(['1154', '779', '1', '999999'], ['117', '2', '1', '999999'])));
  });
  assert.deepEqual(result.current, [
    ...COLLECTION.tokens.filter((card) => ['1', '1154'].includes(card.id)),
    ...COLLECTION_3.tokens.filter((card) => ['2', '117'].includes(card.id)),
  ]);
});

test('Mi Note 3-only holdings do not display Mi Note 2 cards with the same IDs', async () => {
  setSearch(`?address=${ADDRESS}`);
  const requests = captureRequests();
  const { result } = renderHook(useMiNoteCards);
  await act(async () => {
    requests[0].resolve(Response.json(holdings([], ['2', '3'])));
  });
  assert.deepEqual(result.current, COLLECTION_3.tokens.filter((card) => ['2', '3'].includes(card.id)));
  assert.equal(result.current.length, 2);
  assert.ok(result.current.every((card) => card.mid.includes('/mi_note_3/mid/')));
});

test('the same token ID owned in both collections displays both cards', async () => {
  setSearch(`?address=${ADDRESS}`);
  const requests = captureRequests();
  const { result } = renderHook(useMiNoteCards);
  await act(async () => {
    requests[0].resolve(Response.json(holdings(['2'], ['2'])));
  });
  assert.deepEqual(result.current, [COLLECTION.tokens.find((card) => card.id === '2'), COLLECTION_3.tokens[0]]);
  assert.equal(new Set(result.current.map((card) => card.mid)).size, 2);
});

test('address mode shows every known holding without the random gallery limit', async () => {
  setSearch(`?address=${ADDRESS}`);
  const requests = captureRequests();
  const { result } = renderHook(useMiNoteCards);
  await act(async () => {
    requests[0].resolve(Response.json(holdings(
      COLLECTION.tokens.map((card) => card.id).reverse(),
      COLLECTION_3.tokens.map((card) => card.id).reverse(),
    )));
  });
  assert.equal(result.current.length, 1222);
  assert.deepEqual(result.current, [...COLLECTION.tokens, ...COLLECTION_3.tokens]);
});

for (const search of ['?address=', '?address=invalid', `?address=${ADDRESS}&address=${OTHER_ADDRESS}`]) {
  test(`${search} stays empty without making an ownership request`, () => {
    setSearch(search);
    const requests = captureRequests();
    const { result } = renderHook(useMiNoteCards);
    assert.deepEqual(result.current, []);
    assert.equal(requests.length, 0);
  });
}

for (const outcome of ['no holdings', 'provider error', 'network error', 'invalid response'] as const) {
  test(`${outcome} leaves address mode empty`, async () => {
    setSearch(`?address=${ADDRESS}`);
    const requests = captureRequests();
    const { result } = renderHook(useMiNoteCards);
    await act(async () => {
      if (outcome === 'network error') requests[0].reject(new Error('Network unavailable'));
      else if (outcome === 'provider error') {
        requests[0].resolve(Response.json({ ok: false, error: 'provider-unavailable' }, { status: 502 }));
      } else if (outcome === 'invalid response') requests[0].resolve(Response.json({ ok: true, tokenIds: [1] }));
      else requests[0].resolve(Response.json(holdings()));
    });
    assert.deepEqual(result.current, []);
  });
}

test('query navigation clears previous cards before a new request and never shows a random frame', async () => {
  const requests = captureRequests();
  const renders: Array<string[]> = [];
  const { result } = renderHook(() => {
    const cards = useMiNoteCards();
    renders.push(cards.map((card) => card.id));
    return cards;
  });
  const randomCards = result.current;
  renders.length = 0;
  navigateSearch(`?address=${ADDRESS}`, 'mons:navigate');
  assert.ok(renders.every((cards) => cards.length === 0));
  await act(async () => { requests[0].resolve(Response.json(holdings(['1']))); });
  assert.deepEqual(result.current.map((card) => card.id), ['1']);

  renders.length = 0;
  navigateSearch(`?address=${OTHER_ADDRESS}`);
  assert.ok(renders.every((cards) => cards.length === 0));
  await act(async () => { requests[1].resolve(Response.json(holdings([], ['2']))); });
  assert.deepEqual(result.current.map((card) => card.id), ['2']);

  navigateSearch('?address=invalid', 'pageshow');
  assert.deepEqual(result.current, []);
  assert.equal(requests.length, 2);
  navigateSearch('');
  assert.equal(result.current, randomCards);
  assert.equal(requests.length, 2);
});

test('late results from an aborted address cannot replace the current holdings', async () => {
  setSearch(`?address=${ADDRESS}`);
  const requests = captureRequests(true);
  const { result } = renderHook(useMiNoteCards);
  navigateSearch(`?address=${OTHER_ADDRESS}`);
  assert.equal(requests[0].signal.aborted, true);
  await act(async () => { requests[1].resolve(Response.json(holdings([], ['2']))); });
  await act(async () => { requests[0].resolve(Response.json(holdings(['1']))); });
  assert.deepEqual(result.current.map((card) => card.id), ['2']);
});

test('returning to a previously visited address stays empty until its new request finishes', async () => {
  setSearch(`?address=${ADDRESS}`);
  const requests = captureRequests();
  const { result } = renderHook(useMiNoteCards);
  await act(async () => { requests[0].resolve(Response.json(holdings(['1']))); });
  navigateSearch(`?address=${OTHER_ADDRESS}`);
  navigateSearch(`?address=${ADDRESS}`);
  assert.deepEqual(result.current, []);
  assert.equal(requests[1].signal.aborted, true);
  await act(async () => { requests[2].resolve(Response.json(holdings([], ['3']))); });
  assert.deepEqual(result.current.map((card) => card.id), ['3']);
});

test('unmount aborts the ownership request', async () => {
  setSearch(`?address=${ADDRESS}`);
  const requests = captureRequests();
  const { unmount } = renderHook(useMiNoteCards);
  await act(async () => { unmount(); });
  assert.equal(requests[0].signal.aborted, true);
});

test('gallery keeps its thumbnail rendering and Notify me button without adding loading or empty UI', async () => {
  setSearch(`?address=${ADDRESS}`);
  const requests = captureRequests();
  let notifications = 0;
  const gallery = render(createElement(MiNoteCardsGallery, { onNotify: () => { notifications += 1; } }));
  assert.equal(gallery.queryAllByRole('img').length, 0);
  assert.equal(gallery.queryByRole('status'), null);
  assert.equal(gallery.queryByRole('alert'), null);
  assert.equal(gallery.getByRole('main').textContent, '');
  fireEvent.click(gallery.getByRole('button', { name: 'Notify me' }));
  assert.equal(notifications, 1);

  await act(async () => { requests[0].resolve(Response.json(holdings(['2'], ['2']))); });
  assert.equal(gallery.getAllByRole('img').length, 2);
  for (const card of [COLLECTION.tokens.find((token) => token.id === '2')!, COLLECTION_3.tokens[0]]) {
    const image = gallery.getByRole('img', { name: card.name });
    assert.equal(image.getAttribute('src'), card.mid.replace('/mid/', '/thumbs/'));
    assert.equal(image.getAttribute('loading'), 'lazy');
    assert.equal(image.getAttribute('decoding'), 'async');
  }
  assert.equal(gallery.getAllByRole('button').length, 1);
});
