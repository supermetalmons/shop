import { pathToFileURL } from 'node:url';
import { normalizeDropId, requireApiDrop } from '../../cloud/workers/api/src/dropConfig.ts';
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
  shouldTrackPackStatusForDrop,
  type PackStatusCounters,
  type PackStatusDeliveryOrderRecord,
  type PackStatusDropRuntime,
} from '../shared/packStatus.ts';
import {
  hasPackStatusOutboxSchema,
  queryRemoteCommerceD1,
  queryRemoteCommerceDocuments,
  sqlString,
  type CommerceD1Document,
} from '../shared/commerceD1Maintenance.ts';
import { parsePackStatusOutboxRow, type PackStatusOutboxRecord } from '../../shared/packStatusOutbox.ts';
import { LEGACY_PACK_STATUS_PROJECTION_FIELDS } from '../shared/packStatusOutboxMaintenance.ts';
import {
  readD1Integrity,
  writeD1RebuiltSummaries,
} from '../shared/d1PackStatusMaintenance.ts';

type Args = {
  dropIds: string[];
  write: boolean;
  json: boolean;
};

function usage(): string {
  return [
    'Rebuild the public pack-status counters from Commerce D1 history.',
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
    fail(`Unknown arg: ${arg}\n\n${usage()}`);
  }

  if (all && dropId) fail('--all and --drop-id are mutually exclusive.');
  return {
    dropIds: all ? [...PACK_STATUS_SUPPORTED_DROP_IDS] : [dropId || PACK_STATUS_SUPPORTED_DROP_IDS[0]],
    write,
    json,
  };
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

export function requireSettledPackStatusProjectionOutboxes(
  deliveryOrders: readonly PackStatusDeliveryOrderRecord[],
  outboxes?: readonly PackStatusOutboxRecord[],
): void {
  if (outboxes !== undefined) {
    if (outboxes.some((outbox) => outbox.state !== 'completed' && outbox.state !== 'cancelled')) {
      fail('Pack-status rebuild requires every durable delivery projection outbox to be settled.');
    }
    return;
  }
  for (const order of deliveryOrders) {
    const state = (order as Record<string, unknown>)?.packStatusProjectionState;
    if (state !== undefined && state !== 'completed') {
      fail('Pack-status rebuild requires every durable delivery projection outbox to be settled.');
    }
  }
}

export type PackStatusCommerceSnapshot = {
  assignments: CommerceD1Document[];
  deliveryOrders: CommerceD1Document[];
  packStatusOutboxes?: PackStatusOutboxRecord[];
};

function requirePackStatusOutboxParents(snapshot: PackStatusCommerceSnapshot): void {
  if (snapshot.packStatusOutboxes === undefined) return;
  const parents = new Map(snapshot.deliveryOrders.map((document) => [document.path, document]));
  const outboxes = new Map(snapshot.packStatusOutboxes.map((outbox) => [outbox.parentPath, outbox]));
  for (const outbox of snapshot.packStatusOutboxes) {
    if (parents.get(outbox.parentPath)?.dropId !== outbox.dropId) fail('Pack-status outbox parent is invalid.');
  }
  for (const parent of snapshot.deliveryOrders) {
    if (LEGACY_PACK_STATUS_PROJECTION_FIELDS.some((field) => Object.hasOwn(parent.data, field)) && !outboxes.has(parent.path)) {
      fail(`Pack-status outbox is missing: ${parent.path}.`);
    }
  }
}

function loadCommerceDocuments(
  dropId: string,
  kind: 'box_assignment' | 'delivery_order',
  query: typeof queryRemoteCommerceD1,
): CommerceD1Document[] {
  return queryRemoteCommerceDocuments(`SELECT document_path, document_kind, drop_id, document_id,
    document_json, version, create_time, update_time FROM commerce_documents
    WHERE document_kind = ${sqlString(kind)} AND drop_id = ${sqlString(dropId)}
    ORDER BY document_path`, query);
}

export function readPackStatusCommerceSnapshot(
  dropId: string,
  query: typeof queryRemoteCommerceD1 = queryRemoteCommerceD1,
): PackStatusCommerceSnapshot {
  const snapshot: PackStatusCommerceSnapshot = {
    assignments: loadCommerceDocuments(dropId, 'box_assignment', query),
    deliveryOrders: loadCommerceDocuments(dropId, 'delivery_order', query),
  };
  if (hasPackStatusOutboxSchema(query)) {
    const controls = query('SELECT storage_mode FROM commerce_pack_status_outbox_control WHERE singleton = 1');
    if (controls.length !== 1 || (controls[0].storage_mode !== 'legacy' && controls[0].storage_mode !== 'table')) {
      fail('Pack-status outbox control is invalid.');
    }
    if (controls[0].storage_mode === 'table') {
      snapshot.packStatusOutboxes = query(`SELECT * FROM commerce_pack_status_outbox
        WHERE drop_id = ${sqlString(dropId)} ORDER BY parent_path`).map(parsePackStatusOutboxRow);
      requirePackStatusOutboxParents(snapshot);
    }
  }
  return snapshot;
}

export function rebuildPackStatusCounters(
  dropRuntime: PackStatusDropRuntime,
  snapshot: PackStatusCommerceSnapshot = readPackStatusCommerceSnapshot(dropRuntime.dropId),
): {
  counters: PackStatusCounters;
  historicalAssignmentCounts: {
    boxAssignments: number;
    irlClaimAssignments: number;
    adminIrlAssignments: number;
    inFlightNormalAssignments: number;
  };
} {
  const assignments = snapshot.assignments.map((document) => document.data);
  const deliveryOrders = snapshot.deliveryOrders.map((document) => document.data) as PackStatusDeliveryOrderRecord[];
  requirePackStatusOutboxParents(snapshot);
  const assignmentCount = assignments.length;
  const irlClaimAssignmentCount = assignments.filter((assignment) =>
    assignment.irlClaim && typeof assignment.irlClaim === 'object' &&
    !Array.isArray(assignment.irlClaim) &&
    (assignment.irlClaim as Record<string, unknown>).namespace === IRL_CLAIM_CODE_NAMESPACE
  ).length;
  requireSettledPackStatusProjectionOutboxes(deliveryOrders, snapshot.packStatusOutboxes);

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
  const assignmentByAssetId = new Map(snapshot.assignments.map((document) => [document.documentId, document.data]));
  const inFlightNormalAssignments = [...inFlightNormalBoxAssetIds].filter((boxAssetId) => {
    const assignment = assignmentByAssetId.get(boxAssetId);
    return assignment && assignmentHasNormalInFlightPackStatusClaim(assignment);
  }).length;
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
  const results = args.dropIds.map((dropId) => {
    const dropRuntime = requireSupportedPackStatusDrop(dropId);
    const result = rebuildPackStatusCounters(dropRuntime);
    return {
      ...result,
      breakdown: buildPackStatusBreakdown(result.counters),
    };
  });
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
