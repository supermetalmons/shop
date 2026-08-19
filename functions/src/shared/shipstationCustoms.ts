import { normalizeDropId, type DropFamily } from './deploymentCore.js';
import { DEPLOYMENT_DROPS } from './deploymentRegistry.js';
import type { ShipStationPackageProduct } from './shipstationRates.js';

export type ShipStationCustomsCatalogEntry = Readonly<{
  contentDescription: string;
  description: string;
  harmonizedTariffCode: string;
  netWeightOunces: number;
  sku: string;
  unitValueUsd: number;
}>;

export const SHIPSTATION_CUSTOMS_CATALOG: Readonly<
  Partial<Record<DropFamily, ShipStationCustomsCatalogEntry>>
> = Object.freeze({
  little_swag_boxes: Object.freeze({
    contentDescription: 'Painted collectible resin figure',
    description: 'Painted collectible resin figure',
    harmonizedTariffCode: '9503.00',
    netWeightOunces: 3.5,
    sku: 'lsb-figure',
    unitValueUsd: 33.33,
  }),
  poncho_drifella: Object.freeze({
    contentDescription: 'Printed collectible art card',
    description: 'Printed collectible art card',
    harmonizedTariffCode: '4911.99',
    netWeightOunces: 0.2,
    sku: 'poncho-card',
    unitValueUsd: 69,
  }),
  drifella_shirt: Object.freeze({
    contentDescription: 'Printed cotton T-shirt',
    description: 'Printed cotton T-shirt',
    harmonizedTariffCode: '6109.10',
    netWeightOunces: 10,
    sku: 'drifella-shirt',
    unitValueUsd: 144,
  }),
  little_swag_hoodies: Object.freeze({
    contentDescription: 'Printed cotton hooded sweatshirt',
    description: 'Printed cotton hooded sweatshirt',
    harmonizedTariffCode: '6110.20',
    netWeightOunces: 24,
    sku: 'swag-hoodie',
    unitValueUsd: 219,
  }),
  card_nft_2: Object.freeze({
    contentDescription: 'Printed collectible art card',
    description: 'Printed collectible art card',
    harmonizedTariffCode: '4911.99',
    netWeightOunces: 0.2,
    sku: 'card-nft-2',
    unitValueUsd: 14.67,
  }),
  clear_cards: Object.freeze({
    contentDescription: 'Printed plastic collectible card',
    description: 'Printed plastic collectible card',
    harmonizedTariffCode: '4911.99',
    netWeightOunces: 0.3,
    sku: 'clear-card',
    unitValueUsd: 50,
  }),
  card_nft_binder: Object.freeze({
    contentDescription: 'Zippered textile card binder',
    description: 'Zippered textile card binder',
    harmonizedTariffCode: '4202.92',
    netWeightOunces: 20,
    sku: 'card-binder',
    unitValueUsd: 100,
  }),
});

export type ShipStationCustomsDeclaration = Readonly<{
  contentDescription: string;
  minimumPackageWeightOunces: number;
  product: ShipStationPackageProduct;
  totalNetWeightOunces: number;
}>;

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function shipStationCustomsCatalogEntry(
  dropId: string,
): ShipStationCustomsCatalogEntry | undefined {
  const drop = DEPLOYMENT_DROPS[normalizeDropId(dropId)];
  if (!drop) return undefined;
  return SHIPSTATION_CUSTOMS_CATALOG[drop.dropFamily];
}

export function shipStationPhysicalProductQuantity(
  dropId: string,
  boxCount: number,
  looseItemCount: number,
): number {
  const drop = DEPLOYMENT_DROPS[normalizeDropId(dropId)];
  const configuredUnitsPerBox = Math.max(0, Math.floor(Number(drop?.itemsPerBox) || 0));
  const unitsPerBox = drop ? Math.max(1, configuredUnitsPerBox) : 0;
  const quantity = nonNegativeInteger(boxCount) * unitsPerBox + nonNegativeInteger(looseItemCount);
  return quantity;
}

export function buildShipStationCustomsDeclaration(
  dropId: string,
  boxCount: number,
  looseItemCount: number,
): ShipStationCustomsDeclaration | undefined {
  const catalog = shipStationCustomsCatalogEntry(dropId);
  if (!catalog) return undefined;
  const quantity = shipStationPhysicalProductQuantity(dropId, boxCount, looseItemCount);
  if (!quantity) return undefined;
  const netWeight = Math.round(catalog.netWeightOunces * quantity * 100) / 100;
  return {
    contentDescription: catalog.contentDescription,
    minimumPackageWeightOunces: Math.ceil((netWeight + 1) * 100) / 100,
    product: {
      description: catalog.description,
      quantity,
      value: { amount: catalog.unitValueUsd, currency: 'usd' },
      weight: { value: catalog.netWeightOunces, unit: 'ounce' },
      harmonized_tariff_code: catalog.harmonizedTariffCode,
      country_of_origin: 'US',
      sku: catalog.sku,
    },
    totalNetWeightOunces: netWeight,
  };
}
