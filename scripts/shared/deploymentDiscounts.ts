import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PublicKey, SystemProgram } from '@solana/web3.js';

type DeploymentDiscountConfig = {
  priceSol: number;
  discountPriceSol: number;
  discountWhitelistCsvRelativePath?: string;
};

export function resolveDeploymentDiscountAddresses(args: { root: string; config: DeploymentDiscountConfig }): string[] {
  const { priceSol, discountPriceSol, discountWhitelistCsvRelativePath } = args.config;
  if (!Number.isFinite(priceSol) || !Number.isFinite(discountPriceSol)) throw new Error('Mint and discount prices must be finite numbers.');
  let addresses: string[] = [];
  if (discountWhitelistCsvRelativePath !== undefined) {
    if (typeof discountWhitelistCsvRelativePath !== 'string' || !discountWhitelistCsvRelativePath.trim()) {
      throw new Error('discountWhitelistCsvRelativePath must name a CSV file, or be omitted for a drop without discounts.');
    }
    const filePath = path.resolve(args.root, discountWhitelistCsvRelativePath);
    if (!existsSync(filePath)) throw new Error(`Missing discount whitelist CSV: ${filePath}`);
    addresses = [...new Set(readFileSync(filePath, 'utf8').split(/\r?\n/g).map(line => line.trim()).filter(Boolean)
      .map(address => new PublicKey(address).toBase58()))];
  }
  const sentinel = SystemProgram.programId.toBase58();
  if (addresses.some(address => address !== sentinel)) return addresses;
  if (discountPriceSol !== priceSol) {
    throw new Error('A discounted price requires a nonempty whitelist of real wallets. Set discountPriceSol equal to priceSol when discounts are disabled.');
  }
  return [sentinel];
}
