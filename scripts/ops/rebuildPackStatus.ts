import { createPrivateKey } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Firestore, type DocumentSnapshot } from '@google-cloud/firestore';
import { normalizeDropId, requireApiDrop } from '../../cloud/workers/api/src/dropConfig.ts';
import { dropDeliveryOrdersCollectionPath, dropRootPath } from '../../cloud/workers/api/src/dropPaths.ts';
import { IRL_CLAIM_CODE_NAMESPACE } from '../../cloud/workers/api/src/claimCodes.ts';
import {
  ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
  STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
} from '../../shared/fulfillmentSources.ts';
import {
  PACK_STATUS_SUPPORTED_DROP_IDS,
  assignmentHasNormalInFlightPackStatusClaim,
  buildPackStatusBreakdown,
  buildPackStatusCountersFromRebuildInputs,
  deliveryOrderBoxAssetIds,
  isPackStatusSupportedDropId,
  packStatusAssignmentRef,
  shouldTrackPackStatusForDrop,
  type PackStatusCounters,
  type PackStatusDeliveryOrderRecord,
  type PackStatusDropRuntime,
} from '../shared/packStatus.ts';
import {
  firestoreReaderServiceAccountEmail,
  readCloudflareFirestoreKeychainCredential,
} from '../cloudflare-firestore-keychain.ts';
import {
  readD1Integrity,
  writeD1RebuiltSummaries,
} from '../shared/d1PackStatusMaintenance.ts';

type Args = {
  dropIds: string[];
  firestoreServiceAccountFile?: string;
  write: boolean;
  json: boolean;
};

type Credential = {
  client_email: string;
  private_key: string;
  project_id: string;
};

const ASSIGNMENT_READ_BATCH_SIZE = 100;
const PROJECT_ID = 'mons-shop';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function usage(): string {
  return [
    'Rebuild the public pack-status counters from Firestore history.',
    '',
    'Usage:',
    '  npm run rebuild-pack-status',
    '  npm run rebuild-pack-status -- --write',
    '  npm run rebuild-pack-status -- --all --write',
    '  npm run rebuild-pack-status -- --drop-id card_nft_2 --json',
    '',
    'Options:',
    `  --drop-id <id>  Drop to rebuild: ${PACK_STATUS_SUPPORTED_DROP_IDS.join(', ')}`,
    '  --all           Rebuild every supported drop',
    '  --write         Replace the D1 summary and bump its cache generation',
    '  --firestore-service-account-file <path>  Use a reviewed reader credential file',
    '  --json          Print machine-readable output',
    '  -h, --help      Show this help',
  ].join('\n');
}

function fail(message: string): never {
  throw new Error(message);
}

export function parseArgs(argv: string[]): Args {
  let all = false;
  let dropId: string | undefined;
  let firestoreServiceAccountFile: string | undefined;
  let write = false;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--write') {
      write = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--all') {
      if (all) fail('--all may only be provided once.');
      all = true;
      continue;
    }
    if (arg === '--drop-id') {
      const value = argv[i + 1];
      if (!value) fail(`Missing value for ${arg}\n\n${usage()}`);
      if (dropId) fail('--drop-id may only be provided once.');
      dropId = value;
      i += 1;
      continue;
    }
    if (arg === '--firestore-service-account-file') {
      const value = argv[i + 1];
      if (!value) fail(`Missing value for ${arg}\n\n${usage()}`);
      if (firestoreServiceAccountFile) fail('--firestore-service-account-file may only be provided once.');
      firestoreServiceAccountFile = value;
      i += 1;
      continue;
    }
    fail(`Unknown arg: ${arg}\n\n${usage()}`);
  }

  if (all && dropId) fail('--all and --drop-id are mutually exclusive.');
  return {
    dropIds: all ? [...PACK_STATUS_SUPPORTED_DROP_IDS] : [dropId || PACK_STATUS_SUPPORTED_DROP_IDS[0]],
    ...(firestoreServiceAccountFile ? { firestoreServiceAccountFile } : {}),
    write,
    json,
  };
}

function parseCredential(value: string): Credential {
  if (!value || Buffer.byteLength(value, 'utf8') > 64 * 1024) {
    fail('Firestore reader credential is empty or oversized.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fail('Firestore reader credential is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('Firestore reader credential must contain one JSON object.');
  }
  const record = parsed as Record<string, unknown>;
  const rawPrivateKey = typeof record.private_key === 'string' ? record.private_key : '';
  const credential = {
    client_email: typeof record.client_email === 'string' ? record.client_email.trim() : '',
    private_key: rawPrivateKey ? `${rawPrivateKey.trimEnd()}\n` : '',
    project_id: typeof record.project_id === 'string' ? record.project_id.trim() : '',
  };
  if (
    credential.client_email !== firestoreReaderServiceAccountEmail ||
    credential.project_id !== PROJECT_ID ||
    !credential.private_key.startsWith('-----BEGIN PRIVATE KEY-----\n') ||
    !credential.private_key.endsWith('-----END PRIVATE KEY-----\n') ||
    credential.private_key.length > 32 * 1024
  ) fail('Firestore reader credential does not match the reviewed service account.');
  try {
    createPrivateKey(credential.private_key);
  } catch {
    fail('Firestore reader credential does not contain a valid PKCS8 private key.');
  }
  return credential;
}

export function readRebuildFirestoreCredential(path: string | undefined): Credential {
  if (!path) {
    return parseCredential(readCloudflareFirestoreKeychainCredential(firestoreReaderServiceAccountEmail));
  }
  const resolvedPath = resolve(repoRoot, path);
  let entry;
  try {
    entry = lstatSync(resolvedPath);
  } catch {
    return fail('Firestore reader credential file could not be inspected.');
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    fail('Firestore reader credential must be a regular non-symlink file.');
  }
  if ((entry.mode & 0o077) !== 0) {
    fail('Firestore reader credential file permissions must not allow group or other access.');
  }
  if (entry.size <= 0 || entry.size > 64 * 1024) {
    fail('Firestore reader credential file is empty or oversized.');
  }
  let value: string;
  try {
    value = readFileSync(resolvedPath, 'utf8');
  } catch {
    return fail('Firestore reader credential file could not be read.');
  }
  return parseCredential(value);
}

function firestore(credential: Credential): Firestore {
  return new Firestore({
    projectId: PROJECT_ID,
    credentials: {
      client_email: credential.client_email,
      private_key: credential.private_key,
    },
  });
}

export function requireSupportedPackStatusDrop(dropId: string): PackStatusDropRuntime {
  const normalizedDropId = normalizeDropId(dropId);
  if (!isPackStatusSupportedDropId(normalizedDropId)) {
    fail(`Pack status rebuild only supports ${PACK_STATUS_SUPPORTED_DROP_IDS.join(', ')}. Received: ${dropId}`);
  }
  const drop = requireApiDrop(normalizedDropId);
  const dropRuntime = {
    dropId: drop.dropId,
    cluster: drop.solanaCluster,
    itemsPerBox: drop.itemsPerBox,
    maxSupply: drop.maxSupply,
  };
  if (!shouldTrackPackStatusForDrop(dropRuntime)) {
    fail(`Pack status is only supported for mainnet drops: ${PACK_STATUS_SUPPORTED_DROP_IDS.join(', ')}.`);
  }
  return dropRuntime;
}

function packStatusItemPlural(dropId: string): string {
  return dropId === 'little_swag_boxes' ? 'figures' : 'cards';
}

function packStatusContainerPlural(dropId: string): string {
  return dropId === 'little_swag_boxes' ? 'boxes' : 'packs';
}

async function aggregateCount(query: any): Promise<number> {
  if (typeof query?.count === 'function') {
    const snap = await query.count().get();
    return Math.max(0, Math.floor(Number(snap.data()?.count) || 0));
  }
  const snap = await query.get();
  return Math.max(0, Math.floor(Number(snap?.size ?? snap?.docs?.length) || 0));
}

async function fetchDeliveryOrders(db: Firestore, dropId: string): Promise<PackStatusDeliveryOrderRecord[]> {
  let query: any = db.collection(dropDeliveryOrdersCollectionPath(dropId));
  if (typeof query.select === 'function') {
    query = query.select(
      'status',
      'source',
      'items',
      'adminIrlRedeem',
      'metadataId',
      'metadataIds',
      'quantity',
      'packStatusProjectionState',
    );
  }
  const snap = await query.get();
  return (snap.docs || []).map((doc: any) => doc.data());
}

export function requireSettledPackStatusProjectionOutboxes(
  deliveryOrders: readonly PackStatusDeliveryOrderRecord[],
): void {
  for (const order of deliveryOrders) {
    const state = (order as Record<string, unknown>)?.packStatusProjectionState;
    if (state !== undefined && state !== 'completed') {
      fail('Pack-status rebuild requires every durable delivery projection outbox to be settled.');
    }
  }
}

async function fetchAssignmentSnaps(db: Firestore, dropId: string, boxAssetIds: Set<string>): Promise<DocumentSnapshot[]> {
  if (!boxAssetIds.size) return [];
  const refs = [...boxAssetIds].map((boxAssetId) => packStatusAssignmentRef(db, dropId, boxAssetId));
  const snaps: DocumentSnapshot[] = [];
  for (let i = 0; i < refs.length; i += ASSIGNMENT_READ_BATCH_SIZE) {
    snaps.push(...(await db.getAll(...refs.slice(i, i + ASSIGNMENT_READ_BATCH_SIZE))));
  }
  return snaps;
}

async function countAssignedInFlightNormalBoxes(db: Firestore, dropId: string, boxAssetIds: Set<string>): Promise<number> {
  const snaps = await fetchAssignmentSnaps(db, dropId, boxAssetIds);
  return snaps.filter((snap) => snap.exists && assignmentHasNormalInFlightPackStatusClaim(snap.data())).length;
}

export async function rebuildPackStatusCounters(db: Firestore, dropRuntime: PackStatusDropRuntime): Promise<{
  counters: PackStatusCounters;
  historicalAssignmentCounts: {
    boxAssignments: number;
    irlClaimAssignments: number;
    adminIrlAssignments: number;
    inFlightNormalAssignments: number;
  };
}> {
  const assignmentCollection = db.collection(`${dropRootPath(dropRuntime.dropId)}/boxAssignments`);
  const [assignmentCount, irlClaimAssignmentCount, deliveryOrders] = await Promise.all([
    aggregateCount(assignmentCollection),
    aggregateCount(assignmentCollection.where('irlClaim.namespace', '==', IRL_CLAIM_CODE_NAMESPACE)),
    fetchDeliveryOrders(db, dropRuntime.dropId),
  ]);
  requireSettledPackStatusProjectionOutboxes(deliveryOrders);

  const inFlightNormalBoxAssetIds = new Set<string>();
  const adminIrlReceiptAssetIds = new Set<string>();
  for (const order of deliveryOrders) {
    if (order?.status === 'ready_to_ship' && order?.source === ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE) {
      deliveryOrderBoxAssetIds(order?.items).forEach((assetId) => adminIrlReceiptAssetIds.add(assetId));
      continue;
    }
    if (order?.status === 'ready_to_ship' || order?.source === STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE) continue;
    deliveryOrderBoxAssetIds(order?.items).forEach((assetId) => inFlightNormalBoxAssetIds.add(assetId));
  }
  const adminIrlAssignments = adminIrlReceiptAssetIds.size;
  const inFlightNormalAssignments = await countAssignedInFlightNormalBoxes(db, dropRuntime.dropId, inFlightNormalBoxAssetIds);
  const counters = buildPackStatusCountersFromRebuildInputs({
    dropRuntime,
    assignmentCount,
    irlClaimAssignmentCount,
    adminIrlAssignmentCount: adminIrlAssignments,
    inFlightNormalAssignments,
    deliveryOrders,
  });
  return {
    counters,
    historicalAssignmentCounts: {
      boxAssignments: assignmentCount,
      irlClaimAssignments: irlClaimAssignmentCount,
      adminIrlAssignments,
      inFlightNormalAssignments,
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = firestore(readRebuildFirestoreCredential(args.firestoreServiceAccountFile));
  try {
    const results = await Promise.all(args.dropIds.map(async (dropId) => {
      const dropRuntime = requireSupportedPackStatusDrop(dropId);
      const result = await rebuildPackStatusCounters(db, dropRuntime);
      return {
        ...result,
        breakdown: buildPackStatusBreakdown(result.counters),
      };
    }));
    let cacheGeneration: number | undefined;
    if (args.write) {
      const before = readD1Integrity();
      writeD1RebuiltSummaries(results.map((result) => result.counters), before.drops);
      const after = readD1Integrity();
      const beforeEvents = before.drops.map((drop) => ({
        appliedEventCount: drop.appliedEventCount,
        dropId: drop.dropId,
        eventCount: drop.eventCount,
        historicalEventCount: drop.historicalEventCount,
      }));
      const afterEvents = after.drops.map((drop) => ({
        appliedEventCount: drop.appliedEventCount,
        dropId: drop.dropId,
        eventCount: drop.eventCount,
        historicalEventCount: drop.historicalEventCount,
      }));
      if (JSON.stringify(afterEvents) !== JSON.stringify(beforeEvents)) {
        fail('D1 events changed during summary rebuild.');
      }
      if (after.cacheGeneration !== before.cacheGeneration + 1) {
        fail('D1 cache generation did not advance exactly once during summary rebuild.');
      }
      cacheGeneration = after.cacheGeneration;
    }

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            dryRun: !args.write,
            ...(cacheGeneration === undefined ? {} : { cacheGeneration }),
            results,
          },
          null,
          2,
        ),
      );
    } else {
      for (const result of results) {
        const itemPlural = packStatusItemPlural(result.counters.dropId);
        const containerPlural = packStatusContainerPlural(result.counters.dropId);
        console.log(`${args.write ? 'Writing' : 'Dry run for'} pack status: ${result.counters.dropId}`);
        console.log(`  Redeemed ${itemPlural}:          ${result.breakdown.redeemedCards}`);
        console.log(`  Unsealed ${itemPlural}:          ${result.breakdown.unsealedCards}`);
        console.log(`  Total ${itemPlural}:             ${result.breakdown.totalCards}`);
        console.log(`  Unsealed online ${containerPlural}:   ${result.breakdown.unsealedOnline}`);
        console.log(`  Redeemed IRL ${containerPlural}:      ${result.breakdown.redeemedIrl}`);
        console.log(`  Redeemed unsealed ${itemPlural}: ${result.breakdown.redeemedUnsealedCards}`);
        console.log(`  Assignments:             ${result.historicalAssignmentCounts.boxAssignments}`);
        console.log(`  IRL assignments:         ${result.historicalAssignmentCounts.irlClaimAssignments}`);
        console.log(`  Admin IRL assignments:   ${result.historicalAssignmentCounts.adminIrlAssignments}`);
        console.log(`  In-flight boxes:         ${result.historicalAssignmentCounts.inFlightNormalAssignments}`);
      }
    }

    if (!args.write) {
      if (!args.json) console.log('No D1 writes performed. Pass --write to replace the selected summaries.');
      return;
    }

    if (!args.json) {
      console.log(
        `Wrote ${results.length} D1 pack-status ${results.length === 1 ? 'summary' : 'summaries'}; cache generation is ${cacheGeneration}.`,
      );
    }
  } finally {
    await db.terminate();
  }
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
