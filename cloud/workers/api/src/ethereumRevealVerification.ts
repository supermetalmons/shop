import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import type { EthereumRevealTransactionInspection } from './ethereumRevealChain.js';
import type { RevealReceiptClaim } from './ethereumRevealRecoveryStore.js';

export type RevealVerificationScope = Pick<EthereumRevealDeployment, 'chainId' | 'contractAddress' | 'deploymentBlock'>;
export type RevealVerificationWork = { kind: 'receipt' | 'overflow'; claim: RevealReceiptClaim };
export type RevealVerificationResult =
  | { kind: 'inspected'; inspection: EthereumRevealTransactionInspection }
  | { kind: 'throttled'; retryAfterMs: number }
  | { kind: 'failed' };
