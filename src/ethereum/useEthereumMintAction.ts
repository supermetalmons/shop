import type { Ethereum111kConfig } from '../../shared/ethereum/config';
import type { EthereumMintKind } from '../../shared/ethereum/protocol';
import { ETHEREUM_CONTAINER_MEDIA } from './containerMedia';
import type { EthereumWallet } from './useEthereum111k';
import type { EthereumMintQuote } from './discounts';
import { captureEthereumWalletActionConfig, ethereumWalletActionChanged, useEthereumWalletAction } from './useEthereumWalletAction';

type EthereumMintActionOptions = {
  wallet: EthereumWallet;
  config?: Pick<Ethereum111kConfig, 'enabled' | 'chainId' | 'contractAddress'>;
  kind: EthereumMintKind;
  quantity: number;
  remaining: number | undefined;
  saleActive: boolean | undefined;
  loadError?: string | null;
  blocked: boolean;
  suspended: boolean;
  priceKey?: string;
  mintQuote?: (kind: EthereumMintKind, quantity: number) => EthereumMintQuote | null;
  onMint: (kind: EthereumMintKind, quantity: number, quote?: EthereumMintQuote) => Promise<boolean>;
};

type MintAttempt = {
  kind: EthereumMintKind;
  quantity: number;
  quote: EthereumMintQuote | null;
  priceKey: string | null;
};

export function useEthereumMintAction(options: EthereumMintActionOptions) {
  const { start: mint, ...action } = useEthereumWalletAction<EthereumMintActionOptions, MintAttempt>(options, {
    capture: current => {
      if (!Number.isInteger(current.quantity) || current.quantity < 1) {
        return { error: 'Choose a whole-number quantity of at least 1.' };
      }
      return { data: {
        kind: current.kind,
        quantity: current.quantity,
        quote: current.wallet.status === 'connected' ? current.mintQuote?.(current.kind, current.quantity) ?? null : null,
        priceKey: current.priceKey ?? null,
      } };
    },
    isCurrent: (attempt, current) => current.kind === attempt.kind,
    validate: (attempt, current) => {
      const mint = attempt.data;
      if (current.priceKey !== undefined) {
        if (mint.priceKey !== null && current.priceKey !== mint.priceKey) {
          return 'Your mint terms changed. Check the updated price and try again.';
        }
        mint.priceKey ??= current.priceKey;
      }
      const configError = captureEthereumWalletActionConfig(attempt, current.config,
        'This drop changed. Please try minting again.', 'Minting is unavailable for this drop.');
      if (configError) return configError;
      if (current.saleActive === false) return 'Minting is paused.';
      if (current.remaining !== undefined && current.remaining < mint.quantity) {
        return current.remaining <= 0
          ? `${ETHEREUM_CONTAINER_MEDIA[mint.kind].pluralLabel} are sold out.`
          : `That quantity is no longer available. Choose fewer ${ETHEREUM_CONTAINER_MEDIA[mint.kind].pluralLabel.toLowerCase()}.`;
      }
      return ethereumWalletActionChanged(attempt, current.wallet)
        ? 'Your Ethereum wallet changed. Please try minting again.' : null;
    },
    ready: (attempt, current) => {
      if (current.saleActive === undefined || current.remaining === undefined) return false;
      const mint = attempt.data;
      mint.quote ??= current.mintQuote?.(mint.kind, mint.quantity) ?? null;
      return !current.mintQuote || mint.quote !== null;
    },
    submit: (attempt, current) => current.onMint(attempt.kind, attempt.quantity, attempt.quote ?? undefined),
    connectionError: 'Unable to connect your Ethereum wallet. Please try again.',
  });
  return { mint, ...action };
}
