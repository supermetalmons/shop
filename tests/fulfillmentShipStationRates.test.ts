import test from 'node:test';
import assert from 'node:assert/strict';
import { groupFulfillmentShipStationRates } from '../src/lib/fulfillmentShipStationRates.ts';

const rates = (...rateIds: string[]) => rateIds.map((rateId) => ({ rateId }));

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
