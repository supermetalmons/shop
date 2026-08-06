import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupFulfillmentShipStationRates,
  prepareFulfillmentShipStationRates,
} from '../src/lib/fulfillmentShipStationRates.ts';
import type { FulfillmentShipStationRate } from '../src/types.ts';

const rates = (...rateIds: string[]) => rateIds.map((rateId) => ({ rateId }));

const money = { currency: 'usd', amount: 0 };

function shipStationRate(
  rateId: string,
  overrides: Partial<FulfillmentShipStationRate> = {},
): FulfillmentShipStationRate {
  return {
    rateId,
    shipmentId: 'se-shipment',
    carrierId: 'se-usps',
    carrierCode: 'stamps_com',
    carrierName: 'USPS',
    serviceCode: 'usps_ground_advantage',
    serviceName: 'USPS Ground Advantage',
    shippingAmount: { currency: 'usd', amount: 6.25 },
    insuranceAmount: money,
    confirmationAmount: money,
    otherAmount: money,
    totalAmount: { currency: 'usd', amount: 6.25 },
    estimatedDeliveryDate: '2026-08-08T00:00:00Z',
    guaranteedService: false,
    warningMessages: [],
    ...overrides,
  };
}

test('ShipStation rate groups keep zero, one, and three rates in the shortlist', () => {
  for (const input of [rates(), rates('a'), rates('a', 'b', 'c')]) {
    const grouped = groupFulfillmentShipStationRates(input, input[0]?.rateId ?? null);
    assert.deepEqual(grouped.recommendedRates, input);
    assert.deepEqual(grouped.otherRates, []);
    assert.equal(grouped.selectedOtherRate, null);
  }
});

test('ShipStation rate groups preserve price order across the shortlist and other rates', () => {
  const grouped = groupFulfillmentShipStationRates(rates('a', 'b', 'c', 'd', 'e'), 'a');
  assert.deepEqual(grouped.recommendedRates.map((rate) => rate.rateId), ['a', 'b', 'c']);
  assert.deepEqual(grouped.otherRates.map((rate) => rate.rateId), ['d', 'e']);
  assert.equal(grouped.selectedOtherRate, null);
});

test('ShipStation rate groups retain an out-of-shortlist selection for the compact view', () => {
  const grouped = groupFulfillmentShipStationRates(rates('a', 'b', 'c', 'd', 'e'), 'e');
  assert.equal(grouped.selectedOtherRate?.rateId, 'e');
});

test('only repeated entries with the same ShipStation rate id are deduplicated', () => {
  const prepared = prepareFulfillmentShipStationRates([
    shipStationRate('rate-a'),
    shipStationRate('rate-a'),
  ]);

  assert.deepEqual(prepared.rates.map((rate) => rate.rateId), ['rate-a']);
  assert.equal(prepared.detailByRateId.size, 0);
});

test('separate ShipStation quotes are preserved even when their known fields match', () => {
  const prepared = prepareFulfillmentShipStationRates([
    shipStationRate('rate-a'),
    shipStationRate('rate-b'),
  ]);

  assert.deepEqual(prepared.rates.map((rate) => rate.rateId), ['rate-a', 'rate-b']);
  assert.equal(prepared.detailByRateId.get('rate-a'), 'ShipStation quote: rate-a');
  assert.equal(prepared.detailByRateId.get('rate-b'), 'ShipStation quote: rate-b');
});

test('matching ShipStation rates from different carrier accounts stay visible with account details', () => {
  const prepared = prepareFulfillmentShipStationRates([
    shipStationRate('rate-a', { carrierId: 'se-account-a', carrierNickname: 'Warehouse USPS' }),
    shipStationRate('rate-b', { carrierId: 'se-account-b', carrierNickname: 'ShipStation Balance' }),
  ]);

  assert.deepEqual(prepared.rates.map((rate) => rate.rateId), ['rate-a', 'rate-b']);
  assert.equal(prepared.detailByRateId.get('rate-a'), 'Account: Warehouse USPS');
  assert.equal(prepared.detailByRateId.get('rate-b'), 'Account: ShipStation Balance');
});

test('rates are compared using the delivery estimate rendered in the UI', () => {
  const prepared = prepareFulfillmentShipStationRates([
    shipStationRate('rate-a', {
      carrierId: 'se-account-a',
      carrierNickname: 'Warehouse USPS',
      deliveryDays: 1,
    }),
    shipStationRate('rate-b', {
      carrierId: 'se-account-b',
      carrierNickname: 'ShipStation Balance',
      deliveryDays: 2,
    }),
  ]);

  assert.equal(prepared.detailByRateId.get('rate-a'), 'Account: Warehouse USPS');
  assert.equal(prepared.detailByRateId.get('rate-b'), 'Account: ShipStation Balance');
});

test('matching rate names expose different service codes and package types', () => {
  const prepared = prepareFulfillmentShipStationRates([
    shipStationRate('rate-a', { serviceCode: 'service_a', packageType: 'package' }),
    shipStationRate('rate-b', { serviceCode: 'service_b', packageType: 'flat_rate_envelope' }),
  ]);

  assert.equal(prepared.detailByRateId.get('rate-a'), 'Service code: Service A · Package: Package');
  assert.equal(
    prepared.detailByRateId.get('rate-b'),
    'Service code: Service B · Package: Flat Rate Envelope',
  );
});

test('matching total prices expose different charge components', () => {
  const prepared = prepareFulfillmentShipStationRates([
    shipStationRate('rate-a'),
    shipStationRate('rate-b', {
      shippingAmount: { currency: 'usd', amount: 5.25 },
      insuranceAmount: { currency: 'usd', amount: 1 },
    }),
  ]);

  assert.equal(prepared.detailByRateId.get('rate-a'), 'Shipping: USD 6.25 · Insurance: USD 0.00');
  assert.equal(prepared.detailByRateId.get('rate-b'), 'Shipping: USD 5.25 · Insurance: USD 1.00');
});

test('matching rates expose operational ShipStation differences', () => {
  const prepared = prepareFulfillmentShipStationRates([
    shipStationRate('rate-a', {
      trackable: true,
      negotiatedRate: true,
      rateType: 'shipment',
      zone: 4,
      carrierDeliveryDays: '2 business days',
      shipDate: '2026-08-06T00:00:00Z',
    }),
    shipStationRate('rate-b', {
      trackable: false,
      negotiatedRate: false,
      rateType: 'check',
      zone: 5,
      carrierDeliveryDays: '3 business days',
      shipDate: '2026-08-07T00:00:00Z',
    }),
  ]);

  assert.match(prepared.detailByRateId.get('rate-a') ?? '', /Tracking included/);
  assert.match(prepared.detailByRateId.get('rate-a') ?? '', /Negotiated rate/);
  assert.match(prepared.detailByRateId.get('rate-a') ?? '', /Rate type: Shipment/);
  assert.match(prepared.detailByRateId.get('rate-a') ?? '', /Zone: 4/);
  assert.match(prepared.detailByRateId.get('rate-a') ?? '', /Carrier estimate: 2 business days/);
  assert.match(prepared.detailByRateId.get('rate-a') ?? '', /Ship date:/);
  assert.match(prepared.detailByRateId.get('rate-b') ?? '', /Tracking unavailable/);
  assert.match(prepared.detailByRateId.get('rate-b') ?? '', /Standard rate/);
});
