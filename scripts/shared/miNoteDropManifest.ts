import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type AccountInfo, type Connection, PublicKey, SolanaJSONRPCError } from '@solana/web3.js';
import {
  getPreorderConfig, preorderIdFromMetadataUri, type PreorderAsset, type PreorderConfig,
} from '../../shared/preorders.ts';
import { isBase58Bytes } from '../../shared/solanaRpcProxy.ts';
import { MPL_CORE_PROGRAM_ADDRESS } from '../../shared/solanaProgramAddresses.ts';
import { DEPLOYMENT_DROPS, type DeploymentRegistryDrop } from '../../shared/deploymentRegistry.ts';
import { normalizeDropBase } from '../../shared/deploymentCore.ts';
import { resolveDropMaxFigureId } from '../../shared/dropFigureIds.ts';
import { resolveClaimedPreorderAsset } from '../../shared/preorderAssetIdentity.ts';
import { decodePreorderAssetAccount } from '../../cloud/workers/api/src/preorderTransaction.ts';
import { queryRemoteCommerceD1, sqlString, type CommerceAuthorityQuery } from './commerceD1Maintenance.ts';
import { createScriptSolanaConnection } from './solanaRpcEnvironment.ts';

const MI_NOTE_PUBLIC_METADATA_BASES = {
  devnet: 'https://cdn.lil.org/nft/mi_note_cards/json/pre',
  'mainnet-beta': 'https://cdn.lil.org/nft/mi_note_cards/json',
} as const;
const MI_NOTE_CATALOG_PATH = fileURLToPath(new URL('../../mi_note_cards.json', import.meta.url));
export const MI_NOTE_CLUSTER_GENESIS = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
} as const;

type SnapshotOrder = {
  orderId: string;
  preorderId: string;
  cluster: string;
  collection: string;
  status: string;
  revision: number;
  cardIds: number[];
  assets: PreorderAsset[];
};

type SnapshotClaim = { id: number; orderId: string; cluster: string; collection: string };

export type MiNotePreorderSnapshot = {
  orders: SnapshotOrder[];
  claims: SnapshotClaim[];
};

export type MiNotePreorderChainSnapshot = {
  genesisHash: string;
  slot: number;
  assets: (PreorderAsset & { name: string; collection: string; uri: string })[];
  burnedAssets?: PreorderAsset[];
};

export type MiNoteDropManifest = Readonly<{
  version: 1;
  dropFamily: 'mi_note_cards';
  sourcePreorder: { preorderId: string; cluster: 'devnet' | 'mainnet-beta'; collection: string };
  metadataBase: string;
  itemsPerPack: 2;
  packCount: number;
  maxFigureId: number;
  catalogSha256: string;
  preorderSnapshotSha256: string;
  excludedCardIds: number[];
  eligibleCardIds: number[];
  verifiedAt: string;
  chain: { commitment: 'finalized'; genesisHash: string; slot: number; assetCount: number };
  sha256: string;
}>;

type ManifestDependencies = {
  query: CommerceAuthorityQuery;
  catalogText: () => string;
  chain: (config: PreorderConfig, expectedAssets: readonly PreorderAsset[], options: { requireCompleteMembership: boolean }) => Promise<MiNotePreorderChainSnapshot>;
  now: () => Date;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function sameIds(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function miNoteManifestDigest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

export function miNoteCatalogIds(text: string): { all: number[]; preorder: Set<number> } {
  const catalog: unknown = JSON.parse(text);
  if (!object(catalog) || !Array.isArray(catalog.ethereumCollections) || !Array.isArray(catalog.specialCards)) {
    throw new Error('Invalid Mi Note card catalog.');
  }
  const all = new Set<number>();
  const preorder = new Set<number>();
  const add = (card: unknown, eligible: boolean) => {
    if (!object(card) || !positiveInteger(card.clean_card_id) || card.clean_card_id > 0xffff ||
      typeof card.name !== 'string' || !card.name.trim() || all.has(card.clean_card_id)) {
      throw new Error('Catalog card IDs must be unique positive u16 integers with artwork names.');
    }
    all.add(card.clean_card_id);
    if (eligible) preorder.add(card.clean_card_id);
  };
  for (const collection of catalog.ethereumCollections) {
    if (!object(collection) || !Array.isArray(collection.tokens)) throw new Error('Invalid catalog collection.');
    for (const card of collection.tokens) add(card, true);
  }
  for (const card of catalog.specialCards) add(card, false);
  if (!all.size || !preorder.size) throw new Error('Mi Note catalog is empty.');
  return { all: [...all].sort((left, right) => left - right), preorder };
}

export function closedMiNotePreorderConfig(preorderId: string): PreorderConfig {
  const config = getPreorderConfig(preorderId);
  if (!config || !config.enabled || config.checkoutEnabled ||
    !Object.hasOwn(MI_NOTE_CLUSTER_GENESIS, config.cluster)) {
    throw new Error('Mi Note inventory preparation requires an enabled preorder collection with checkout closed.');
  }
  return config;
}

export async function readMiNotePreorderSnapshot(
  query: CommerceAuthorityQuery, config: PreorderConfig,
): Promise<MiNotePreorderSnapshot> {
  const scope = `cluster = ${sqlString(config.cluster)} AND collection = ${sqlString(config.collection)}`;
  const rows = await query(`SELECT json_object(
    'orders', json((SELECT COALESCE(json_group_array(json_object(
      'orderId', order_id, 'preorderId', preorder_id, 'cluster', cluster, 'collection', collection,
      'status', status, 'revision', revision, 'cardIds', json(card_ids_json), 'assets', json(assets_json)
    )), '[]') FROM (SELECT order_id, preorder_id, cluster, collection, status, revision, card_ids_json, assets_json
      FROM commerce_preorder_orders WHERE ${scope} ORDER BY order_id))),
    'claims', json((SELECT COALESCE(json_group_array(json_object(
      'id', card_id, 'orderId', order_id, 'cluster', cluster, 'collection', collection
    )), '[]') FROM (SELECT card_id, order_id, cluster, collection FROM commerce_preorder_claims
      WHERE ${scope} ORDER BY card_id)))
  ) AS snapshot_json`);
  if (rows.length !== 1 || typeof rows[0].snapshot_json !== 'string') throw new Error('Invalid preorder snapshot response.');
  const snapshot: unknown = JSON.parse(rows[0].snapshot_json);
  if (!object(snapshot) || !Array.isArray(snapshot.orders) || !Array.isArray(snapshot.claims)) {
    throw new Error('Invalid preorder snapshot.');
  }
  return snapshot as MiNotePreorderSnapshot;
}

export function validateMiNotePreorderSnapshot(
  snapshot: MiNotePreorderSnapshot, config: PreorderConfig, preorderCardIds: ReadonlySet<number>,
): { excludedIds: number[]; assets: PreorderAsset[] } {
  const orders = new Map<string, SnapshotOrder>();
  const sold = new Map<number, { orderId: string; address: string }>();
  const assetAddresses = new Set<string>();
  for (const order of snapshot.orders) {
    if (!object(order) || typeof order.orderId !== 'string' || !order.orderId || orders.has(order.orderId) ||
      order.preorderId !== config.preorderId || order.cluster !== config.cluster || order.collection !== config.collection ||
      !positiveInteger(order.revision) || !['prepared', 'submitted', 'succeeded', 'failed', 'expired', 'cancelled'].includes(order.status) ||
      !Array.isArray(order.cardIds) || !order.cardIds.length || order.cardIds.length > config.maxItems ||
      order.cardIds.some((id) => !preorderCardIds.has(id)) || new Set(order.cardIds).size !== order.cardIds.length ||
      !Array.isArray(order.assets) || order.assets.length !== order.cardIds.length ||
      order.assets.some((asset) => !object(asset) || !order.cardIds.includes(asset.id) || !isBase58Bytes(asset.address, 32)) ||
      new Set(order.assets.map((asset) => asset.id)).size !== order.cardIds.length) {
      throw new Error('Preorder order identity or card/asset mapping is invalid.');
    }
    if (order.status === 'prepared' || order.status === 'submitted') {
      throw new Error('Preorder preparation or submission is unresolved. Reconcile it before preparing public inventory.');
    }
    orders.set(order.orderId, order);
    if (order.status !== 'succeeded') continue;
    for (const asset of order.assets) {
      if (sold.has(asset.id) || assetAddresses.has(asset.address)) throw new Error('Succeeded preorders contain duplicate cards or assets.');
      sold.set(asset.id, { orderId: order.orderId, address: asset.address });
      assetAddresses.add(asset.address);
    }
  }
  const claims = new Set<number>();
  for (const claim of snapshot.claims) {
    if (!object(claim) || !positiveInteger(claim.id) || claims.has(claim.id) ||
      claim.cluster !== config.cluster || claim.collection !== config.collection ||
      sold.get(claim.id)?.orderId !== claim.orderId || orders.get(claim.orderId)?.status !== 'succeeded') {
      throw new Error('Preorder claims differ from the succeeded orders in this collection and cluster.');
    }
    claims.add(claim.id);
  }
  if (claims.size !== sold.size) throw new Error('Succeeded preorder cards are missing permanent claims.');
  const excludedIds = [...sold.keys()].sort((left, right) => left - right);
  return { excludedIds, assets: excludedIds.map((id) => ({ id, address: sold.get(id)!.address })) };
}

export function miNoteReadOnlyConnection(cluster: 'devnet' | 'mainnet-beta', explicitUrl = process.env.MI_NOTE_PREORDER_RPC_URL): Connection {
  return createScriptSolanaConnection({ cluster, explicitUrl });
}

export function miNotePreorderAssetsFromCollection(
  config: PreorderConfig,
  assets: readonly { address: string; name: string; collection: string; uri: string }[],
  publicDrops: readonly DeploymentRegistryDrop[] = Object.values(DEPLOYMENT_DROPS),
  knownClaims: readonly PreorderAsset[] = [],
): MiNotePreorderChainSnapshot['assets'] {
  const matchingDrops = publicDrops.filter((drop) => drop.dropFamily === 'mi_note_cards' &&
    drop.solanaCluster === config.cluster && drop.collectionMint === config.collection);
  const claimsByAddress = new Map(knownClaims.map((claim) => [claim.address, claim]));
  const isRegularAsset = (uri: string) => matchingDrops.some((drop) =>
    [drop.metadataBase, ...(drop.metadataBaseAliases ?? [])].some((base) => {
      const prefix = `${normalizeDropBase(base)}/`;
      if (!uri.startsWith(prefix)) return false;
      const match = /^(b|f)([1-9]\d*)\.json$/.exec(uri.slice(prefix.length));
      if (!match) return false;
      const id = Number(match[2]);
      return Number.isSafeInteger(id) && id <= (match[1] === 'b' ? drop.maxSupply : resolveDropMaxFigureId(drop));
    }));
  return assets.flatMap((asset) => {
    if (asset.collection !== config.collection) throw new Error('Preorder collection scan returned another collection.');
    const claim = claimsByAddress.get(asset.address);
    if (claim && matchingDrops.some((publicDrop) => resolveClaimedPreorderAsset({ config, cluster: config.cluster,
      claim, actual: asset, publicDrop })?.kind === 'dude')) return [{ ...asset, id: claim.id }];
    const id = preorderIdFromMetadataUri(config, asset.uri);
    if (id !== null && asset.name === `Preorder #${id}`) return [{ ...asset, id }];
    if (id === null && isRegularAsset(asset.uri)) return [];
    throw new Error('The preorder collection contains an unexpected or malformed asset.');
  });
}

function collectionCoverage(account: AccountInfo<Buffer> | null, config: PreorderConfig) {
  if (!account || account.executable || account.owner.toBase58() !== MPL_CORE_PROGRAM_ADDRESS ||
    account.data.length < 49 || account.data[0] !== 5 ||
    new PublicKey(account.data.subarray(1, 33)).toBase58() !== config.authority) {
    throw new Error('Invalid finalized Mi Note collection account.');
  }
  let offset = 33;
  for (let index = 0; index < 2; index += 1) {
    if (offset + 4 > account.data.length) throw new Error('Truncated Mi Note collection metadata.');
    const length = account.data.readUInt32LE(offset);
    offset += 4;
    if (length > 2048 || offset + length > account.data.length) throw new Error('Invalid Mi Note collection metadata length.');
    new TextDecoder('utf-8', { fatal: true }).decode(account.data.subarray(offset, offset + length));
    offset += length;
  }
  if (offset + 8 > account.data.length) throw new Error('Missing Mi Note collection size counters.');
  return { identity: account.data.subarray(0, offset).toString('hex'),
    fingerprint: account.data.subarray(0, offset + 8).toString('hex'), size: account.data.readUInt32LE(offset + 4) };
}

async function finalizedRead<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await read(); } catch (error) {
      if (!(error instanceof SolanaJSONRPCError) || error.code !== -32016 || attempt >= 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}

export async function readMiNotePreorderChain(
  config: PreorderConfig, expectedAssets: readonly PreorderAsset[],
  connection: Pick<Connection, 'getGenesisHash' | 'getProgramAccounts' | 'getMultipleAccountsInfoAndContext'> =
    miNoteReadOnlyConnection(config.cluster as 'devnet' | 'mainnet-beta'),
  options: { requireCompleteMembership?: boolean } = {},
): Promise<MiNotePreorderChainSnapshot> {
  if (config.cluster !== 'devnet' && config.cluster !== 'mainnet-beta') throw new Error('Unsupported preorder cluster.');
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash !== MI_NOTE_CLUSTER_GENESIS[config.cluster]) throw new Error('Preorder RPC cluster does not match the manifest source.');
  const collectionKey = new PublicKey(config.collection);
  const before = await connection.getMultipleAccountsInfoAndContext([collectionKey], { commitment: 'finalized' });
  if (before.value.length !== 1 || !Number.isSafeInteger(before.context.slot) || before.context.slot < 0) {
    throw new Error('Invalid finalized collection response.');
  }
  const coverage = collectionCoverage(before.value[0], config);
  const result = await finalizedRead(() => connection.getProgramAccounts(new PublicKey(MPL_CORE_PROGRAM_ADDRESS), {
    commitment: 'finalized', withContext: true, minContextSlot: before.context.slot,
    filters: [{ memcmp: { offset: 0, bytes: '2' } }, { memcmp: { offset: 34, bytes: config.collection } }],
  }));
  if (!Number.isSafeInteger(result.context.slot) || result.context.slot < before.context.slot) {
    throw new Error('Collection scan returned stale finalized state.');
  }
  const scanned = result.value.map(({ pubkey, account }) => {
    const decoded = decodePreorderAssetAccount(account.data);
    if (!decoded || account.executable || account.owner.toBase58() !== MPL_CORE_PROGRAM_ADDRESS) {
      throw new Error('The collection scan contains an invalid Core asset.');
    }
    return { address: pubkey.toBase58(), name: decoded.name, collection: decoded.collection, uri: decoded.uri };
  });
  const complete = options.requireCompleteMembership !== false;
  const known = new Map(expectedAssets.map((asset) => [asset.id, asset.address]));
  const convertedClaims = complete ? [] : expectedAssets;
  if (miNotePreorderAssetsFromCollection(config, scanned, undefined, convertedClaims).some((asset) => known.get(asset.id) !== asset.address)) {
    throw new Error('The collection scan contains an unaccounted preorder identity.');
  }
  const addresses = [...new Set([...expectedAssets.map((asset) => asset.address), ...(complete ? scanned.map((asset) => asset.address) : [])])];
  if (complete && addresses.length !== coverage.size) {
    throw new Error('Finalized collection coverage is incomplete or includes unaccounted assets.');
  }
  const verified: { address: string; name: string; collection: string; uri: string }[] = [];
  const claimedByAddress = new Map(expectedAssets.map(asset => [asset.address, asset]));
  const burnedAssets: PreorderAsset[] = [];
  let slot = result.context.slot;
  for (let offset = 0; offset < Math.max(1, addresses.length); offset += 99) {
    const batch = addresses.slice(offset, offset + 99);
    const direct = await finalizedRead(() => connection.getMultipleAccountsInfoAndContext([collectionKey, ...batch.map((address) => new PublicKey(address))], {
      commitment: 'finalized', minContextSlot: slot,
    }));
    if (!Number.isSafeInteger(direct.context.slot) || direct.context.slot < slot || direct.value.length !== batch.length + 1) {
      throw new Error('Known preorder account verification returned stale or incomplete data.');
    }
    slot = direct.context.slot;
    const currentCollection = collectionCoverage(direct.value[0], config);
    if (complete ? currentCollection.fingerprint !== coverage.fingerprint : currentCollection.identity !== coverage.identity) {
      throw new Error('The Mi Note collection changed during finalized coverage verification.');
    }
    for (const [index, address] of batch.entries()) {
      const account = direct.value[index + 1];
      const claim = claimedByAddress.get(address);
      if (!complete && claim && account && !account.executable && account.owner.toBase58() === MPL_CORE_PROGRAM_ADDRESS &&
        account.data.length === 1 && account.data[0] === 0) {
        burnedAssets.push(claim);
        continue;
      }
      const decoded = account && decodePreorderAssetAccount(account.data);
      if (!account || !decoded || account.executable || account.owner.toBase58() !== MPL_CORE_PROGRAM_ADDRESS) {
        throw new Error('A recorded or scanned Mi Note asset is missing or is not a valid Core asset.');
      }
      verified.push({ address, name: decoded.name, collection: decoded.collection, uri: decoded.uri });
    }
  }
  const preorders = miNotePreorderAssetsFromCollection(config, verified, undefined, convertedClaims);
  const covered = [...preorders, ...burnedAssets];
  const byAddress = new Map(covered.map((asset) => [asset.address, asset]));
  if (covered.length !== expectedAssets.length || expectedAssets.some((asset) => byAddress.get(asset.address)?.id !== asset.id)) {
    throw new Error('Direct finalized preorder identities differ from the succeeded asset records.');
  }
  return { genesisHash, slot, assets: preorders, ...(burnedAssets.length ? { burnedAssets } : {}) };
}

function validateChainSnapshot(
  chain: MiNotePreorderChainSnapshot, config: PreorderConfig, expected: readonly PreorderAsset[],
  allowConverted: boolean,
): void {
  if (chain.genesisHash !== MI_NOTE_CLUSTER_GENESIS[config.cluster as keyof typeof MI_NOTE_CLUSTER_GENESIS] ||
    !Number.isSafeInteger(chain.slot) || chain.slot < 0 || chain.assets.length + (chain.burnedAssets?.length ?? 0) !== expected.length ||
    !allowConverted && Boolean(chain.burnedAssets?.length)) {
    throw new Error('Finalized preorder collection does not match the permanent claims.');
  }
  const actual = [...chain.assets, ...(chain.burnedAssets ?? [])].sort((left, right) => left.id - right.id);
  if (actual.some((asset, index) => asset.id !== expected[index].id || asset.address !== expected[index].address) ||
    chain.assets.some(asset => !resolveClaimedPreorderAsset({ config, cluster: config.cluster, claim: asset, actual: asset,
      publicDrop: allowConverted ? DEPLOYMENT_DROPS[config.preorderId] : undefined }))) {
    throw new Error('Finalized preorder card IDs or asset addresses differ from the permanent claims.');
  }
}

const defaults: ManifestDependencies = {
  query: queryRemoteCommerceD1,
  catalogText: () => readFileSync(MI_NOTE_CATALOG_PATH, 'utf8'),
  chain: (config, assets, options) => readMiNotePreorderChain(config, assets, undefined, options),
  now: () => new Date(),
};

async function verifiedMiNoteManifest(
  preorderId: string, overrides: Partial<ManifestDependencies>, requireCompleteMembership: boolean,
): Promise<MiNoteDropManifest> {
  const dependencies = { ...defaults, ...overrides };
  const config = closedMiNotePreorderConfig(preorderId);
  const catalogText = dependencies.catalogText();
  const catalog = miNoteCatalogIds(catalogText);
  const snapshot = await readMiNotePreorderSnapshot(dependencies.query, config);
  const { excludedIds, assets } = validateMiNotePreorderSnapshot(snapshot, config, catalog.preorder);
  const chain = await dependencies.chain(config, assets, { requireCompleteMembership });
  validateChainSnapshot(chain, config, assets, !requireCompleteMembership);
  const fresh = await readMiNotePreorderSnapshot(dependencies.query, config);
  if (miNoteManifestDigest(fresh) !== miNoteManifestDigest(snapshot)) {
    throw new Error('Preorder state changed during chain verification. Prepare a fresh snapshot.');
  }
  const excluded = new Set(excludedIds);
  const eligibleCardIds = catalog.all.filter((id) => !excluded.has(id));
  if (!eligibleCardIds.length || eligibleCardIds.length % 2) {
    throw new Error('Available cards must fill an exact positive number of two-card packs; no card is silently omitted.');
  }
  const content: Omit<MiNoteDropManifest, 'sha256'> = {
    version: 1, dropFamily: 'mi_note_cards',
    sourcePreorder: { preorderId: config.preorderId, cluster: config.cluster as 'devnet' | 'mainnet-beta', collection: config.collection },
    metadataBase: MI_NOTE_PUBLIC_METADATA_BASES[config.cluster as keyof typeof MI_NOTE_PUBLIC_METADATA_BASES], itemsPerPack: 2,
    packCount: eligibleCardIds.length / 2, maxFigureId: catalog.all.at(-1)!,
    catalogSha256: miNoteManifestDigest(catalogText), preorderSnapshotSha256: miNoteManifestDigest(snapshot),
    excludedCardIds: excludedIds, eligibleCardIds, verifiedAt: dependencies.now().toISOString(),
    chain: { commitment: 'finalized', genesisHash: chain.genesisHash, slot: chain.slot, assetCount: chain.assets.length + (chain.burnedAssets?.length ?? 0) },
  };
  return { ...content, sha256: miNoteManifestDigest(content) };
}

export function prepareMiNoteDropManifest(
  preorderId: string, overrides: Partial<ManifestDependencies> = {},
): Promise<MiNoteDropManifest> {
  return verifiedMiNoteManifest(preorderId, overrides, true);
}

export function parseMiNoteDropManifest(value: unknown): MiNoteDropManifest {
  if (!object(value)) throw new Error('Invalid Mi Note inventory manifest.');
  const { sha256, ...content } = value;
  const keys = ['version', 'dropFamily', 'sourcePreorder', 'metadataBase', 'itemsPerPack', 'packCount', 'maxFigureId',
    'catalogSha256', 'preorderSnapshotSha256', 'excludedCardIds', 'eligibleCardIds', 'verifiedAt', 'chain', 'sha256'];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
    typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256) || miNoteManifestDigest(content) !== sha256 ||
    value.version !== 1 || value.dropFamily !== 'mi_note_cards' ||
    value.itemsPerPack !== 2 || !positiveInteger(value.packCount) || !positiveInteger(value.maxFigureId) || value.maxFigureId > 0xffff ||
    !object(value.sourcePreorder) || typeof value.sourcePreorder.preorderId !== 'string' ||
    !object(value.chain) || value.chain.commitment !== 'finalized' || !Number.isSafeInteger(value.chain.slot) || Number(value.chain.slot) < 0 ||
    typeof value.verifiedAt !== 'string' || !Number.isFinite(Date.parse(value.verifiedAt)) ||
    !['catalogSha256', 'preorderSnapshotSha256'].every((key) => typeof value[key] === 'string' && /^[0-9a-f]{64}$/.test(value[key])) ||
    !Array.isArray(value.excludedCardIds) || !Array.isArray(value.eligibleCardIds)) {
    throw new Error('Invalid or modified Mi Note inventory manifest.');
  }
  const config = closedMiNotePreorderConfig(value.sourcePreorder.preorderId);
  const excluded = value.excludedCardIds as number[];
  const eligible = value.eligibleCardIds as number[];
  const ids = [...excluded, ...eligible];
  if (value.sourcePreorder.cluster !== config.cluster || value.sourcePreorder.collection !== config.collection ||
    value.metadataBase !== MI_NOTE_PUBLIC_METADATA_BASES[config.cluster as keyof typeof MI_NOTE_PUBLIC_METADATA_BASES] ||
    value.chain.genesisHash !== MI_NOTE_CLUSTER_GENESIS[config.cluster as keyof typeof MI_NOTE_CLUSTER_GENESIS] ||
    value.chain.assetCount !== excluded.length || eligible.length !== value.packCount * 2 ||
    ids.some((id) => !positiveInteger(id) || id > Number(value.maxFigureId)) || new Set(ids).size !== ids.length ||
    [excluded, eligible].some((group) => group.some((id, index) => index > 0 && id <= group[index - 1]))) {
    throw new Error('Mi Note manifest source, inventory, or cardinality is invalid.');
  }
  return value as MiNoteDropManifest;
}

export async function verifyMiNoteDropManifest(
  manifest: MiNoteDropManifest, overrides: Partial<ManifestDependencies> = {},
): Promise<MiNoteDropManifest> {
  const parsed = parseMiNoteDropManifest(manifest);
  const registered = Object.values(DEPLOYMENT_DROPS).some((drop) => drop.dropId === parsed.sourcePreorder.preorderId &&
    drop.dropFamily === 'mi_note_cards' && drop.solanaCluster === parsed.sourcePreorder.cluster &&
    drop.collectionMint === parsed.sourcePreorder.collection && normalizeDropBase(drop.metadataBase) === parsed.metadataBase &&
    drop.maxSupply === parsed.packCount && drop.itemsPerBox === parsed.itemsPerPack &&
    drop.inventoryManifest?.sha256 === parsed.sha256 && sameIds(drop.inventoryManifest.cardIds, parsed.eligibleCardIds));
  const current = await verifiedMiNoteManifest(parsed.sourcePreorder.preorderId, overrides, !registered);
  if (current.catalogSha256 !== parsed.catalogSha256 || current.preorderSnapshotSha256 !== parsed.preorderSnapshotSha256 ||
    current.packCount !== parsed.packCount || current.maxFigureId !== parsed.maxFigureId ||
    !sameIds(current.excludedCardIds, parsed.excludedCardIds) || !sameIds(current.eligibleCardIds, parsed.eligibleCardIds)) {
    throw new Error('Mi Note inventory manifest is stale. Prepare and review a new snapshot before initialization.');
  }
  return current;
}
