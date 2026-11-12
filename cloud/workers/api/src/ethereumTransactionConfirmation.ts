import type { EthereumTransactionConfirmResponse } from '../../../../shared/ethereum/api.js';
import { EthereumApiError } from './ethereumError.js';
import { ethereumInventoryItems, ethereumReceipt, ethereumTokenInfos, transferTokenIds, type EthereumLog } from './ethereumRead.js';
import { ethereumBlockSnapshot, requireEthereumContract, rpcInteger, verifyEthereumBlockSnapshot,
  withEthereumReadProvider, type EthereumCollectionReadContext } from './ethereumRuntime.js';

export async function confirmEthereumTransaction(context: EthereumCollectionReadContext, hash: string): Promise<
  EthereumTransactionConfirmResponse & { logs?: EthereumLog[] }
> {
  if (!context.providerAttempt) return withEthereumReadProvider(context, selected => confirmEthereumTransaction(selected, hash));
  const { receipt, confirmations } = await ethereumReceipt(context, hash);
  if (!receipt) return { status: 'pending', confirmations, items: [], burnedTokenIds: [] };
  const snapshot = await ethereumBlockSnapshot(context);
  const receiptBlock = rpcInteger(receipt.blockNumber);
  if (snapshot.blockNumber < receiptBlock) throw new EthereumApiError('unavailable', 'Ethereum changed while confirming your transaction. Try again.');
  const ids = transferTokenIds(receipt, requireEthereumContract(context));
  const items = await ethereumInventoryItems(context, await ethereumTokenInfos(context, ids.minted, snapshot.blockHash));
  const logs = receipt.logs.filter(log => log.address.toLowerCase() === context.config.contractAddress);
  await Promise.all([verifyEthereumBlockSnapshot(context, snapshot),
    verifyEthereumBlockSnapshot(context, { blockNumber: receiptBlock, blockHash: receipt.blockHash })]);
  return { status: 'confirmed', confirmations: snapshot.blockNumber - receiptBlock + 1, items, burnedTokenIds: ids.burned, logs };
}
