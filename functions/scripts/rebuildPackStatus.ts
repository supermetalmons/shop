import { pathToFileURL } from 'node:url';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import { normalizeDropId, requireFunctionsDrop } from '../src/config/deployment.ts';
import { dropDeliveryOrdersCollectionPath, dropRootPath } from '../src/dropPaths.ts';
import { IRL_CLAIM_CODE_NAMESPACE } from '../src/claimCodes.ts';
import {
  PACK_STATUS_DEFAULT_DROP_ID,
  PACK_STATUS_SUPPORTED_DROP_IDS,
  assignmentHasNormalInFlightPackStatusClaim,
  buildPackStatusBreakdown,
  buildPackStatusCountersFromRebuildInputs,
  buildPackStatusStatsDocument,
  deliveryOrderBoxAssetIds,
  isPackStatusSupportedDropId,
  packStatusAssignmentRef,
  packStatusStatsRef,
  shouldTrackPackStatusForDrop,
  type PackStatusCounters,
  type PackStatusDeliveryOrderRecord,
  type PackStatusDropRuntime,
} from '../src/packStatus.ts';

type Args = {
  dropId: string;
  write: boolean;
  json: boolean;
};

const ASSIGNMENT_READ_BATCH_SIZE = 100;

function usage(): string {
  return [
    'Rebuild the public pack-status counters from Firestore history.',
    '',
    'Usage:',
    '  npm run rebuild-pack-status',
    '  npm run rebuild-pack-status -- --write',
    '  npm run rebuild-pack-status -- --drop-id card_nft_2 --json',
    '',
    'Options:',
    `  --drop-id <id>  Drop to rebuild: ${PACK_STATUS_SUPPORTED_DROP_IDS.join(', ')} (default: ${PACK_STATUS_DEFAULT_DROP_ID})`,
    '  --write         Overwrite drops/<drop>/meta/packStatus',
    '  --json          Print machine-readable output',
    '  -h, --help      Show this help',
  ].join('\n');
}

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dropId: PACK_STATUS_DEFAULT_DROP_ID, write: false, json: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--write') {
      args.write = true;
      continue;
    }
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (arg === '--drop-id') {
      const value = argv[i + 1];
      if (!value) fail(`Missing value for ${arg}\n\n${usage()}`);
      args.dropId = value;
      i += 1;
      continue;
    }
    fail(`Unknown arg: ${arg}\n\n${usage()}`);
  }

  return args;
}

export function requireSupportedPackStatusDrop(dropId: string): PackStatusDropRuntime {
  const normalizedDropId = normalizeDropId(dropId);
  if (!isPackStatusSupportedDropId(normalizedDropId)) {
    fail(`Pack status rebuild only supports ${PACK_STATUS_SUPPORTED_DROP_IDS.join(', ')}. Received: ${dropId}`);
  }
  const drop = requireFunctionsDrop(normalizedDropId);
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
    query = query.select('status', 'source', 'items', 'metadataId', 'metadataIds', 'quantity');
  }
  const snap = await query.get();
  return (snap.docs || []).map((doc: any) => doc.data());
}

async function countAssignedInFlightNormalBoxes(db: Firestore, dropId: string, boxAssetIds: Set<string>): Promise<number> {
  if (!boxAssetIds.size) return 0;
  const refs = [...boxAssetIds].map((boxAssetId) => packStatusAssignmentRef(db, dropId, boxAssetId));
  const snaps: DocumentSnapshot[] = [];
  for (let i = 0; i < refs.length; i += ASSIGNMENT_READ_BATCH_SIZE) {
    snaps.push(...(await db.getAll(...refs.slice(i, i + ASSIGNMENT_READ_BATCH_SIZE))));
  }
  return snaps.filter((snap) => snap.exists && assignmentHasNormalInFlightPackStatusClaim(snap.data())).length;
}

export async function rebuildPackStatusCounters(db: Firestore, dropRuntime: PackStatusDropRuntime): Promise<{
  counters: PackStatusCounters;
  historicalAssignmentCounts: {
    boxAssignments: number;
    irlClaimAssignments: number;
    inFlightNormalAssignments: number;
  };
}> {
  const assignmentCollection = db.collection(`${dropRootPath(dropRuntime.dropId)}/boxAssignments`);
  const [assignmentCount, irlClaimAssignmentCount, deliveryOrders] = await Promise.all([
    aggregateCount(assignmentCollection),
    aggregateCount(assignmentCollection.where('irlClaim.namespace', '==', IRL_CLAIM_CODE_NAMESPACE)),
    fetchDeliveryOrders(db, dropRuntime.dropId),
  ]);

  const inFlightNormalBoxAssetIds = new Set<string>();
  for (const order of deliveryOrders) {
    if (order?.status === 'ready_to_ship' || order?.source === 'stripe_offchain') continue;
    deliveryOrderBoxAssetIds(order?.items).forEach((assetId) => inFlightNormalBoxAssetIds.add(assetId));
  }
  const inFlightNormalAssignments = await countAssignedInFlightNormalBoxes(db, dropRuntime.dropId, inFlightNormalBoxAssetIds);
  const counters = buildPackStatusCountersFromRebuildInputs({
    dropRuntime,
    assignmentCount,
    irlClaimAssignmentCount,
    inFlightNormalAssignments,
    deliveryOrders,
  });
  return {
    counters,
    historicalAssignmentCounts: {
      boxAssignments: assignmentCount,
      irlClaimAssignments: irlClaimAssignmentCount,
      inFlightNormalAssignments,
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dropRuntime = requireSupportedPackStatusDrop(args.dropId);
  const app = getApps()[0] || initializeApp();
  const db = getFirestore(app);
  const result = await rebuildPackStatusCounters(db, dropRuntime);
  const breakdown = buildPackStatusBreakdown(result.counters);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          dryRun: !args.write,
          counters: result.counters,
          breakdown,
          historicalAssignmentCounts: result.historicalAssignmentCounts,
        },
        null,
        2,
      ),
    );
  } else {
    const itemPlural = packStatusItemPlural(dropRuntime.dropId);
    const containerPlural = packStatusContainerPlural(dropRuntime.dropId);
    console.log(`${args.write ? 'Writing' : 'Dry run for'} pack status: ${dropRuntime.dropId}`);
    console.log(`  Redeemed ${itemPlural}:          ${breakdown.redeemedCards}`);
    console.log(`  Unsealed ${itemPlural}:          ${breakdown.unsealedCards}`);
    console.log(`  Total ${itemPlural}:             ${breakdown.totalCards}`);
    console.log(`  Unsealed online ${containerPlural}:   ${breakdown.unsealedOnline}`);
    console.log(`  Redeemed IRL ${containerPlural}:      ${breakdown.redeemedIrl}`);
    console.log(`  Redeemed unsealed ${itemPlural}: ${breakdown.redeemedUnsealedCards}`);
    console.log(`  Assignments:             ${result.historicalAssignmentCounts.boxAssignments}`);
    console.log(`  IRL assignments:         ${result.historicalAssignmentCounts.irlClaimAssignments}`);
    console.log(`  In-flight boxes:         ${result.historicalAssignmentCounts.inFlightNormalAssignments}`);
  }

  if (!args.write) {
    if (!args.json) console.log('No Firestore writes performed. Pass --write to overwrite counters.');
    return;
  }

  await packStatusStatsRef(db, dropRuntime.dropId).set(buildPackStatusStatsDocument(result.counters));
  if (!args.json) console.log(`Wrote drops/${dropRuntime.dropId}/meta/packStatus.`);
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
