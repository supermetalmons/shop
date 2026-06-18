import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getApps, initializeApp } from 'firebase-admin/app';
import {
  FieldValue,
  getFirestore,
  type DocumentSnapshot,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { PublicKey } from '@solana/web3.js';
import fetch from 'cross-fetch';
import {
  DudeAssignmentValidationError,
  pickDudeIdsForAssignment,
  validateDudeIdsForAssignment,
} from '../src/assignDudesPicker.ts';
import {
  assignSpecificDudesForBox,
  ensureIrlClaimCodeForBox,
  sanitizeDudeAssignmentPool,
  type CardAssignmentDropRuntime,
} from '../src/cardAssignment.ts';
import { FUNCTIONS_DROPS, requireFunctionsDrop, type FunctionsDropConfig, type SolanaCluster } from '../src/config/deployment.ts';
import { IRL_CLAIM_CODE_DIGITS, IRL_CLAIM_CODE_NAMESPACE, normalizeIrlClaimCode } from '../src/claimCodes.ts';
import {
  boxIdFromMetadataUri,
  canonicalMetadataBase,
  metadataBaseFromMetadataUri,
  metadataKindFromUri,
  selectMetadataUri,
} from '../src/dropMetadataUri.ts';
import {
  dropBoxAssignmentPath,
  dropDeliveryOrderPath,
  dropDeliveryOrdersCollectionPath,
  dropDudeAssignmentPath,
  dropDudePoolPath,
} from '../src/dropPaths.ts';
import {
  STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
  orderStripeReceiptClaimByBoxId,
  requireStripeReceiptClaimCode,
} from '../src/stripeCheckout/contract.ts';

const TARGET_DROP_ID = 'card_nft_2';
const MANIFEST_VERSION = 1;
const HELIUS_ASSETS_PAGE_LIMIT = 1000;
const HELIUS_ASSETS_MAX_SEARCH_PAGES = 64;
const ORDER_DOC_PAGE_SIZE = 100;
const RPC_TIMEOUT_MS = 20_000;

type Args = {
  execute: boolean;
  manifest?: string;
  deliveryId?: number;
  limit?: number;
  json: boolean;
};

type StripeReceiptClaimSummary = {
  code: string;
};

type ReceiptOwnerResolution = {
  owner: string;
  source: 'claimed_recipient' | 'receipt_owner';
  claimStatus: 'claimed' | 'unclaimed';
};

type DasAsset = Record<string, any>;

type ScriptDropRuntime = CardAssignmentDropRuntime & {
  cluster: SolanaCluster;
  heliusRpcBase: string;
  collectionMintStr: string;
  canonicalMetadataBase: string;
  collectionMintSharedOnCluster: boolean;
};

type ManifestBox = {
  boxId: number;
  receiptClaimCode: string;
  receiptOwner: string;
  receiptOwnerSource: ReceiptOwnerResolution['source'];
  receiptClaimStatus: ReceiptOwnerResolution['claimStatus'];
  receiptAssetId: string;
  assignmentStatus: 'planned' | 'already_assigned';
  dudeIds: number[];
  staleDudeIds?: number[];
  existingIrlClaimCode?: string;
};

type ManifestOrder = {
  docPath: string;
  deliveryId: number;
  stripeCheckoutSessionId?: string;
  receiptOwner?: string;
  boxes: ManifestBox[];
};

type Manifest = {
  version: typeof MANIFEST_VERSION;
  dropId: typeof TARGET_DROP_ID;
  createdAt: string;
  generatedByDryRun: true;
  orders: ManifestOrder[];
  totals: {
    orders: number;
    boxes: number;
    plannedAssignments: number;
    existingAssignments: number;
  };
};

type ExecutePlanBox = {
  manifestBox: ManifestBox;
  receiptOwner: ReceiptOwnerResolution;
};

type ExecutePlanOrder = {
  order: ManifestOrder;
  boxes: ExecutePlanBox[];
};

function usage(): string {
  return [
    'Assign card ids to card_nft_2 Stripe offchain delivery orders that are missing FF card assignments.',
    '',
    'Usage:',
    '  npm run assign-stripe-order-cards',
    '  npm run assign-stripe-order-cards -- --delivery-id <id>',
    '  npm run assign-stripe-order-cards -- --limit 10',
    '  npm run assign-stripe-order-cards -- --execute --manifest <path>',
    '',
    'Options:',
    '  --delivery-id <id>  Dry-run one delivery order',
    '  --limit <n>         Dry-run at most n matching orders',
    '  --execute           Apply an existing dry-run manifest',
    '  --manifest <path>   Required with --execute',
    '  --json              Print machine-readable output',
    '  -h, --help          Show this help',
  ].join('\n');
}

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { execute: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--execute') {
      args.execute = true;
      continue;
    }
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (arg === '--manifest') {
      const value = argv[index + 1];
      if (!value) fail(`Missing value for ${arg}\n\n${usage()}`);
      args.manifest = value;
      index += 1;
      continue;
    }
    if (arg === '--delivery-id') {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) fail(`Invalid value for ${arg}\n\n${usage()}`);
      args.deliveryId = Math.floor(value);
      index += 1;
      continue;
    }
    if (arg === '--limit') {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) fail(`Invalid value for ${arg}\n\n${usage()}`);
      args.limit = Math.floor(value);
      index += 1;
      continue;
    }
    fail(`Unknown arg: ${arg}\n\n${usage()}`);
  }
  if (args.execute && !args.manifest) fail(`--manifest is required with --execute\n\n${usage()}`);
  if (args.execute && (args.deliveryId || args.limit)) fail('--delivery-id/--limit are dry-run options and cannot be used with --execute');
  return args;
}

function loadLocalEnvFile(filePath: string) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    const value = rawValue.trim().replace(/^['"]|['"]$/g, '');
    process.env[key] = value;
  }
}

function loadLocalEnv() {
  const cwd = process.cwd();
  [
    path.join(cwd, 'functions/.env'),
    path.join(cwd, 'functions/.env.local'),
    path.join(cwd, '.env'),
    path.join(cwd, '.env.local'),
  ].forEach(loadLocalEnvFile);
}

function requireEnv(name: string, hint: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) fail(`${name} is not set. ${hint}`);
  return value;
}

function initDb(): Firestore {
  if (!getApps().length) initializeApp();
  return getFirestore();
}

function heliusRpcBaseForCluster(cluster: SolanaCluster): string {
  return cluster === 'mainnet-beta'
    ? 'https://mainnet.helius-rpc.com'
    : cluster === 'testnet'
      ? 'https://testnet.helius-rpc.com'
      : 'https://devnet.helius-rpc.com';
}

function pubkeyString(label: string, value: string | undefined): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  try {
    return new PublicKey(trimmed).toBase58();
  } catch (err) {
    fail(`${label} is invalid in functions/src/config/deployment.ts: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function collectionMintSharedOnCluster(config: FunctionsDropConfig, collectionMintStr: string): boolean {
  if (!collectionMintStr) return false;
  let count = 0;
  for (const drop of Object.values(FUNCTIONS_DROPS)) {
    if (drop.solanaCluster !== config.solanaCluster) continue;
    if (pubkeyString('COLLECTION_MINT', drop.collectionMint) === collectionMintStr) count += 1;
  }
  return count > 1;
}

function buildScriptDropRuntime(config: FunctionsDropConfig): ScriptDropRuntime {
  const itemsPerBox = Math.floor(Number(config.itemsPerBox));
  const maxSupply = Math.floor(Number(config.maxSupply));
  if (!Number.isInteger(itemsPerBox) || itemsPerBox < 1) fail(`${TARGET_DROP_ID} must be an openable drop`);
  if (!Number.isInteger(maxSupply) || maxSupply < 1) fail(`${TARGET_DROP_ID} has invalid maxSupply`);
  const maxDudeId = maxSupply * itemsPerBox;
  if (!Number.isFinite(maxDudeId) || maxDudeId <= 0 || maxDudeId > 0xffff) fail(`${TARGET_DROP_ID} has invalid max card id`);
  const collectionMintStr = pubkeyString('COLLECTION_MINT', config.collectionMint);
  return {
    dropId: TARGET_DROP_ID,
    config: { dropFamily: config.dropFamily },
    itemsPerBox,
    maxDudeId,
    cluster: config.solanaCluster,
    heliusRpcBase: heliusRpcBaseForCluster(config.solanaCluster),
    collectionMintStr,
    canonicalMetadataBase: canonicalMetadataBase(config.metadataBase),
    collectionMintSharedOnCluster: collectionMintSharedOnCluster(config, collectionMintStr),
  };
}

function normalizeWalletMaybe(wallet: unknown): string | undefined {
  if (typeof wallet !== 'string' || !wallet.trim()) return undefined;
  try {
    return new PublicKey(wallet).toBase58();
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function positiveInteger(value: unknown): number | undefined {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric > 0 && numeric <= 0xffff_ffff ? numeric : undefined;
}

function getOrderDeliveryId(doc: DocumentSnapshot, order: any): number {
  return positiveInteger(order?.deliveryId) || positiveInteger(doc.id) || fail(`Invalid delivery id for ${doc.ref.path}`);
}

function getBoxItems(order: any): Array<{ boxId: number }> {
  const items = Array.isArray(order?.items) ? order.items : [];
  return items
    .filter((item: any) => item?.kind === 'box')
    .map((item: any) => ({ boxId: positiveInteger(item?.refId) || 0 }))
    .filter((item) => item.boxId > 0)
    .sort((a, b) => a.boxId - b.boxId);
}

function normalizeDudeIds(raw: unknown, runtime: CardAssignmentDropRuntime): number[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.map((value) => Math.floor(Number(value)));
  if (ids.length !== runtime.itemsPerBox) return [];
  if (ids.some((id) => !Number.isFinite(id))) return [];
  if (new Set(ids).size !== ids.length) return [];
  if (ids.some((id) => id < 1 || id > runtime.maxDudeId)) return [];
  return ids;
}

type NormalizedIrlClaim = Record<string, any> & {
  code: string;
  boxId: number;
  boxAssetId: string;
  dudeIds: number[];
};

type ExistingIrlClaim = {
  boxId: number;
  raw: any;
  complete: NormalizedIrlClaim | null;
};

function normalizeCompleteExistingIrlClaimForBox(params: {
  claim: any;
  boxId: number;
  runtime: CardAssignmentDropRuntime;
  context: string;
}): NormalizedIrlClaim | null {
  const rawDudeIds = params.claim?.dudeIds;
  const hasDudeIds = Array.isArray(rawDudeIds) && rawDudeIds.length > 0;
  const dudeIds = normalizeDudeIds(rawDudeIds, params.runtime);
  if (hasDudeIds && !dudeIds.length) fail(`${params.context} has invalid existing IRL claim dudeIds`);
  if (!dudeIds.length) return null;

  const code = requireIrlClaimCode(params.claim?.code, params.context);
  const boxAssetId = typeof params.claim?.boxAssetId === 'string' ? params.claim.boxAssetId.trim() : '';
  if (!boxAssetId) fail(`${params.context} has an existing IRL claim without boxAssetId`);
  return {
    ...params.claim,
    code,
    boxId: params.boxId,
    boxAssetId,
    dudeIds,
  };
}

function existingIrlClaimsByBoxId(order: any, runtime: CardAssignmentDropRuntime, context: string): Map<number, ExistingIrlClaim> {
  const out = new Map<number, ExistingIrlClaim>();
  const rawClaims = order?.irlClaims;
  if (rawClaims == null) return out;
  if (!Array.isArray(rawClaims)) fail(`${context} has invalid existing IRL claims`);
  for (const [index, claim] of rawClaims.entries()) {
    const boxId = positiveInteger(claim?.boxId);
    if (!boxId) fail(`${context} has an existing IRL claim with invalid boxId at index ${index}`);
    if (out.has(boxId)) fail(`${context} has duplicate existing IRL claims for box ${boxId}`);
    const claimContext = `${context} box ${boxId}`;
    out.set(boxId, {
      boxId,
      raw: claim,
      complete: normalizeCompleteExistingIrlClaimForBox({ claim, boxId, runtime, context: claimContext }),
    });
  }
  return out;
}

function stripeReceiptClaimMaybe(rawClaim: any): StripeReceiptClaimSummary | null {
  if (!isPlainObject(rawClaim)) return null;
  try {
    const code = requireStripeReceiptClaimCode(rawClaim.code);
    return { code };
  } catch {
    return null;
  }
}

function stripeReceiptClaimByBoxId(order: any, boxId: number): StripeReceiptClaimSummary | null {
  return stripeReceiptClaimMaybe(
    orderStripeReceiptClaimByBoxId(order, boxId, {
      includeSingularFallback: true,
      acceptClaim: (claim) => stripeReceiptClaimMaybe(claim) !== null,
    }),
  );
}

function requireStoredStripeReceiptClaimCode(rawCode: unknown, context: string): string {
  try {
    return requireStripeReceiptClaimCode(rawCode);
  } catch {
    fail(`${context} has invalid stored Stripe receipt claim code`);
  }
}

async function requireStripeReceiptClaimDoc(params: {
  db: Firestore;
  code: string;
  dropId: string;
  deliveryId: number;
  boxId: number;
}): Promise<any> {
  const { db, code } = params;
  const snap = await db.doc(`claimCodes/${code}`).get();
  if (!snap.exists) fail(`Stripe receipt claim ${code} is missing claimCodes/${code}`);
  const data = snap.data() as any;
  if (data?.namespace !== STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE) {
    fail(`Stripe receipt claim ${code} has invalid namespace in ${snap.ref.path}`);
  }
  const storedCode = requireStoredStripeReceiptClaimCode(data?.code, snap.ref.path);
  if (storedCode !== code) fail(`Stripe receipt claim ${code} has mismatched stored code in ${snap.ref.path}`);
  if (String(data?.dropId || '').trim() !== params.dropId) {
    fail(`Stripe receipt claim ${code} has mismatched dropId in ${snap.ref.path}`);
  }
  if (positiveInteger(data?.deliveryId) !== params.deliveryId) {
    fail(`Stripe receipt claim ${code} has mismatched deliveryId in ${snap.ref.path}`);
  }
  if (positiveInteger(data?.boxId) !== params.boxId) {
    fail(`Stripe receipt claim ${code} has mismatched boxId in ${snap.ref.path}`);
  }
  return data;
}

async function resolveReceiptOwner(params: {
  db: Firestore;
  dropId: string;
  deliveryId: number;
  boxId: number;
  receiptClaim: StripeReceiptClaimSummary;
}): Promise<ReceiptOwnerResolution> {
  const claimDoc = await requireStripeReceiptClaimDoc({
    db: params.db,
    code: params.receiptClaim.code,
    dropId: params.dropId,
    deliveryId: params.deliveryId,
    boxId: params.boxId,
  });
  const claimStatus = String(claimDoc?.status || '').trim();
  if (claimStatus === 'processing') {
    fail(`Stripe receipt claim ${params.receiptClaim.code} for box ${params.boxId} is processing; retry later`);
  }
  if (claimStatus !== 'claimed' && claimStatus !== 'unclaimed') {
    fail(`Stripe receipt claim ${params.receiptClaim.code} for box ${params.boxId} has unsupported status: ${claimStatus || 'missing'}`);
  }
  const claimedRecipient = normalizeWalletMaybe(claimDoc?.recipient);
  if (claimStatus === 'claimed') {
    if (!claimedRecipient) fail(`Stripe receipt claim ${params.receiptClaim.code} for box ${params.boxId} is claimed but has no valid recipient`);
    return { owner: claimedRecipient, source: 'claimed_recipient', claimStatus };
  }

  const receiptOwner = normalizeWalletMaybe(claimDoc?.receiptOwner);
  if (!receiptOwner) fail(`Unable to resolve current receipt owner for box ${params.boxId} (${params.receiptClaim.code})`);
  return { owner: receiptOwner, source: 'receipt_owner', claimStatus };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function heliusRpcEndpoint(runtime: ScriptDropRuntime): string {
  const apiKey = requireEnv('HELIUS_API_KEY', 'Set it in functions/.env.local or export it before running this script.');
  return `${runtime.heliusRpcBase}/?api-key=${apiKey}`;
}

async function heliusRpc<T>(runtime: ScriptDropRuntime, method: string, params: any): Promise<T> {
  const res = await withTimeout(
    fetch(heliusRpcEndpoint(runtime), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
    }),
    RPC_TIMEOUT_MS,
    `heliusRpc:${method}`,
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) {
    const message = json?.error?.message || res.statusText || 'Unknown Helius RPC error';
    fail(`Helius ${method} failed: ${message}`);
  }
  return json.result as T;
}

function heliusSearchAssetsParams(owner: string, page: number, grouping?: readonly [string, string]) {
  const params: any = {
    ownerAddress: owner,
    page,
    limit: HELIUS_ASSETS_PAGE_LIMIT,
    displayOptions: {
      showCollectionMetadata: true,
      showUnverifiedCollections: true,
    },
  };
  if (grouping) params.grouping = grouping;
  return params;
}

function heliusSearchAssetsItems(result: any): DasAsset[] {
  return Array.isArray(result?.items) ? result.items : [];
}

function heliusSearchAssetsHasNextPage(result: any, page: number, items: DasAsset[]): boolean {
  if (!items.length) return false;
  const responseLimit = Number(result?.limit);
  const limit = Number.isFinite(responseLimit) && responseLimit > 0 ? responseLimit : HELIUS_ASSETS_PAGE_LIMIT;
  if (items.length < limit) return false;
  const total = Number(result?.total);
  const resultPage = Number(result?.page ?? page);
  if (Number.isFinite(total) && total >= 0 && Number.isFinite(limit) && limit > 0 && Number.isFinite(resultPage)) {
    return resultPage * limit < total;
  }
  return true;
}

const ownerGroupedAssetsCache = new Map<string, Promise<DasAsset[]>>();
const ownerUngroupedAssetsCache = new Map<string, Promise<DasAsset[]>>();

async function fetchOwnedAssetsGrouped(runtime: ScriptDropRuntime, owner: string): Promise<DasAsset[]> {
  if (!runtime.collectionMintStr) return [];
  const cacheKey = `${runtime.dropId}:${owner}`;
  const cached = ownerGroupedAssetsCache.get(cacheKey);
  if (cached) return cached;

  const promise = fetchOwnedAssetsPages(runtime, owner, ['collection', runtime.collectionMintStr]).catch((err) => {
    ownerGroupedAssetsCache.delete(cacheKey);
    throw err;
  });

  ownerGroupedAssetsCache.set(cacheKey, promise);
  return promise;
}

async function fetchOwnedAssetsUngrouped(runtime: ScriptDropRuntime, owner: string): Promise<DasAsset[]> {
  const cacheKey = `${runtime.dropId}:${owner}`;
  const cached = ownerUngroupedAssetsCache.get(cacheKey);
  if (cached) return cached;

  const promise = fetchOwnedAssetsPages(runtime, owner).catch((err) => {
    ownerUngroupedAssetsCache.delete(cacheKey);
    throw err;
  });
  ownerUngroupedAssetsCache.set(cacheKey, promise);
  return promise;
}

async function fetchOwnedAssetsPages(
  runtime: ScriptDropRuntime,
  owner: string,
  grouping?: readonly [string, string],
): Promise<DasAsset[]> {
  const out: DasAsset[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= HELIUS_ASSETS_MAX_SEARCH_PAGES; page += 1) {
    const result = await heliusRpc<any>(runtime, 'searchAssets', heliusSearchAssetsParams(owner, page, grouping));
    const items = heliusSearchAssetsItems(result);
    for (const item of items) {
      const id = String(item?.id || '');
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push(item);
    }
    if (!heliusSearchAssetsHasNextPage(result, page, items)) return out;
  }
  fail(`Helius searchAssets page cap reached while scanning ${owner}`);
}

function assetMetadataUri(asset: DasAsset): string {
  return selectMetadataUri(
    asset?.content?.json_uri,
    asset?.content?.jsonUri,
    asset?.content?.metadata?.json_uri,
    asset?.content?.metadata?.jsonUri,
    asset?.content?.metadata?.uri,
  );
}

function getAssetKind(asset: DasAsset): 'box' | 'dude' | 'certificate' | null {
  const kindAttr = asset?.content?.metadata?.attributes?.find((attr: any) => attr?.trait_type === 'type');
  const value = kindAttr?.value;
  if (value === 'box' || value === 'dude' || value === 'certificate') return value;
  const kindFromUri = metadataKindFromUri(assetMetadataUri(asset));
  if (kindFromUri) return kindFromUri;
  const name = String(asset?.content?.metadata?.name || asset?.content?.metadata?.title || '').toLowerCase();
  if (name.includes('blind box')) return 'box';
  if (name.includes('receipt') || name.includes('authenticity')) return 'certificate';
  if (name.includes('figure')) return 'dude';
  if (/^(b|box)#?\d+$/.test(name.replace(/\s+/g, ''))) return 'box';
  return null;
}

function getBoxIdFromAsset(asset: DasAsset): string | undefined {
  const boxAttr = asset?.content?.metadata?.attributes?.find((attr: any) => attr?.trait_type === 'box_id');
  if (typeof boxAttr?.value === 'string' && boxAttr.value) return boxAttr.value;
  const uriBoxId = boxIdFromMetadataUri(assetMetadataUri(asset));
  if (uriBoxId) return uriBoxId;
  const normalized = String(asset?.content?.metadata?.name || asset?.content?.metadata?.title || '')
    .toLowerCase()
    .replace(/\s+/g, '');
  const match = normalized.match(/^(b|box)#?(\d+)$/);
  return match?.[2];
}

function assetCollectionMints(asset: DasAsset): string[] {
  const out = new Set<string>();
  const grouped = asset?.grouping;
  if (Array.isArray(grouped)) {
    for (const group of grouped) {
      if (group?.group_key === 'collection' && typeof group?.group_value === 'string' && group.group_value) {
        out.add(group.group_value);
      }
    }
  }
  const collectionKey = asset?.content?.metadata?.collection?.key;
  if (typeof collectionKey === 'string' && collectionKey) out.add(collectionKey);
  return Array.from(out);
}

function assetMatchesRequestedDrop(asset: DasAsset, runtime: ScriptDropRuntime): boolean {
  if (getAssetKind(asset) !== 'certificate') return false;
  const collectionMatches = Boolean(runtime.collectionMintStr) && assetCollectionMints(asset).includes(runtime.collectionMintStr);
  if (!collectionMatches) return false;
  const assetMetadataBase = metadataBaseFromMetadataUri(assetMetadataUri(asset));
  if (assetMetadataBase) return assetMetadataBase === runtime.canonicalMetadataBase;
  return !runtime.collectionMintSharedOnCluster;
}

function looksBurntOrClosedInHelius(asset: DasAsset | null | undefined): boolean {
  if (!asset || typeof asset !== 'object') return true;
  const burntFlag =
    asset?.burnt ??
    asset?.burned ??
    asset?.is_burnt ??
    asset?.isBurnt ??
    asset?.compression?.burnt ??
    asset?.compression?.burned ??
    asset?.compression?.is_burnt ??
    asset?.compression?.isBurnt ??
    asset?.ownership?.burnt ??
    asset?.ownership?.burned;
  if (typeof burntFlag === 'boolean') return burntFlag;
  if (burntFlag != null && burntFlag !== false) return true;
  const ownershipState = String(
    asset?.ownership?.ownership_state || asset?.ownership?.ownershipState || asset?.ownership?.state || '',
  ).toLowerCase();
  return Boolean(ownershipState && /burn/.test(ownershipState));
}

function uniqueDasAssetsById(assets: DasAsset[]): DasAsset[] {
  const out: DasAsset[] = [];
  const seen = new Set<string>();
  for (const asset of assets) {
    const id = String(asset?.id || '');
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(asset);
  }
  return out;
}

async function findReceiptAssetCandidatesOwnedBy(params: {
  owner: string;
  runtime: ScriptDropRuntime;
  boxId: number;
}): Promise<DasAsset[]> {
  const matches = (asset: DasAsset) => {
    if (looksBurntOrClosedInHelius(asset)) return false;
    if (asset?.ownership?.owner !== params.owner) return false;
    if (!assetMatchesRequestedDrop(asset, params.runtime)) return false;
    return String(getBoxIdFromAsset(asset) || '') === String(params.boxId);
  };

  if (params.runtime.collectionMintStr) {
    const groupedMatches = (await fetchOwnedAssetsGrouped(params.runtime, params.owner)).filter(matches);
    if (groupedMatches.length) return groupedMatches;
  }

  const ungroupedMatches = (await fetchOwnedAssetsUngrouped(params.runtime, params.owner)).filter(matches);
  return uniqueDasAssetsById(ungroupedMatches);
}

async function fetchAssetById(runtime: ScriptDropRuntime, assetId: string): Promise<DasAsset | null> {
  const result = await heliusRpc<any>(runtime, 'getAsset', {
    id: assetId,
    displayOptions: {
      showCollectionMetadata: true,
      showUnverifiedCollections: true,
    },
  });
  return result && typeof result === 'object' ? result : null;
}

function validateReceiptAssetForManifest(params: {
  asset: DasAsset | null;
  assetId: string;
  owner: string;
  runtime: ScriptDropRuntime;
  boxId: number;
  context: string;
}): void {
  const { asset, assetId, owner, runtime, boxId, context } = params;
  if (!asset) fail(`${context} receipt asset ${assetId} was not found`);
  if (String(asset?.id || '') !== assetId) fail(`${context} receipt asset id mismatch; expected ${assetId}`);
  if (looksBurntOrClosedInHelius(asset)) fail(`${context} receipt asset ${assetId} is burnt or closed`);
  if (asset?.ownership?.owner !== owner) {
    fail(`${context} receipt asset ${assetId} is not owned by ${owner}`);
  }
  if (!assetMatchesRequestedDrop(asset, runtime)) fail(`${context} receipt asset ${assetId} does not match ${runtime.dropId}`);
  if (String(getBoxIdFromAsset(asset) || '') !== String(boxId)) {
    fail(`${context} receipt asset ${assetId} does not match box ${boxId}`);
  }
}

async function loadInitialPool(db: Firestore, runtime: ScriptDropRuntime): Promise<number[]> {
  const poolSnap = await db.doc(dropDudePoolPath(runtime.dropId)).get();
  return sanitizeDudeAssignmentPool(poolSnap.exists ? (poolSnap.data() as any)?.available : undefined, runtime.maxDudeId).pool;
}

type ExistingBoxAssignment = {
  dudeIds: number[];
  irlClaimCode?: string;
};

async function loadExistingBoxAssignment(db: Firestore, runtime: ScriptDropRuntime, boxAssetId: string): Promise<ExistingBoxAssignment | null> {
  const snap = await db.doc(dropBoxAssignmentPath(runtime.dropId, boxAssetId)).get();
  if (!snap.exists) return null;
  const data = snap.data() as any;
  const dudeIds = normalizeDudeIds(data?.dudeIds, runtime);
  if (!dudeIds.length) fail(`Invalid existing assignment in ${snap.ref.path}`);
  await verifyDudeAssignmentsForBox(db, runtime, boxAssetId, dudeIds, snap.ref.path);
  const code = data?.irlClaimCode;
  return {
    dudeIds,
    ...(typeof code === 'string' && code.trim() ? { irlClaimCode: code.trim() } : {}),
  };
}

async function verifyDudeAssignmentsForBox(
  db: Firestore,
  runtime: ScriptDropRuntime,
  boxAssetId: string,
  dudeIds: readonly number[],
  context: string,
): Promise<void> {
  const snaps = await Promise.all(dudeIds.map((dudeId) => db.doc(dropDudeAssignmentPath(runtime.dropId, dudeId)).get()));
  snaps.forEach((snap, index) => {
    const dudeId = dudeIds[index];
    if (!snap.exists) {
      fail(`${context} is missing required dude assignment ${dropDudeAssignmentPath(runtime.dropId, dudeId)}`);
    }
    const data = snap.data() as any;
    const storedDudeId = positiveInteger(data?.dudeId);
    const assignedBoxAssetId = typeof data?.boxAssetId === 'string' ? data.boxAssetId : '';
    if (storedDudeId !== dudeId || assignedBoxAssetId !== boxAssetId) {
      fail(
        `${context} has conflicting dude assignment ${snap.ref.path}: expected dude ${dudeId} -> ${boxAssetId}, found ${
          storedDudeId ?? 'missing'
        } -> ${assignedBoxAssetId || 'missing'}`,
      );
    }
  });
}

function requireIrlClaimCode(rawCode: unknown, context: string): string {
  const code = normalizeIrlClaimCode(rawCode);
  if (code.length !== IRL_CLAIM_CODE_DIGITS) fail(`${context} has invalid IRL claim code`);
  return code;
}

async function validateExistingIrlClaimForBox(params: {
  db: Firestore;
  runtime: ScriptDropRuntime;
  orderPath: string;
  deliveryId: number;
  boxId: number;
  claim: any;
}): Promise<void> {
  const context = `${params.orderPath} box ${params.boxId}`;
  const code = requireIrlClaimCode(params.claim?.code, context);
  const boxAssetId = typeof params.claim?.boxAssetId === 'string' ? params.claim.boxAssetId.trim() : '';
  if (!boxAssetId) fail(`${context} has an existing IRL claim without boxAssetId`);
  const dudeIds = normalizeDudeIds(params.claim?.dudeIds, params.runtime);
  if (!dudeIds.length) fail(`${context} has invalid existing IRL claim dudeIds`);

  const assignmentPath = dropBoxAssignmentPath(params.runtime.dropId, boxAssetId);
  const existingAssignment = await loadExistingBoxAssignment(params.db, params.runtime, boxAssetId);
  if (!existingAssignment || !sameNumbers(existingAssignment.dudeIds, dudeIds)) {
    fail(`${context} existing IRL claim does not match ${assignmentPath}`);
  }
  const assignmentCode = existingAssignment.irlClaimCode
    ? requireIrlClaimCode(existingAssignment.irlClaimCode, assignmentPath)
    : '';
  if (assignmentCode !== code) {
    fail(`${context} existing IRL claim code does not match ${assignmentPath}`);
  }

  const claimSnap = await params.db.doc(`claimCodes/${code}`).get();
  if (!claimSnap.exists) fail(`${context} is missing claimCodes/${code}`);
  const claimDoc = claimSnap.data() as any;
  if (claimDoc?.namespace !== IRL_CLAIM_CODE_NAMESPACE) fail(`${context} claimCodes/${code} has invalid namespace`);
  if (requireIrlClaimCode(claimDoc?.code, claimSnap.ref.path) !== code) fail(`${context} claimCodes/${code} has mismatched code`);
  if (String(claimDoc?.dropId || '').trim() !== params.runtime.dropId) fail(`${context} claimCodes/${code} has mismatched dropId`);
  if (positiveInteger(claimDoc?.deliveryId) !== params.deliveryId) fail(`${context} claimCodes/${code} has mismatched deliveryId`);
  if (positiveInteger(claimDoc?.boxId) !== params.boxId) fail(`${context} claimCodes/${code} has mismatched boxId`);
  if (String(claimDoc?.boxAssetId || '').trim() !== boxAssetId) fail(`${context} claimCodes/${code} has mismatched boxAssetId`);
  const claimDocDudeIds = normalizeDudeIds(claimDoc?.dudeIds, params.runtime);
  if (!sameNumbers(claimDocDudeIds, dudeIds)) fail(`${context} claimCodes/${code} has mismatched dudeIds`);
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function manifestPathFor(dropId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.resolve(process.cwd(), '.cache', `stripe-order-card-assignments-${dropId}-${stamp}.json`);
}

async function writeManifest(manifest: Manifest): Promise<string> {
  const filePath = manifestPathFor(manifest.dropId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return filePath;
}

async function loadManifest(filePath: string): Promise<Manifest> {
  const resolved = path.resolve(process.cwd(), filePath);
  const parsed = JSON.parse(await readFile(resolved, 'utf8')) as Manifest;
  if (parsed?.version !== MANIFEST_VERSION) fail(`Unsupported manifest version in ${resolved}`);
  if (parsed?.dropId !== TARGET_DROP_ID) fail(`Manifest dropId must be ${TARGET_DROP_ID}`);
  if (parsed?.generatedByDryRun !== true) fail(`Manifest was not generated by this dry-run script: ${resolved}`);
  if (!Array.isArray(parsed?.orders)) fail(`Manifest is missing orders: ${resolved}`);
  validateManifestTotals(parsed, resolved);
  return parsed;
}

async function* loadOrderDocs(db: Firestore, args: Args): AsyncGenerator<QueryDocumentSnapshot> {
  if (args.deliveryId) {
    const snap = await db.doc(dropDeliveryOrderPath(TARGET_DROP_ID, args.deliveryId)).get();
    if (!snap.exists) fail(`Delivery order not found: ${dropDeliveryOrderPath(TARGET_DROP_ID, args.deliveryId)}`);
    yield snap as QueryDocumentSnapshot;
    return;
  }

  const baseQuery = db
    .collection(dropDeliveryOrdersCollectionPath(TARGET_DROP_ID))
    .where('status', '==', 'ready_to_ship')
    .where('source', '==', 'stripe_offchain');
  let cursor: QueryDocumentSnapshot | undefined;
  while (true) {
    const query = cursor ? baseQuery.startAfter(cursor).limit(ORDER_DOC_PAGE_SIZE) : baseQuery.limit(ORDER_DOC_PAGE_SIZE);
    const snap = await query.get();
    if (snap.empty) return;
    for (const doc of snap.docs) yield doc;
    cursor = snap.docs[snap.docs.length - 1]!;
    if (snap.size < ORDER_DOC_PAGE_SIZE) return;
  }
}

async function buildDryRunManifest(db: Firestore, runtime: ScriptDropRuntime, args: Args): Promise<Manifest> {
  const pool = await loadInitialPool(db, runtime);
  const localReserved = new Set<number>();
  const assignmentCache = new Map<number, Promise<boolean>>();
  const orders: ManifestOrder[] = [];

  const isAssigned = async (dudeId: number): Promise<boolean> => {
    if (localReserved.has(dudeId)) return true;
    let cached = assignmentCache.get(dudeId);
    if (!cached) {
      cached = db.doc(dropDudeAssignmentPath(runtime.dropId, dudeId)).get().then((snap) => snap.exists);
      assignmentCache.set(dudeId, cached);
    }
    return cached;
  };

  for await (const doc of loadOrderDocs(db, args)) {
    const order = doc.data() as any;
    if (order?.source !== 'stripe_offchain' || order?.status !== 'ready_to_ship') continue;
    const deliveryId = getOrderDeliveryId(doc, order);
    const existingClaims = existingIrlClaimsByBoxId(order, runtime, doc.ref.path);
    const boxes: ManifestBox[] = [];

    for (const item of getBoxItems(order)) {
      const existingClaim = existingClaims.get(item.boxId)?.complete;
      if (existingClaim) {
        await validateExistingIrlClaimForBox({
          db,
          runtime,
          orderPath: doc.ref.path,
          deliveryId,
          boxId: item.boxId,
          claim: existingClaim,
        });
        continue;
      }

      const receiptClaim = stripeReceiptClaimByBoxId(order, item.boxId);
      if (!receiptClaim) fail(`${doc.ref.path} box ${item.boxId} is missing a Stripe receipt claim code`);
      const receiptOwner = await resolveReceiptOwner({
        db,
        dropId: runtime.dropId,
        deliveryId,
        boxId: item.boxId,
        receiptClaim,
      });
      const candidates = await findReceiptAssetCandidatesOwnedBy({ owner: receiptOwner.owner, runtime, boxId: item.boxId });
      if (candidates.length !== 1) {
        const ids = candidates.map((asset) => String(asset?.id || '')).filter(Boolean);
        fail(
          `${doc.ref.path} box ${item.boxId} expected exactly one live receipt cNFT owned by ${receiptOwner.owner}; found ${candidates.length}${
            ids.length ? ` (${ids.join(', ')})` : ''
          }`,
        );
      }
      const receiptAssetId = String(candidates[0]?.id || '');
      if (!receiptAssetId) fail(`${doc.ref.path} box ${item.boxId} receipt cNFT is missing an asset id`);

      const existingAssignment = await loadExistingBoxAssignment(db, runtime, receiptAssetId);
      let dudeIds: number[];
      let assignmentStatus: ManifestBox['assignmentStatus'];
      let staleDudeIds: number[] = [];
      if (existingAssignment) {
        dudeIds = existingAssignment.dudeIds;
        assignmentStatus = 'already_assigned';
      } else {
        const picked = await pickDudeIdsForAssignment({
          dropFamily: runtime.config.dropFamily,
          itemsPerBox: runtime.itemsPerBox,
          maxDudeId: runtime.maxDudeId,
          pool,
          isAssigned,
        });
        dudeIds = picked.chosen;
        assignmentStatus = 'planned';
        staleDudeIds = Array.from(new Set(picked.staleDudeIds)).sort((a, b) => a - b);
      }
      dudeIds.forEach((dudeId) => localReserved.add(dudeId));

      boxes.push({
        boxId: item.boxId,
        receiptClaimCode: receiptClaim.code,
        receiptOwner: receiptOwner.owner,
        receiptOwnerSource: receiptOwner.source,
        receiptClaimStatus: receiptOwner.claimStatus,
        receiptAssetId,
        assignmentStatus,
        dudeIds,
        ...(staleDudeIds.length ? { staleDudeIds } : {}),
        ...(existingAssignment?.irlClaimCode ? { existingIrlClaimCode: existingAssignment.irlClaimCode } : {}),
      });
    }

    if (boxes.length) {
      orders.push({
        docPath: doc.ref.path,
        deliveryId,
        ...(typeof order?.stripeCheckoutSessionId === 'string' ? { stripeCheckoutSessionId: order.stripeCheckoutSessionId } : {}),
        ...(typeof order?.receiptOwner === 'string' ? { receiptOwner: order.receiptOwner } : {}),
        boxes,
      });
      if (args.limit && orders.length >= args.limit) break;
    }
  }

  return {
    version: MANIFEST_VERSION,
    dropId: TARGET_DROP_ID,
    createdAt: new Date().toISOString(),
    generatedByDryRun: true,
    orders,
    totals: manifestTotals({ orders }),
  };
}

function normalizeManifestStaleDudeIds(params: {
  raw: unknown;
  runtime: ScriptDropRuntime;
  selectedDudeIds: readonly number[];
  context: string;
}): number[] {
  if (params.raw == null) return [];
  if (!Array.isArray(params.raw)) fail(`${params.context} has invalid staleDudeIds`);
  const selected = new Set(params.selectedDudeIds);
  const staleDudeIds = params.raw.map((value) => Math.floor(Number(value)));
  staleDudeIds.forEach((dudeId) => {
    if (!Number.isFinite(dudeId) || dudeId < 1 || dudeId > params.runtime.maxDudeId) {
      fail(`${params.context} has invalid stale dude id: ${String(dudeId)}`);
    }
    if (selected.has(dudeId)) {
      fail(`${params.context} has staleDudeIds overlapping selected dudeIds: ${dudeId}`);
    }
  });
  if (new Set(staleDudeIds).size !== staleDudeIds.length) fail(`${params.context} has duplicate staleDudeIds`);
  return staleDudeIds;
}

function manifestTotals(manifest: Pick<Manifest, 'orders'>): Manifest['totals'] {
  const boxesByOrder = manifest.orders.map((order: any) => (Array.isArray(order?.boxes) ? order.boxes : []));
  const boxes = boxesByOrder.flat();
  return {
    orders: manifest.orders.length,
    boxes: boxes.length,
    plannedAssignments: boxes.filter((box) => box.assignmentStatus === 'planned').length,
    existingAssignments: boxes.filter((box) => box.assignmentStatus === 'already_assigned').length,
  };
}

function validateManifestTotals(manifest: Manifest, context: string): void {
  if (!isPlainObject(manifest.totals)) fail(`Manifest is missing totals: ${context}`);
  const expected = manifestTotals(manifest);
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = (manifest.totals as Record<string, unknown>)[key];
    if (actualValue !== expectedValue) {
      fail(`Manifest totals.${key} mismatch in ${context}: expected ${expectedValue}, found ${String(actualValue)}`);
    }
  }
}

function validateManifestShape(manifest: Manifest, runtime: ScriptDropRuntime): void {
  if (manifest.generatedByDryRun !== true) fail('Manifest was not generated by this dry-run script');
  validateManifestTotals(manifest, 'manifest');
  const seenAssets = new Set<string>();
  const seenDudeIds = new Map<number, string>();
  for (const order of manifest.orders) {
    if (!order.docPath || !order.docPath.startsWith(`drops/${TARGET_DROP_ID}/deliveryOrders/`)) fail(`Invalid manifest order path: ${order.docPath}`);
    if (!positiveInteger(order.deliveryId)) fail(`Invalid manifest deliveryId for ${order.docPath}`);
    if (!Array.isArray(order.boxes)) fail(`Manifest order ${order.docPath} is missing boxes`);
    for (const box of order.boxes) {
      if (!positiveInteger(box.boxId)) fail(`Invalid manifest box id for ${order.docPath}`);
      if (box.assignmentStatus !== 'planned' && box.assignmentStatus !== 'already_assigned') {
        fail(`Invalid manifest assignment status for ${order.docPath}/${box.boxId}`);
      }
      requireStripeReceiptClaimCode(box.receiptClaimCode);
      if (!normalizeWalletMaybe(box.receiptOwner)) fail(`Manifest box ${order.docPath}/${box.boxId} has invalid receiptOwner`);
      if (box.receiptOwnerSource !== 'claimed_recipient' && box.receiptOwnerSource !== 'receipt_owner') {
        fail(`Manifest box ${order.docPath}/${box.boxId} has invalid receiptOwnerSource`);
      }
      if (box.receiptClaimStatus !== 'claimed' && box.receiptClaimStatus !== 'unclaimed') {
        fail(`Manifest box ${order.docPath}/${box.boxId} has invalid receiptClaimStatus`);
      }
      if (typeof box.existingIrlClaimCode === 'string' && box.existingIrlClaimCode.trim()) {
        requireIrlClaimCode(box.existingIrlClaimCode, `Manifest box ${order.docPath}/${box.boxId}`);
      }
      if (!box.receiptAssetId) fail(`Manifest box ${order.docPath}/${box.boxId} is missing receiptAssetId`);
      if (seenAssets.has(box.receiptAssetId)) fail(`Manifest uses receipt asset ${box.receiptAssetId} more than once`);
      seenAssets.add(box.receiptAssetId);
      const dudeIds = normalizeDudeIds(box.dudeIds, runtime);
      if (!dudeIds.length) fail(`Manifest box ${order.docPath}/${box.boxId} has invalid dudeIds`);
      for (const dudeId of dudeIds) {
        const previousAsset = seenDudeIds.get(dudeId);
        if (previousAsset && previousAsset !== box.receiptAssetId) {
          fail(`Manifest assigns dude ${dudeId} to both ${previousAsset} and ${box.receiptAssetId}`);
        }
        seenDudeIds.set(dudeId, box.receiptAssetId);
      }
      normalizeManifestStaleDudeIds({
        raw: box.staleDudeIds,
        runtime,
        selectedDudeIds: dudeIds,
        context: `Manifest box ${order.docPath}/${box.boxId}`,
      });
    }
  }
}

function validateManifestReceiptSnapshot(params: {
  manifestBox: ManifestBox;
  receiptOwner: ReceiptOwnerResolution;
  context: string;
}): void {
  const { manifestBox, receiptOwner, context } = params;
  if (manifestBox.receiptOwner !== receiptOwner.owner) {
    fail(`${context} receipt owner changed since manifest creation`);
  }
  if (manifestBox.receiptOwnerSource !== receiptOwner.source) {
    fail(`${context} receipt owner source changed since manifest creation`);
  }
  if (manifestBox.receiptClaimStatus !== receiptOwner.claimStatus) {
    fail(`${context} receipt claim status changed since manifest creation`);
  }
}

async function revalidateManifestBox(params: {
  db: Firestore;
  runtime: ScriptDropRuntime;
  orderSnap: DocumentSnapshot;
  orderData: any;
  manifestBox: ManifestBox;
}): Promise<ReceiptOwnerResolution> {
  const { db, runtime, orderData, manifestBox } = params;
  const currentBoxes = new Set(getBoxItems(orderData).map((item) => item.boxId));
  if (!currentBoxes.has(manifestBox.boxId)) fail(`${params.orderSnap.ref.path} no longer contains box ${manifestBox.boxId}`);

  const currentClaim = existingIrlClaimsByBoxId(orderData, runtime, params.orderSnap.ref.path).get(manifestBox.boxId)?.complete;
  if (currentClaim) {
    if (!sameNumbers(currentClaim.dudeIds, manifestBox.dudeIds) || currentClaim.boxAssetId !== manifestBox.receiptAssetId) {
      fail(`${params.orderSnap.ref.path} box ${manifestBox.boxId} already has a different IRL card assignment`);
    }
    await validateExistingIrlClaimForBox({
      db,
      runtime,
      orderPath: params.orderSnap.ref.path,
      deliveryId: getOrderDeliveryId(params.orderSnap, orderData),
      boxId: manifestBox.boxId,
      claim: currentClaim,
    });
  }

  const receiptClaim = stripeReceiptClaimByBoxId(orderData, manifestBox.boxId);
  if (!receiptClaim) fail(`${params.orderSnap.ref.path} box ${manifestBox.boxId} is missing its Stripe receipt claim code`);
  if (receiptClaim.code !== manifestBox.receiptClaimCode) {
    fail(`${params.orderSnap.ref.path} box ${manifestBox.boxId} Stripe receipt claim code changed`);
  }

  const receiptOwner = await resolveReceiptOwner({
    db,
    dropId: runtime.dropId,
    deliveryId: getOrderDeliveryId(params.orderSnap, orderData),
    boxId: manifestBox.boxId,
    receiptClaim,
  });
  validateManifestReceiptSnapshot({
    manifestBox,
    receiptOwner,
    context: `${params.orderSnap.ref.path} box ${manifestBox.boxId}`,
  });
  const asset = await fetchAssetById(runtime, manifestBox.receiptAssetId);
  validateReceiptAssetForManifest({
    asset,
    assetId: manifestBox.receiptAssetId,
    owner: receiptOwner.owner,
    runtime,
    boxId: manifestBox.boxId,
    context: `${params.orderSnap.ref.path} box ${manifestBox.boxId}`,
  });

  return receiptOwner;
}

async function preflightManifestAssignments(db: Firestore, runtime: ScriptDropRuntime, manifest: Manifest): Promise<void> {
  const pool = await loadInitialPool(db, runtime);
  const available = new Set(pool);
  const assignmentSnapCache = new Map<number, Promise<DocumentSnapshot>>();
  const dudeAssignmentSnap = (dudeId: number): Promise<DocumentSnapshot> => {
    let cached = assignmentSnapCache.get(dudeId);
    if (!cached) {
      cached = db.doc(dropDudeAssignmentPath(runtime.dropId, dudeId)).get();
      assignmentSnapCache.set(dudeId, cached);
    }
    return cached;
  };

  for (const order of manifest.orders) {
    for (const manifestBox of order.boxes) {
      const dudeIds = normalizeDudeIds(manifestBox.dudeIds, runtime);
      if (!dudeIds.length) fail(`${order.docPath} box ${manifestBox.boxId} has invalid dudeIds`);
      const staleDudeIds = normalizeManifestStaleDudeIds({
        raw: manifestBox.staleDudeIds,
        runtime,
        selectedDudeIds: dudeIds,
        context: `${order.docPath} box ${manifestBox.boxId}`,
      });
      const staleDudeIdsToCheck = staleDudeIds.filter((dudeId) => available.has(dudeId));
      const staleSnaps = await Promise.all(staleDudeIdsToCheck.map(dudeAssignmentSnap));
      staleSnaps.forEach((snap, index) => {
        const staleDudeId = staleDudeIdsToCheck[index];
        if (!snap.exists) {
          fail(`${order.docPath} box ${manifestBox.boxId} stale dude ${staleDudeId} is now available; regenerate the manifest`);
        }
        available.delete(staleDudeId);
      });

      const existingAssignment = await loadExistingBoxAssignment(db, runtime, manifestBox.receiptAssetId);
      const manifestExistingCode =
        typeof manifestBox.existingIrlClaimCode === 'string' && manifestBox.existingIrlClaimCode.trim()
          ? requireIrlClaimCode(manifestBox.existingIrlClaimCode, `${order.docPath} box ${manifestBox.boxId}`)
          : '';
      if (existingAssignment) {
        const existingDudeIds = existingAssignment.dudeIds;
        if (!sameNumbers(existingDudeIds, dudeIds)) {
          fail(
            `${order.docPath} box ${manifestBox.boxId} existing assignment changed; expected ${dudeIds.join(
              ', ',
            )}, found ${existingDudeIds.join(', ')}`,
          );
        }
        const existingCode = existingAssignment.irlClaimCode
          ? requireIrlClaimCode(existingAssignment.irlClaimCode, dropBoxAssignmentPath(runtime.dropId, manifestBox.receiptAssetId))
          : '';
        if (manifestExistingCode && existingCode !== manifestExistingCode) {
          fail(`${order.docPath} box ${manifestBox.boxId} existing IRL claim code changed since manifest creation`);
        }
        dudeIds.forEach((dudeId) => available.delete(dudeId));
        continue;
      }

      if (manifestBox.assignmentStatus === 'already_assigned') {
        fail(`${order.docPath} box ${manifestBox.boxId} was already assigned in the manifest, but its assignment doc is now missing`);
      }

      const missingFromPool = dudeIds.filter((dudeId) => !available.has(dudeId));
      if (missingFromPool.length) {
        fail(`${order.docPath} box ${manifestBox.boxId} manifest dudeIds are no longer available: ${missingFromPool.join(', ')}`);
      }

      const selectedDudeIds = new Set(dudeIds);
      const assignedDudeIdsDiscovered = new Set<number>();
      const isAssigned = async (dudeId: number): Promise<boolean> => {
        const snap = await dudeAssignmentSnap(dudeId);
        if (snap.exists && !selectedDudeIds.has(dudeId)) assignedDudeIdsDiscovered.add(dudeId);
        return snap.exists;
      };

      try {
        await validateDudeIdsForAssignment({
          dropFamily: runtime.config.dropFamily,
          itemsPerBox: runtime.itemsPerBox,
          maxDudeId: runtime.maxDudeId,
          pool: [...available],
          dudeIds,
          knownAssignedDudeIds: staleDudeIdsToCheck,
          isAssigned,
        });
      } catch (err) {
        if (err instanceof DudeAssignmentValidationError) {
          fail(`${order.docPath} box ${manifestBox.boxId} manifest assignment is invalid: ${err.message}`);
        }
        throw err;
      }

      assignedDudeIdsDiscovered.forEach((dudeId) => available.delete(dudeId));
      dudeIds.forEach((dudeId) => available.delete(dudeId));
    }
  }
}

async function buildExecutePlan(db: Firestore, runtime: ScriptDropRuntime, manifest: Manifest): Promise<ExecutePlanOrder[]> {
  validateManifestShape(manifest, runtime);
  const plan: ExecutePlanOrder[] = [];

  for (const order of manifest.orders) {
    const orderSnap = await db.doc(order.docPath).get();
    if (!orderSnap.exists) fail(`Delivery order not found: ${order.docPath}`);
    const orderData = orderSnap.data() as any;
    if (orderData?.source !== 'stripe_offchain' || orderData?.status !== 'ready_to_ship') {
      fail(`${order.docPath} is no longer a ready_to_ship Stripe offchain order`);
    }
    if (getOrderDeliveryId(orderSnap, orderData) !== order.deliveryId) {
      fail(`${order.docPath} delivery id changed`);
    }

    const boxes: ExecutePlanBox[] = [];
    for (const manifestBox of order.boxes) {
      const receiptOwner = await revalidateManifestBox({ db, runtime, orderSnap, orderData, manifestBox });
      boxes.push({ manifestBox, receiptOwner });
    }
    plan.push({ order, boxes });
  }

  await preflightManifestAssignments(db, runtime, manifest);
  return plan;
}

type OrderIrlClaimInput = { code: string; boxId: number; boxAssetId: string; dudeIds: number[] };

async function upsertOrderIrlClaims(params: {
  db: Firestore;
  runtime: ScriptDropRuntime;
  orderPath: string;
  claims: OrderIrlClaimInput[];
}): Promise<void> {
  const orderRef = params.db.doc(params.orderPath);
  await params.db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) fail(`Delivery order disappeared: ${params.orderPath}`);
    const order = snap.data() as any;
    if (order?.source !== 'stripe_offchain' || order?.status !== 'ready_to_ship') {
      fail(`${params.orderPath} is no longer a ready_to_ship Stripe offchain order`);
    }
    const existingClaims = existingIrlClaimsByBoxId(order, params.runtime, params.orderPath);
    const byBoxId = new Map<number, any>();
    for (const entry of existingClaims.values()) {
      byBoxId.set(entry.boxId, entry.complete || entry.raw);
    }
    for (const claim of params.claims) {
      const existing = existingClaims.get(claim.boxId)?.complete || null;
      if (
        existing &&
        (!sameNumbers(existing.dudeIds, claim.dudeIds) || existing.boxAssetId !== claim.boxAssetId || existing.code !== claim.code)
      ) {
        fail(`${params.orderPath} box ${claim.boxId} has a conflicting IRL claim`);
      }
      byBoxId.set(claim.boxId, claim);
    }
    const irlClaims = Array.from(byBoxId.values()).sort((a, b) => Number(a.boxId) - Number(b.boxId));
    tx.set(
      orderRef,
      {
        irlClaims,
        irlClaimsUpdatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
}

async function executeManifest(db: Firestore, runtime: ScriptDropRuntime, manifest: Manifest) {
  const plan = await buildExecutePlan(db, runtime, manifest);
  const results: Array<{ orderPath: string; boxes: number; createdAssignments: number }> = [];

  for (const plannedOrder of plan) {
    const order = plannedOrder.order;
    let createdAssignments = 0;
    for (const plannedBox of plannedOrder.boxes) {
      const { manifestBox, receiptOwner } = plannedBox;
      const assignment = await assignSpecificDudesForBox({
        db,
        dropRuntime: runtime,
        boxAssetId: manifestBox.receiptAssetId,
        dudeIds: manifestBox.dudeIds,
        staleDudeIds: manifestBox.staleDudeIds,
        logger: console,
      });
      if (assignment.created) createdAssignments += 1;
      const code = await ensureIrlClaimCodeForBox({
        db,
        dropRuntime: runtime,
        ownerWallet: receiptOwner.owner,
        deliveryId: order.deliveryId,
        boxAssetId: manifestBox.receiptAssetId,
        boxId: manifestBox.boxId,
        dudeIds: assignment.dudeIds,
        logger: console,
      });
      const claim = {
        code,
        boxId: manifestBox.boxId,
        boxAssetId: manifestBox.receiptAssetId,
        dudeIds: assignment.dudeIds,
      };
      await upsertOrderIrlClaims({ db, runtime, orderPath: order.docPath, claims: [claim] });
    }
    results.push({ orderPath: order.docPath, boxes: plannedOrder.boxes.length, createdAssignments });
  }
  return {
    orders: results.length,
    boxes: results.reduce((sum, result) => sum + result.boxes, 0),
    createdAssignments: results.reduce((sum, result) => sum + result.createdAssignments, 0),
    results,
  };
}

async function main() {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  requireEnv('HELIUS_API_KEY', 'Set it in functions/.env.local or export it before running this script.');
  const db = initDb();
  const config = requireFunctionsDrop(TARGET_DROP_ID);
  if (config.dropFamily !== 'card_nft_2') fail(`${TARGET_DROP_ID} config is not a card_nft_2 drop`);
  const runtime = buildScriptDropRuntime(config);

  if (args.execute) {
    const manifest = await loadManifest(args.manifest!);
    const result = await executeManifest(db, runtime, manifest);
    if (args.json) {
      console.log(JSON.stringify({ mode: 'execute', result }, null, 2));
    } else {
      console.log(`Execute complete. Orders updated: ${result.orders}; boxes updated: ${result.boxes}; new assignments: ${result.createdAssignments}.`);
    }
    return;
  }

  const manifest = await buildDryRunManifest(db, runtime, args);
  const manifestPath = await writeManifest(manifest);
  if (args.json) {
    console.log(JSON.stringify({ mode: 'dry_run', manifestPath, manifest }, null, 2));
    return;
  }
  console.log('Dry run complete. Planned manifest saved; no Firestore writes performed.');
  console.log(`Manifest: ${manifestPath}`);
  console.log(
    `Orders: ${manifest.totals.orders}; boxes: ${manifest.totals.boxes}; planned assignments: ${manifest.totals.plannedAssignments}; existing assignments: ${manifest.totals.existingAssignments}.`,
  );
  console.log(`Pass --execute --manifest ${manifestPath} to apply exactly these assignments and update order IRL claims.`);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && path.resolve(entry) === fileURLToPath(import.meta.url));
}

export const assignStripeOrderCardsTestHooks = {
  existingIrlClaimsByBoxId,
  preflightManifestAssignments,
  validateManifestShape,
  validateManifestTotals,
  validateManifestReceiptSnapshot,
  validateReceiptAssetForManifest,
};

if (isDirectRun()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack || err.message : err);
    process.exit(1);
  });
}
