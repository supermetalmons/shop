import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';
import { FRONTEND_DROPS } from '../src/config/deployment.ts';
import { figureMetadataCacheKey, type FigureMetadataRecord } from '../src/lib/figureMetadata.ts';
import type { FulfillmentOrder } from '../src/types.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

setupFrontendDom();

const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useFulfillmentExports } = await import('../src/fulfillment/useFulfillmentExports.ts');

type Options = Parameters<typeof useFulfillmentExports>[0];
type Dependencies = NonNullable<Parameters<typeof useFulfillmentExports>[1]>;
const cardDrop = FRONTEND_DROPS.card_nft_2;

afterEach(() => {
  cleanup();
  mock.restoreAll();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function order(): FulfillmentOrder {
  return {
    dropId: cardDrop.dropId,
    deliveryId: 7,
    owner: 'owner-wallet',
    status: 'ready_to_ship',
    address: { full: 'Ada\n123 Main St\nUS', countryCode: 'US', email: 'ada@example.com' },
    boxes: [{ boxId: 11, receiptClaimCode: 'PACK-SECRET', dudeIds: [101] }],
    cardClaims: [{ figureId: 102, receiptClaimCode: 'CARD-SECRET', receiptClaimStatus: 'unclaimed' }],
    looseDudes: [],
  };
}

function metadata(id: number): FigureMetadataRecord {
  return { dropId: cardDrop.dropId, id, image: `https://assets.example.com/${id}.webp` };
}

function options() {
  return {
    displayedOrders: [order()],
    selectedDropId: cardDrop.dropId,
    orderVisibilityFilter: 'all' as const,
    dropById: new Map([[cardDrop.dropId, cardDrop]]),
    figureMetadataByKey: {} as Options['figureMetadataByKey'],
    fulfillmentFigureMetadataTargets: [101, 102].map((figureId) => ({ dropId: cardDrop.dropId, figureId })),
    mergeLoadedFigureMetadata: mock.fn<Options['mergeLoadedFigureMetadata']>(),
    setOrdersError: mock.fn<Options['setOrdersError']>(),
    onMenuClose: mock.fn<Options['onMenuClose']>(),
  } satisfies Options;
}

function dependencies() {
  return {
    loadFigureMetadataBatch: mock.fn<Dependencies['loadFigureMetadataBatch']>(async (targets) =>
      targets.map(({ figureId }) => metadata(figureId))),
    buildSecretCodePngBlob: mock.fn<Dependencies['buildSecretCodePngBlob']>(async () => new Blob(['png'])),
    buildSecretCodesZipBlob: mock.fn<Dependencies['buildSecretCodesZipBlob']>(async () => new Blob(['zip'])),
    downloadBlobFile: mock.fn<Dependencies['downloadBlobFile']>(),
    downloadJsonFile: mock.fn<Dependencies['downloadJsonFile']>(),
  };
}

test('ZIP uses refreshed metadata, reports progress, and blocks PNG downloads until completion', async () => {
  const inputs = options();
  inputs.figureMetadataByKey[figureMetadataCacheKey(cardDrop.dropId, 101)] = {
    ...metadata(101), image: 'https://assets.example.com/stale.webp',
  };
  const files = dependencies();
  const pending = deferred<Blob>();
  files.buildSecretCodesZipBlob.mock.mockImplementation((_entries, onProgress) => {
    onProgress?.(37.6);
    return pending.promise;
  });
  const { result } = renderHook(() => useFulfillmentExports(inputs, files));
  let download!: Promise<void>;
  await act(async () => { download = result.current.downloadDisplayedSecretCodes(); });

  assert.equal(inputs.onMenuClose.mock.callCount(), 1);
  assert.equal(result.current.secretCodesExporting, true);
  assert.equal(result.current.secretCodeDownloadDisabled, true);
  assert.equal(result.current.secretCodesExportPercent, 38);
  assert.deepEqual(files.loadFigureMetadataBatch.mock.calls[0].arguments[0], inputs.fulfillmentFigureMetadataTargets);
  assert.deepEqual(inputs.mergeLoadedFigureMetadata.mock.calls[0].arguments[0], [metadata(101), metadata(102)]);
  assert.deepEqual(files.buildSecretCodesZipBlob.mock.calls[0].arguments[0].map((entry) => entry.previewImages), [
    [{ src: metadata(101).image }], [{ src: metadata(102).image }],
  ]);
  await act(async () => { await result.current.downloadSecretCodePng(inputs.displayedOrders[0], { kind: 'box', index: 0 }); });
  assert.equal(files.buildSecretCodePngBlob.mock.callCount(), 0);

  const zip = new Blob(['finished zip']);
  await act(async () => { pending.resolve(zip); await download; });
  assert.equal(result.current.secretCodesExporting, false);
  assert.equal(result.current.secretCodeDownloadDisabled, false);
  assert.equal(result.current.secretCodesExportPercent, 0);
  assert.match(files.downloadBlobFile.mock.calls[0].arguments[0], /^secret-codes-card-nft-2-all-.*\.zip$/);
  assert.equal(files.downloadBlobFile.mock.calls[0].arguments[1], zip);
});

test('failed ZIP downloads clear progress and allow a successful retry', async () => {
  const inputs = options();
  const files = dependencies();
  const pending = deferred<Blob>();
  files.buildSecretCodesZipBlob.mock.mockImplementation((_entries, onProgress) => {
    onProgress?.(95);
    return pending.promise;
  });
  mock.method(console, 'error', () => undefined);
  const { result } = renderHook(() => useFulfillmentExports(inputs, files));
  let download!: Promise<void>;
  await act(async () => { download = result.current.downloadDisplayedSecretCodes(); });
  await act(async () => { pending.reject(new Error('Image unavailable')); await download; });

  assert.equal(result.current.secretCodesExporting, false);
  assert.equal(result.current.secretCodeDownloadDisabled, false);
  assert.equal(result.current.secretCodesExportPercent, 0);
  assert.deepEqual(inputs.setOrdersError.mock.calls.map((call) => call.arguments[0]), [null, 'Image unavailable']);
  assert.equal(files.downloadBlobFile.mock.callCount(), 0);

  files.buildSecretCodesZipBlob.mock.mockImplementation(async () => new Blob(['retry']));
  await act(async () => { await result.current.downloadDisplayedSecretCodes(); });
  assert.equal(files.downloadBlobFile.mock.callCount(), 1);
  assert.equal(inputs.setOrdersError.mock.calls.at(-1)?.arguments[0], null);
});

test('individual PNGs hydrate only the selected box or card and block ZIP downloads while pending', async () => {
  const inputs = options();
  const files = dependencies();
  const pending = deferred<Blob>();
  files.buildSecretCodePngBlob.mock.mockImplementation(() => pending.promise);
  const { result } = renderHook(() => useFulfillmentExports(inputs, files));
  let download!: Promise<void>;
  await act(async () => {
    download = result.current.downloadSecretCodePng(inputs.displayedOrders[0], { kind: 'box', index: 0 });
  });
  assert.equal(result.current.secretCodeDownloadDisabled, true);
  assert.equal(result.current.secretCodesExporting, false);
  assert.equal(inputs.onMenuClose.mock.callCount(), 0);
  assert.deepEqual(files.loadFigureMetadataBatch.mock.calls[0].arguments[0], [{ dropId: cardDrop.dropId, figureId: 101 }]);
  assert.deepEqual(files.buildSecretCodePngBlob.mock.calls[0].arguments[0].previewImages, [{ src: metadata(101).image }]);
  await act(async () => { await result.current.downloadDisplayedSecretCodes(); });
  assert.equal(files.buildSecretCodesZipBlob.mock.callCount(), 0);
  assert.equal(inputs.onMenuClose.mock.callCount(), 1);
  await act(async () => { pending.resolve(new Blob(['box'])); await download; });
  assert.equal(result.current.secretCodeDownloadDisabled, false);

  files.buildSecretCodePngBlob.mock.mockImplementation(async () => new Blob(['card']));
  await act(async () => {
    await result.current.downloadSecretCodePng(inputs.displayedOrders[0], { kind: 'card-claim', index: 0 });
  });
  assert.deepEqual(files.loadFigureMetadataBatch.mock.calls[1].arguments[0], [{ dropId: cardDrop.dropId, figureId: 102 }]);
  assert.equal(files.buildSecretCodePngBlob.mock.calls[1].arguments[0].secretCode, 'CARD-SECRET');
  assert.deepEqual(files.downloadBlobFile.mock.calls.map((call) => call.arguments[0]), ['7-1.png', '7-2.png']);
});

test('missing codes, missing targets, and used card receipts do not start PNG downloads', async () => {
  const inputs = options();
  const invalidOrder = order();
  invalidOrder.boxes[0].receiptClaimCode = '';
  invalidOrder.cardClaims = [
    { figureId: 102, receiptClaimCode: 'USED', receiptClaimStatus: 'claimed' },
    { figureId: 103, receiptClaimCode: 'PENDING', receiptClaimStatus: 'processing' },
    { figureId: 104, receiptClaimCode: '   ' },
  ];
  const files = dependencies();
  const { result } = renderHook(() => useFulfillmentExports(inputs, files));
  await act(async () => {
    for (const index of [0, 1]) await result.current.downloadSecretCodePng(invalidOrder, { kind: 'box', index });
    for (const index of [0, 1, 2, 3]) await result.current.downloadSecretCodePng(invalidOrder, { kind: 'card-claim', index });
  });
  assert.equal(result.current.secretCodeDownloadDisabled, false);
  assert.equal(files.loadFigureMetadataBatch.mock.callCount(), 0);
  assert.equal(files.buildSecretCodePngBlob.mock.callCount(), 0);
  assert.equal(inputs.setOrdersError.mock.callCount(), 0);
});

test('JSON downloads use displayed orders and current metadata before closing the menu', () => {
  const inputs = options();
  const metadataDrop = FRONTEND_DROPS.little_swag_hoodies;
  inputs.dropById.set(metadataDrop.dropId, metadataDrop);
  inputs.displayedOrders = [{ ...order(), dropId: metadataDrop.dropId, boxes: [], cardClaims: [], looseDudes: [101] }];
  inputs.figureMetadataByKey[figureMetadataCacheKey(metadataDrop.dropId, 101)] = {
    dropId: metadataDrop.dropId, id: 101, name: '321',
  };
  const files = dependencies();
  const events: string[] = [];
  files.downloadJsonFile.mock.mockImplementation(() => { events.push('download'); });
  inputs.onMenuClose.mock.mockImplementation(() => { events.push('close'); });
  const { result } = renderHook(() => useFulfillmentExports(inputs, files));
  act(() => {
    result.current.downloadDisplayedOrders();
    result.current.downloadDisplayedAddresses();
  });

  assert.deepEqual(events, ['download', 'close', 'download', 'close']);
  assert.deepEqual(files.downloadJsonFile.mock.calls[0].arguments[1], [
    { orderId: 'little_swag_hoodies:7', country: 'United States', looseFigures: [321] },
  ]);
  assert.deepEqual(files.downloadJsonFile.mock.calls[1].arguments[1], {
    'little_swag_hoodies:7': { address: ['Ada', '123 Main St', 'United States'], email: 'ada@example.com' },
  });
  assert.equal(files.loadFigureMetadataBatch.mock.callCount(), 0);
});

test('an empty ZIP selection closes the menu without starting an export', async () => {
  const inputs = { ...options(), displayedOrders: [] };
  const files = dependencies();
  const { result } = renderHook(() => useFulfillmentExports(inputs, files));
  await act(async () => { await result.current.downloadDisplayedSecretCodes(); });
  assert.equal(result.current.displayedSecretCodeCount, 0);
  assert.equal(result.current.secretCodeDownloadDisabled, false);
  assert.equal(inputs.onMenuClose.mock.callCount(), 1);
  assert.equal(files.loadFigureMetadataBatch.mock.callCount(), 0);
  assert.equal(files.buildSecretCodesZipBlob.mock.callCount(), 0);
});
