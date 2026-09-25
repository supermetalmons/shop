import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { normalizeAndValidateDropId } from './deploymentRegistry.ts';

export type PreorderCollectionConfig = {
  collectionId: string;
  isMainnet: boolean;
  solanaRpcUrl?: string;
  authority: string;
  collectionMetadataUri: string;
  collectionMetadata: {
    name: string;
    symbol: string;
    description: string;
    image: string;
    externalUrl: string;
    sellerFeeBasisPoints: number | null;
    creators: readonly { address: string; share: number }[];
  };
};

export type PreparedPreorderCollectionConfig = Omit<
  PreorderCollectionConfig,
  'isMainnet' | 'collectionMetadata'
> & {
  solanaCluster: 'devnet' | 'mainnet-beta';
  collectionMetadata: Omit<
    PreorderCollectionConfig['collectionMetadata'],
    'sellerFeeBasisPoints'
  > & { sellerFeeBasisPoints: number };
};

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    /^(?:TODO\b|TBD\b|REPLACE_ME\b|YOUR[_\s]|<.*>$)/i.test(value.trim())
  ) {
    throw new Error(`${label} is required; fill in the preorder collection configuration`);
  }
  return value.trim();
}

function requirePublicKey(value: unknown, label: string): string {
  const text = requireText(value, label);
  let key: PublicKey;
  try {
    key = new PublicKey(text);
  } catch {
    throw new Error(`${label} must be a valid Solana public key`);
  }
  if (key.equals(PublicKey.default)) {
    throw new Error(`${label} must not be the zero public key`);
  }
  return key.toBase58();
}

function requireUrl(value: unknown, label: string, protocols: readonly string[]): string {
  const text = requireText(value, label);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be a full ${protocols.join(' or ')} URL`);
  }
  if (
    !protocols.includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    /\s/.test(text) ||
    !text.startsWith(`${url.protocol}//`)
  ) {
    throw new Error(`${label} must be a full ${protocols.join(' or ')} URL without credentials or whitespace`);
  }
  return text;
}

export function preparePreorderCollectionConfig(
  raw: unknown,
  expectedId: string,
): PreparedPreorderCollectionConfig {
  const requestedId = normalizeAndValidateDropId(expectedId, 'collectionId');
  const config = requireObject(raw, 'NEW_PREORDER_COLLECTION');
  const collectionId = normalizeAndValidateDropId(
    requireText(config.collectionId, 'collectionId'),
    'collectionId',
  );
  if (collectionId !== requestedId) {
    throw new Error(
      `Collection config file name must match collectionId: requested ${requestedId}, configured ${collectionId}`,
    );
  }
  if (typeof config.isMainnet !== 'boolean') {
    throw new Error('isMainnet must be explicitly set to true or false');
  }
  const authority = requirePublicKey(config.authority, 'authority');
  const collectionMetadataUri = requireUrl(
    config.collectionMetadataUri,
    'collectionMetadataUri',
    ['https:', 'ipfs:'],
  );
  const metadata = requireObject(config.collectionMetadata, 'collectionMetadata');
  const name = requireText(metadata.name, 'collectionMetadata.name');
  const symbol = requireText(metadata.symbol, 'collectionMetadata.symbol');
  const description = requireText(metadata.description, 'collectionMetadata.description');
  const image = requireUrl(metadata.image, 'collectionMetadata.image', ['https:', 'ipfs:']);
  const externalUrl = requireUrl(metadata.externalUrl, 'collectionMetadata.externalUrl', ['https:']);
  const sellerFeeBasisPoints = metadata.sellerFeeBasisPoints;
  if (
    typeof sellerFeeBasisPoints !== 'number' ||
    !Number.isInteger(sellerFeeBasisPoints) ||
    sellerFeeBasisPoints < 0 ||
    sellerFeeBasisPoints > 10_000
  ) {
    throw new Error('collectionMetadata.sellerFeeBasisPoints must be an explicit integer from 0 to 10000 (0 means no royalties)');
  }
  if (!Array.isArray(metadata.creators) || !metadata.creators.length) {
    throw new Error('collectionMetadata.creators must contain at least one royalty recipient');
  }
  const addresses = new Set<string>();
  const creators = metadata.creators.map((entry, index) => {
    const label = `collectionMetadata.creators[${index}]`;
    const creator = requireObject(entry, label);
    const address = requirePublicKey(creator.address, `${label}.address`);
    if (addresses.has(address)) {
      throw new Error(`${label}.address duplicates another royalty recipient`);
    }
    addresses.add(address);
    if (
      typeof creator.share !== 'number' ||
      !Number.isInteger(creator.share) ||
      creator.share < 1 ||
      creator.share > 100
    ) {
      throw new Error(`${label}.share must be an integer percentage from 1 to 100`);
    }
    return { address, share: creator.share };
  });
  if (creators.reduce((total, creator) => total + creator.share, 0) !== 100) {
    throw new Error('collectionMetadata.creators shares must sum to 100');
  }
  const solanaRpcUrl = config.solanaRpcUrl === undefined
    ? undefined
    : requireUrl(config.solanaRpcUrl, 'solanaRpcUrl', ['https:', 'http:']);
  return {
    collectionId,
    solanaCluster: config.isMainnet ? 'mainnet-beta' : 'devnet',
    ...(solanaRpcUrl ? { solanaRpcUrl } : {}),
    authority,
    collectionMetadataUri,
    collectionMetadata: {
      name,
      symbol,
      description,
      image,
      externalUrl,
      sellerFeeBasisPoints,
      creators,
    },
  };
}

export function preorderCollectionUsage(): string {
  return 'Run:\n  npm run deploy-preorder-collection -- <collectionId>\n';
}

export async function loadPreorderCollectionConfig(args: {
  root: string;
  collectionId: string;
}): Promise<{ config: PreparedPreorderCollectionConfig; configPath: string }> {
  if (!args.collectionId?.trim()) {
    throw new Error(`Missing collectionId.\n${preorderCollectionUsage()}`);
  }
  const collectionId = normalizeAndValidateDropId(args.collectionId, 'collectionId');
  const directory = path.join(args.root, 'scripts', 'newPreorderCollections');
  const configPath = path.join(directory, `${collectionId}.ts`);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    entries = [];
  }
  const knownIds = entries
    .filter((name) => /^[a-z0-9][a-z0-9_-]{0,63}\.ts$/.test(name))
    .map((name) => name.slice(0, -3))
    .sort();
  const relativePath = path.relative(args.root, configPath);
  if (!knownIds.includes(collectionId)) {
    throw new Error(
      `Could not find a preorder collection config for ${collectionId}.\n` +
      `Expected file: ${relativePath}\n` +
      `Known collection configs: ${knownIds.join(', ') || '(none)'}\n` +
      preorderCollectionUsage(),
    );
  }
  let imported: Record<string, unknown>;
  try {
    const { mtimeMs } = await stat(configPath);
    imported = await import(`${pathToFileURL(configPath).href}?t=${mtimeMs}-${process.pid}`);
  } catch (error) {
    throw new Error(
      `Could not load preorder collection config from ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!imported.NEW_PREORDER_COLLECTION) {
    throw new Error(`Expected ${relativePath} to export NEW_PREORDER_COLLECTION`);
  }
  return {
    config: preparePreorderCollectionConfig(imported.NEW_PREORDER_COLLECTION, collectionId),
    configPath,
  };
}
