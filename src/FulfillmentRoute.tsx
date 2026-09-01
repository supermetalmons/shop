import React from 'react';
import FulfillmentApp from './FulfillmentApp';
import { type SolanaCluster, listFrontendDrops } from './config/deployment';
import { buildFulfillmentFiltersHref, parseFulfillmentFilters } from './fulfillment/filters';
import { WalletContextProvider } from './wallet/WalletContext';

const NEUTRAL_WALLET_CLUSTER: SolanaCluster = 'mainnet-beta';

export default function FulfillmentRoute() {
  const drops = React.useMemo(() => listFrontendDrops(), []);
  const [selectedDropId, setSelectedDropId] = React.useState(
    () => parseFulfillmentFilters(window.location.search).dropId,
  );
  const [orderVisibilityFilter, setOrderVisibilityFilter] = React.useState(
    () => parseFulfillmentFilters(window.location.search).status,
  );
  const selectedDrop = React.useMemo(
    () => drops.find((drop) => drop.dropId === selectedDropId) || null,
    [drops, selectedDropId],
  );

  React.useEffect(() => {
    const restoreFilters = () => {
      const filters = parseFulfillmentFilters(window.location.search);
      setSelectedDropId(filters.dropId);
      setOrderVisibilityFilter(filters.status);
    };
    window.addEventListener('popstate', restoreFilters);
    return () => window.removeEventListener('popstate', restoreFilters);
  }, []);

  React.useEffect(() => {
    const href = buildFulfillmentFiltersHref(window.location, {
      dropId: selectedDropId,
      status: orderVisibilityFilter,
    });
    const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (href !== currentHref) window.history.replaceState(window.history.state, '', href);
  }, [orderVisibilityFilter, selectedDropId]);

  return (
    <WalletContextProvider cluster={selectedDrop?.solanaCluster || NEUTRAL_WALLET_CLUSTER}>
      <FulfillmentApp
        selectedDropId={selectedDropId}
        onSelectedDropIdChange={setSelectedDropId}
        orderVisibilityFilter={orderVisibilityFilter}
        onOrderVisibilityFilterChange={setOrderVisibilityFilter}
      />
    </WalletContextProvider>
  );
}
