import { useEffect, useState } from 'react';
import { captureNfcScan, readScannedCode } from '../ethereum/nfcScan';
import { subscribeToNavigation } from '../navigation';
import { resolveAppRoute, type ResolvedAppRoute } from '../routes';

const routesEqual = (a: ResolvedAppRoute, b: ResolvedAppRoute): boolean =>
  a.kind === b.kind &&
  a.path === b.path &&
  a.shopPath === b.shopPath &&
  a.claimDeepLinkCode === b.claimDeepLinkCode &&
  a.nfcLink?.key === b.nfcLink?.key &&
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
  captureNfcScan(window);
  const route = resolveAppRoute(window.location, tokenId => readScannedCode(window, tokenId));
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
