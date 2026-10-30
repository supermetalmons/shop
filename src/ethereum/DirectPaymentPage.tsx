import { useEffect, useRef } from 'react';
import { ShopHeader } from '../components/ShopHeader';
import { getLegacyInjectedProvider, listInjectedEthereumProviders } from '../wallet/injectedEthereumProviders';
import { ethereumAddress, ethereumOperation, type EthereumNetwork, type EthereumTransaction } from './wallet';
import '../drif.css';

const PAYMENT_NETWORK: EthereumNetwork = {
  chainId: 1,
  chainName: 'Ethereum',
  walletRpcUrl: 'https://ethereum-rpc.publicnode.com',
  explorerUrl: 'https://etherscan.io',
};

const PAYMENT_TRANSACTION: EthereumTransaction = {
  to: '0x72D0c5623A05033F9eE4495D408BC6c05DF8367d',
  value: `0x${2300000000000000000n.toString(16)}`,
  data: '0x',
  chainId: 1,
};

let paymentInFlight = false;

export default function DirectPaymentPage() {
  const mounted = useRef(false);
  const activeOperation = useRef<ReturnType<typeof ethereumOperation> | null>(null);

  useEffect(() => {
    mounted.current = true;
    document.body.classList.add('drif-body');
    return () => {
      mounted.current = false;
      activeOperation.current?.dispose();
      activeOperation.current = null;
      document.body.classList.remove('drif-body');
    };
  }, []);

  const pay = async () => {
    if (!mounted.current || paymentInFlight) return;
    paymentInFlight = true;
    let operation: ReturnType<typeof ethereumOperation> | undefined;
    try {
      const provider = getLegacyInjectedProvider() ?? (await listInjectedEthereumProviders())[0]?.provider;
      if (!provider || !mounted.current) return;
      let accounts = await provider.request({ method: 'eth_accounts' });
      if (!mounted.current) return;
      let address = ethereumAddress(Array.isArray(accounts) ? accounts[0] : null);
      if (!address) {
        accounts = await provider.request({ method: 'eth_requestAccounts' });
        address = ethereumAddress(Array.isArray(accounts) ? accounts[0] : null);
      }
      if (!address || !mounted.current) return;
      const wallet = { address, provider };
      operation = ethereumOperation(
        () => mounted.current ? wallet : { address: null, provider: null },
        PAYMENT_NETWORK,
      );
      activeOperation.current = operation;
      await operation.send(PAYMENT_TRANSACTION, operation.assertCurrent);
    } catch {} finally {
      operation?.dispose();
      if (activeOperation.current === operation) activeOperation.current = null;
      paymentInFlight = false;
    }
  };

  return (
    <div className="drif-page">
      <ShopHeader scrollHomeToTop variant="drif" />
      <main className="drif-main">
        <div className="drif-card-showcase">
          <img
            className="drif-static-artwork"
            src="https://wip.lil.org/111k/artwork_placeholder.png"
            alt="Artwork"
            draggable={false}
          />
        </div>
      </main>
      <button type="button" className="drif-notify-btn" onClick={() => { void pay(); }}>
        Pay 2.3 ETH
      </button>
    </div>
  );
}
