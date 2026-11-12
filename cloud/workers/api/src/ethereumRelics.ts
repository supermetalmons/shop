import { decodeReturn, encodeCall } from '../../../../shared/ethereum/abi.js';
import type { EthereumPublicRelicSale, EthereumRelicStatus } from '../../../../shared/ethereum/api.js';
import { ETHEREUM_CRATES_PER_RELIC, ETHEREUM_FUNCTIONS, ETHEREUM_MAX_RELICS,
  ethereumItemDisplayIdMaximum, ethereumRelicClaimCount, normalizeEthereumAddress } from '../../../../shared/ethereum/protocol.js';
import { readEthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { decode111kStats, valid111kRelicSupply } from '../../../../shared/ethereum/stats.js';
import { EthereumApiError } from './ethereumError.js';
import { ethereumAddress, ethereumBlockSnapshot, ethereumCallBatch, verifyEthereumBlockSnapshot,
  withEthereumReadProvider, type EthereumContext, type EthereumReadContext } from './ethereumRuntime.js';

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
  return withEthereumReadProvider(readContext, selected => readRelics(selected, owner));
}

async function readRelics(readContext: EthereumReadContext, owner: string | null): Promise<EthereumRelicStatus> {
  const { chainId, contractAddress } = readContext.config;
  if (!contractAddress) throw new EthereumApiError('unavailable', 'Ethereum collection is unavailable.');
  const snapshot = await ethereumBlockSnapshot(readContext);
  const [maskData, statsData, allowanceData] = await ethereumCallBatch(readContext, [
    encodeCall(ETHEREUM_FUNCTIONS.relicClaimedMask, [], []),
    encodeCall(ETHEREUM_FUNCTIONS.stats, ['address'], [owner ?? ZERO_ADDRESS]),
    encodeCall(ETHEREUM_FUNCTIONS.freeMintAllowances, ['address'], [owner ?? ZERO_ADDRESS]),
  ], snapshot.blockHash);
  const stats = maskData.length === 66 && allowanceData.length === 386 ? decode111kStats(statsData) : null;
  if (!stats) {
    throw new EthereumApiError('unavailable', 'The Ethereum collection returned invalid relic availability.');
  }
  const claimedMask = Number(decodeReturn(['uint256'], maskData)[0]);
  const allowance = decodeReturn(['uint16', 'uint16', 'uint16', 'uint16', 'uint16', 'uint16'], allowanceData);
  const allocatedCrates = Number(stats.allocatedCrates);
  const relicsAllocated = Number(stats.relicsAllocated);
  const relicsMinted = Number(stats.relicsMinted);
  const publicRelicsMinted = Number(stats.publicRelicsMinted);
  const relicLimit = Number(allowance[2]);
  const relicsUsed = Number(allowance[5]);
  if (!Number.isSafeInteger(claimedMask) || claimedMask < 0 || claimedMask >= 2 ** ETHEREUM_MAX_RELICS ||
    !valid111kRelicSupply(stats) || relicLimit > ETHEREUM_MAX_RELICS || relicsUsed > relicsMinted ||
    ethereumRelicClaimCount(claimedMask) !== relicsMinted + publicRelicsMinted) {
    throw new EthereumApiError('unavailable', 'The Ethereum collection returned invalid relic availability.');
  }
  let publicSale: EthereumPublicRelicSale | null = null;
  if (stats.wordCount === 15) {
    const [data] = await ethereumCallBatch(readContext,
      [encodeCall(ETHEREUM_FUNCTIONS.publicRelicStats, ['address'], [owner ?? ZERO_ADDRESS])], snapshot.blockHash);
    if (data.length !== 2 + 64 * 7) throw new EthereumApiError('unavailable', 'The Ethereum collection returned invalid public relic availability.');
    const values = decodeReturn(['uint256', 'uint256', 'uint256', 'bool', 'uint256', 'uint16', 'uint16'], data);
    const [limit, minted, mintable, freeLimit, freeUsed] = [values[0], values[1], values[4], values[5], values[6]].map(Number);
    const active = values[3] === true;
    const remainingCrates = ethereumItemDisplayIdMaximum('crate') - allocatedCrates;
    const expectedMintable = stats.saleActive && active ? Math.min(limit - minted, Math.floor(remainingCrates / ETHEREUM_CRATES_PER_RELIC)) : 0;
    if (![limit, minted, mintable, freeLimit, freeUsed].every(value => Number.isSafeInteger(value) && value >= 0 && value <= ETHEREUM_MAX_RELICS) ||
      minted !== publicRelicsMinted || minted > limit || limit + relicsAllocated > ETHEREUM_MAX_RELICS || freeUsed > minted || mintable !== expectedMintable) {
      throw new EthereumApiError('unavailable', 'The Ethereum collection returned invalid public relic availability.');
    }
    publicSale = { limit, minted, priceWei: String(values[2]), active, mintable, freeLimit, freeUsed,
      remainingFreeAllowance: Math.max(0, freeLimit - freeUsed) };
  }
  await verifyEthereumBlockSnapshot(readContext, snapshot);
  return { chainId, contractAddress, owner,
    observedBlock: snapshot.blockNumber, blockHash: snapshot.blockHash, saleActive: stats.saleActive,
    relicsAllocated, relicsMinted, publicRelicsMinted, publicSale, remainingRelics: relicsAllocated - relicsMinted, claimedMask,
    relicLimit, relicsUsed, remainingAllowance: Math.max(0, relicLimit - relicsUsed) };
}
