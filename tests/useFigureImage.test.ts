import assert from 'node:assert/strict';
import test, { after, afterEach, mock } from 'node:test';
import { createElement } from 'react';
import type { FigureMetadataRecord } from '../src/lib/figureMetadata.ts';
import {
  CLEAR_CARDS_CARD_CLEAN_BASE_URL,
  CLEAR_CARDS_CARD_CLEAN_DARK_BASE_URL,
} from '../src/config/dropMediaDefaults.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom, setMediaQueryMatches } = setupFrontendDom();
const { act, cleanup, fireEvent, render, renderHook } = await import('@testing-library/react');
const { useFigureImage } = await import('../src/hooks/useFigureImage.ts');
const { FigureTileImage } = await import('../src/shop/inventory/media.tsx');

type Options = Parameters<typeof useFigureImage>[0];
type Loader = NonNullable<Parameters<typeof useFigureImage>[1]>;

afterEach(() => {
  cleanup();
  mock.restoreAll();
  setMediaQueryMatches('(prefers-color-scheme: dark)', false);
});
after(() => dom.window.close());

function options(overrides: Partial<Options> = {}): Options {
  return {
    dropId: 'drop-a',
    figureId: 1,
    primarySrc: 'https://images.example/primary.webp',
    ...overrides,
  };
}

function metadata(image = 'https://images.example/metadata.webp'): FigureMetadataRecord {
  return { dropId: 'drop-a', id: 1, image };
}

function deferred() {
  let resolve!: (value: FigureMetadataRecord | null) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<FigureMetadataRecord | null>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function mount(initialProps: Options, loader: Loader) {
  return renderHook((props: Options) => useFigureImage(props, loader), {
    initialProps,
    reactStrictMode: true,
  });
}

test('primary and supplied fallback images do not request metadata, including fallback failure', () => {
  const fallbackSrc = 'https://images.example/fallback.webp';
  const loader = mock.fn<Loader>(async () => metadata());
  const initial = options({ fallbackSrc });
  const { result } = mount(initial, loader);

  assert.equal(result.current.activeSrc, initial.primarySrc);
  act(() => result.current.handleError());
  assert.equal(result.current.activeSrc, fallbackSrc);
  act(() => result.current.handleError());
  assert.equal(result.current.activeSrc, null);
  assert.equal(loader.mock.callCount(), 0);
});

test('fallback-only and empty sources render without requesting metadata', () => {
  const loader = mock.fn<Loader>(async () => metadata());
  const initial = options({ primarySrc: undefined, fallbackSrc: 'https://images.example/fallback.webp' });
  const { result, rerender } = mount(initial, loader);

  assert.equal(result.current.activeSrc, initial.fallbackSrc);
  act(() => result.current.handleError());
  assert.equal(result.current.activeSrc, null);
  rerender(options({ figureId: 2, primarySrc: undefined }));
  assert.equal(result.current.activeSrc, null);
  assert.equal(loader.mock.callCount(), 0);
});

test('primary failure resolves metadata once and failed metadata images become placeholders', async () => {
  const pending = deferred();
  const loader = mock.fn<Loader>(() => pending.promise);
  const onMetadataResolved = mock.fn<NonNullable<Options['onMetadataResolved']>>();
  const initial = options({ onMetadataResolved });
  initial.fallbackSrc = initial.primarySrc;
  const { result } = mount(initial, loader);

  act(() => result.current.handleError());
  assert.equal(result.current.activeSrc, null);
  assert.deepEqual(loader.mock.calls[0].arguments, [initial.dropId, initial.figureId]);
  const record = metadata();
  await act(async () => { pending.resolve(record); });
  assert.equal(result.current.activeSrc, record.image);
  assert.deepEqual(onMetadataResolved.mock.calls.map((call) => call.arguments), [[record]]);

  act(() => result.current.handleError());
  assert.equal(result.current.activeSrc, null);
  assert.equal(loader.mock.callCount(), 1);
});

for (const failure of ['rejection', 'null', 'missing image', 'same primary image'] as const) {
  test(`metadata ${failure} leaves a placeholder without publishing metadata`, async () => {
    const pending = deferred();
    const onMetadataResolved = mock.fn<NonNullable<Options['onMetadataResolved']>>();
    const initial = options({ onMetadataResolved });
    const { result } = mount(initial, () => pending.promise);

    act(() => result.current.handleError());
    await act(async () => {
      if (failure === 'rejection') pending.reject(new Error('Metadata unavailable'));
      else if (failure === 'null') pending.resolve(null);
      else if (failure === 'missing image') pending.resolve({ dropId: 'drop-a', id: 1 });
      else pending.resolve(metadata(initial.primarySrc));
    });
    assert.equal(result.current.activeSrc, null);
    assert.equal(onMetadataResolved.mock.callCount(), 0);
  });
}

test('late fallback sources fill placeholders without replacing an active fallback', () => {
  const loader = mock.fn<Loader>(async () => metadata());
  const initial = options({ primarySrc: undefined });
  const { result, rerender } = mount(initial, loader);
  const first = 'https://images.example/first.webp';
  const second = 'https://images.example/second.webp';
  const third = 'https://images.example/third.webp';

  rerender({ ...initial, fallbackSrc: first });
  assert.equal(result.current.activeSrc, first);
  rerender({ ...initial, fallbackSrc: second });
  assert.equal(result.current.activeSrc, first);
  act(() => result.current.handleError());
  assert.equal(result.current.activeSrc, null);
  rerender({ ...initial, fallbackSrc: third });
  assert.equal(result.current.activeSrc, third);
  assert.equal(loader.mock.callCount(), 0);
});

test('a late fallback preserves the primary image and becomes available on primary failure', () => {
  const loader = mock.fn<Loader>(async () => metadata());
  const initial = options();
  const { result, rerender } = mount(initial, loader);
  const fallbackSrc = 'https://images.example/late.webp';

  rerender({ ...initial, fallbackSrc });
  assert.equal(result.current.activeSrc, initial.primarySrc);
  act(() => result.current.handleError());
  assert.equal(result.current.activeSrc, fallbackSrc);
  assert.equal(loader.mock.callCount(), 0);
});

for (const change of [
  { label: 'drop', value: { dropId: 'drop-b' } },
  { label: 'figure', value: { figureId: 2 } },
  { label: 'primary source', value: { primarySrc: 'https://images.example/new-primary.webp' } },
] satisfies Array<{ label: string; value: Partial<Options> }>) {
  for (const outcome of ['success', 'failure'] as const) {
    test(`changing ${change.label} resets the image and ignores an older metadata ${outcome}`, async () => {
      const oldRequest = deferred();
      const newRequest = deferred();
      let calls = 0;
      const loader: Loader = () => (++calls === 1 ? oldRequest.promise : newRequest.promise);
      const onMetadataResolved = mock.fn<NonNullable<Options['onMetadataResolved']>>();
      const initial = options({ onMetadataResolved });
      const { result, rerender } = mount(initial, loader);

      act(() => result.current.handleError());
      const next = { ...initial, ...change.value };
      rerender(next);
      assert.equal(result.current.activeSrc, next.primarySrc);
      act(() => result.current.handleError());
      const currentRecord = metadata('https://images.example/current.webp');
      await act(async () => { newRequest.resolve(currentRecord); });
      await act(async () => {
        if (outcome === 'success') oldRequest.resolve(metadata('https://images.example/old.webp'));
        else oldRequest.reject(new Error('Old request failed'));
      });

      assert.equal(result.current.activeSrc, currentRecord.image);
      assert.deepEqual(onMetadataResolved.mock.calls.map((call) => call.arguments), [[currentRecord]]);
    });
  }
}

test('unmount invalidates pending metadata callbacks', async () => {
  const pending = deferred();
  const onMetadataResolved = mock.fn<NonNullable<Options['onMetadataResolved']>>();
  const { result, unmount } = mount(options({ onMetadataResolved }), () => pending.promise);

  act(() => result.current.handleError());
  unmount();
  await act(async () => { pending.resolve(metadata()); });
  assert.equal(onMetadataResolved.mock.callCount(), 0);
});

test('inventory images retain color-scheme rendering, fallback handling, and drag prevention', () => {
  const dropId = 'clear_cards_devnet_v2';
  const fallbackSrc = 'https://images.example/fallback.webp';
  const view = render(createElement(FigureTileImage, {
    dropId,
    figureId: 167,
    primarySrc: `${CLEAR_CARDS_CARD_CLEAN_BASE_URL}/167.webp`,
    fallbackSrc,
    alt: 'Clear Card #167',
  }));
  const image = view.getByRole('img', { name: 'Clear Card #167' }) as HTMLImageElement;
  assert.equal(image.draggable, false);
  assert.equal(fireEvent.dragStart(image), false);
  act(() => setMediaQueryMatches('(prefers-color-scheme: dark)', true));
  assert.equal(image.src, `${CLEAR_CARDS_CARD_CLEAN_DARK_BASE_URL}/167.webp`);

  fireEvent.error(image);
  assert.equal(image.src, fallbackSrc);
  fireEvent.error(image);
  assert.equal(view.queryByRole('img'), null);
  assert.equal(view.container.firstElementChild?.tagName, 'DIV');
  assert.equal(view.container.firstElementChild?.className, 'figure-image figure-image--placeholder');
});
