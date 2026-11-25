import { encodeCall } from './abi.ts';

export const DMX_MAX_CARDS = 999_999;
export const DMX_RECEIPT_OFFSET = 999_999;
const DMX_REDEMPTION_RECEIPT_OFFSET = 1_000_776;
const DMX_MAX_BATCH_SIZE = 50;

type Uint = number | bigint;
export type DMXMintQuote = { authorizationId: string; recipient: string; deadline: Uint };
export type DMXRedemptionQuote = {
  orderId: Uint; wallet: string; recipient: string; fee: Uint; deadline: Uint; configId: Uint;
};

export function dmxRedemptionReceiptTokenId(cardId: Uint): bigint {
  if (typeof cardId === 'number' && !Number.isSafeInteger(cardId) || cardId < 1 || cardId > DMX_MAX_CARDS) {
    throw new Error('Invalid DMX card ID');
  }
  return BigInt(cardId) + BigInt(DMX_REDEMPTION_RECEIPT_OFFSET);
}

function requireCardIds(cardIds: readonly Uint[], minimum: number, allowEmpty = false): void {
  if ((!allowEmpty && cardIds.length === 0) || cardIds.length > DMX_MAX_BATCH_SIZE ||
    cardIds.some(id => typeof id === 'number' && !Number.isSafeInteger(id) || id < minimum || id > DMX_MAX_CARDS) ||
    new Set(cardIds.map(String)).size !== cardIds.length) throw new Error('Invalid DMX card IDs');
}

export function encodeDmxMintTo(recipient: string, cardIds: readonly Uint[]): string {
  requireCardIds(cardIds, 1);
  return encodeCall('mintTo(address,uint256[])', ['address', 'uint256[]'], [recipient, cardIds]);
}

export function encodeDmxMintToAuthorized(cardIds: readonly Uint[], quote: DMXMintQuote, signature: string): string {
  requireCardIds(cardIds, 1);
  return encodeCall('mintToAuthorized(uint256[],(bytes32,address,uint256),bytes)',
    ['uint256[]', '(bytes32,address,uint256)', 'bytes'],
    [cardIds, [quote.authorizationId, quote.recipient, quote.deadline], signature]);
}

export function encodeDmxRedeem(inputCardIds: readonly Uint[], outputCardIds: readonly Uint[],
  quote: DMXRedemptionQuote, signature: string): string {
  requireCardIds(inputCardIds, 1);
  requireCardIds(outputCardIds, 778, true);
  return encodeCall('redeem(uint256[],uint256[],(uint256,address,address,uint256,uint256,uint256),bytes)',
    ['uint256[]', 'uint256[]', '(uint256,address,address,uint256,uint256,uint256)', 'bytes'],
    [inputCardIds, outputCardIds, [quote.orderId, quote.wallet, quote.recipient, quote.fee, quote.deadline, quote.configId], signature]);
}
