import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const ADMIN = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
export const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
export const MPL_CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
export const ACCOUNT_COMPRESSION = 'mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW';
export const BUBBLEGUM = 'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY';

const CONFIG_DISCRIMINATOR = Buffer.from([62, 29, 116, 188, 219, 247, 48, 227]);
const TREE_CONFIG_DISCRIMINATOR = Buffer.from([122, 245, 175, 248, 171, 34, 0, 207]);

export type Asset = Record<string, any>;
type DropKind = 'little_swag_boxes' | 'poncho_drifella' | 'card_nft_2';

type UriPath = {
  kind: 'box' | 'figure';
  corePath: string;
  receiptPath: string;
  maximum: 'supply' | 'figures';
};

export type DropSpec = {
  dropId: DropKind;
  program: string;
  programData: string;
  deploymentSlot: number;
  elfSha256: string;
  config: string;
  configBytes: number;
  configSha256: string;
  configHasItemsPerBox: boolean;
  collection: string;
  collectionUpdateAuthority: string;
  receiptsTree: string;
  receiptsTreeConfig: string;
  legacyBase: string;
  canonicalBase: string;
  paths: UriPath[];
  fixedMaximumFigures?: number;
  coreAuthority: string;
};

export type DecodedConfig = {
  admin: string;
  treasury: string;
  coreCollection: string;
  maxSupply: number;
  maxPerTx: number;
  itemsPerBox: number;
  minted: number;
  namePrefix: string;
  symbol: string;
  uriBase: string;
};

export type InventorySummary = {
  pages: number;
  total: number;
  liveCore: number;
  liveReceipts: number;
  burnedCore: number;
  burnedReceipts: number;
  canonicalLiveCore: number;
  canonicalLiveReceipts: number;
  canonicalBurnedCore: number;
  canonicalBurnedReceipts: number;
  legacyBurnedCore: number;
  legacyBurnedReceipts: number;
  mutableLegacy: string[];
  liveCoreAssets: Asset[];
};

export const MAINNET_URI_DROPS: readonly DropSpec[] = Object.freeze([
  {
    dropId: 'little_swag_boxes',
    program: '22NeePs5wgkzP4j5sPzfzJqXsFAu9SUMiGBznPQVaAep',
    programData: '2u35tdkjBJkT79tdT58XeNEw216B82BPVmMeD8WoEfa6',
    deploymentSlot: 437_191_823,
    elfSha256: '0b0b2572727d787e6c78c462afbab6d5d88124ada7b8cf65b1df94f90bbd974f',
    config: 'iGsmSPPYJovrb7jNFCX6BimZN5Z7dpkmCuW9SYAgcMc',
    configBytes: 289,
    configSha256: '8654ebab1f6870156bc412e231a16ec9ff5f54be6cf3e7dfdc2379c3c6fee613',
    configHasItemsPerBox: false,
    collection: '7c3tY7nEZ6yDuUCrsL6dX7AFcCqKbwMwS6HRvdZXeQXr',
    collectionUpdateAuthority: 'iGsmSPPYJovrb7jNFCX6BimZN5Z7dpkmCuW9SYAgcMc',
    receiptsTree: 'Bep28XBM8LEjdCHgTzhuo5hFazpKrKgxDaEcnRg2VThV',
    receiptsTreeConfig: '61nRmLFVKe7x63Frz9TM2AkGSTmuDyYAuppAwZUee5tX',
    legacyBase: 'https://assets.mons.link/drops/lsb',
    canonicalBase: 'https://cdn.lil.org/nft/little_swag_boxes',
    fixedMaximumFigures: 999,
    paths: [
      { kind: 'box', corePath: '/json/boxes/', receiptPath: '/json/receipts/boxes/', maximum: 'supply' },
      { kind: 'figure', corePath: '/json/figures/', receiptPath: '/json/receipts/figures/', maximum: 'figures' },
    ],
    coreAuthority: 'iGsmSPPYJovrb7jNFCX6BimZN5Z7dpkmCuW9SYAgcMc',
  },
  {
    dropId: 'poncho_drifella',
    program: 'C96UF1dNPzAiRoWPDyU1BRVez5Rfqf2WeFy6gipkBS5A',
    programData: '3rmLDxbb6AFQfAKjWMjvFF7axnXBJYBigATFdCSm9Mvv',
    deploymentSlot: 437_216_909,
    elfSha256: '705a938ea341c07b2469bda68f6b229bc68976202c335a17fa697b46469292fc',
    config: '2bYowarQZyoBjHmu1fzHDnWUfQRctLL4YHr7yhYjnVQq',
    configBytes: 307,
    configSha256: 'b94040fb4d1bf8d68b7cb17e93ebaad9cffb8bf315d729d2b7760d43ee60c068',
    configHasItemsPerBox: true,
    collection: 'JCTP3kK3xGtWs5mDHxJBuRro38HftaiCDdKsfkXuK2gH',
    collectionUpdateAuthority: '2bYowarQZyoBjHmu1fzHDnWUfQRctLL4YHr7yhYjnVQq',
    receiptsTree: '5wCjVex6yXCms518RccxmAaVMGoPvTEQcb4UR3MYtQow',
    receiptsTreeConfig: '3ZDjwqjnahBUPhprv8WXt2jAyJahQo2TEEfPAwTnTRNp',
    legacyBase: 'https://assets.mons.link/drops/poncho',
    canonicalBase: 'https://cdn.lil.org/nft/poncho_drifella',
    paths: [
      { kind: 'box', corePath: '/json/boxes/', receiptPath: '/json/receipts/boxes/', maximum: 'supply' },
      { kind: 'figure', corePath: '/json/figures/', receiptPath: '/json/receipts/figures/', maximum: 'figures' },
    ],
    coreAuthority: '2bYowarQZyoBjHmu1fzHDnWUfQRctLL4YHr7yhYjnVQq',
  },
  {
    dropId: 'card_nft_2',
    program: '7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU',
    programData: 'EoFbiCxRabimw8NHUNcdtMuVTuxVcriZSFZys4GvkWMK',
    deploymentSlot: 437_244_047,
    elfSha256: 'a11f08436c0c1f7da6d3254f5191ba297a7d73b243bd14f3f81622c61eb5cb66',
    config: '5Wm8XacaTagt9UTdYuGSUmVk87GgMLeyeV5JerzjTNqm',
    configBytes: 376,
    configSha256: '8d2bb5abe151e5255d0bc5c97af90bef8b23d1a4b63858f4bf60a7dcdcbf3627',
    configHasItemsPerBox: true,
    collection: 'EAzEpagtyeRAx9npnpVMpygoA8ouX7DRpLTghhPvYTiu',
    collectionUpdateAuthority: ADMIN,
    receiptsTree: 'EsGrHZjZzHmxzCSrqjyzuBBC4oAq3yS87ZNF1JdvDBh',
    receiptsTreeConfig: 'HQxfJuE57mGh96UJ6eBAusRVLjX4sSZwQxfn6moW5N9i',
    legacyBase: 'https://assets.mons.link/drops/cardnft2/json',
    canonicalBase: 'https://cdn.lil.org/nft/card_nft_2/json',
    paths: [
      { kind: 'box', corePath: '/b', receiptPath: '/rb', maximum: 'supply' },
      { kind: 'figure', corePath: '/f', receiptPath: '/rf', maximum: 'figures' },
    ],
    coreAuthority: ADMIN,
  },
]);

export const KNOWN_DEPLOYMENT_BUFFERS = Object.freeze([
  '8882Y4L1wT1a17w7zTERVpaiYHXRG5A5CQrW1PxFUZ6k',
  'FmysLeXppJqRokBzVg7Qz22UNJcXpGb8rqQrffxC7kuW',
  '2Kn4q1ND69HzBYq2UBb9VS9gAgZUFcYrtryXTzS54Mcb',
  '8WQ3QaEVyeUkDMfmBGycdeNRkKG2zKnzATeBjjH1zLkP',
  'DECub82hX8qFRo2rA5BDHLVQJWeh5cCdWSMpupMoEcmJ',
]);

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function readString(data: Buffer, offset: number): { value: string; offset: number } {
  if (offset + 4 > data.length) throw new Error('String length exceeds account data');
  const length = data.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > data.length) throw new Error('String exceeds account data');
  return { value: data.subarray(start, end).toString('utf8'), offset: end };
}

function decodeConfig(spec: DropSpec, data: Buffer): DecodedConfig {
  if (data.length !== spec.configBytes) {
    throw new Error(`${spec.dropId} config is ${data.length} bytes, expected ${spec.configBytes}`);
  }
  if (!data.subarray(0, 8).equals(CONFIG_DISCRIMINATOR)) {
    throw new Error(`${spec.dropId} config discriminator mismatch`);
  }
  let offset = 8;
  const pubkey = () => {
    if (offset + 32 > data.length) throw new Error('Config public key exceeds account data');
    const value = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    return value;
  };
  const admin = pubkey();
  const treasury = pubkey();
  const coreCollection = pubkey();
  offset += 8 + 8 + 32;
  if (offset + 5 > data.length) throw new Error('Config numeric fields exceed account data');
  const maxSupply = data.readUInt32LE(offset);
  offset += 4;
  const maxPerTx = data[offset++];
  const itemsPerBox = spec.configHasItemsPerBox ? data[offset++] : 3;
  if (offset + 4 > data.length) throw new Error('Config minted field exceeds account data');
  const minted = data.readUInt32LE(offset);
  offset += 4;
  const namePrefix = readString(data, offset);
  const symbol = readString(data, namePrefix.offset);
  const uriBase = readString(data, symbol.offset);
  return {
    admin,
    treasury,
    coreCollection,
    maxSupply,
    maxPerTx,
    itemsPerBox,
    minted,
    namePrefix: namePrefix.value,
    symbol: symbol.value,
    uriBase: uriBase.value,
  };
}

export function assertConfigState(spec: DropSpec, owner: string, data: Buffer): DecodedConfig {
  if (owner !== spec.program) throw new Error(`${spec.dropId} config owner mismatch`);
  if (sha256(data) !== spec.configSha256) throw new Error(`${spec.dropId} config hash mismatch`);
  const decoded = decodeConfig(spec, data);
  if (decoded.admin !== ADMIN
    || decoded.coreCollection !== spec.collection
    || decoded.uriBase !== spec.canonicalBase) {
    throw new Error(`${spec.dropId} decoded config mismatch`);
  }
  return decoded;
}

export function parseProgramData(data: Buffer): { slot: number; authority: string; payloadSha256: string } {
  if (data.length < 45 || data.readUInt32LE(0) !== 3 || data[12] !== 1) {
    throw new Error('Invalid upgradeable ProgramData account');
  }
  return {
    slot: Number(data.readBigUInt64LE(4)),
    authority: new PublicKey(data.subarray(13, 45)).toBase58(),
    payloadSha256: sha256(data.subarray(45)),
  };
}

export function assertProgramState(
  spec: DropSpec,
  programOwner: string,
  executable: boolean,
  programDataOwner: string,
  data: Buffer,
): ReturnType<typeof parseProgramData> {
  if (programOwner !== UPGRADEABLE_LOADER || !executable || programDataOwner !== UPGRADEABLE_LOADER) {
    throw new Error(`${spec.dropId} program account mismatch`);
  }
  const decoded = parseProgramData(data);
  if (decoded.slot !== spec.deploymentSlot
    || decoded.authority !== ADMIN
    || decoded.payloadSha256 !== spec.elfSha256) {
    throw new Error(`${spec.dropId} deployed program mismatch`);
  }
  return decoded;
}

export function parseRawCollection(data: Buffer): { updateAuthority: string; name: string; uri: string } {
  if (data[0] !== 5) throw new Error(`MPL Core collection discriminator is ${data[0]}, expected 5`);
  let offset = 1;
  const updateAuthority = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const name = readString(data, offset);
  const uri = readString(data, name.offset);
  return { updateAuthority, name: name.value, uri: uri.value };
}

export function parseRawCoreAsset(data: Buffer): {
  updateAuthorityKind: number;
  updateAuthority: string | null;
  name: string;
  uri: string;
} {
  if (data[0] !== 1) throw new Error(`MPL Core asset discriminator is ${data[0]}, expected 1`);
  let offset = 33;
  const updateAuthorityKind = data[offset++];
  let updateAuthority: string | null = null;
  if (updateAuthorityKind === 1 || updateAuthorityKind === 2) {
    updateAuthority = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;
  } else if (updateAuthorityKind !== 0) {
    throw new Error(`Unknown MPL Core update authority kind ${updateAuthorityKind}`);
  }
  const name = readString(data, offset);
  const uri = readString(data, name.offset);
  return { updateAuthorityKind, updateAuthority, name: name.value, uri: uri.value };
}

export function assertTreeConfig(spec: DropSpec, treeOwner: string, treeConfigOwner: string, data: Buffer): void {
  if (treeOwner !== ACCOUNT_COMPRESSION || treeConfigOwner !== BUBBLEGUM) {
    throw new Error(`${spec.dropId} receipt tree owner mismatch`);
  }
  if (data.length !== 96 || !data.subarray(0, 8).equals(TREE_CONFIG_DISCRIMINATOR)) {
    throw new Error(`${spec.dropId} receipt TreeConfig layout mismatch`);
  }
  const creator = new PublicKey(data.subarray(8, 40)).toBase58();
  const delegate = new PublicKey(data.subarray(40, 72)).toBase58();
  if (creator !== ADMIN || delegate !== ADMIN) {
    throw new Error(`${spec.dropId} receipt TreeConfig authority mismatch`);
  }
}

function strictReference(uri: string, base: string, path: string, maximum: number): number | null {
  const prefix = `${base}${path}`;
  if (!uri.startsWith(prefix) || !uri.endsWith('.json')) return null;
  const stem = uri.slice(prefix.length, -5);
  if (!/^[1-9]\d*$/.test(stem)) return null;
  const value = Number(stem);
  return Number.isSafeInteger(value) && value <= maximum ? value : null;
}

function classifyUri(
  spec: DropSpec,
  config: DecodedConfig,
  uri: string,
  receipt: boolean,
): { root: 'canonical' | 'legacy'; kind: 'box' | 'figure'; referenceId: number } | null {
  const maximumFigures = spec.fixedMaximumFigures ?? config.maxSupply * config.itemsPerBox;
  for (const rule of spec.paths) {
    const path = receipt ? rule.receiptPath : rule.corePath;
    const maximum = rule.maximum === 'supply' ? config.maxSupply : maximumFigures;
    const canonical = strictReference(uri, spec.canonicalBase, path, maximum);
    if (canonical !== null) return { root: 'canonical', kind: rule.kind, referenceId: canonical };
    const legacy = strictReference(uri, spec.legacyBase, path, maximum);
    if (legacy !== null) return { root: 'legacy', kind: rule.kind, referenceId: legacy };
  }
  return null;
}

function inCollection(asset: Asset, collection: string): boolean {
  return Array.isArray(asset.grouping) && asset.grouping.some(
    (group: any) => group?.group_key === 'collection' && group?.group_value === collection,
  );
}

function authorityIncludes(asset: Asset, address: string): boolean {
  return Array.isArray(asset.authorities) && asset.authorities.some(
    (authority: any) => authority?.address === address
      && Array.isArray(authority.scopes)
      && authority.scopes.includes('full'),
  );
}

export async function paginateDasAssets(
  fetchPage: (page: number) => Promise<any>,
  pageSize = 1_000,
): Promise<{ assets: Asset[]; pages: number }> {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('Invalid DAS page size');
  const assets = new Map<string, Asset>();
  let pages = 0;
  for (let page = 1; ; page += 1) {
    const result = await fetchPage(page);
    if (!result || !Array.isArray(result.items)) throw new Error(`Malformed DAS page ${page}`);
    pages = page;
    for (const asset of result.items) {
      const id = String(asset?.id || '');
      if (!id) throw new Error(`Missing asset ID on DAS page ${page}`);
      const existing = assets.get(id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(asset)) {
        throw new Error(`Conflicting duplicate DAS asset ${id}`);
      }
      assets.set(id, asset);
    }
    if (result.items.length < pageSize) break;
    if (page >= 100) throw new Error('DAS pagination exceeded 100 pages');
  }
  return { assets: [...assets.values()], pages };
}

export function scanInventory(
  spec: DropSpec,
  config: DecodedConfig,
  assets: Asset[],
  pages = 0,
): InventorySummary {
  const summary: InventorySummary = {
    pages,
    total: assets.length,
    liveCore: 0,
    liveReceipts: 0,
    burnedCore: 0,
    burnedReceipts: 0,
    canonicalLiveCore: 0,
    canonicalLiveReceipts: 0,
    canonicalBurnedCore: 0,
    canonicalBurnedReceipts: 0,
    legacyBurnedCore: 0,
    legacyBurnedReceipts: 0,
    mutableLegacy: [],
    liveCoreAssets: [],
  };
  for (const asset of assets) {
    const id = String(asset?.id || '');
    if (!id || !inCollection(asset, spec.collection)) throw new Error(`Invalid collection grouping: ${id || 'unknown'}`);
    const receipt = asset.interface === 'MplBubblegumV2';
    const core = asset.interface === 'MplCoreAsset';
    if (!core && !receipt) throw new Error(`Unexpected collection interface ${id}: ${asset.interface}`);
    const classification = classifyUri(spec, config, String(asset.content?.json_uri || ''), receipt);
    if (!classification) throw new Error(`Unexpected ${receipt ? 'receipt' : 'Core'} URI ${id}`);
    if (asset.burnt) {
      if (receipt) {
        summary.burnedReceipts += 1;
        summary[classification.root === 'legacy' ? 'legacyBurnedReceipts' : 'canonicalBurnedReceipts'] += 1;
      } else {
        summary.burnedCore += 1;
        summary[classification.root === 'legacy' ? 'legacyBurnedCore' : 'canonicalBurnedCore'] += 1;
      }
      continue;
    }
    if (!asset.mutable) throw new Error(`Live asset is immutable: ${id}`);
    if (receipt) {
      if (asset.compression?.tree !== spec.receiptsTree) throw new Error(`Receipt tree mismatch: ${id}`);
      summary.liveReceipts += 1;
      if (classification.root === 'canonical') summary.canonicalLiveReceipts += 1;
      else summary.mutableLegacy.push(id);
    } else {
      if (!authorityIncludes(asset, spec.coreAuthority)) throw new Error(`Core authority mismatch: ${id}`);
      summary.liveCore += 1;
      summary.liveCoreAssets.push(asset);
      if (classification.root === 'canonical') summary.canonicalLiveCore += 1;
      else summary.mutableLegacy.push(id);
    }
  }
  summary.mutableLegacy.sort();
  return summary;
}

export function assertNoMutableLegacy(summary: InventorySummary, dropId: string): void {
  if (summary.mutableLegacy.length) {
    throw new Error(`${dropId} has ${summary.mutableLegacy.length} mutable legacy URI(s): ${summary.mutableLegacy.join(', ')}`);
  }
}
