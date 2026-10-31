import { useEffect, useState } from 'react';
import { subscribeToNavigation } from '../navigation';
import { resolveAppRoute, type ResolvedAppRoute } from '../routes';

const routesEqual = (a: ResolvedAppRoute, b: ResolvedAppRoute): boolean =>
  a.kind === b.kind &&
  a.path === b.path &&
  a.shopPath === b.shopPath &&
  a.claimDeepLinkCode === b.claimDeepLinkCode &&
  a.nfcDeepLinkCode === b.nfcDeepLinkCode &&
  a.drop === b.drop &&
  a.upcoming === b.upcoming &&
  a.wipExperience === b.wipExperience &&
  a.walletCluster === b.walletCluster &&
  a.ethereumDropId === b.ethereumDropId &&
  a.ethereumClaimReceiptId === b.ethereumClaimReceiptId &&
  a.ethereumClaimCode === b.ethereumClaimCode &&
  a.checkoutId === b.checkoutId &&
  a.checkoutSearch === b.checkoutSearch &&
  a.ethereumCheckoutReturnId === b.ethereumCheckoutReturnId;

function resolveCurrentRoute(): ResolvedAppRoute {
  const route = resolveAppRoute({
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  });
  if (route.replacementHref) {
    window.history.replaceState(window.history.state, '', route.replacementHref);
  }
  return route;
}

export function useAppRoute(): ResolvedAppRoute {
  const [route, setRoute] = useState(resolveCurrentRoute);

  useEffect(() => subscribeToNavigation(() => {
    const nextRoute = resolveCurrentRoute();
    setRoute(currentRoute => routesEqual(currentRoute, nextRoute) ? currentRoute : nextRoute);
  }), []);

  return route;
}
