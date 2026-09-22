import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommerceDocumentData, CommerceJsonValue } from '../src/commerceRepositoryTypes.ts';
import {
  parseDeliveryAddressSnapshot,
  parseDeliveryFulfillmentState,
  parseDeliveryOrderShipStation,
  parseDeliveryRecoveryState,
} from '../src/deliveryOrderReadModel.ts';

const JOB_ID = '123e4567-e89b-42d3-a456-426614174000';
const PARCEL = { length: 12, width: 9, height: 2, weight: 4 };

test('fulfillment parsing ignores retired notification state and normalizes tracking', () => {
  assert.deepEqual(parseDeliveryFulfillmentState({
    fulfillmentStatus: 'Shipped', fulfillmentTrackingCode: '  TRACK-123 \n',
    buyerOrderShippedEmailState: 'queued', buyerOrderShippedEmailJobId: JOB_ID,
  }), { fulfillmentStatus: 'Shipped', fulfillmentTrackingCode: 'TRACK-123' });
  assert.deepEqual(parseDeliveryFulfillmentState({ fulfillmentStatus: ' Shipped ', fulfillmentTrackingCode: ' \n ' }), {
    fulfillmentStatus: undefined, fulfillmentTrackingCode: undefined,
  });
});

test('address snapshots retain exact strings and ignore malformed optional fields', () => {
  assert.deepEqual(parseDeliveryAddressSnapshot({
    addressSnapshot: {
      label: '  Buyer  ',
      email: '',
      phone: '  +123  ',
      country: ' US ',
      countryCode: ' us ',
      hint: null,
      encrypted: 123,
      legacy: 'retained in source only',
    },
  }), {
    label: '  Buyer  ',
    email: '',
    phone: '  +123  ',
    country: ' US ',
    countryCode: ' us ',
  });
  for (const addressSnapshot of [undefined, null, [], 'legacy', 12]) {
    assert.deepEqual(parseDeliveryAddressSnapshot({ addressSnapshot }), {});
  }
});

test('recovery timestamps require finite numbers while status and rollback values remain exact', () => {
  const rollbackValues = { attemptCount: ' 03 ', lastAttemptAt: null, preparedProbeCount: ['legacy'] };
  const parsed = parseDeliveryRecoveryState({
    status: ' processing ',
    createdAt: 0,
    processingAt: 123,
    receiptRecovery: { ...rollbackValues, leaseExpiresAt: 456 },
  });
  assert.deepEqual(parsed, {
    status: ' processing ',
    createdAtMs: 0,
    processingAtMs: 123,
    lastAttemptAtMs: null,
    leaseExpiresAtMs: 456,
    rawAttemptCount: ' 03 ',
    rawLastAttemptAt: null,
    rawPreparedProbeCount: ['legacy'],
  });
  assert.equal(parsed.rawPreparedProbeCount, rollbackValues.preparedProbeCount);
  assert.equal(parseDeliveryRecoveryState({ status: 'legacy-status' }).status, 'legacy-status');
  for (const value of ['123', null, Number.NaN, Infinity, -Infinity]) {
    const state = parseDeliveryRecoveryState({
      createdAt: value,
      processingAt: value,
      receiptRecovery: { lastAttemptAt: value, leaseExpiresAt: value },
    });
    assert.deepEqual([state.createdAtMs, state.processingAtMs, state.lastAttemptAtMs, state.leaseExpiresAtMs], [null, null, null, null]);
    assert.equal(state.rawLastAttemptAt, value);
  }
});

test('recovery rollback distinguishes missing fields from explicit null and preserves legacy counters', () => {
  for (const receiptRecovery of [null, [], 'legacy', 12]) {
    assert.deepEqual(parseDeliveryRecoveryState({ receiptRecovery }), parseDeliveryRecoveryState({}));
  }
  const empty = parseDeliveryRecoveryState({});
  assert.equal(empty.rawAttemptCount, undefined);
  assert.equal(empty.rawLastAttemptAt, undefined);
  assert.equal(empty.rawPreparedProbeCount, undefined);
  for (const value of [null, false, 0, '03', { legacy: true }] satisfies CommerceJsonValue[]) {
    const state = parseDeliveryRecoveryState({
      receiptRecovery: { attemptCount: value, lastAttemptAt: value, preparedProbeCount: value },
    });
    assert.equal(state.rawAttemptCount, value);
    assert.equal(state.rawLastAttemptAt, value);
    assert.equal(state.rawPreparedProbeCount, value);
  }
});

test('ShipStation identifiers are trimmed while purchase guards can retain exact stored strings', () => {
  const purchase = { status: ' purchasing ', requestId: ' request-1 ', legacy: true };
  const state = parseDeliveryOrderShipStation({
    shipstation: {
      shipmentId: ' shipment-1 ',
      claimId: ' claim-1 ',
      claimedBy: ' wallet-1 ',
      claimFenceId: ' fence-1 ',
      ratesClaimId: ' rate-claim-1 ',
      ratesClaimedBy: ' wallet-2 ',
      ratesClaimFenceId: ' fence-2 ',
      labelPurchase: purchase,
      rateRequest: {
        requestId: ' request-2 ',
        shipmentId: ' shipment-1 ',
        inputHash: ' hash ',
        createdAt: ' 2026-09-21T00:00:00Z ',
        requestedAt: 123,
        package: PARCEL,
      },
    },
  });
  assert.deepEqual([
    state.shipmentId,
    state.claimId,
    state.claimedBy,
    state.claimFenceId,
    state.ratesClaimId,
    state.ratesClaimedBy,
    state.ratesClaimFenceId,
  ], ['shipment-1', 'claim-1', 'wallet-1', 'fence-1', 'rate-claim-1', 'wallet-2', 'fence-2']);
  assert.deepEqual(state.labelPurchase, {
    raw: purchase,
    status: 'purchasing',
    requestId: 'request-1',
    exactStatus: ' purchasing ',
    exactRequestId: ' request-1 ',
  });
  assert.equal(state.labelPurchase.raw, purchase);
  assert.deepEqual(state.rateRequest, {
    requestId: 'request-2',
    shipmentId: 'shipment-1',
    inputHash: 'hash',
    createdAt: '2026-09-21T00:00:00Z',
    requestedAt: 123,
    package: PARCEL,
  });
  const blankPurchase = parseDeliveryOrderShipStation({
    shipstation: { shipmentId: ' ', labelPurchase: { status: ' ', requestId: '' } },
  });
  assert.equal(blankPurchase.shipmentId, undefined);
  assert.equal(blankPurchase.labelPurchase.status, undefined);
  assert.equal(blankPurchase.labelPurchase.requestId, undefined);
  assert.equal(blankPurchase.labelPurchase.exactStatus, ' ');
  assert.equal(blankPurchase.labelPurchase.exactRequestId, '');
});

test('ShipStation timestamps preserve number-only semantics, including non-finite numbers', () => {
  for (const value of [0, 123, Number.NaN, Infinity, -Infinity, '123', null]) {
    const state = parseDeliveryOrderShipStation({
      shipstation: {
        createdAt: value,
        claimedAt: value,
        ratesClaimedAt: value,
        rateRequest: { requestedAt: value },
      },
    });
    const expected = typeof value === 'number' ? value : undefined;
    assert.equal(state.createdAt, expected);
    assert.equal(state.claimedAt, expected);
    assert.equal(state.ratesClaimedAt, expected);
    assert.equal(state.rateRequest.requestedAt, expected);
  }
});

test('ShipStation package counts retain legacy numeric coercion and flooring', () => {
  for (const [value, expected] of [
    [undefined, 0], [null, 0], ['', 0], [' 2.9 ', 2], [true, 1], [[3], 3],
    [-2, 0], [Number.NaN, 0], [Infinity, Infinity], ['legacy', 0],
  ] as const) {
    assert.equal(parseDeliveryOrderShipStation({ shipstation: { packageCount: value } }).packageCount, expected);
  }
});

test('ShipStation fields reuse stored-label, package, and rate-quote validation', () => {
  const state = parseDeliveryOrderShipStation({
    shipstation: {
      package: { ...PARCEL, weight: 2000 },
      label: {
        labelId: ' label-1 ', shipmentId: ' shipment-1 ', status: 'completed',
        trackingNumber: ' TRACK-1 ', purchasedAt: '123',
        totalCost: { currency: ' USD ', amount: '12.345' },
      },
      rateQuotes: [
        { rateId: ' rate-1 ', shipmentId: ' shipment-1 ', totalAmount: { currency: ' USD ', amount: 12.345 } },
        { rateId: 'rate-2', shipmentId: 'shipment-1', totalAmount: { currency: 'usd', amount: '12.345' } },
        null,
      ],
    },
  });
  assert.deepEqual(state.package, { ...PARCEL, weight: 2000 });
  assert.deepEqual(state.label, {
    labelId: 'label-1', shipmentId: 'shipment-1', status: 'completed',
    trackingNumber: 'TRACK-1', purchasedAt: 123, totalCost: { currency: 'usd', amount: 12.35 },
  });
  assert.deepEqual(state.rateQuotes, [
    { rateId: 'rate-1', shipmentId: 'shipment-1', totalAmount: { currency: 'usd', amount: 12.345 } },
  ]);
  assert.equal(parseDeliveryOrderShipStation({ shipstation: { package: { ...PARCEL, weight: '4' } } }).package, undefined);
  for (const status of [' completed ', 'unknown']) {
    assert.equal(parseDeliveryOrderShipStation({
      shipstation: { label: { labelId: 'label-1', shipmentId: 'shipment-1', status } },
    }).label, undefined);
  }
});

test('missing and malformed ShipStation sections supply optional defaults without rejecting the order', () => {
  for (const shipstation of [undefined, null, [], 'legacy', 12]) {
    const state = parseDeliveryOrderShipStation({ shipstation });
    assert.equal(state.shipmentId, undefined);
    assert.equal(state.label, undefined);
    assert.equal(state.package, undefined);
    assert.equal(state.packageCount, 0);
    assert.deepEqual(state.rateQuotes, []);
    assert.equal(state.rateRequest.requestId, undefined);
    assert.equal(state.rateRequest.package, undefined);
    assert.equal(state.labelPurchase.raw, undefined);
  }
  for (const value of [null, [], 'legacy', 12]) {
    const state = parseDeliveryOrderShipStation({
      shipstation: { label: value, package: value, rateQuotes: value, rateRequest: value, labelPurchase: value },
    });
    assert.equal(state.label, undefined);
    assert.equal(state.package, undefined);
    assert.deepEqual(state.rateQuotes, []);
    assert.equal(state.rateRequest.requestId, undefined);
    assert.equal(state.labelPurchase.status, undefined);
    assert.equal(state.labelPurchase.exactStatus, undefined);
    assert.equal(state.labelPurchase.raw, value);
  }
});

test('unrelated reads do not evaluate malformed optional ShipStation numbers or receipt journals', () => {
  const order = {
    fulfillmentStatus: 'Preparing',
    addressSnapshot: { label: 'Buyer' },
    receiptRecovery: { pendingSubmission: { invalid: true } },
    shipstation: {
      shipmentId: 'shipment-1',
      packageCount: { toString: null, valueOf: null },
      label: {
        labelId: 'label-1', shipmentId: 'shipment-1', status: 'completed',
        purchasedAt: { toString: null, valueOf: null },
      },
    },
  };
  assert.equal(parseDeliveryFulfillmentState(order).fulfillmentStatus, 'Preparing');
  assert.equal(parseDeliveryAddressSnapshot(order).label, 'Buyer');
  assert.equal(parseDeliveryRecoveryState(order).rawAttemptCount, undefined);
  const state = parseDeliveryOrderShipStation(order);
  assert.equal(state.shipmentId, 'shipment-1');
  assert.equal(state.labelPurchase.status, undefined);
  assert.throws(() => state.packageCount, TypeError);
  assert.throws(() => state.label, TypeError);
});

test('parsers preserve source records and unknown fields, and fresh reads reflect updated data', () => {
  const order: CommerceDocumentData = {
    fulfillmentStatus: 'Preparing',
    fulfillmentTrackingCode: ' TRACK-1 ',
    addressSnapshot: { label: ' Buyer ', legacy: ['retained'] },
    receiptRecovery: { attemptCount: '2', pendingSubmission: { invalid: true }, unknown: null },
    shipstation: {
      package: PARCEL,
      packageCount: '2',
      label: { labelId: 'label-1', shipmentId: 'shipment-1', status: 'completed', unknown: true },
      rateQuotes: [],
      rateRequest: { requestId: ' request-1 ', package: PARCEL, unknown: true },
      labelPurchase: { status: 'purchasing', requestId: 'request-1', unknown: true },
      unknown: { retained: true },
    },
    legacy: [null, true, 'retained'],
  };
  const original = structuredClone(order);
  parseDeliveryFulfillmentState(order);
  parseDeliveryAddressSnapshot(order);
  parseDeliveryRecoveryState(order);
  const state = parseDeliveryOrderShipStation(order);
  void { ...state, rateRequest: { ...state.rateRequest } };
  assert.deepEqual(order, original);
  order.fulfillmentStatus = 'Shipped';
  order.shipstation = { shipmentId: 'shipment-2', packageCount: 3 };
  assert.equal(parseDeliveryFulfillmentState(order).fulfillmentStatus, 'Shipped');
  assert.equal(parseDeliveryOrderShipStation(order).shipmentId, 'shipment-2');
  assert.equal(parseDeliveryOrderShipStation(order).packageCount, 3);
});

test('ShipStation parsed sections do not cache optional nested results', () => {
  const shipstation = {
    label: { labelId: 'label-1', shipmentId: 'shipment-1', status: 'completed' },
    package: { ...PARCEL },
    packageCount: 1,
    rateQuotes: [{ rateId: 'rate-1', shipmentId: 'shipment-1', totalAmount: { currency: 'usd', amount: 1 } }],
    rateRequest: { package: { ...PARCEL } },
  };
  const state = parseDeliveryOrderShipStation({ shipstation });
  assert.equal(state.label?.status, 'completed');
  assert.equal(state.package?.weight, 4);
  assert.equal(state.packageCount, 1);
  assert.equal(state.rateQuotes[0]?.totalAmount.amount, 1);
  assert.equal(state.rateRequest.package?.weight, 4);
  shipstation.label.status = 'voided';
  shipstation.package.weight = 8;
  shipstation.packageCount = 2;
  shipstation.rateQuotes[0]!.totalAmount.amount = 2;
  shipstation.rateRequest.package.weight = 8;
  assert.equal(state.label?.status, 'voided');
  assert.equal(state.package?.weight, 8);
  assert.equal(state.packageCount, 2);
  assert.equal(state.rateQuotes[0]?.totalAmount.amount, 2);
  assert.equal(state.rateRequest.package?.weight, 8);
});
