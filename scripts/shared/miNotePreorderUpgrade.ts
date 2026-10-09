import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
  type AccountInfo,
} from '@solana/web3.js';
import type { DeploymentRegistryDrop } from '../../shared/deploymentRegistry.ts';
import { resolveDropMaxFigureId } from '../../shared/dropFigureIds.ts';
import { preorderCardMetadata, resolveClaimedPreorderAsset } from '../../shared/preorderAssetIdentity.ts';
import { preorderMetadataUri, type PreorderConfig } from '../../shared/preorders.ts';
import { MPL_CORE_PROGRAM_ADDRESS, SPL_NOOP_PROGRAM_ADDRESS } from '../../shared/solanaProgramAddresses.ts';
import { decodePreorderAssetAccount } from '../../cloud/workers/api/src/preorderTransaction.ts';
import { decodeMplCoreCollectionBase } from '../deploy-all-onchain.ts';
import { readDeploymentDropRegistry } from './deploymentRegistry.ts';
import { loadPreorderCollectionConfig, type PreparedPreorderCollectionConfig } from './preorderCollectionConfig.ts';
import {
  closedMiNotePreorderConfig, MI_NOTE_CLUSTER_GENESIS, miNoteCatalogIds, miNoteManifestDigest, parseMiNoteDropManifest,
  readMiNotePreorderSnapshot, validateMiNotePreorderSnapshot, type MiNoteDropManifest, type MiNotePreorderSnapshot,
} from './miNoteDropManifest.ts';
import { resolveMiNoteCollectionDelegates } from './miNoteMintResources.ts';
import { parseCommerceD1DocumentRow, queryRemoteCommerceD1, sqlString } from './commerceD1Maintenance.ts';
import { requireInventoryConfig, validateInventoryOwnership, validateManifestInventory } from './dudeInventoryMaintenance.ts';

export const PREORDER_UPGRADE_BATCH_SIZE = 4;
export class MiNoteUpgradeRetryableError extends Error {}
const PREORDER_UPGRADE_COMPUTE_UNITS = 100_000;
export type UpgradeAsset = { id: number; address: string; original: { name: string; uri: string }; target: { name: string; uri: string } };
export type MiNoteUpgradeSource = {
  config: PreorderConfig;
  drop: DeploymentRegistryDrop;
  inventory: MiNoteDropManifest;
  collectionConfig: PreparedPreorderCollectionConfig;
  approvedCollectionDelegates: string[];
  inventoryPath: string;
  deploymentSha256: string;
  targetMetadataSha256: string;
  inventoryGeneration: string;
  available: number;
  assigned: number;
  assets: UpgradeAsset[];
};

export type MiNotePreorderUpgradeManifest = {
  version: 1;
  preorderId: string;
  cluster: 'devnet' | 'mainnet-beta';
  genesisHash: string;
  authority: string;
  collection: string;
  coreProgram: typeof MPL_CORE_PROGRAM_ADDRESS;
  mintConfig: string;
  operationsConfig: string;
  batchSize: 4;
  preparedAt: string;
  sourceSlot: number;
  source: {
    inventoryPath: string;
    inventorySha256: string;
    preorderSnapshotSha256: string;
    catalogSha256: string;
    dropSha256: string;
    deploymentSha256: string;
    targetMetadataSha256: string;
    collectionConfigSha256: string;
    inventoryGeneration: string;
    programsSha256: string;
  };
  assets: UpgradeAsset[];
  sha256: string;
};

export type MiNoteUpgradeAttempt = {
  cardIds: number[];
  before: { id: number; protectedSha256: string; sequence: string | null }[];
  collectionSha256: string;
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  transactionBase64: string;
  signedAt: string;
  status: 'signed' | 'finalized' | 'failed' | 'expired' | 'state-verified';
  finalizedSlot?: number;
  preservationVerifiedAtSlot?: number;
};

export type MiNoteUpgradeJournal = {
  version: 1;
  manifestSha256: string;
  preorderId: string;
  cluster: 'devnet' | 'mainnet-beta';
  collection: string;
  authority: string;
  createdAt: string;
  status: 'prepared' | 'running' | 'complete';
  lastVerifiedSlot: number;
  attempts: MiNoteUpgradeAttempt[];
};

function frozenMiNoteInventoryPath(preorderId: string): string {
  return `releases/${preorderId.replaceAll('_', '-')}/inventory.json`;
}

export async function validateMiNoteUpgradeSource(args: {
  config: PreorderConfig; drop: DeploymentRegistryDrop; inventory: MiNoteDropManifest;
  collectionConfig: PreparedPreorderCollectionConfig; catalogText: string; snapshot: MiNotePreorderSnapshot;
  deployment: unknown; inventoryGeneration: string; available: number; assigned: number;
  targetMetadataSha256: string;
}): Promise<MiNoteUpgradeSource> {
  const { config, drop, collectionConfig } = args;
  const inventory = parseMiNoteDropManifest(args.inventory);
  const catalog = miNoteCatalogIds(args.catalogText);
  const claims = validateMiNotePreorderSnapshot(args.snapshot, config, catalog.preorder);
  if (!drop || drop.dropId !== config.preorderId || drop.dropFamily !== 'mi_note_cards' ||
    drop.solanaCluster !== config.cluster || drop.collectionMint !== config.collection || !drop.operationsConfig ||
    !drop.boxMinterConfigPda || drop.itemsPerBox !== 2 || drop.maxSupply !== inventory.packCount ||
    resolveDropMaxFigureId(drop) !== inventory.maxFigureId || drop.metadataBase !== inventory.metadataBase ||
    inventory.sourcePreorder.preorderId !== config.preorderId || inventory.sourcePreorder.cluster !== config.cluster ||
    inventory.sourcePreorder.collection !== config.collection || collectionConfig.authority !== config.authority ||
    collectionConfig.collectionId !== config.preorderId || collectionConfig.solanaCluster !== config.cluster ||
    inventory.catalogSha256 !== miNoteManifestDigest(args.catalogText) ||
    inventory.preorderSnapshotSha256 !== miNoteManifestDigest(args.snapshot) ||
    !isDeepStrictEqual(claims.excludedIds, inventory.excludedCardIds) ||
    !isDeepStrictEqual(catalog.all.filter(id => !claims.excludedIds.includes(id)), inventory.eligibleCardIds) ||
    !isDeepStrictEqual(drop.inventoryManifest, { sha256: inventory.sha256, cardIds: inventory.eligibleCardIds }) ||
    !/^[0-9a-f-]{36}$/i.test(args.inventoryGeneration) || !/^[0-9a-f]{64}$/.test(args.targetMetadataSha256) || !Number.isSafeInteger(args.available) || args.available < 0 ||
    !Number.isSafeInteger(args.assigned) || args.assigned < 0 || args.available + args.assigned !== inventory.eligibleCardIds.length) {
    throw new Error('Preorder upgrade source differs from the deployed drop, permanent claims, or frozen inventory.');
  }
  const assets = claims.assets.map(asset => {
    const target = preorderCardMetadata({ config, publicDrop: drop, id: asset.id });
    if (!target) throw new Error('A claimed card is not excluded from the matching public drop.');
    return { ...asset, original: { name: `Preorder #${asset.id}`, uri: preorderMetadataUri(config, asset.id) }, target };
  });
  if (!assets.length) throw new Error('No succeeded preorder assets to upgrade.');
  return { config, drop, inventory, collectionConfig, assets,
    approvedCollectionDelegates: await resolveMiNoteCollectionDelegates(args.deployment, drop, config.authority),
    inventoryPath: frozenMiNoteInventoryPath(config.preorderId), deploymentSha256: miNoteManifestDigest(args.deployment),
    targetMetadataSha256: args.targetMetadataSha256,
    inventoryGeneration: args.inventoryGeneration, available: args.available, assigned: args.assigned };
}

export function validateMiNoteUpgradeTargetMetadata(text: string, id: number, artworkName: string, cluster: PreorderConfig['cluster']): string {
  const metadata = JSON.parse(text);
  const cleanImage = `https://cdn.lil.org/nft/mi_note_cards/clean/${id}.png`;
  const mainnet = cluster === 'mainnet-beta';
  const image = mainnet ? `https://cdn.lil.org/nft/mi_note_cards/square/${id}.jpg` : cleanImage;
  const files = metadata?.properties?.files;
  const attribute = (type: string, value: unknown) => Array.isArray(metadata?.attributes) &&
    metadata.attributes.filter((entry: { trait_type?: unknown }) => entry?.trait_type === type).length === 1 &&
    metadata.attributes.some((entry: { trait_type?: unknown; value?: unknown }) => entry?.trait_type === type && entry.value === value);
  if (!['devnet', 'mainnet-beta'].includes(cluster) ||
    metadata?.id !== id || metadata.name !== `Card #${id}` || metadata.image !== image || metadata.external_url !== 'https://mons.shop' ||
    !attribute('type', 'card') || !attribute('redeemed', false) || !attribute('name', artworkName) ||
    !Array.isArray(files) || files[0]?.uri !== image || files[0]?.type !== (mainnet ? 'image/jpeg' : 'image/png') ||
    mainnet && !files.some(file => file?.uri === cleanImage && file.type === 'image/png')) {
    throw new Error(`Target card JSON does not match source card ${id}.`);
  }
  return miNoteManifestDigest(text);
}

async function readTargetMetadataHashes(config: PreorderConfig, drop: DeploymentRegistryDrop, ids: number[], catalogText: string): Promise<string> {
  const catalog = JSON.parse(catalogText);
  const cards = new Map<number, string>([...catalog.ethereumCollections.flatMap((collection: { tokens: unknown[] }) => collection.tokens),
    ...catalog.specialCards].map((card: { clean_card_id: number; name: string }) => [card.clean_card_id, card.name]));
  const hashes: { id: number; uri: string; sha256: string }[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      const target = preorderCardMetadata({ config, publicDrop: drop, id });
      if (!target) throw new Error(`No canonical target metadata for card ${id}.`);
      const response = await fetch(target.uri, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        throw new MiNoteUpgradeRetryableError(`Target card JSON is temporarily unavailable for card ${id} (HTTP ${response.status}).`);
      }
      if (!response.ok || !response.body) throw new Error(`Target card JSON is unavailable for card ${id}.`);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 65_536) throw new Error(`Target card JSON is too large for card ${id}.`);
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      hashes.push({ id, uri: target.uri, sha256: validateMiNoteUpgradeTargetMetadata(text, id, cards.get(id)!, config.cluster) });
    }
  }));
  return miNoteManifestDigest(hashes.sort((left, right) => left.id - right.id));
}

export async function loadMiNoteUpgradeSource(root: string, preorderId: string): Promise<MiNoteUpgradeSource> {
  const config = closedMiNotePreorderConfig(preorderId);
  const registry = await readDeploymentDropRegistry(path.join(root, 'shared/deploymentRegistry.ts'));
  const drop = registry.drops[preorderId];
  if (!drop?.operationsConfig || !drop.inventoryManifest) throw new Error('Deploy and register the matching public two-config drop before upgrading preorders.');
  const inventory = parseMiNoteDropManifest(JSON.parse(readFileSync(path.join(root, frozenMiNoteInventoryPath(preorderId)), 'utf8')));
  const deployment = JSON.parse(readFileSync(path.join(root, 'releases', preorderId.replaceAll('_', '-'), 'deployment.json'), 'utf8'));
  const { config: collectionConfig } = await loadPreorderCollectionConfig({ root, collectionId: preorderId });
  const snapshot = await readMiNotePreorderSnapshot(queryRemoteCommerceD1, config);
  const scope = sqlString(preorderId);
  const rows = queryRemoteCommerceD1(`SELECT inventory.*, authority.authority_state, authority.paused_at_ms, authority.dude_inventory_mode,
    initialization.generation AS authorized_generation, initialization.manifest_sha256,
    initialization.preorder_snapshot_sha256, initialization.eligible_card_ids_json, initialization.excluded_card_ids_json,
    initialization.completed_at_ms,
    (SELECT COALESCE(json_group_array(json_object('dudeId', dude_id, 'poolPosition', pool_position)), '[]')
      FROM commerce_available_dudes WHERE drop_id = ${scope}) AS available_json,
    (SELECT COALESCE(json_group_array(json_object('document_path', document_path, 'document_kind', document_kind,
      'drop_id', drop_id, 'document_id', document_id, 'document_json', document_json,
      'version', version, 'create_time', create_time, 'update_time', update_time)), '[]')
      FROM commerce_documents WHERE drop_id = ${scope} AND document_kind IN ('dude_assignment', 'box_assignment')) AS documents_json
    FROM commerce_inventory_drops AS inventory
    JOIN commerce_inventory_initializations AS initialization ON initialization.drop_id = inventory.drop_id
    JOIN commerce_authority_control AS authority ON authority.singleton = 1 WHERE inventory.drop_id = ${scope}`);
  const stock = rows[0];
  if (rows.length !== 1 || stock.authority_state !== 'd1' || stock.paused_at_ms !== null || stock.dude_inventory_mode !== 'rows' ||
    stock.ready !== 1 || stock.generation !== stock.authorized_generation || stock.completed_at_ms === null ||
    stock.manifest_sha256 !== inventory.sha256 || stock.preorder_snapshot_sha256 !== inventory.preorderSnapshotSha256 ||
    stock.eligible_card_ids_json !== JSON.stringify(inventory.eligibleCardIds) ||
    stock.excluded_card_ids_json !== JSON.stringify(inventory.excludedCardIds)) throw new Error('Upgrade requires active, conserved frozen inventory.');
  const inventoryConfig = { dropId: preorderId, dropFamily: drop.dropFamily, itemsPerBox: drop.itemsPerBox,
    maxDudeId: resolveDropMaxFigureId(drop), inventoryManifest: drop.inventoryManifest };
  requireInventoryConfig(stock, inventoryConfig);
  const available = JSON.parse(String(stock.available_json));
  const ownership = validateInventoryOwnership(inventoryConfig, JSON.parse(String(stock.documents_json)).map(parseCommerceD1DocumentRow));
  validateManifestInventory(inventoryConfig, available, ownership.assignedIds);
  const catalogText = readFileSync(path.join(root, 'mi_note_cards.json'), 'utf8');
  const targetMetadataSha256 = await readTargetMetadataHashes(config, drop, inventory.excludedCardIds, catalogText);
  return validateMiNoteUpgradeSource({ config, drop, inventory, collectionConfig, deployment, snapshot,
    catalogText, targetMetadataSha256, inventoryGeneration: String(stock.generation),
    available: available.length, assigned: ownership.assignedCount });
}

export function createMiNoteUpgradeManifest(source: MiNoteUpgradeSource, programsSha256: string, slot: number, now: Date): MiNotePreorderUpgradeManifest {
  const content: Omit<MiNotePreorderUpgradeManifest, 'sha256'> = {
    version: 1, preorderId: source.config.preorderId, cluster: source.config.cluster as 'devnet' | 'mainnet-beta',
    genesisHash: MI_NOTE_CLUSTER_GENESIS[source.config.cluster as 'devnet' | 'mainnet-beta'],
    authority: source.config.authority, collection: source.config.collection, coreProgram: MPL_CORE_PROGRAM_ADDRESS,
    mintConfig: source.drop.boxMinterConfigPda!, operationsConfig: source.drop.operationsConfig!.boxMinterConfigPda,
    batchSize: 4, preparedAt: now.toISOString(), sourceSlot: slot,
    source: { inventoryPath: source.inventoryPath, inventorySha256: source.inventory.sha256,
      preorderSnapshotSha256: source.inventory.preorderSnapshotSha256, catalogSha256: source.inventory.catalogSha256,
      dropSha256: miNoteManifestDigest(source.drop), deploymentSha256: source.deploymentSha256,
      targetMetadataSha256: source.targetMetadataSha256,
      collectionConfigSha256: miNoteManifestDigest(source.collectionConfig), inventoryGeneration: source.inventoryGeneration, programsSha256 },
    assets: source.assets,
  };
  return { ...content, sha256: miNoteManifestDigest(content) };
}

export function validateMiNoteUpgradeManifest(value: unknown, source: MiNoteUpgradeSource, programsSha256: string): MiNotePreorderUpgradeManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid preorder upgrade manifest.');
  const manifest = value as MiNotePreorderUpgradeManifest;
  if (!Number.isSafeInteger(manifest.sourceSlot) || manifest.sourceSlot < source.inventory.chain.slot ||
    typeof manifest.preparedAt !== 'string' || !Number.isFinite(Date.parse(manifest.preparedAt)) ||
    !/^[0-9a-f]{64}$/.test(programsSha256) ||
    !isDeepStrictEqual(manifest, createMiNoteUpgradeManifest(source, programsSha256, manifest.sourceSlot, new Date(manifest.preparedAt)))) {
    throw new Error('Preorder upgrade manifest is modified or its deployment/source identity changed.');
  }
  return manifest;
}

export function inspectMiNoteUpgradeAsset(account: AccountInfo<Buffer> | null, asset: UpgradeAsset, source: MiNoteUpgradeSource) {
  if (!account || account.executable || account.owner.toBase58() !== MPL_CORE_PROGRAM_ADDRESS) {
    throw new Error(`Card ${asset.id} is missing, burned, or owned by another program.`);
  }
  const decoded = decodePreorderAssetAccount(account.data);
  if (!decoded) throw new Error(`Card ${asset.id} is not a live collection-bound Core asset.`);
  const baseEnd = 66 + 4 + Buffer.byteLength(decoded.name) + 4 + Buffer.byteLength(decoded.uri);
  const sequence = account.data[baseEnd] === 0 ? null : account.data.readBigUInt64LE(baseEnd + 1);
  if (account.data.length !== baseEnd + (sequence === null ? 1 : 9)) {
    throw new Error(`Card ${asset.id} has unexpected asset plugins; inspect them before upgrading metadata.`);
  }
  const identity = resolveClaimedPreorderAsset({ config: source.config, cluster: source.config.cluster,
    claim: asset, actual: { address: asset.address, ...decoded }, publicDrop: source.drop });
  if (!identity) throw new Error(`Card ${asset.id} has an unexpected collection, name, or metadata URI.`);
  return { ...decoded, sequence, state: identity.kind === 'dude' ? 'target' as const : 'original' as const,
    protectedSha256: miNoteManifestDigest({ owner: decoded.owner, collection: decoded.collection, updateAuthorityKind: 2, plugins: [] }) };
}

export function miNoteUpgradeCollectionFingerprint(account: AccountInfo<Buffer> | null): string {
  if (!account || account.executable || account.owner.toBase58() !== MPL_CORE_PROGRAM_ADDRESS) {
    throw new Error('Upgrade collection is missing or has an unexpected owner.');
  }
  const base = decodeMplCoreCollectionBase(account.data);
  const counters = 33 + 4 + Buffer.byteLength(base.name) + 4 + Buffer.byteLength(base.uri);
  if (account.data.length < counters + 8) throw new Error('Upgrade collection data is truncated.');
  return miNoteManifestDigest(Buffer.concat([account.data.subarray(0, counters), account.data.subarray(counters + 8)]).toString('hex'));
}

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4); length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}

export function buildMiNotePreorderUpdateInstruction(manifest: MiNotePreorderUpgradeManifest, asset: UpgradeAsset): TransactionInstruction {
  const authority = new PublicKey(manifest.authority);
  return new TransactionInstruction({ programId: new PublicKey(MPL_CORE_PROGRAM_ADDRESS), keys: [
    { pubkey: new PublicKey(asset.address), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(manifest.collection), isSigner: false, isWritable: false },
    { pubkey: authority, isSigner: true, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: new PublicKey(SPL_NOOP_PROGRAM_ADDRESS), isSigner: false, isWritable: false },
  ], data: Buffer.concat([Buffer.from([15, 1]), borshString(asset.target.name), Buffer.from([1]), borshString(asset.target.uri), Buffer.from([0])]) });
}

export function buildMiNoteUpgradeTransaction(manifest: MiNotePreorderUpgradeManifest, cardIds: readonly number[], blockhash: string): VersionedTransaction {
  if (!cardIds.length || cardIds.length > PREORDER_UPGRADE_BATCH_SIZE || new Set(cardIds).size !== cardIds.length ||
    cardIds.some((id, index) => !manifest.assets.some(asset => asset.id === id) || index > 0 && id <= cardIds[index - 1])) {
    throw new Error('Upgrade batch must contain one to four distinct ordered manifest card IDs.');
  }
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(manifest.authority), recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: PREORDER_UPGRADE_COMPUTE_UNITS }),
      ...cardIds.map(id => buildMiNotePreorderUpdateInstruction(manifest, manifest.assets.find(asset => asset.id === id)!))],
  }).compileToV0Message());
  if (transaction.serialize().length > 1232) throw new Error('Upgrade batch exceeds the Solana packet limit.');
  return transaction;
}

export function validateMiNoteUpgradeAttempt(attempt: MiNoteUpgradeAttempt, manifest: MiNotePreorderUpgradeManifest): VersionedTransaction {
  if (!attempt || !['signed', 'finalized', 'failed', 'expired', 'state-verified'].includes(attempt.status) ||
    !Number.isSafeInteger(attempt.lastValidBlockHeight) || attempt.lastValidBlockHeight < 0 ||
    !Number.isFinite(Date.parse(attempt.signedAt)) || attempt.finalizedSlot !== undefined &&
    (!Number.isSafeInteger(attempt.finalizedSlot) || attempt.finalizedSlot < manifest.sourceSlot) ||
    attempt.preservationVerifiedAtSlot !== undefined && (!Number.isSafeInteger(attempt.preservationVerifiedAtSlot) ||
      attempt.preservationVerifiedAtSlot < manifest.sourceSlot || attempt.preservationVerifiedAtSlot > attempt.finalizedSlot!) ||
    ['finalized', 'state-verified'].includes(attempt.status) &&
    (attempt.preservationVerifiedAtSlot === undefined || !Number.isSafeInteger(attempt.finalizedSlot)) ||
    !['finalized', 'state-verified'].includes(attempt.status) && attempt.preservationVerifiedAtSlot !== undefined ||
    !/^[0-9a-f]{64}$/.test(attempt.collectionSha256) || !Array.isArray(attempt.before) ||
    !Array.isArray(attempt.cardIds) || attempt.before.length !== attempt.cardIds.length ||
    attempt.before.some((before, index) => !before || before.id !== attempt.cardIds[index] ||
      !/^[0-9a-f]{64}$/.test(before.protectedSha256) || before.sequence !== null && !/^(0|[1-9]\d*)$/.test(before.sequence) ||
      Object.keys(before).some(key => !['id', 'protectedSha256', 'sequence'].includes(key))) ||
    Object.keys(attempt).some(key => !['cardIds', 'before', 'collectionSha256', 'signature', 'blockhash', 'lastValidBlockHeight', 'transactionBase64', 'signedAt', 'status', 'finalizedSlot', 'preservationVerifiedAtSlot'].includes(key))) {
    throw new Error('Invalid preorder upgrade journal attempt.');
  }
  const transaction = VersionedTransaction.deserialize(Buffer.from(attempt.transactionBase64, 'base64'));
  const expected = buildMiNoteUpgradeTransaction(manifest, attempt.cardIds, attempt.blockhash);
  if (Buffer.from(transaction.serialize()).toString('base64') !== attempt.transactionBase64 || transaction.signatures.length !== 1 ||
    transaction.message.header.numRequiredSignatures !== 1 || bs58.encode(transaction.signatures[0]) !== attempt.signature ||
    !Buffer.from(transaction.message.serialize()).equals(Buffer.from(expected.message.serialize())) ||
    !nacl.sign.detached.verify(transaction.message.serialize(), transaction.signatures[0], new PublicKey(manifest.authority).toBytes())) {
    throw new Error('Saved upgrade is not the exact authority-signed metadata-only transaction for these assets.');
  }
  return transaction;
}

export function readMiNoteUpgradeJournal(file: string, manifest: MiNotePreorderUpgradeManifest, now: Date): { journal: MiNoteUpgradeJournal; source?: string } {
  const identity = { version: 1 as const, manifestSha256: manifest.sha256, preorderId: manifest.preorderId,
    cluster: manifest.cluster, collection: manifest.collection, authority: manifest.authority };
  if (!existsSync(file)) return { journal: { ...identity, createdAt: now.toISOString(), status: 'prepared', lastVerifiedSlot: manifest.sourceSlot, attempts: [] } };
  const source = readFileSync(file, 'utf8');
  const value = JSON.parse(source) as MiNoteUpgradeJournal;
  if (!value || Object.entries(identity).some(([key, expected]) => value[key] !== expected) ||
    !Number.isFinite(Date.parse(value.createdAt)) || !['prepared', 'running', 'complete'].includes(value.status) ||
    !Number.isSafeInteger(value.lastVerifiedSlot) || value.lastVerifiedSlot < manifest.sourceSlot || !Array.isArray(value.attempts) ||
    Object.keys(value).some(key => ![...Object.keys(identity), 'createdAt', 'status', 'lastVerifiedSlot', 'attempts'].includes(key))) {
    throw new Error('Upgrade journal belongs to another manifest or has invalid state.');
  }
  value.attempts.forEach(attempt => validateMiNoteUpgradeAttempt(attempt, manifest));
  if (new Set(value.attempts.map(attempt => attempt.signature)).size !== value.attempts.length ||
    value.attempts.some(attempt => (attempt.finalizedSlot ?? manifest.sourceSlot) > value.lastVerifiedSlot ||
      (attempt.preservationVerifiedAtSlot ?? manifest.sourceSlot) > value.lastVerifiedSlot) ||
    value.attempts.some((attempt, index) => attempt.status === 'signed' && index !== value.attempts.length - 1) ||
    value.status === 'complete' && value.attempts.some(attempt => attempt.status === 'signed')) {
    throw new Error('Upgrade journal contains duplicate or unresolved transaction history.');
  }
  return { journal: value, source };
}

export function writeMiNoteUpgradeJson(file: string, value: unknown, expectedSource?: string): string {
  const source = `${JSON.stringify(value, null, 2)}\n`;
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true });
  if (expectedSource !== undefined && (!existsSync(file) || readFileSync(file, 'utf8') !== expectedSource)) {
    throw new Error('Upgrade file changed while in use; preserve it and review before retrying.');
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(descriptor, source); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  try {
    if (expectedSource === undefined) linkSync(temporary, file); else renameSync(temporary, file);
    const parent = openSync(directory, 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { rmSync(temporary, { force: true }); }
  if (readFileSync(file, 'utf8') !== source) throw new Error('Upgrade file persistence could not be verified.');
  return source;
}
