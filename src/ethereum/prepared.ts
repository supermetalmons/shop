import type { Ethereum111kConfig, EthereumClaimPrepareResponse, EthereumDeliveryPrepareResponse, EthereumInventoryItem, EthereumPreparedTransaction } from '../../shared/ethereum/api';
import { encodeCall } from '../../shared/ethereum/abi';
import { ethereumReceiptIdsHash } from '../../shared/ethereum/crypto';
import { ETHEREUM_FUNCTIONS, ethereumReceiptTokenId, isEthereumDeliveryKind, normalizeEthereumAddress } from '../../shared/ethereum/protocol';

function checkedTransaction(transaction: EthereumPreparedTransaction, config: Ethereum111kConfig, expectedData: string, expectedValue: string): EthereumPreparedTransaction {
  if (normalizeEthereumAddress(transaction.to) !== config.contractAddress || transaction.chainId !== config.chainId ||
    transaction.data.toLowerCase() !== expectedData.toLowerCase() || BigInt(transaction.value) !== BigInt(expectedValue)) {
    throw new Error('The prepared transaction does not match your request. Please try again.');
  }
  return transaction;
}

function validAuthorization(signature: string, deadline: number, expiresAtMs: number): boolean {
  return /^0x[0-9a-fA-F]{130}$/.test(signature) && Number.isSafeInteger(deadline) && deadline * 1000 > Date.now() &&
    Number.isSafeInteger(expiresAtMs) && expiresAtMs > Date.now() && expiresAtMs <= deadline * 1000;
}

export function checkedEthereumDelivery(prepared: EthereumDeliveryPrepareResponse, config: Ethereum111kConfig, owner: string, selected: readonly EthereumInventoryItem[]): EthereumPreparedTransaction {
  const { quote } = prepared;
  if (!validAuthorization(prepared.signature, quote.deadline, prepared.expiresAtMs) ||
    !Number.isSafeInteger(prepared.orderId) || prepared.orderId < 1 || quote.orderId !== prepared.orderId ||
    normalizeEthereumAddress(quote.wallet) !== owner || BigInt(quote.fee) !== BigInt(config.deliveryFeeWei)) {
    throw new Error('The delivery quote does not match your wallet or fee. Please try again.');
  }
  const receiptIdsHash = ethereumReceiptIdsHash(selected.map(item => {
    if (!isEthereumDeliveryKind(item.kind)) throw new Error('Select artworks, crates or monuments for delivery.');
    return ethereumReceiptTokenId(item.kind, item.displayId);
  }));
  if (typeof quote.receiptIdsHash !== 'string' || quote.receiptIdsHash.toLowerCase() !== receiptIdsHash) {
    throw new Error('The delivery quote does not match the selected items. Please try again.');
  }
  const data = encodeCall(ETHEREUM_FUNCTIONS.redeemForDelivery, ['uint256[]', '(uint256,address,uint256,uint256,bytes32)', 'bytes'],
    [selected.map(item => item.tokenId), [prepared.orderId, owner, config.deliveryFeeWei, quote.deadline, receiptIdsHash], prepared.signature]);
  return checkedTransaction(prepared.transaction, config, data, config.deliveryFeeWei);
}

export function checkedEthereumClaim(prepared: EthereumClaimPrepareResponse, config: Ethereum111kConfig, receiptId: string): EthereumPreparedTransaction {
  if (prepared.receiptId !== receiptId || !/^0x[0-9a-fA-F]{64}$/.test(prepared.claimId) ||
    !validAuthorization(prepared.signature, prepared.deadline, prepared.expiresAtMs)) {
    throw new Error('The claim does not match this receipt or has expired. Please try again.');
  }
  const data = encodeCall(ETHEREUM_FUNCTIONS.claimCrateReceipt, ['uint256', 'bytes32', 'uint256', 'bytes'],
    [receiptId, prepared.claimId, prepared.deadline, prepared.signature]);
  return checkedTransaction(prepared.transaction, config, data, '0');
}
