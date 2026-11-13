import { BOX_MINTER_MIN_DISCOUNT_MINTS_PER_WALLET, BOX_MINTER_MAX_DISCOUNT_MINTS_PER_WALLET } from '../../shared/boxMinterProtocol.ts';

export function requireIntegerInRange(args: {
  value: number;
  label: string;
  min: number;
  max?: number;
}): number {
  const n = Number(args.value);
  if (!Number.isInteger(n) || n < args.min || (typeof args.max === 'number' && n > args.max)) {
    const range = typeof args.max === 'number' ? `${args.min}..${args.max}` : `>= ${args.min}`;
    throw new Error(`Invalid ${args.label}: ${args.value} (expected an integer in ${range})`);
  }
  return n;
}

export function requireDiscountMintsPerWallet(value: number, label: string): number {
  return requireIntegerInRange({
    value,
    label,
    min: BOX_MINTER_MIN_DISCOUNT_MINTS_PER_WALLET,
    max: BOX_MINTER_MAX_DISCOUNT_MINTS_PER_WALLET,
  });
}
