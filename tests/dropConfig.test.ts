import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRONTEND_DROPS,
  defaultDropFamilyForDropId as defaultFrontendDropFamilyForDropId,
  normalizeDropFamily as normalizeFrontendDropFamily,
} from '../src/config/deployment.ts';
import {
  FUNCTIONS_DROPS,
  defaultDropFamilyForDropId as defaultFunctionsDropFamilyForDropId,
  normalizeDropFamily as normalizeFunctionsDropFamily,
} from '../functions/src/config/deployment.ts';
import {
  defaultDropFamilyForDropId as defaultRegistryDropFamilyForDropId,
  normalizeDropFamily as normalizeRegistryDropFamily,
  requireDropFamily,
} from '../scripts/shared/deploymentRegistry.ts';
import {
  listUpcomingDropRoutes,
  resolveUpcomingDropRouteByPath,
  resolveUpcomingRouteDrop,
} from '../src/lib/dropConfig.ts';

const DRIFELLA_UPCOMING_ROUTES = [
  {
    path: '/drifella_binder',
    dropFamily: 'drifella_binder',
    solanaCluster: 'mainnet-beta',
    label: 'Card NFT Binder',
    title: 'Card NFT Binder',
    previewImageUrl: 'https://cdn.lil.org/wip/binder.webp',
    previewAspectRatio: 1034 / 1400,
    boxNamePrefix: 'binder',
  },
  {
    path: '/drifella_shirt',
    dropFamily: 'drifella_shirt',
    solanaCluster: 'mainnet-beta',
    label: 'Drifella Shirt',
    title: 'Drifella Shirt',
    previewImageUrl: 'https://cdn.lil.org/wip/shirt_1.webp',
    previewAspectRatio: 1781 / 1400,
    boxNamePrefix: 'shirt',
  },
] as const;

test('Drifella upcoming routes expose their exact preview configuration', () => {
  const routesByPath = new Map(listUpcomingDropRoutes().map((route) => [route.path, route]));

  for (const expected of DRIFELLA_UPCOMING_ROUTES) {
    assert.deepEqual(routesByPath.get(expected.path), expected);
  }
});

test('Drifella upcoming routes resolve with trailing slashes but not deployed drops', () => {
  for (const expected of DRIFELLA_UPCOMING_ROUTES) {
    const route = resolveUpcomingDropRouteByPath(`${expected.path}/`);

    assert.deepEqual(route, expected);
    assert.equal(resolveUpcomingRouteDrop(route, []), null);
    assert.equal(FRONTEND_DROPS[expected.dropFamily], undefined);
    assert.equal(FUNCTIONS_DROPS[expected.dropFamily], undefined);
  }
});

test('Drifella family names normalize and default from IDs across registry contracts', () => {
  for (const family of ['drifella_binder', 'drifella_shirt'] as const) {
    assert.equal(defaultFrontendDropFamilyForDropId(` ${family.toUpperCase()} `), family);
    assert.equal(normalizeFrontendDropFamily(` ${family.toUpperCase()} `), family);
    assert.equal(normalizeFrontendDropFamily(undefined, ` ${family.toUpperCase()} `), family);

    assert.equal(defaultFunctionsDropFamilyForDropId(` ${family.toUpperCase()} `), family);
    assert.equal(normalizeFunctionsDropFamily(` ${family.toUpperCase()} `), family);
    assert.equal(normalizeFunctionsDropFamily(undefined, ` ${family.toUpperCase()} `), family);

    assert.equal(defaultRegistryDropFamilyForDropId(` ${family.toUpperCase()} `), family);
    assert.equal(normalizeRegistryDropFamily(` ${family.toUpperCase()} `), family);
    assert.equal(normalizeRegistryDropFamily(undefined, ` ${family.toUpperCase()} `), family);
    assert.equal(requireDropFamily(` ${family.toUpperCase()} `, 'dropFamily'), family);
  }
});
