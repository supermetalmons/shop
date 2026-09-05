import { DeliveryReceiptError } from './deliveryReceiptErrors.js';

export function secureRandomInt(maxExclusive: number): number {
  const maximum = Math.floor(maxExclusive);
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new DeliveryReceiptError('internal', 'Secure random range is invalid.');
  }
  const range = 1n << 64n;
  const maximumBigInt = BigInt(maximum);
  const limit = (range / maximumBigInt) * maximumBigInt;
  const words = new Uint32Array(2);
  let value: bigint;
  do {
    crypto.getRandomValues(words);
    value = (BigInt(words[0]) << 32n) | BigInt(words[1]);
  } while (value >= limit);
  return Number(value % maximumBigInt);
}
