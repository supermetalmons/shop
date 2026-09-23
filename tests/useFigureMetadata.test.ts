import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import {
  figureMetadataCacheKey,
  getCachedFigureMetadata,
  type FigureMetadataTarget,
} from '../src/lib/figureMetadata.ts';
import { useFigureMetadataSnapshot, useFigureMetadataTargets } from '../src/hooks/useFigureMetadata.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook } = await import('@testing-library/react');
afterEach(cleanup);
after(() => dom.window.close());

function target(figureId: number): FigureMetadataTarget {
  return { dropId: 'little_swag_hoodies', figureId };
}

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function response(name: string): Response {
  return new Response(JSON.stringify({ name, image: 'https://images.example/hoodie.webp' }));
}

test('StrictMode shares metadata requests and wallet target changes preserve late public cache results', async (t) => {
  const previous = target(92001);
  const current = target(92002);
  const previousRequest = deferredResponse();
  const currentRequest = deferredResponse();
  let requests = 0;
  const fetch = t.mock.method(globalThis, 'fetch', () =>
    ++requests === 1 ? previousRequest.promise : currentRequest.promise,
  );
  const useMetadata = (targets: FigureMetadataTarget[]) => {
    useFigureMetadataTargets(targets);
    return useFigureMetadataSnapshot();
  };
  const { result, rerender, unmount } = renderHook(useMetadata, {
    initialProps: [previous],
    reactStrictMode: true,
  });
  assert.equal(fetch.mock.callCount(), 1);
  rerender([current]);
  assert.equal(fetch.mock.callCount(), 2);

  await act(async () => currentRequest.resolve(response('Current wallet hoodie')));
  const currentKey = figureMetadataCacheKey(current.dropId, current.figureId);
  const currentRecord = result.current[currentKey];
  assert.equal(currentRecord.name, 'Current wallet hoodie');
  await act(async () => previousRequest.resolve(response('Previous wallet hoodie')));
  assert.equal(result.current[currentKey], currentRecord);
  assert.equal(getCachedFigureMetadata(previous.dropId, previous.figureId)?.name, 'Previous wallet hoodie');
  unmount();

  const remount = renderHook(useMetadata, {
    initialProps: [previous, current],
    reactStrictMode: true,
  });
  assert.equal(remount.result.current[currentKey], currentRecord);
  assert.equal(fetch.mock.callCount(), 2);
});

test('target changes release old retries and unmount cancels retries until remount', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const previous = target(92003);
  const current = target(92004);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
  t.mock.method(console, 'warn', () => undefined);
  const { rerender, unmount } = renderHook(useFigureMetadataTargets, {
    initialProps: [previous],
    reactStrictMode: true,
  });
  await act(async () => undefined);
  assert.equal(fetch.mock.callCount(), 1);
  rerender([current]);
  await act(async () => undefined);
  assert.equal(fetch.mock.callCount(), 2);

  await act(async () => t.mock.timers.tick(3_000));
  assert.equal(fetch.mock.callCount(), 3);
  assert.match(String(fetch.mock.calls[2].arguments[0]), /92004\.json$/);
  unmount();
  await act(async () => t.mock.timers.tick(30_000));
  assert.equal(fetch.mock.callCount(), 3);

  renderHook(useFigureMetadataTargets, { initialProps: [current], reactStrictMode: true });
  await act(async () => undefined);
  assert.equal(fetch.mock.callCount(), 4);
});

test('adding and removing other targets preserves an unchanged target retry deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const failing = target(92005);
  const successful = target(92006);
  const fetch = t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) =>
    String(input).endsWith('92005.json')
      ? new Response(null, { status: 503 })
      : response('Successful hoodie'),
  );
  t.mock.method(console, 'warn', () => undefined);
  const { rerender } = renderHook(useFigureMetadataTargets, {
    initialProps: [failing],
    reactStrictMode: true,
  });
  await act(async () => undefined);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(getCachedFigureMetadata(failing.dropId, failing.figureId), undefined);

  await act(async () => t.mock.timers.tick(1_000));
  rerender([failing, successful]);
  await act(async () => undefined);
  assert.equal(fetch.mock.callCount(), 2);
  assert.ok(getCachedFigureMetadata(successful.dropId, successful.figureId));

  await act(async () => t.mock.timers.tick(1_000));
  rerender([failing]);
  await act(async () => undefined);
  assert.equal(fetch.mock.callCount(), 2);
  await act(async () => t.mock.timers.tick(999));
  assert.equal(fetch.mock.callCount(), 2);
  await act(async () => t.mock.timers.tick(1));
  assert.equal(fetch.mock.callCount(), 3);
  assert.match(String(fetch.mock.calls[2].arguments[0]), /92005\.json$/);
});
