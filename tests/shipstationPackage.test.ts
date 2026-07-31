import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultShipStationPackage,
  normalizeShipStationPackage,
} from '../functions/src/shared/shipstationPackage.ts';
import { buildShipStationPackages } from '../functions/src/shipstation.ts';

test('the default parcel scales its weight with the unit count and keeps a floor of one unit', () => {
  assert.deepEqual(defaultShipStationPackage(1), { length: 12, width: 9, height: 2, weight: 4 });
  assert.deepEqual(defaultShipStationPackage(3), { length: 12, width: 9, height: 2, weight: 12 });
  assert.deepEqual(defaultShipStationPackage(0), defaultShipStationPackage(1));
  assert.deepEqual(defaultShipStationPackage(Number.NaN), defaultShipStationPackage(1));
});

test('edited measurements are rounded to two decimals', () => {
  assert.deepEqual(normalizeShipStationPackage({ length: 12.345, width: 9, height: 2, weight: 4.006 }), {
    length: 12.35,
    width: 9,
    height: 2,
    weight: 4.01,
  });
});

test('measurements outside the accepted range are rejected rather than silently clamped', () => {
  const valid = { length: 12, width: 9, height: 2, weight: 4 };
  assert.equal(normalizeShipStationPackage({ ...valid, length: 0 }), null);
  assert.equal(normalizeShipStationPackage({ ...valid, width: -1 }), null);
  assert.equal(normalizeShipStationPackage({ ...valid, height: 500 }), null);
  assert.equal(normalizeShipStationPackage({ ...valid, weight: 0 }), null);
  assert.equal(normalizeShipStationPackage({ ...valid, weight: 5000 }), null);
  assert.equal(normalizeShipStationPackage({ ...valid, length: '' }), null);
  assert.equal(normalizeShipStationPackage({ length: 12, width: 9, height: 2 }), null);
  assert.equal(normalizeShipStationPackage(null), null);
});

test('an override replaces the derived parcel, and its absence falls back to the defaults', () => {
  assert.deepEqual(buildShipStationPackages(2), [
    { weight: { value: 8, unit: 'ounce' }, dimensions: { length: 12, width: 9, height: 2, unit: 'inch' } },
  ]);
  assert.deepEqual(buildShipStationPackages(2, { length: 6, width: 4, height: 1.5, weight: 10 }), [
    { weight: { value: 10, unit: 'ounce' }, dimensions: { length: 6, width: 4, height: 1.5, unit: 'inch' } },
  ]);
});
