import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRONTEND_DROPS,
} from '../src/config/deployment.ts';
import {
  API_DROPS,
} from '../cloud/workers/api/src/dropConfig.ts';
import {
  requireDropFamily,
} from '../scripts/shared/deploymentRegistry.ts';
import {
  defaultDropFamilyForDropId,
  normalizeDropFamily,
} from '../shared/deploymentCore.ts';
import {
  LEGACY_DROP_ROUTE_ALIASES,
  listUpcomingDropRoutes,
  resolveFrontendDropByPath,
  resolveUpcomingDropRouteByPath,
  resolveUpcomingRouteDrop,
} from '../src/lib/dropConfig.ts';
import { resolveAppRoute, WIP_ROUTES } from '../src/routes.ts';

const UPCOMING_ROUTES = [
  {
    path: '/clear_cards',
    dropFamily: 'clear_cards',
    solanaCluster: 'mainnet-beta',
    label: 'Clear Cards',
    title: 'Clear Cards',
    previewImageUrl: 'https://cdn.lil.org/nft/clear_cards/pack_clean.webp',
    previewAspectRatio: 1362 / 1400,
    boxNamePrefix: 'card',
  },
  {
    path: '/tbd',
    dropFamily: 'tbd',
    solanaCluster: 'mainnet-beta',
    label: 'TBD',
    title: 'TBD',
    previewImageUrl: 'https://wip.lil.org/tbd_3.webp',
    previewAspectRatio: 1122 / 1266,
    boxNamePrefix: 'drop',
    statusText: 'Fall 2026',
  },
  {
    path: '/card_nft_binder',
    dropFamily: 'card_nft_binder',
    solanaCluster: 'mainnet-beta',
    label: 'Card NFT Binder',
    title: 'Card NFT Binder',
    previewImageUrl: 'https://cdn.lil.org/nft/card_nft_binder/clean.webp',
    previewAspectRatio: 1034 / 1400,
    boxNamePrefix: 'binder',
  },
  {
    path: '/drifella_shirt',
    dropFamily: 'drifella_shirt',
    solanaCluster: 'mainnet-beta',
    label: 'Drifella Shirt',
    title: 'Drifella Shirt',
    previewImageUrl: 'https://cdn.lil.org/nft/drifella_shirt/images/clean.webp',
    previewAspectRatio: 1585 / 1242,
    boxNamePrefix: 'shirt',
  },
] as const;

test('upcoming routes expose their exact preview configuration', () => {
  const routesByPath = new Map(listUpcomingDropRoutes().map((route) => [route.path, route]));

  for (const expected of UPCOMING_ROUTES) {
    assert.deepEqual(routesByPath.get(expected.path), expected);
  }
});

test('Clear Cards keeps its public upcoming route separate from its WIP route', () => {
  const wipRoute = resolveAppRoute({ pathname: '/clear_cards/wip' });

  assert.equal(wipRoute.kind, 'wip');
  assert.equal(wipRoute.path, '/clear_cards/wip');
  assert.equal(wipRoute.wipExperience, 'clear_cards');
  assert.equal(wipRoute.walletCluster, 'mainnet-beta');
  assert.equal(wipRoute.replacementHref, null);
  assert.deepEqual(resolveUpcomingDropRouteByPath('/clear_cards'), UPCOMING_ROUTES[0]);
  assert.equal(resolveUpcomingDropRouteByPath('/clear_cards/wip'), null);
});

test('pack WIP routes stay separate from their live drop routes', () => {
  const expectedWipRoutes = [
    ['/card_nft_2/wip', 'card_nft_2'],
    ['/little_swag_boxes/wip', 'little_swag_boxes'],
    ['/poncho_drifella/wip', 'poncho_drifella'],
  ] as const;

  for (const [pathname, experience] of expectedWipRoutes) {
    const route = resolveAppRoute({ pathname });
    assert.equal(route.kind, 'wip');
    assert.equal(route.path, pathname);
    assert.equal(route.wipExperience, experience);
  }

  assert.equal(resolveFrontendDropByPath('/little_swag_boxes/wip'), null);
  assert.equal(resolveFrontendDropByPath('/poncho_drifella/wip'), null);
  assert.equal(resolveFrontendDropByPath('/little_swag_boxes'), FRONTEND_DROPS.little_swag_boxes);
  assert.equal(resolveFrontendDropByPath('/poncho_drifella'), FRONTEND_DROPS.poncho_drifella);
});

test('the route resolver keeps the complete WIP table in one exported definition', () => {
  assert.deepEqual(WIP_ROUTES, [
    { path: '/card_nft_2/wip', experience: 'card_nft_2', dropId: 'card_nft_2' },
    {
      path: '/little_swag_boxes/wip',
      experience: 'little_swag_boxes',
      dropId: 'little_swag_boxes',
    },
    {
      path: '/poncho_drifella/wip',
      experience: 'poncho_drifella',
      dropId: 'poncho_drifella',
    },
    { path: '/clear_cards/wip', experience: 'clear_cards' },
  ]);
});

test('route aliases replace only the pathname and preserve search and hash bytes', () => {
  const cases = [
    ['/ff', '/fulfillment', 'fulfillment'],
    ['/fullfillment', '/fulfillment', 'fulfillment'],
    ['/notify-me', '/notify_me', 'notify'],
    ['/drifella_binder', '/card_nft_binder', 'drop'],
  ] as const;

  for (const [pathname, targetPath, kind] of cases) {
    const route = resolveAppRoute({
      pathname: `${pathname}/`,
      search: '?code=a%2Fb&next=%2Fclaim',
      hash: '#receipt-1',
    });
    assert.equal(route.kind, kind);
    assert.equal(route.path, targetPath);
    assert.equal(route.replacementHref, `${targetPath}?code=a%2Fb&next=%2Fclaim#receipt-1`);
  }
});

test('claim deep links render the home shop without replacing their URL', () => {
  const route = resolveAppRoute({
    pathname: '/claim/',
    search: '?code=claim%2F123',
    hash: '#receipt',
  });

  assert.equal(route.kind, 'claim');
  assert.equal(route.path, '/');
  assert.equal(route.claimDeepLinkCode, 'claim/123');
  assert.equal(route.replacementHref, null);
  assert.equal(route.walletCluster, 'mainnet-beta');
  assert.equal(resolveAppRoute({ pathname: '/claim' }).claimDeepLinkCode, '');
});

test('home and special routes keep their canonical paths and neutral wallet cluster', () => {
  for (const [pathname, kind] of [
    ['/', 'home'],
    ['/fulfillment', 'fulfillment'],
    ['/notify_me', 'notify'],
  ] as const) {
    const route = resolveAppRoute({ pathname });
    assert.equal(route.kind, kind);
    assert.equal(route.path, pathname);
    assert.equal(route.replacementHref, null);
    assert.equal(route.walletCluster, 'mainnet-beta');
  }
});

test('live deployments take precedence over upcoming routes at the same path', () => {
  const liveRoute = resolveAppRoute({ pathname: '/clear_cards/' });
  const upcomingRoute = resolveAppRoute({ pathname: '/tbd/' });

  assert.equal(liveRoute.kind, 'drop');
  assert.equal(liveRoute.drop, FRONTEND_DROPS.clear_cards);
  assert.equal(liveRoute.upcoming, null);
  assert.equal(upcomingRoute.kind, 'upcoming');
  assert.equal(upcomingRoute.upcoming?.path, '/tbd');
});

test('unknown and case-mismatched paths fall back to home while preserving URL suffixes', () => {
  for (const pathname of ['/does-not-exist/', '/clear_cards/unknown', '/CLEAR_CARDS']) {
    const route = resolveAppRoute({ pathname, search: '?from=unknown', hash: '#top' });
    assert.equal(route.kind, 'home');
    assert.equal(route.path, '/');
    assert.equal(route.claimDeepLinkCode, null);
    assert.equal(route.replacementHref, '/?from=unknown#top');
  }
});

test('Clear Cards resolves its live drop instead of the notify-only state', () => {
  assert.equal(resolveFrontendDropByPath('/clear_cards'), FRONTEND_DROPS.clear_cards);
  assert.equal(resolveFrontendDropByPath('/clear_cards/'), FRONTEND_DROPS.clear_cards);
  assert.equal(
    resolveFrontendDropByPath('/clear_cards', {
      drops: [FRONTEND_DROPS.clear_cards],
    }),
    FRONTEND_DROPS.clear_cards,
  );
});

test('legacy binder route redirects to the canonical family route', () => {
  assert.deepEqual(LEGACY_DROP_ROUTE_ALIASES['/drifella_binder'], {
    targetPath: '/card_nft_binder',
    replaceUrl: true,
  });
  assert.equal(resolveUpcomingDropRouteByPath('/drifella_binder'), null);
});

test('upcoming routes resolve with trailing slashes and reflect deployment state', () => {
  for (const expected of UPCOMING_ROUTES) {
    const route = resolveUpcomingDropRouteByPath(`${expected.path}/`);

    assert.deepEqual(route, expected);
    assert.equal(resolveUpcomingRouteDrop(route, []), null);
  }

  assert.equal(
    FRONTEND_DROPS.card_nft_binder?.dropId,
    API_DROPS.card_nft_binder?.dropId,
  );
  assert.equal(FRONTEND_DROPS.drifella_shirt?.dropId, 'drifella_shirt');
  assert.equal(API_DROPS.drifella_shirt?.dropId, 'drifella_shirt');
  assert.equal(
    resolveUpcomingRouteDrop(resolveUpcomingDropRouteByPath('/card_nft_binder/'))?.dropId,
    FRONTEND_DROPS.card_nft_binder?.dropId,
  );
  assert.equal(
    resolveUpcomingRouteDrop(resolveUpcomingDropRouteByPath('/drifella_shirt/'))?.dropId,
    'drifella_shirt',
  );
});

test('card NFT binder resolves its live mainnet deployment config', () => {
  assert.equal(resolveFrontendDropByPath('/card_nft_binder')?.dropId, 'card_nft_binder');
  assert.equal(resolveFrontendDropByPath('/card_nft_binder/')?.dropId, 'card_nft_binder');
  assert.equal(
    resolveFrontendDropByPath('/card_nft_binder_devnet')?.dropId,
    'card_nft_binder_devnet',
  );
  assert.equal(FRONTEND_DROPS.card_nft_binder?.dropId, 'card_nft_binder');
  assert.equal(API_DROPS.card_nft_binder?.dropId, 'card_nft_binder');
});

test('drop family names normalize and default from IDs', () => {
  for (const family of ['card_nft_binder', 'drifella_shirt', 'clear_cards', 'tbd'] as const) {
    assert.equal(defaultDropFamilyForDropId(` ${family.toUpperCase()} `), family);
    assert.equal(normalizeDropFamily(` ${family.toUpperCase()} `), family);
    assert.equal(normalizeDropFamily(undefined, ` ${family.toUpperCase()} `), family);
    assert.equal(requireDropFamily(` ${family.toUpperCase()} `, 'dropFamily'), family);
  }
});
