import React from 'react';
import FulfillmentApp from './FulfillmentApp';
import { type SolanaCluster, listFrontendDrops } from './config/deployment';
import { WalletContextProvider } from './wallet/WalletContext';

const NEUTRAL_WALLET_CLUSTER: SolanaCluster = 'mainnet-beta';

export default function FulfillmentRoute() {
  const drops = React.useMemo(() => listFrontendDrops(), []);
  const [selectedDropId, setSelectedDropId] = React.useState('');
  const selectedDrop = React.useMemo(
    () => drops.find((drop) => drop.dropId === selectedDropId) || null,
    [drops, selectedDropId],
  );

  return (
    <WalletContextProvider cluster={selectedDrop?.solanaCluster || NEUTRAL_WALLET_CLUSTER}>
      <FulfillmentApp selectedDropId={selectedDropId} onSelectedDropIdChange={setSelectedDropId} />
    </WalletContextProvider>
  );
}
