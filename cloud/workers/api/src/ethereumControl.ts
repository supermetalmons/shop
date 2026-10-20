import {
  ETHEREUM_111K_CONTROL_SQL,
  ethereum111kControlAllows,
  parseEthereum111kControl,
} from '../../../../shared/ethereum/control.js';
import { EthereumApiError } from './ethereumError.js';

type Ethereum111kScope = { chainId: number; contractAddress: string | null };

export async function ethereum111kWritesAllowed(
  db: D1Database,
  scope: Ethereum111kScope,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  if (!scope.contractAddress) return false;
  try {
    const control = parseEthereum111kControl(await db.prepare(ETHEREUM_111K_CONTROL_SQL).first());
    signal.throwIfAborted();
    return ethereum111kControlAllows(control, { chainId: scope.chainId, contractAddress: scope.contractAddress });
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

export async function requireEthereum111kWrites(
  db: D1Database,
  scope: Ethereum111kScope,
  signal: AbortSignal,
): Promise<void> {
  if (!await ethereum111kWritesAllowed(db, scope, signal)) {
    throw new EthereumApiError('unavailable', 'Ethereum service is temporarily unavailable.');
  }
}
