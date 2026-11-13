import type { Ethereum111kConfig } from '../../shared/ethereum/config';
import type { EthereumRelicStatus } from '../../shared/ethereum/api';
import type { EthereumWallet } from './useEthereum111k';
import { captureEthereumWalletActionConfig, ethereumWalletActionChanged, useEthereumWalletAction } from './useEthereumWalletAction';

type Options = {
  wallet: EthereumWallet;
  config?: Pick<Ethereum111kConfig, 'enabled' | 'chainId' | 'contractAddress'>;
  active: boolean;
  selectedId: number | null;
  status?: EthereumRelicStatus;
  loadError?: string | null;
  blocked: boolean;
  suspended: boolean;
  onClaim: (id: number) => Promise<boolean>;
};

export function useEthereumRelicClaimAction(options: Options) {
  const { start: claim, ...action } = useEthereumWalletAction<Options, { id: number }>(options, {
    canStart: current => current.active,
    capture: current => {
      if (current.selectedId === null || !Number.isInteger(current.selectedId) || current.selectedId < 1 || current.selectedId > 18) {
        return { error: 'Choose an available relic first.' };
      }
      return { data: { id: current.selectedId } };
    },
    isCurrent: (attempt, current) => current.active && current.selectedId === attempt.id,
    validate: (attempt, current) => {
      const configError = captureEthereumWalletActionConfig(attempt, current.config,
        'This drop changed. Please try claiming again.', 'Relic claims are unavailable.');
      if (configError) return configError;
      if (ethereumWalletActionChanged(attempt, current.wallet)) return 'Your Ethereum wallet changed. Please try claiming again.';
      const status = current.status;
      if (status) {
        if (!status.saleActive) return 'Relic claims are paused.';
        if (status.remainingRelics === 0) return 'All allocated relics have been claimed.';
        if ((status.claimedMask & (1 << (attempt.data.id - 1))) !== 0) return 'That relic was already claimed. Choose another one.';
      }
      return null;
    },
    ready: (_attempt, current) => {
      const { status, wallet, config } = current;
      if (!wallet.address || !status || !config || status.owner !== wallet.address.toLowerCase() ||
        status.chainId !== config.chainId || status.contractAddress !== config.contractAddress) return false;
      if (status.remainingAllowance === 0) {
        return status.relicLimit === 0 ? 'This wallet is not eligible to claim a relic.' : 'You have claimed your relic allowance.';
      }
      return true;
    },
    submit: (attempt, current) => current.onClaim(attempt.id),
    connectionError: 'Unable to connect your Ethereum wallet.',
  });
  return { claim, ...action };
}
