import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach } from 'node:test';
import { createElement } from 'react';
import miNoteCollections from '../mi_note_eth.json';
import {
  MI_NOTE_2_CONTRACT_ADDRESS,
  MI_NOTE_3_CONTRACT_ADDRESS,
  MI_NOTE_CONTRACT_ADDRESS,
  type MiNoteCardsResponse,
} from '../shared/miNoteCards.ts';
import type { MiNoteCardsSource } from '../src/hooks/useMiNoteCards.ts';
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
const ORIGINAL_COLLECTION = miNoteCollections.find((collection) => collection.contractAddress === MI_NOTE_CONTRACT_ADDRESS)!;
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

function holdings(miNote2: string[] = [], miNote3: string[] = [], original: string[] = []): MiNoteCardsResponse {
  return {
    ok: true,
    tokenIdsByContract: {
      [MI_NOTE_2_CONTRACT_ADDRESS]: miNote2,
      [MI_NOTE_3_CONTRACT_ADDRESS]: miNote3,
      [MI_NOTE_CONTRACT_ADDRESS]: original,
    },
    resultsByContract: {
      [MI_NOTE_2_CONTRACT_ADDRESS]: { status: 'success', provider: 'alchemy', visibilityLimited: false },
      [MI_NOTE_3_CONTRACT_ADDRESS]: { status: 'success', provider: 'alchemy', visibilityLimited: false },
      [MI_NOTE_CONTRACT_ADDRESS]: { status: 'success', provider: 'opensea', visibilityLimited: true },
    },
  };
}

function openResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel() { cancelled = true; },
  });
  return {
    response: new Response(body, { headers: { 'Content-Type': 'application/json' } }),
    append: (value: string) => controller.enqueue(new TextEncoder().encode(value)),
    close: () => controller.close(),
    fail: () => controller.error(new Error('Body failed')),
    get cancelled() { return cancelled; },
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

test('all mode preserves 300 unique random cards without an ownership request', () => {
  const requests = captureRequests();
  const { result, rerender } = renderHook(() => useMiNoteCards({ mode: 'all' }));
  assert.equal(result.current.cards.length, 300);
  assert.equal(result.current.status, 'success');
  assert.equal(new Set(result.current.cards.map((card) => card.mid)).size, 300);
  const initialCards = result.current.cards;
  rerender();
  assert.equal(result.current.cards, initialCards);
  assert.equal(requests.length, 0);
});

test('address mode starts empty and returns only catalogued holdings in collection and catalog order', async () => {
  const requests = captureRequests();
  const { result } = renderHook(() => useMiNoteCards({ mode: 'owned', address: ADDRESS }));
  assert.deepEqual(result.current.cards, []);
  assert.equal(result.current.status, 'loading');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `https://api.mons.shop/mi-note-cards?address=${ADDRESS.toLowerCase()}`);
  await act(async () => {
    requests[0].resolve(Response.json(holdings(['1154', '779', '1', '999999'], ['117', '2', '1', '999999'])));
  });
  assert.deepEqual(result.current.cards, [
    ...COLLECTION_3.tokens.filter((card) => ['2', '117'].includes(card.id)),
    ...COLLECTION.tokens.filter((card) => ['1', '1154'].includes(card.id)),
  ]);
});

test('Mi Note 3-only holdings do not display Mi Note 2 cards with the same IDs', async () => {
  const requests = captureRequests();
  const { result } = renderHook(() => useMiNoteCards({ mode: 'owned', address: ADDRESS }));
  await act(async () => {
    requests[0].resolve(Response.json(holdings([], ['2', '3'])));
  });
  assert.deepEqual(result.current.cards, COLLECTION_3.tokens.filter((card) => ['2', '3'].includes(card.id)));
  assert.equal(result.current.cards.length, 2);
  assert.ok(result.current.cards.every((card) => card.mid.includes('/mi_note_3/mid/')));
});

test('the same token ID owned in both collections displays both cards', async () => {
  const requests = captureRequests();
  const { result } = renderHook(() => useMiNoteCards({ mode: 'owned', address: ADDRESS }));
  await act(async () => {
    requests[0].resolve(Response.json(holdings(['2'], ['2'])));
  });
  assert.deepEqual(result.current.cards, [COLLECTION_3.tokens[0], COLLECTION.tokens.find((card) => card.id === '2')]);
  assert.equal(new Set(result.current.cards.map((card) => card.mid)).size, 2);
});

test('address mode shows every known holding without the random gallery limit', async () => {
  const requests = captureRequests();
  const { result } = renderHook(() => useMiNoteCards({ mode: 'owned', address: ADDRESS }));
  await act(async () => {
    requests[0].resolve(Response.json(holdings(
      COLLECTION.tokens.map((card) => card.id).reverse(),
      COLLECTION_3.tokens.map((card) => card.id).reverse(),
      ORIGINAL_COLLECTION.tokens.map((card) => card.id).reverse(),
    )));
  });
  assert.equal(result.current.cards.length, 1388);
  assert.deepEqual(result.current.cards, [...COLLECTION_3.tokens, ...COLLECTION.tokens, ...ORIGINAL_COLLECTION.tokens]);
});

test('address mode waits for the complete JSON response before showing cards in 3, 2, original order', async () => {
  const requests = captureRequests();
  const body = openResponse();
  const { result } = renderHook(() => useMiNoteCards({ mode: 'owned', address: ADDRESS }));
  const originalCard = ORIGINAL_COLLECTION.tokens[72];
  const payload = JSON.stringify(holdings(['2'], ['2'], [originalCard.id]));
  const split = Math.floor(payload.length / 2);
  await act(async () => {
    requests[0].resolve(body.response);
    body.append(payload.slice(0, split));
  });
  assert.deepEqual(result.current.cards, []);
  await act(async () => {
    body.append(payload.slice(split));
    body.close();
  });
  assert.deepEqual(result.current.cards, [COLLECTION_3.tokens[0], COLLECTION.tokens.find((card) => card.id === '2'), originalCard]);
});

for (const failure of ['truncated', 'network'] as const) {
  test(`${failure} JSON response never displays partially received holdings`, async () => {
    const requests = captureRequests();
    const body = openResponse();
    const { result } = renderHook(() => useMiNoteCards({ mode: 'owned', address: ADDRESS }));
    await act(async () => {
      requests[0].resolve(body.response);
      body.append(JSON.stringify(holdings(['2'])).slice(0, -1));
    });
    assert.deepEqual(result.current.cards, []);
    await act(async () => {
      if (failure === 'network') body.fail();
      else body.close();
    });
    assert.deepEqual(result.current.cards, []);
    assert.equal(result.current.status, 'error');
  });
}

test('a compatible partial JSON response shows only successful collection holdings', async () => {
  const requests = captureRequests();
  const { result } = renderHook(() => useMiNoteCards({ mode: 'owned', address: ADDRESS }));
  const card = ORIGINAL_COLLECTION.tokens[72];
  const payload = holdings([], [], [card.id]);
  payload.resultsByContract[MI_NOTE_2_CONTRACT_ADDRESS] = { status: 'error', error: 'provider-unavailable' };
  payload.resultsByContract[MI_NOTE_3_CONTRACT_ADDRESS] = { status: 'error', error: 'provider-timeout' };
  await act(async () => { requests[0].resolve(Response.json(payload)); });
  assert.deepEqual(result.current.cards, [card]);
  assert.equal(result.current.status, 'partial');
});

for (const source of [{ mode: 'inactive' }, { mode: 'owned', address: '' }, { mode: 'owned', address: 'invalid' }] as const) {
  test(`${JSON.stringify(source)} stays idle without making an ownership request`, () => {
    const requests = captureRequests();
    const { result } = renderHook(() => useMiNoteCards(source));
    assert.deepEqual(result.current.cards, []);
    assert.equal(result.current.status, 'idle');
    assert.equal(requests.length, 0);
  });
}

for (const outcome of ['no holdings', 'provider error', 'network error', 'invalid response'] as const) {
  test(`${outcome} leaves address mode empty`, async () => {
    const requests = captureRequests();
    const { result } = renderHook(() => useMiNoteCards({ mode: 'owned', address: ADDRESS }));
    await act(async () => {
      if (outcome === 'network error') requests[0].reject(new Error('Network unavailable'));
      else if (outcome === 'provider error') {
        requests[0].resolve(Response.json({ ok: false, error: 'provider-unavailable' }, { status: 502 }));
      } else if (outcome === 'invalid response') requests[0].resolve(Response.json({ ok: true, tokenIds: [1] }));
      else requests[0].resolve(Response.json(holdings()));
    });
    assert.deepEqual(result.current.cards, []);
    assert.equal(result.current.status, outcome === 'no holdings' ? 'success' : 'error');
  });
}

test('source changes clear previous cards on every render and retain the random sample', async () => {
  const requests = captureRequests();
  const renders: Array<string[]> = [];
  const { result, rerender } = renderHook((source: MiNoteCardsSource) => {
    const state = useMiNoteCards(source);
    renders.push(state.cards.map((card) => card.id));
    return state;
  }, { initialProps: { mode: 'all' } as MiNoteCardsSource });
  const randomCards = result.current.cards;
  renders.length = 0;
  rerender({ mode: 'owned', address: ADDRESS });
  assert.ok(renders.every((cards) => cards.length === 0));
  assert.equal(result.current.status, 'loading');
  await act(async () => { requests[0].resolve(Response.json(holdings(['1']))); });
  assert.deepEqual(result.current.cards.map((card) => card.id), ['1']);

  renders.length = 0;
  rerender({ mode: 'owned', address: OTHER_ADDRESS });
  assert.ok(renders.every((cards) => cards.length === 0));
  await act(async () => { requests[1].resolve(Response.json(holdings([], ['2']))); });
  assert.deepEqual(result.current.cards.map((card) => card.id), ['2']);

  rerender({ mode: 'inactive' });
  assert.deepEqual(result.current.cards, []);
  assert.equal(result.current.status, 'idle');
  assert.equal(requests.length, 2);
  rerender({ mode: 'all' });
  assert.equal(result.current.cards, randomCards);
  assert.equal(result.current.status, 'success');
  assert.equal(requests.length, 2);
});

test('a recreated source and equivalent address casing do not request holdings again', async () => {
  const requests = captureRequests();
  const { result, rerender } = renderHook(useMiNoteCards, {
    initialProps: { mode: 'owned', address: ADDRESS } as MiNoteCardsSource,
  });
  rerender({ mode: 'owned', address: ADDRESS.toLowerCase() });
  assert.equal(requests.length, 1);
  await act(async () => { requests[0].resolve(Response.json(holdings(['1']))); });
  const cards = result.current.cards;
  rerender({ mode: 'owned', address: ADDRESS });
  assert.equal(result.current.cards, cards);
  assert.equal(requests.length, 1);
});

test('late results from an aborted address cannot replace the current holdings', async () => {
  const requests = captureRequests(true);
  const { result, rerender } = renderHook(useMiNoteCards, {
    initialProps: { mode: 'owned', address: ADDRESS } as MiNoteCardsSource,
  });
  rerender({ mode: 'owned', address: OTHER_ADDRESS });
  assert.equal(requests[0].signal.aborted, true);
  await act(async () => { requests[1].resolve(Response.json(holdings([], ['2']))); });
  await act(async () => { requests[0].resolve(Response.json(holdings(['1']))); });
  assert.deepEqual(result.current.cards.map((card) => card.id), ['2']);
});

for (const transition of [
  { mode: 'owned', address: OTHER_ADDRESS }, { mode: 'all' }, { mode: 'inactive' },
] as const) {
  test(`returning from ${transition.mode} to a previous address waits for its new request`, async () => {
    const requests = captureRequests(true);
    const { result, rerender } = renderHook(useMiNoteCards, {
      initialProps: { mode: 'owned', address: ADDRESS } as MiNoteCardsSource,
    });
    await act(async () => { requests[0].resolve(Response.json(holdings(['1']))); });
    rerender(transition);
    rerender({ mode: 'owned', address: ADDRESS });
    assert.deepEqual(result.current.cards, []);
    assert.equal(result.current.status, 'loading');
    const current = requests.at(-1)!;
    await act(async () => { current.resolve(Response.json(holdings([], ['3']))); });
    assert.deepEqual(result.current.cards.map((card) => card.id), ['3']);
    if (transition.mode === 'owned') {
      assert.equal(requests[1].signal.aborted, true);
      await act(async () => { requests[1].resolve(Response.json(holdings(['2']))); });
      assert.deepEqual(result.current.cards.map((card) => card.id), ['3']);
    }
  });
}

for (const mode of ['all', 'inactive'] as const) {
  test(`${mode} aborts pending ownership work and ignores late results`, async () => {
    const requests = captureRequests(true);
    const { result, rerender } = renderHook(useMiNoteCards, {
      initialProps: { mode: 'owned', address: ADDRESS } as MiNoteCardsSource,
    });
    rerender({ mode });
    const cards = result.current.cards;
    assert.equal(requests[0].signal.aborted, true);
    await act(async () => { requests[0].resolve(Response.json(holdings(['1']))); });
    assert.equal(result.current.cards, cards);
    assert.equal(requests.length, 1);
    assert.equal(result.current.status, mode === 'all' ? 'success' : 'idle');
  });
}

test('retry recovers from a failed ownership request', async () => {
  const requests = captureRequests();
  const { result } = renderHook(() => useMiNoteCards({ mode: 'owned', address: ADDRESS }));
  await act(async () => { requests[0].reject(new Error('Network unavailable')); });
  assert.equal(result.current.status, 'error');
  act(() => { result.current.retry(); });
  assert.equal(result.current.status, 'loading');
  assert.deepEqual(result.current.cards, []);
  await act(async () => { requests[1].resolve(Response.json(holdings(['1']))); });
  assert.equal(result.current.status, 'success');
  assert.deepEqual(result.current.cards.map((card) => card.id), ['1']);
});

test('retry clears prior cards and ignores results from replaced requests', async () => {
  const requests = captureRequests(true);
  const { result } = renderHook(() => useMiNoteCards({ mode: 'owned', address: ADDRESS }));
  await act(async () => { requests[0].resolve(Response.json(holdings(['1']))); });
  act(() => { result.current.retry(); });
  assert.deepEqual(result.current.cards, []);
  assert.equal(result.current.status, 'loading');
  act(() => { result.current.retry(); });
  assert.equal(requests[1].signal.aborted, true);
  await act(async () => { requests[2].resolve(Response.json(holdings([], ['2']))); });
  await act(async () => { requests[1].resolve(Response.json(holdings(['1']))); });
  assert.deepEqual(result.current.cards.map((card) => card.id), ['2']);
});

test('unmount aborts the ownership request', async () => {
  const requests = captureRequests();
  const { unmount } = renderHook(() => useMiNoteCards({ mode: 'owned', address: ADDRESS }));
  await act(async () => { unmount(); });
  assert.equal(requests[0].signal.aborted, true);
});

test('source changes and unmount cancel pending JSON response bodies', async () => {
  const requests = captureRequests();
  const body = openResponse();
  const { result, rerender, unmount } = renderHook(useMiNoteCards, {
    initialProps: { mode: 'owned', address: ADDRESS } as MiNoteCardsSource,
  });
  await act(async () => {
    requests[0].resolve(body.response);
    body.append(JSON.stringify(holdings(['2'])).slice(0, -1));
  });
  rerender({ mode: 'owned', address: OTHER_ADDRESS });
  assert.deepEqual(result.current.cards, []);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(body.cancelled, true);
  const next = openResponse();
  await act(async () => {
    requests[1].resolve(next.response);
    next.append(JSON.stringify(holdings([], ['2'])).slice(0, -1));
  });
  assert.deepEqual(result.current.cards, []);
  await act(async () => { unmount(); });
  assert.equal(next.cancelled, true);
});

test('StrictMode ignores the aborted initial request and displays the active response', async () => {
  const requests = captureRequests(true);
  const { result } = renderHook(() => useMiNoteCards({ mode: 'owned', address: ADDRESS }), { reactStrictMode: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal.aborted, true);
  await act(async () => { requests[1].resolve(Response.json(holdings([], ['2']))); });
  await act(async () => { requests[0].resolve(Response.json(holdings(['1']))); });
  assert.deepEqual(result.current.cards, [COLLECTION_3.tokens[0]]);
});

test('address gallery keeps thumbnails and Notify me without wallet, loading, or empty UI', async () => {
  setSearch(`?address=${ADDRESS}`);
  const requests = captureRequests();
  let notifications = 0;
  const gallery = render(createElement(MiNoteCardsGallery, { onNotify: () => { notifications += 1; } }));
  assert.equal(gallery.queryAllByRole('img').length, 0);
  assert.equal(gallery.queryByRole('tablist'), null);
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

for (const search of ['?address=', '?address=invalid', `?address=${ADDRESS}&address=${OTHER_ADDRESS}`]) {
  test(`gallery with ${search} stays empty without wallet controls or ownership requests`, () => {
    setSearch(search);
    const requests = captureRequests();
    const gallery = render(createElement(MiNoteCardsGallery, { onNotify: () => undefined }));
    assert.equal(gallery.queryAllByRole('img').length, 0);
    assert.equal(gallery.queryByRole('tablist'), null);
    assert.equal(gallery.getByRole('main').textContent, '');
    assert.equal(requests.length, 0);
  });
}

test('gallery query navigation clears cards, tracks navigation events, and restores the same random sample', async () => {
  const requests = captureRequests();
  const gallery = render(createElement(MiNoteCardsGallery, { onNotify: () => undefined }));
  const randomSources = gallery.getAllByRole('img').map((image) => image.getAttribute('src'));
  assert.equal(randomSources.length, 300);
  assert.equal(requests.length, 0);
  navigateSearch(`?address=${ADDRESS}`, 'mons:navigate');
  assert.equal(gallery.queryAllByRole('img').length, 0);
  assert.equal(gallery.queryByRole('tablist'), null);
  await act(async () => { requests[0].resolve(Response.json(holdings(['1']))); });
  assert.equal(gallery.getAllByRole('img').length, 1);

  navigateSearch(`?address=${OTHER_ADDRESS}`);
  assert.equal(gallery.queryAllByRole('img').length, 0);
  await act(async () => { requests[1].resolve(Response.json(holdings([], ['2']))); });
  assert.equal(gallery.getByRole('img').getAttribute('alt'), COLLECTION_3.tokens[0].name);

  navigateSearch('?address=invalid', 'pageshow');
  assert.equal(gallery.queryAllByRole('img').length, 0);
  assert.equal(requests.length, 2);
  navigateSearch('');
  assert.deepEqual(gallery.getAllByRole('img').map((image) => image.getAttribute('src')), randomSources);
  assert.equal(gallery.getByRole('tab', { name: 'All' }).getAttribute('aria-selected'), 'true');
  assert.equal(requests.length, 2);
});

test('All and Your tabs preserve the random sample and show the disconnected wallet action', () => {
  const requests = captureRequests();
  const gallery = render(createElement(MiNoteCardsGallery, { onNotify: () => undefined }));
  const all = gallery.getByRole('tab', { name: 'All' });
  const yours = gallery.getByRole('tab', { name: 'Your' });
  const randomSources = gallery.getAllByRole('img').map((image) => image.getAttribute('src'));
  assert.equal(all.getAttribute('aria-selected'), 'true');
  assert.equal(yours.getAttribute('aria-selected'), 'false');
  assert.equal(gallery.queryByRole('button', { name: 'Connect Ethereum Wallet' }), null);
  fireEvent.click(yours);
  assert.equal(yours.getAttribute('aria-selected'), 'true');
  assert.equal(gallery.queryAllByRole('img').length, 0);
  assert.ok(gallery.getByRole('button', { name: 'Connect Ethereum Wallet' }));
  assert.equal(requests.length, 0);
  fireEvent.click(all);
  assert.deepEqual(gallery.getAllByRole('img').map((image) => image.getAttribute('src')), randomSources);
  assert.equal(requests.length, 0);
});
