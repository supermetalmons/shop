import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SHIPSTATION_CUSTOMS_CATALOG,
  buildShipStationCustomsDeclaration,
  shipStationCustomsCatalogEntry,
  shipStationPhysicalProductQuantity,
} from '../functions/src/shared/shipstationCustoms.ts';
import { DEPLOYMENT_DROPS } from '../functions/src/shared/deploymentRegistry.ts';

test('the ShipStation customs catalog contains every deployed drop family', () => {
  const deployedFamilies = Array.from(new Set(
    Object.values(DEPLOYMENT_DROPS).map((drop) => drop.dropFamily),
  )).sort();
  assert.deepEqual(Object.keys(SHIPSTATION_CUSTOMS_CATALOG).sort(), deployedFamilies);
  assert.deepEqual(SHIPSTATION_CUSTOMS_CATALOG, {
    little_swag_boxes: {
      contentDescription: 'Painted collectible resin figure',
      description: 'Painted collectible resin figure',
      harmonizedTariffCode: '9503.00',
      netWeightOunces: 3.5,
      sku: 'lsb-figure',
      unitValueUsd: 33.33,
    },
    poncho_drifella: {
      contentDescription: 'Printed collectible art card',
      description: 'Printed collectible art card',
      harmonizedTariffCode: '4911.99',
      netWeightOunces: 0.2,
      sku: 'poncho-card',
      unitValueUsd: 69,
    },
    drifella_shirt: {
      contentDescription: 'Printed cotton T-shirt',
      description: 'Printed cotton T-shirt',
      harmonizedTariffCode: '6109.10',
      netWeightOunces: 10,
      sku: 'drifella-shirt',
      unitValueUsd: 144,
    },
    little_swag_hoodies: {
      contentDescription: 'Printed cotton hooded sweatshirt',
      description: 'Printed cotton hooded sweatshirt',
      harmonizedTariffCode: '6110.20',
      netWeightOunces: 24,
      sku: 'swag-hoodie',
      unitValueUsd: 219,
    },
    card_nft_2: {
      contentDescription: 'Printed collectible art card',
      description: 'Printed collectible art card',
      harmonizedTariffCode: '4911.99',
      netWeightOunces: 0.2,
      sku: 'card-nft-2',
      unitValueUsd: 14.67,
    },
    clear_cards: {
      contentDescription: 'Printed plastic collectible card',
      description: 'Printed plastic collectible card',
      harmonizedTariffCode: '4911.99',
      netWeightOunces: 0.3,
      sku: 'clear-card',
      unitValueUsd: 50,
    },
    card_nft_binder: {
      contentDescription: 'Zippered textile card binder',
      description: 'Zippered textile card binder',
      harmonizedTariffCode: '4202.92',
      netWeightOunces: 20,
      sku: 'card-binder',
      unitValueUsd: 100,
    },
  });
});

test('physical customs quantities expand boxes and count loose products individually', () => {
  assert.equal(shipStationPhysicalProductQuantity('card_nft_2', 2, 1), 7);
  assert.equal(shipStationPhysicalProductQuantity('little_swag_boxes', 3, 2), 11);
  assert.equal(shipStationPhysicalProductQuantity('poncho_drifella', 2, 1), 3);
  assert.equal(shipStationPhysicalProductQuantity('clear_cards_devnet_v3', 2, 1), 3);
  assert.equal(shipStationPhysicalProductQuantity('drifella_shirt', 2, 3), 5);
  assert.equal(shipStationPhysicalProductQuantity('little_swag_hoodies', 2, 3), 5);
  assert.equal(shipStationPhysicalProductQuantity('card_nft_binder', 2, 3), 5);
  assert.equal(shipStationPhysicalProductQuantity('unknown', 2, 3), 3);
});

test('customs declarations use family defaults and add one ounce of packaging', () => {
  assert.deepEqual(buildShipStationCustomsDeclaration('little_swag_boxes', 2, 1), {
    contentDescription: 'Painted collectible resin figure',
    minimumPackageWeightOunces: 25.5,
    product: {
      description: 'Painted collectible resin figure',
      quantity: 7,
      value: { amount: 33.33, currency: 'usd' },
      weight: { value: 3.5, unit: 'ounce' },
      harmonized_tariff_code: '9503.00',
      country_of_origin: 'US',
      sku: 'lsb-figure',
    },
    totalNetWeightOunces: 24.5,
  });
  assert.deepEqual(buildShipStationCustomsDeclaration('drifella_shirt_devnet', 4, 2), {
    contentDescription: 'Printed cotton T-shirt',
    minimumPackageWeightOunces: 61,
    product: {
      description: 'Printed cotton T-shirt',
      quantity: 6,
      value: { amount: 144, currency: 'usd' },
      weight: { value: 10, unit: 'ounce' },
      harmonized_tariff_code: '6109.10',
      country_of_origin: 'US',
      sku: 'drifella-shirt',
    },
    totalNetWeightOunces: 60,
  });
  assert.equal(shipStationCustomsCatalogEntry('card_nft_binder_devnet')?.sku, 'card-binder');
  assert.equal(buildShipStationCustomsDeclaration('drifella_shirt', 2, 0)?.product.quantity, 2);
  assert.equal(buildShipStationCustomsDeclaration('unknown', 2, 1), undefined);
});
