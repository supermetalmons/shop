import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bs58 from 'bs58';
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';

export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const PROGRAM_ID = new PublicKey('7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU');
export const PROGRAM_DATA = new PublicKey('EoFbiCxRabimw8NHUNcdtMuVTuxVcriZSFZys4GvkWMK');
export const CONFIG_PDA = new PublicKey('5Wm8XacaTagt9UTdYuGSUmVk87GgMLeyeV5JerzjTNqm');
export const ADMIN = new PublicKey('kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx');
export const COLLECTION = new PublicKey('EAzEpagtyeRAx9npnpVMpygoA8ouX7DRpLTghhPvYTiu');
export const RECEIPTS_TREE = new PublicKey('EsGrHZjZzHmxzCSrqjyzuBBC4oAq3yS87ZNF1JdvDBh');
export const RECEIPTS_TREE_CONFIG = new PublicKey('HQxfJuE57mGh96UJ6eBAusRVLjX4sSZwQxfn6moW5N9i');
export const DELIVERY_LOOKUP_TABLE = new PublicKey('27S1HddzYtfhYpwq4QHxnnXAkRt6JFx9Kad9KMnRUpcd');
export const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const SPL_NOOP = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
const MPL_NOOP = new PublicKey('mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3');
export const ACCOUNT_COMPRESSION = new PublicKey('mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW');
export const BUBBLEGUM = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
export const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export const OLD_BASE = 'https://assets.mons.link/drops/cardnft2/json';
export const NEW_BASE = 'https://cdn.lil.org/nft/card_nft_2/json';
const CONFIG_BYTES = 376;
export const MAX_BOX_ID = 3_711;
export const MAX_CARD_ID = 11_133;
export const CORE_BATCH_SIZE = 10;
const MAX_RECEIPT_PROOF_ACCOUNTS = 14;
export const LIVE_PROGRAM_CAPACITY = 482_520;
export const LIVE_PROGRAM_SHA256 = 'dfad30f7a415bedd7083afe1641b717503a7512395ba7d63ab275ece470afdb5';
export const SET_URI_BASE_DISCRIMINATOR = Buffer.from([160, 250, 204, 89, 122, 8, 207, 34]);
const CONFIG_DISCRIMINATOR = Buffer.from([62, 29, 116, 188, 219, 247, 48, 227]);
const TREE_CONFIG_DISCRIMINATOR = Buffer.from([122, 245, 175, 248, 171, 34, 0, 207]);
const UPDATE_METADATA_V2_DISCRIMINATOR = Buffer.from([43, 103, 89, 42, 121, 242, 62, 72]);

export const SHARED_CONFIGS = Object.freeze({
  card_nft_2: CONFIG_PDA,
  card_nft_binder: new PublicKey('9fd9YF6ZYMZw9ERwdnc798xoUFo584Tmqxc5bWu8j1Bi'),
  drifella_shirt: new PublicKey('FRJeVgAF9sjUgUJD6Da4eRCBSyfzxjoU4wjxStp8RGXG'),
  little_swag_hoodies: new PublicKey('3WSAzs8qN1kQoFM8eSKXAYkHXxZ3UianQDRVbVazb8Hi'),
});

export type Asset = Record<string, any>;
export type MigrationKind = 'box' | 'card';
type UriStatus = 'source' | 'target';

export type CoreTarget = {
  address: string;
  kind: MigrationKind;
  referenceId: number;
  sourceUri: string;
  targetUri: string;
};

export type ReceiptTarget = CoreTarget & {
  leafId: number;
};

export type DecodedConfig = {
  admin: string;
  treasury: string;
  coreCollection: string;
  priceLamports: string;
  discountPriceLamports: string;
  discountMerkleRoot: string;
  maxSupply: number;
  maxPerTx: number;
  itemsPerBox: number;
  minted: number;
  namePrefix: string;
  symbol: string;
  uriBase: string;
  started: boolean;
  bump: number;
  discountMintsPerWallet: number;
  figureNamePrefix: string;
  trailingBytesSha256: string;
};

export type ClassifiedUri = {
  status: UriStatus;
  kind: MigrationKind;
  referenceId: number;
  sourceUri: string;
  targetUri: string;
};

export function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sanitizedRpcUrl(rpcUrl: string): string {
  const url = new URL(rpcUrl);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

export function configuredMainnetRpc(): { rpcUrl: string; rpcSource: string } {
  if (process.env.MAINNET_RPC_URL?.trim()) {
    return {
      rpcUrl: process.env.MAINNET_RPC_URL.trim(),
      rpcSource: 'MAINNET_RPC_URL (process environment)',
    };
  }
  for (const name of ['HELIUS_API_KEY', 'VITE_HELIUS_API_KEY']) {
    const value = process.env[name]?.trim();
    if (value) return {
      rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(value)}`,
      rpcSource: `${name} (process environment)`,
    };
  }
  const envPath = path.join(repositoryRoot(), '.env.local');
  if (existsSync(envPath)) {
    const contents = readFileSync(envPath, 'utf8');
    for (const name of ['HELIUS_API_KEY', 'VITE_HELIUS_API_KEY']) {
      const match = contents.match(new RegExp(`^${name}\\s*=\\s*(.+?)\\s*$`, 'm'));
      const value = match?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
      if (value) return {
        rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(value)}`,
        rpcSource: `${name} (.env.local)`,
      };
    }
  }
  throw new Error('HELIUS_API_KEY, VITE_HELIUS_API_KEY, or MAINNET_RPC_URL is required');
}

let rpcSequence = 0;

export async function rpc<T>(rpcUrl: string, method: string, params: unknown = []): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcSequence, method, params }),
    });
    if (response.ok) {
      const payload = await response.json() as { result?: T; error?: { code?: number; message?: string } };
      if (!payload.error) return payload.result as T;
      if (payload.error.code !== 429 && payload.error.code !== -32005) {
        throw new Error(`${method}: ${payload.error.message || JSON.stringify(payload.error)}`);
      }
    } else if (response.status !== 429 && response.status < 500) {
      throw new Error(`${method}: HTTP ${response.status}`);
    }
    if (attempt === 7) throw new Error(`${method}: RPC retry limit exceeded`);
    const retryAfter = Number(response.headers.get('retry-after'));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1_000
      : Math.min(6_000, 250 * 2 ** attempt) + Math.floor(Math.random() * 200);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
  }
  throw new Error(`${method}: unreachable retry state`);
}

export function accountData(response: any, address: string): Buffer {
  if (!response?.value) throw new Error(`Missing account ${address}`);
  if (!Array.isArray(response.value.data) || response.value.data[1] !== 'base64') {
    throw new Error(`Unexpected account encoding for ${address}`);
  }
  return Buffer.from(response.value.data[0], 'base64');
}

export function assertReceiptTreeConfig(data: Buffer): { creator: string; delegate: string } {
  if (data.length !== 96) throw new Error(`Receipt TreeConfig is ${data.length} bytes, expected 96`);
  if (!data.subarray(0, 8).equals(TREE_CONFIG_DISCRIMINATOR)) {
    throw new Error('Receipt TreeConfig discriminator mismatch');
  }
  const creator = new PublicKey(data.subarray(8, 40)).toBase58();
  const delegate = new PublicKey(data.subarray(40, 72)).toBase58();
  if (creator !== ADMIN.toBase58() || delegate !== ADMIN.toBase58()) {
    throw new Error(`Receipt TreeConfig authority mismatch: ${creator} / ${delegate}`);
  }
  return { creator, delegate };
}

function readString(data: Buffer, offset: number): { value: string; offset: number } {
  if (offset + 4 > data.length) throw new Error('String length exceeds account data');
  const length = data.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > data.length) throw new Error('String exceeds account data');
  return { value: data.subarray(start, end).toString('utf8'), offset: end };
}

export function decodeConfig(data: Buffer): DecodedConfig {
  if (data.length !== CONFIG_BYTES) throw new Error(`Config is ${data.length} bytes, expected ${CONFIG_BYTES}`);
  if (!data.subarray(0, 8).equals(CONFIG_DISCRIMINATOR)) throw new Error('Config discriminator mismatch');
  let offset = 8;
  const pubkey = () => {
    const value = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    return value;
  };
  const admin = pubkey();
  const treasury = pubkey();
  const coreCollection = pubkey();
  const priceLamports = data.readBigUInt64LE(offset).toString();
  offset += 8;
  const discountPriceLamports = data.readBigUInt64LE(offset).toString();
  offset += 8;
  const discountMerkleRoot = data.subarray(offset, offset + 32).toString('hex');
  offset += 32;
  const maxSupply = data.readUInt32LE(offset);
  offset += 4;
  const maxPerTx = data[offset++];
  const itemsPerBox = data[offset++];
  const minted = data.readUInt32LE(offset);
  offset += 4;
  const namePrefix = readString(data, offset);
  offset = namePrefix.offset;
  const symbol = readString(data, offset);
  offset = symbol.offset;
  const uriBase = readString(data, offset);
  offset = uriBase.offset;
  const started = data[offset++] === 1;
  const bump = data[offset++];
  const discountMintsPerWallet = data[offset++];
  const figureNamePrefix = readString(data, offset);
  offset = figureNamePrefix.offset;
  return {
    admin,
    treasury,
    coreCollection,
    priceLamports,
    discountPriceLamports,
    discountMerkleRoot,
    maxSupply,
    maxPerTx,
    itemsPerBox,
    minted,
    namePrefix: namePrefix.value,
    symbol: symbol.value,
    uriBase: uriBase.value,
    started,
    bump,
    discountMintsPerWallet,
    figureNamePrefix: figureNamePrefix.value,
    trailingBytesSha256: sha256(data.subarray(offset)),
  };
}

export function assertCardConfig(config: DecodedConfig): void {
  assert.equal(config.admin, ADMIN.toBase58(), 'Card config admin mismatch');
  assert.equal(config.coreCollection, COLLECTION.toBase58(), 'Card collection mismatch');
  assert.equal(config.maxSupply, MAX_BOX_ID, 'Card maximum supply mismatch');
  assert.equal(config.itemsPerBox, 3, 'Card items per box mismatch');
  assert.equal(config.namePrefix, 'pack', 'Card box prefix mismatch');
  assert.equal(config.figureNamePrefix, 'card', 'Card figure prefix mismatch');
  assert.equal(config.symbol, 'cardnft2', 'Card symbol mismatch');
  assert.ok(config.uriBase === OLD_BASE || config.uriBase === NEW_BASE, `Unexpected Card URI base ${config.uriBase}`);
}

function compactPath(kind: MigrationKind, receipt: boolean): string {
  if (kind === 'box') return receipt ? 'rb' : 'b';
  return receipt ? 'rf' : 'f';
}

function exactUri(base: string, kind: MigrationKind, referenceId: number, receipt: boolean): string {
  return `${base}/${compactPath(kind, receipt)}${referenceId}.json`;
}

export function classifyUri(uri: string, sourceBase: string, targetBase: string, receipt: boolean): ClassifiedUri | null {
  for (const kind of ['box', 'card'] as const) {
    const maximum = kind === 'box' ? MAX_BOX_ID : MAX_CARD_ID;
    const prefix = compactPath(kind, receipt);
    for (const [status, base] of [['source', sourceBase], ['target', targetBase]] as const) {
      const match = uri.match(new RegExp(`^${escapeRegExp(base)}/${prefix}([1-9]\\d*)\\.json$`));
      if (!match) continue;
      const referenceId = Number(match[1]);
      if (!Number.isSafeInteger(referenceId) || referenceId > maximum) return null;
      return {
        status,
        kind,
        referenceId,
        sourceUri: exactUri(sourceBase, kind, referenceId, receipt),
        targetUri: exactUri(targetBase, kind, referenceId, receipt),
      };
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function expectedName(kind: MigrationKind, referenceId: number, receipt: boolean): string {
  const name = `${kind === 'box' ? 'pack' : 'card'} ${referenceId}`;
  return receipt ? `receipt · ${name}` : name;
}

export function inCollection(asset: Asset): boolean {
  return Array.isArray(asset.grouping) && asset.grouping.some(
    (group: any) => group?.group_key === 'collection' && group?.group_value === COLLECTION.toBase58(),
  );
}

export function authorityIncludes(asset: Asset, address = ADMIN): boolean {
  return Array.isArray(asset.authorities) && asset.authorities.some(
    (authority: any) => authority?.address === address.toBase58()
      && Array.isArray(authority.scopes)
      && authority.scopes.includes('full'),
  );
}

export async function searchAllCollectionAssets(
  rpcUrl: string,
  fetchPage: (page: number) => Promise<any> = async (page) => rpc<any>(rpcUrl, 'searchAssets', {
    grouping: ['collection', COLLECTION.toBase58()],
    page,
    limit: 1_000,
    options: { showUnverifiedCollections: true, showCollectionMetadata: true },
  }),
): Promise<{ assets: Asset[]; pages: number }> {
  const assets = new Map<string, Asset>();
  let pages = 0;
  for (let page = 1; ; page += 1) {
    const result = await fetchPage(page);
    const items = Array.isArray(result?.items) ? result.items as Asset[] : [];
    pages = page;
    for (const asset of items) {
      const id = String(asset?.id || '');
      if (!id) throw new Error(`Missing asset ID on DAS page ${page}`);
      const existing = assets.get(id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(asset)) {
        throw new Error(`Conflicting duplicate DAS asset ${id}`);
      }
      assets.set(id, asset);
    }
    if (items.length < 1_000) break;
    if (page >= 100) throw new Error('DAS pagination exceeded 100 pages');
  }
  return { assets: [...assets.values()], pages };
}

function u32(value: number): Buffer {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(value);
  return data;
}

function u64(value: number): Buffer {
  const data = Buffer.alloc(8);
  data.writeBigUInt64LE(BigInt(value));
  return data;
}

function string(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u32(bytes.length), bytes]);
}

function option(value?: Buffer | null): Buffer {
  return value ? Buffer.concat([Buffer.from([1]), value]) : Buffer.from([0]);
}

function bytes32(value: string, label: string): Buffer {
  const bytes = Buffer.from(bs58.decode(value));
  if (bytes.length !== 32) throw new Error(`${label} must decode to 32 bytes`);
  return bytes;
}

export function setUriBaseInstruction(target: string, signer = ADMIN): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([SET_URI_BASE_DISCRIMINATOR, string(target)]),
  });
}

export function updateCollectionInstruction(targetUri: string, signer = ADMIN): TransactionInstruction {
  return new TransactionInstruction({
    programId: MPL_CORE,
    keys: [
      { pubkey: COLLECTION, isSigner: false, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: false },
      { pubkey: MPL_CORE, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([16, 0, 1]), string(targetUri)]),
  });
}

export function updateCoreInstruction(asset: PublicKey, targetUri: string, signer = ADMIN): TransactionInstruction {
  return new TransactionInstruction({
    programId: MPL_CORE,
    keys: [
      { pubkey: asset, isSigner: false, isWritable: true },
      { pubkey: COLLECTION, isSigner: false, isWritable: false },
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([15, 0, 1]), string(targetUri), Buffer.from([0])]),
  });
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
  owner: string;
  updateAuthorityKind: number;
  updateAuthority: string | null;
  name: string;
  uri: string;
} {
  if (data[0] !== 1) throw new Error(`MPL Core asset discriminator is ${data[0]}, expected 1`);
  let offset = 1;
  const owner = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  offset += 32;
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
  return { owner, updateAuthorityKind, updateAuthority, name: name.value, uri: uri.value };
}

export function updateReceiptInstruction(asset: Asset, proof: any, targetUri: string): TransactionInstruction {
  const compression = asset?.compression || {};
  const tree = String(proof?.tree_id || proof?.treeId || compression?.tree || '');
  if (tree !== RECEIPTS_TREE.toBase58()) throw new Error(`Receipt tree mismatch: ${tree}`);
  const root = bytes32(String(proof?.root || ''), 'proof.root');
  const assetDataHashRaw = compression.asset_data_hash || compression.assetDataHash;
  const assetDataHash = assetDataHashRaw ? bytes32(String(assetDataHashRaw), 'asset data hash') : null;
  const flagsRaw = compression.flags;
  const flags = flagsRaw == null ? null : Number(flagsRaw);
  if (flags != null && (!Number.isInteger(flags) || flags < 0 || flags > 255)) throw new Error('Invalid receipt flags');
  const nonce = Number(compression.leaf_id ?? compression.leafId);
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Invalid receipt leaf ID');
  const index = Number(compression.leaf_index ?? compression.leafIndex ?? nonce);
  if (!Number.isInteger(index) || index < 0 || index > 0xffff_ffff) throw new Error('Invalid receipt leaf index');
  const owner = new PublicKey(String(asset?.ownership?.owner || ''));
  const delegate = new PublicKey(String(asset?.ownership?.delegate || asset?.ownership?.owner || ''));
  const proofAccounts = (Array.isArray(proof?.proof) ? proof.proof : []).map((address: string) => new PublicKey(address));
  if (proofAccounts.length !== MAX_RECEIPT_PROOF_ACCOUNTS) {
    throw new Error(`Receipt proof has ${proofAccounts.length} accounts, expected ${MAX_RECEIPT_PROOF_ACCOUNTS}`);
  }
  const metadata = asset.content?.metadata || {};
  const name = String(metadata.name || '');
  const symbol = String(metadata.symbol || '');
  const sellerFee = Number(asset.royalty?.basis_points);
  const fee = Buffer.alloc(2);
  fee.writeUInt16LE(sellerFee);
  const tokenStandard = Buffer.from([1, 0]);
  const creators = Array.isArray(asset.creators) ? asset.creators : [];
  const creatorBytes = creators.map((creator: any) => Buffer.concat([
    new PublicKey(String(creator.address)).toBuffer(),
    Buffer.from([creator.verified ? 1 : 0, Number(creator.share)]),
  ]));
  const currentMetadata = Buffer.concat([
    string(name),
    string(symbol),
    string(String(asset.content?.json_uri || '')),
    fee,
    Buffer.from([asset.royalty?.primary_sale_happened ? 1 : 0, asset.mutable ? 1 : 0]),
    tokenStandard,
    u32(creatorBytes.length),
    ...creatorBytes,
    Buffer.from([1]),
    COLLECTION.toBuffer(),
    Buffer.from([0, 0]),
  ]);
  const updateArgs = Buffer.concat([
    Buffer.from([0, 0, 1]),
    string(targetUri),
    Buffer.from([0, 0, 0, 0]),
  ]);
  return new TransactionInstruction({
    programId: BUBBLEGUM,
    keys: [
      { pubkey: RECEIPTS_TREE_CONFIG, isSigner: false, isWritable: true },
      { pubkey: ADMIN, isSigner: true, isWritable: true },
      { pubkey: ADMIN, isSigner: true, isWritable: false },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: delegate, isSigner: false, isWritable: false },
      { pubkey: RECEIPTS_TREE, isSigner: false, isWritable: true },
      { pubkey: COLLECTION, isSigner: false, isWritable: false },
      { pubkey: MPL_NOOP, isSigner: false, isWritable: false },
      { pubkey: ACCOUNT_COMPRESSION, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...proofAccounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    ],
    data: Buffer.concat([
      UPDATE_METADATA_V2_DISCRIMINATOR,
      root,
      option(assetDataHash),
      option(flags == null ? null : Buffer.from([flags])),
      u64(nonce),
      u32(index),
      currentMetadata,
      updateArgs,
    ]),
  });
}

export function classifyCollectionAsset(asset: Asset, sourceBase: string, targetBase: string): {
  coreTargets: CoreTarget[];
  receiptTargets: ReceiptTarget[];
  alreadyTarget: { core: number; receipts: number };
  burned: { core: number; receipts: number };
} {
  const coreTargets: CoreTarget[] = [];
  const receiptTargets: ReceiptTarget[] = [];
  const alreadyTarget = { core: 0, receipts: 0 };
  const burned = { core: 0, receipts: 0 };
  for (const item of Array.isArray(asset) ? asset : []) {
    if (!item.id || !inCollection(item)) throw new Error(`Invalid collection grouping for ${item.id || 'unknown'}`);
    const isReceipt = item.interface === 'MplBubblegumV2';
    const isCore = item.interface === 'MplCoreAsset';
    if (!isCore && !isReceipt) throw new Error(`Unexpected collection interface ${item.id}: ${item.interface}`);
    const classification = classifyUri(String(item.content?.json_uri || ''), sourceBase, targetBase, isReceipt);
    if (!classification) throw new Error(`Unexpected ${isReceipt ? 'receipt' : 'Core'} URI ${item.id}: ${item.content?.json_uri || ''}`);
    if (item.burnt) {
      burned[isReceipt ? 'receipts' : 'core'] += 1;
      continue;
    }
    const expectedAuthority = isReceipt ? RECEIPTS_TREE_CONFIG : ADMIN;
    if (!item.mutable || !authorityIncludes(item, expectedAuthority)) {
      throw new Error(`Asset authority or mutability mismatch: ${item.id}`);
    }
    assert.equal(item.content?.metadata?.name, expectedName(classification.kind, classification.referenceId, isReceipt));
    if (classification.status === 'target') {
      alreadyTarget[isReceipt ? 'receipts' : 'core'] += 1;
      continue;
    }
    const target = {
      address: String(item.id),
      kind: classification.kind,
      referenceId: classification.referenceId,
      sourceUri: classification.sourceUri,
      targetUri: classification.targetUri,
    };
    if (isReceipt) {
      const leafId = Number(item.compression?.leaf_id ?? item.compression?.leafId);
      if (!Number.isSafeInteger(leafId) || leafId < 0) throw new Error(`Invalid receipt leaf ID: ${item.id}`);
      if (item.compression?.tree !== RECEIPTS_TREE.toBase58()) throw new Error(`Receipt tree mismatch: ${item.id}`);
      if (item.content?.metadata?.symbol !== ''
        || item.royalty?.basis_points !== 0
        || item.royalty?.primary_sale_happened !== false
        || !Array.isArray(item.creators)
        || item.creators.length !== 0) {
        throw new Error(`Receipt metadata mismatch: ${item.id}`);
      }
      receiptTargets.push({ ...target, leafId });
    } else {
      coreTargets.push(target);
    }
  }
  coreTargets.sort((left, right) => left.address.localeCompare(right.address));
  receiptTargets.sort((left, right) => left.leafId - right.leafId);
  return { coreTargets, receiptTargets, alreadyTarget, burned };
}

export function batches<T>(items: T[], size = CORE_BATCH_SIZE): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error('Batch size must be positive');
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

export function planChecksum(value: unknown): string {
  return sha256(JSON.stringify(value));
}
