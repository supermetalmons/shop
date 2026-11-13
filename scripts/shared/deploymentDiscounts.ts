import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  requireDiscountMerkleDatasetIdentity,
  validateDiscountMerkleFamilyRootInvariant,
  type DiscountMerkleDatasetReference,
} from './discountMerkleDataset.ts';
import { readDeploymentDropRegistry, type DropFamily } from './deploymentRegistry.ts';
import type { NewDropOnchainConfig } from './newDropConfig.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

type PreparedInitDropInputs = {
  requiredDropMetadataBase: string;
  discountMerkle: { root: Buffer; proofs: Record<string, string[]> };
};

export function prepareInitDropInputs(args: {
  root: string;
  dropCfg: NewDropOnchainConfig;
  dropMetadataBase: string;
  configPath?: string;
}): PreparedInitDropInputs {
  const requiredDropMetadataBase = String(args.dropMetadataBase || '').trim();
  if (!requiredDropMetadataBase) throw new Error(`Missing NEW_DROP.onchain.metadataBase in ${args.configPath ?? 'scripts/newDrops/<dropId>.ts'}`);
  const discountAddresses = resolveDeploymentDiscountAddresses({ root: args.root, config: args.dropCfg });
  const discountMerkle = buildDiscountMerkleData(discountAddresses);
  return {
    requiredDropMetadataBase,
    discountMerkle,
  };
}

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

function hashLeafAddress(address: string): Buffer {
  return sha256(new PublicKey(address).toBuffer());
}

function hashSortedPair(left: Buffer, right: Buffer): Buffer {
  const ordered = Buffer.compare(left, right) <= 0 ? [left, right] : [right, left];
  return sha256(Buffer.concat(ordered));
}

function buildMerkleTree(leaves: Buffer[]): Buffer[][] {
  if (!leaves.length) return [];
  const levels: Buffer[][] = [leaves];
  let level = leaves;
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left;
      next.push(hashSortedPair(left, right));
    }
    levels.push(next);
    level = next;
  }
  return levels;
}

function buildMerkleProof(levels: Buffer[][], leafIndex: number): Buffer[] {
  const proof: Buffer[] = [];
  let idx = leafIndex;
  for (let level = 0; level < levels.length - 1; level += 1) {
    const nodes = levels[level];
    const isRight = idx % 2 === 1;
    const siblingIndex = isRight ? idx - 1 : idx + 1;
    const sibling = nodes[siblingIndex] ?? nodes[idx];
    proof.push(sibling);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function buildDiscountMerkleData(addresses: string[]) {
  const leaves = addresses
    .map((address) => ({ address, hash: hashLeafAddress(address) }))
    .sort((a, b) => Buffer.compare(a.hash, b.hash));
  const leafHashes = leaves.map((leaf) => leaf.hash);
  const levels = buildMerkleTree(leafHashes);
  const root = levels.length ? levels[levels.length - 1][0] : Buffer.alloc(32);
  const proofs: Record<string, string[]> = {};
  leaves.forEach((leaf, index) => {
    proofs[leaf.address] = buildMerkleProof(levels, index).map((buf) => buf.toString('hex'));
  });
  return { root, proofs };
}

function renderDiscountMerkleJson(args: { root: Buffer; proofs: Record<string, string[]> }): string {
  return `${JSON.stringify(discountMerkleJsonValue(args), null, 2)}\n`;
}

function discountMerkleJsonValue(args: { root: Buffer; proofs: Record<string, string[]> }) {
  return {
    root: args.root.toString('hex'),
    proofs: args.proofs,
  };
}

function assertExistingDiscountMerkleJsonMatches(args: {
  root: Buffer;
  proofs: Record<string, string[]>;
  filePath: string;
}): void {
  const existingSource = readFileSync(args.filePath, 'utf8');
  let existingValue: unknown;
  try {
    existingValue = JSON.parse(existingSource);
  } catch (err) {
    throw new Error(
      `Existing discount Merkle dataset is not valid JSON: ${args.filePath} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!isDeepStrictEqual(existingValue, discountMerkleJsonValue(args))) {
    throw new Error(
      `Existing discount Merkle dataset conflicts with the generated dataset for root ${args.root.toString('hex')}: ${args.filePath}`,
    );
  }
}

function discountMerkleRegistryReferences(
  root: string,
  registryPath: string,
  drops: Record<string, { dropId: string; dropFamily: string; discountMerkleRoot: string }>,
): DiscountMerkleDatasetReference[] {
  const registryLabel = path.relative(root, registryPath);
  return Object.values(drops).map((drop) => ({
    dropFamily: drop.dropFamily,
    rootHex: drop.discountMerkleRoot,
    source: `${registryLabel}:${drop.dropId}`,
  }));
}

export async function validateDiscountMerkleDatasetForDeploy(args: {
  root: string;
  dropId: string;
  dropFamily: DropFamily;
  merkleRoot: Buffer;
  configPath?: string;
  proofs: Record<string, string[]>;
}): Promise<{
  dropFamily: string;
  rootHex: string;
  fileName: string;
  relativePath: string;
  filePath: string;
}> {
  const desired = requireDiscountMerkleDatasetIdentity({
    dropFamily: args.dropFamily,
    rootHex: args.merkleRoot.toString('hex'),
    source: `${args.configPath ?? 'scripts/newDrops/<dropId>.ts'}:${args.dropId}`,
  });
  const registryPath = path.join(
    args.root,
    'shared',
    'deploymentRegistry.ts',
  );
  const registry = await readDeploymentDropRegistry(registryPath);
  validateDiscountMerkleFamilyRootInvariant([
    ...discountMerkleRegistryReferences(
      args.root,
      registryPath,
      registry.drops,
    ),
    {
      dropFamily: desired.dropFamily,
      rootHex: desired.rootHex,
      source: `${args.configPath ?? 'scripts/newDrops/<dropId>.ts'}:${args.dropId}`,
    },
  ]);

  const filePath = path.join(args.root, desired.relativePath);
  if (existsSync(filePath)) {
    assertExistingDiscountMerkleJsonMatches({
      root: args.merkleRoot,
      proofs: args.proofs,
      filePath,
    });
  }
  return { ...desired, filePath };
}

export function writeDiscountMerkleJson(args: {
  root: Buffer;
  proofs: Record<string, string[]>;
  filePath: string;
}): void {
  const payload = renderDiscountMerkleJson(args);
  mkdirSync(path.dirname(args.filePath), { recursive: true });
  if (existsSync(args.filePath)) {
    assertExistingDiscountMerkleJsonMatches(args);
    return;
  }
  try {
    writeFileSync(args.filePath, payload, { encoding: 'utf8', flag: 'wx' });
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
  }
  assertExistingDiscountMerkleJsonMatches(args);
}

export async function finalizeDiscountMerkleAndDeploymentRegistry<T>(args: {
  root: Buffer;
  proofs: Record<string, string[]>;
  filePath: string;
  commitRegistryChanges: () => Promise<T>;
}): Promise<T> {
  // The initialize transaction may already have committed this root. Registry
  // rollback must never remove the only data capable of producing its proofs.
  writeDiscountMerkleJson(args);
  return args.commitRegistryChanges();
}
