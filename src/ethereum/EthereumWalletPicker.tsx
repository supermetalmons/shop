import { Modal } from '../components/Modal';
import { getInjectedWalletIconSrc } from '../wallet/injectedEthereumProviders';
import type { EthereumWallet } from './useEthereum111k';

export function EthereumWalletPicker({ wallet, onClose, suspended = false }: {
  wallet: EthereumWallet; onClose: () => void; suspended?: boolean;
}) {
  return <Modal open={wallet.status === 'choosing'} title="Connect wallet" onClose={onClose} suspended={suspended}>
    <div className="ethereum111k__wallets">{wallet.wallets.map(candidate => {
      const icon = getInjectedWalletIconSrc(candidate.info.icon);
      return <button key={candidate.info.uuid} type="button" onClick={() => wallet.selectWallet(candidate)}>
        {icon ? <img src={icon} alt="" referrerPolicy="no-referrer" /> : null}{candidate.info.name}
      </button>;
    })}</div>
  </Modal>;
}
