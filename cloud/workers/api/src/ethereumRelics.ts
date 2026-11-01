import { decodeReturn, encodeCall } from '../../../../shared/ethereum/abi.js';
import type { EthereumRelicStatus } from '../../../../shared/ethereum/api.js';
import { ETHEREUM_CRATES_PER_RELIC, ETHEREUM_FUNCTIONS, ETHEREUM_MAX_RELICS,
  ethereumRelicClaimCount, normalizeEthereumAddress } from '../../../../shared/ethereum/protocol.js';
import { readEthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { EthereumApiError } from './ethereumError.js';
import { ethereumAddress, ethereumBlockSnapshot, ethereumCallBatch, verifyEthereumBlockSnapshot,
  type EthereumContext, type EthereumReadContext } from './ethereumRuntime.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export async function ethereumRelics(request: Request, context: Pick<EthereumContext, 'env' | 'signal' | 'fetch'>): Promise<EthereumRelicStatus> {
  const params = new URL(request.url).searchParams;
  if (params.getAll('chainId').length !== 1 || params.getAll('contractAddress').length !== 1 || params.getAll('owner').length > 1 ||
    [...params.keys()].some(key => !['chainId', 'contractAddress', 'owner'].includes(key)) ||
    !['1', '11155111', '31337'].includes(params.get('chainId')!)) {
    throw new EthereumApiError('invalid-argument', 'Provide one chainId and contractAddress for the collection.');
  }
  const chainId = Number(params.get('chainId'));
  const contractAddress = normalizeEthereumAddress(params.get('contractAddress'));
  if (!contractAddress || contractAddress === ZERO_ADDRESS) {
    throw new EthereumApiError('invalid-argument', 'Invalid Ethereum collection contract.');
  }
  const owner = params.has('owner') ? ethereumAddress(params.get('owner')) : null;
  if (chainId === 31337 && context.env.ETHEREUM_111K_CHAIN_ID !== '31337') {
    throw new EthereumApiError('invalid-argument', 'Local Ethereum collections are unavailable in this environment.');
  }
  const deployment = await readEthereumRevealDeployment(context.env.OPS_DB, { chainId, contractAddress });
  context.signal.throwIfAborted();
  if (!deployment) throw new EthereumApiError('not-found', 'The Ethereum collection is not registered.');
  const readContext: EthereumReadContext = {
    env: context.env, signal: context.signal, fetch: context.fetch,
    config: { chainId: deployment.chainId, contractAddress: deployment.contractAddress, enabled: true },
  };
  const snapshot = await ethereumBlockSnapshot(readContext);
  const [maskData, statsData, allowanceData] = await ethereumCallBatch(readContext, [
    encodeCall(ETHEREUM_FUNCTIONS.relicClaimedMask, [], []),
    encodeCall(ETHEREUM_FUNCTIONS.stats, ['address'], [owner ?? ZERO_ADDRESS]),
    encodeCall(ETHEREUM_FUNCTIONS.freeMintAllowances, ['address'], [owner ?? ZERO_ADDRESS]),
  ], snapshot.blockHash);
  if (maskData.length !== 66 || statsData.length !== 770 || allowanceData.length !== 386) {
    throw new EthereumApiError('unavailable', 'The Ethereum collection returned invalid relic availability.');
  }
  const claimedMask = Number(decodeReturn(['uint256'], maskData)[0]);
  const stats = decodeReturn(['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32',
    'uint256', 'uint256', 'uint256', 'uint256', 'uint256'], statsData);
  const allowance = decodeReturn(['uint16', 'uint16', 'uint16', 'uint16', 'uint16', 'uint16'], allowanceData);
  const allocatedCrates = Number(stats[0]);
  const relicsAllocated = Number(stats[10]);
  const relicsMinted = Number(stats[11]);
  const relicLimit = Number(allowance[2]);
  const relicsUsed = Number(allowance[5]);
  if (!Number.isSafeInteger(claimedMask) || claimedMask < 0 || claimedMask >= 2 ** ETHEREUM_MAX_RELICS ||
    !Number.isSafeInteger(allocatedCrates) || allocatedCrates > 5555 ||
    ![relicsAllocated, relicsMinted, relicLimit, relicsUsed].every(value => Number.isSafeInteger(value) && value >= 0 && value <= ETHEREUM_MAX_RELICS) ||
    relicsMinted > relicsAllocated || relicsUsed > relicsMinted || allocatedCrates < relicsAllocated * ETHEREUM_CRATES_PER_RELIC ||
    ethereumRelicClaimCount(claimedMask) !== relicsMinted) {
    throw new EthereumApiError('unavailable', 'The Ethereum collection returned invalid relic availability.');
  }
  await verifyEthereumBlockSnapshot(readContext, snapshot);
  return { chainId: deployment.chainId, contractAddress: deployment.contractAddress, owner,
    observedBlock: snapshot.blockNumber, blockHash: snapshot.blockHash, saleActive: stats[5] === true,
    relicsAllocated, relicsMinted, remainingRelics: relicsAllocated - relicsMinted, claimedMask,
    relicLimit, relicsUsed, remainingAllowance: Math.max(0, relicLimit - relicsUsed) };
}
