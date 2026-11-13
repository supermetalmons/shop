import { parseDeliveryRecoveryRecord, parseDeliveryRecoveryRow, type DeliveryRecoveryRecord } from '../../shared/deliveryRecoveryState.ts';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import {
  planCanonicalDiscountMerkleDatasetRemoval,
  type DiscountMerkleDatasetReference,
} from '../shared/discountMerkleDataset.ts';
import {
  acquireCommerceAuthorityLease,
  executeRemoteCommerceD1File,
  queryRemoteCommerceD1,
  queryRemoteCommerceDocuments,
  readRemoteCommerceAuthority,
  releaseCommerceAuthorityLease,
  renewCommerceAuthorityLease,
  safeInteger,
  sqlString,
  type CommerceAuthorityQuery,
  type CommerceD1Authority,
  type CommerceD1Document,
} from '../shared/commerceD1Maintenance.ts';
import { readD1Integrity } from '../shared/d1PackStatusMaintenance.ts';
import { queryRemoteOpsD1 } from '../shared/opsD1Maintenance.ts';
import {
  acquireDeploymentRegistryMutationLock,
  clonePaymentRoutingConfig,
  defaultDropFamilyForDropId,
  normalizeDropId,
  normalizeAndValidateDropId,
  readDeploymentDropRegistry,
  renderDeploymentRegistryFileFromSource,
  type BoxMinterConfigTombstone,
} from '../shared/deploymentRegistry.ts';

import {
  deterministicQuarantineRelativePath,
  isCanonicalDropFile,
  parseWipeRecoveryManifest,
  recoveryFingerprintMatchesSnapshot,
  recoveryTargetAuthenticatesLivePath,
  renderWipeRecoveryManifest,
  wipeRecoveryManifestPath,
  type WipeRecoveryManifest,
} from './repoWipeRecovery.ts';
import {
  localPathEntryExists,
  sha256LocalSnapshot,
  snapshotLocalFile,
  type LocalFileSnapshot,
} from './repoWipeSnapshot.ts';
import {
  abortPreparedRepoWipe,
  applyPreparedRepoWipe,
  assertRepoWipeRegistryWritable,
  prepareRepoWipe,
  type CanonicalDeleteTarget,
  type RepoPlan,
} from './repoWipeTransaction.ts';

export type { LocalFileSnapshot } from './repoWipeSnapshot.ts';
export {
  abortPreparedRepoWipe,
  applyPreparedRepoWipe,
  applyRepoWipe,
  assertRepoWipeRegistryWritable,
  prepareRepoWipe,
  RepoWipePostCommitCleanupError,
  type CanonicalDeleteTarget,
  type PreparedRepoWipe,
  type RepoPlan,
} from './repoWipeTransaction.ts';

type Args = {
  dropId: string;
  dryRun: boolean;
  yes: boolean;
};

class WipeInterruptedError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super('Wipe interrupted.');
    this.name = 'WipeInterruptedError';
    this.exitCode = exitCode;
  }
}

export class CommerceD1WipeOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super('Commerce D1 wipe outcome could not be confirmed.', { cause });
    this.name = 'CommerceD1WipeOutcomeUnknownError';
  }
}

type CommerceD1InventorySnapshot = {
  mode: 'legacy' | 'rows';
  metadata: {
    generation: string;
    ready: boolean;
    dropFamily: string;
    itemsPerBox: number;
    maxDudeId: number;
    initializedAtMs: number;
  } | null;
  availableCount: number;
};

export type CommerceD1Plan = {
  authority: CommerceD1Authority;
  dropId: string;
  inventory: CommerceD1InventorySnapshot;
  claimCodesByDropId: string[];
  claimCodesFromAssignments: string[];
  claimCodesFromDeliveryOrders: string[];
  claimCodesToDelete: string[];
  documentsToDelete: Array<{ path: string; version: number }>;
  missingClaimCodes: string[];
  targetDocumentCount: number;
  notificationOutboxCount: number;
  packStatusOutboxCount: number | null;
  stripeCheckoutStateCount: number | null;
  deliveryRecoveryStateCount: number | null;
  deliveryRecoveryExpectations: Array<Pick<DeliveryRecoveryRecord, 'parentPath' | 'generation' | 'revision'>>;
};

export function sameCommerceD1Plan(
  left: CommerceD1Plan,
  right: CommerceD1Plan,
): boolean {
  const stable = (plan: CommerceD1Plan) => {
    const { databaseNowMs: _databaseNowMs, ...authority } = plan.authority;
    return { ...plan, authority };
  };
  return isDeepStrictEqual(stable(left), stable(right));
}

export async function withCommerceWipeAuthorityLease<T>(args: {
  queryCommerceD1: CommerceAuthorityQuery;
  run: (renew: () => Promise<void>) => Promise<T>;
  token?: string;
}): Promise<T> {
  let lease = await acquireCommerceAuthorityLease(
    args.queryCommerceD1,
    args.token || crypto.randomUUID(),
  );
  const renew = async () => {
    lease = await renewCommerceAuthorityLease(args.queryCommerceD1, lease);
  };
  let result: T | undefined;
  let completed = false;
  let operationError: unknown;
  try {
    result = await args.run(renew);
    completed = true;
  } catch (error) {
    operationError = error;
  }
  let releaseError: unknown;
  try {
    await releaseCommerceAuthorityLease(args.queryCommerceD1, lease);
  } catch (error) {
    releaseError = error;
  }
  if (operationError !== undefined) {
    if (releaseError === undefined) throw operationError;
    throw new AggregateError(
      [operationError, releaseError],
      'Commerce wipe failed and its authority lease release could not be confirmed.',
    );
  }
  if (releaseError !== undefined) {
    throw new Error('Commerce wipe completed, but its authority lease release could not be confirmed.', {
      cause: releaseError,
    });
  }
  if (!completed) return fail('Commerce wipe returned no result.');
  return result as T;
}

export const COMMERCE_WIPE_MINIMUM_PAUSE_MS = 65_000;
const COMMERCE_WIPE_D1_PAUSE_THRESHOLD_MS = COMMERCE_WIPE_MINIMUM_PAUSE_MS + 1_000;

function usage(): string {
  return [
    'Wipe one drop from local config/data and Commerce D1.',
    '',
    'Usage:',
    '  npm run wipe-drop -- --drop-id <dropId>',
    '  npm run wipe-drop -- --drop_id <dropId>',
    '  npm run wipe-drop --drop_id=<dropId>',
    '  npm run wipe-drop -- <dropId>',
    '',
    'Options:',
    '  --drop-id <id>      Drop id to remove',
    '  --drop_id <id>      Alias for --drop-id',
    '  --dry-run           Preview only; do not mutate',
    '  --yes               Skip interactive confirmation',
    '  -h, --help          Show this help',
  ].join('\n');
}

function fail(message: string): never {
  throw new Error(message);
}

function validateDropId(raw: string, label: string): string {
  return normalizeAndValidateDropId(raw, label);
}

function readNpmConfigString(keys: string[]): string | undefined {
  for (const key of keys) {
    const envKey = `npm_config_${key.replace(/-/g, '_')}`;
    const value = process.env[envKey];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function parseArgs(argv: string[]): Args {
  let dropId: string | undefined;
  let dryRun = false;
  let yes = false;
  const positional: string[] = [];

  function readValue(flag: string, index: number, inlineValue?: string): { value: string; nextIndex: number } {
    if (inlineValue != null) return { value: inlineValue, nextIndex: index };
    const value = argv[index + 1];
    if (!value) fail(`Missing value for ${flag}\n\n${usage()}`);
    return { value, nextIndex: index + 1 };
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      console.log(usage());
      process.exit(0);
    }

    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--yes') {
      yes = true;
      continue;
    }

    if (arg === '--drop-id' || arg === '--drop_id' || arg.startsWith('--drop-id=') || arg.startsWith('--drop_id=')) {
      const { value, nextIndex } = readValue(
        arg.startsWith('--drop-id=') ? '--drop-id' : arg.startsWith('--drop_id=') ? '--drop_id' : arg,
        i,
        arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined,
      );
      dropId = value;
      i = nextIndex;
      continue;
    }

    if (arg.startsWith('-')) {
      fail(`Unknown arg: ${arg}\n\n${usage()}`);
    }

    positional.push(arg);
  }

  if (positional.length > 1) {
    fail(`Expected at most one positional drop id.\n\n${usage()}`);
  }

  const positionalDropId = positional[0];
  const dropIdFromNpmConfig = readNpmConfigString(['drop_id', 'drop-id']);
  const finalDropIdRaw = dropId ?? positionalDropId ?? dropIdFromNpmConfig;

  if (!finalDropIdRaw) {
    fail(`Missing drop id.\n\n${usage()}`);
  }

  const normalizedDropId = validateDropId(finalDropIdRaw, 'drop id');
  return {
    dropId: normalizedDropId,
    dryRun,
    yes,
  };
}

export function asStoredDocumentId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value;
}

export function normalizeStoredDropIdField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = normalizeDropId(value);
  return normalized || undefined;
}

function normalizeClaimCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function sortStrings(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function repoRoot(): string {
  return path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
}

function runGit(args: string[], cwd: string, opts?: { allowNoMatch?: boolean; binary?: boolean }) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: opts?.binary ? 'buffer' : 'utf8',
  });
  if (result.status === 0) return result;
  if (opts?.allowNoMatch && result.status === 1) return result;
  const stderr = opts?.binary ? Buffer.from(result.stderr as Buffer).toString('utf8') : String(result.stderr || '');
  const stdout = opts?.binary ? Buffer.from(result.stdout as Buffer).toString('utf8') : String(result.stdout || '');
  throw new Error(`git ${args.join(' ')} failed.\n${stderr || stdout || '(no output)'}`.trim());
}

function listTrackedFiles(root: string): string[] {
  const result = runGit(['ls-files', '-z'], root, { binary: true });
  return Buffer.from(result.stdout as Buffer)
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildDropIdTokenRegex(dropId: string): RegExp {
  const escapedDropId = escapeRegExp(dropId);

  return new RegExp(`(^|[^A-Za-z0-9_-])${escapedDropId}($|[^A-Za-z0-9_-])`);
}

function hasDropIdToken(text: string, dropIdTokenRegex: RegExp): boolean {
  return dropIdTokenRegex.test(text);
}

function fileContainsDropIdToken(filePath: string, dropIdTokenRegex: RegExp): boolean {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch {
    return false;
  }
  if (bytes.includes(0)) return false;
  return hasDropIdToken(bytes.toString('utf8'), dropIdTokenRegex);
}

function isPreservedDropConfigFile(relPath: string): boolean {
  return relPath.startsWith('scripts/newDrops/');
}

function discountMerkleReference(
  drop: { dropId: string; dropFamily: string; discountMerkleRoot: string } | undefined,
  source: string,
): DiscountMerkleDatasetReference | undefined {
  if (!drop) return undefined;
  return {
    dropFamily: drop.dropFamily,
    rootHex: drop.discountMerkleRoot,
    source: `${source}:${drop.dropId}`,
  };
}

function discountMerkleReferences(
  drops: Record<string, { dropId: string; dropFamily: string; discountMerkleRoot: string }>,
  source: string,
): DiscountMerkleDatasetReference[] {
  return Object.values(drops).map((drop) => ({
    dropFamily: drop.dropFamily,
    rootHex: drop.discountMerkleRoot,
    source: `${source}:${drop.dropId}`,
  }));
}

function readDiscountMerkleDatasetRoot(filePath: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    fail(
      `Refusing to delete malformed discount Merkle dataset ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const embeddedRoot =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? String((parsed as { root?: unknown }).root ?? '')
      : '';
  if (!/^[0-9a-f]{64}$/.test(embeddedRoot)) {
    fail(
      `Refusing to use malformed discount Merkle dataset ${filePath}: embedded root must be 32 lowercase hexadecimal bytes.`,
    );
  }
  return embeddedRoot;
}

function assertDiscountMerkleDatasetRoot(filePath: string, expectedRoot: string): void {
  const embeddedRoot = readDiscountMerkleDatasetRoot(filePath);
  if (embeddedRoot !== expectedRoot) {
    fail(
      `Refusing to delete discount Merkle dataset ${filePath}: embedded root ${embeddedRoot || '(missing)'} ` +
        `does not match registry root ${expectedRoot}.`,
    );
  }
}

function assertQuarantinedDiscountMerkleDatasetRoot(args: {
  quarantinePath: string;
  canonicalPath: string;
  snapshot: Exclude<LocalFileSnapshot, { exists: false }>;
  expectedRoot: string;
}): void {
  const datasetPath =
    args.snapshot.kind === 'symlink'
      ? path.resolve(
          path.dirname(args.canonicalPath),
          args.snapshot.target,
        )
      : args.quarantinePath;
  assertDiscountMerkleDatasetRoot(datasetPath, args.expectedRoot);
}

function objectLiteralStringProperty(
  object: ts.ObjectLiteralExpression,
  propertyName: string,
): string | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
      ? property.name.text
      : undefined;
    if (name !== propertyName) continue;
    return ts.isStringLiteral(property.initializer) ||
      ts.isNoSubstitutionTemplateLiteral(property.initializer)
      ? property.initializer.text
      : undefined;
  }
  return undefined;
}

function readPreservedDropFamily(args: {
  root: string;
  dropId: string;
}): string | undefined {
  const configPath = path.join(
    args.root,
    'scripts',
    'newDrops',
    `${args.dropId}.ts`,
  );
  let configuredFamily: string | undefined;
  if (existsSync(configPath)) {
    const source = readFileSync(configPath, 'utf8');
    const sourceFile = ts.createSourceFile(
      configPath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const matches: Array<{ dropId: string; dropFamily: string }> = [];
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const dropId = objectLiteralStringProperty(node, 'dropId');
        const dropFamily = objectLiteralStringProperty(node, 'dropFamily');
        if (dropId != null && dropFamily != null) {
          matches.push({ dropId, dropFamily });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    const matchingDropIds = matches.filter(
      (candidate) =>
        normalizeAndValidateDropId(
          candidate.dropId,
          'preserved new-drop config dropId',
        ) === args.dropId,
    );
    if (matchingDropIds.length !== 1) {
      fail(
        `Could not recover one unambiguous drop family for ${args.dropId} from ${path.relative(args.root, configPath)}.`,
      );
    }
    configuredFamily = matchingDropIds[0].dropFamily;
  }

  const defaultFamily = defaultDropFamilyForDropId(args.dropId);
  const mappedFamily = defaultFamily === 'default' ? undefined : defaultFamily;
  if (
    configuredFamily != null &&
    mappedFamily != null &&
    configuredFamily !== mappedFamily
  ) {
    fail(
      `Preserved drop-family sources disagree for ${args.dropId}: ${configuredFamily} versus ${mappedFamily}.`,
    );
  }
  return configuredFamily ?? mappedFamily;
}

const COMMERCE_DOCUMENT_SELECT = `SELECT document_path, document_kind, drop_id, document_id,
  document_json, version, create_time, update_time FROM commerce_documents`;

function commerceDocuments(where: string): CommerceD1Document[] {
  return queryRemoteCommerceDocuments(`${COMMERCE_DOCUMENT_SELECT} WHERE ${where} ORDER BY document_path`);
}

export function requireNoProtectedD1History(args: {
  dropId: string;
  packStatusEventCount: number;
  packStatusSummaryCount: number;
  revealSubmissionCount: number;
}): void {
  if (args.packStatusSummaryCount || args.packStatusEventCount) {
    fail(
      `Refusing to wipe ${args.dropId} because DATA_DB retains ` +
      `${args.packStatusSummaryCount} pack-status summary row(s) and ${args.packStatusEventCount} event row(s).`,
    );
  }
  if (args.revealSubmissionCount) {
    fail(`Refusing to wipe ${args.dropId} because OPS_DB retains ${args.revealSubmissionCount} reveal submission(s).`);
  }
}

function requireRemoteD1HistoryClear(dropId: string): void {
  const packStatus = readD1Integrity().drops.find((drop) => drop.dropId === dropId);
  const revealRows = queryRemoteOpsD1(`SELECT COUNT(*) AS count FROM reveal_submissions
    WHERE drop_id = ${sqlString(dropId)}`);
  const revealSubmissionCount = Number(revealRows[0]?.count || 0);
  if (!Number.isSafeInteger(revealSubmissionCount) || revealSubmissionCount < 0) {
    fail('OPS_DB returned an invalid reveal-submission count.');
  }
  requireNoProtectedD1History({
    dropId,
    packStatusSummaryCount: packStatus ? 1 : 0,
    packStatusEventCount: packStatus?.eventCount || 0,
    revealSubmissionCount,
  });
}

function addClaimOwner(ownership: Map<string, Set<string>>, code: string, dropId: string): void {
  const owners = ownership.get(code) || new Set<string>();
  owners.add(dropId);
  ownership.set(code, owners);
}

export function buildCommerceD1PlanFromDocuments(args: {
  authority: CommerceD1Authority;
  assignmentDocuments: CommerceD1Document[];
  claimDocuments: CommerceD1Document[];
  dropId: string;
  inventory: CommerceD1InventorySnapshot;
  targetDocuments: CommerceD1Document[];
  notificationOutboxCount?: number;
  packStatusOutboxCount?: number;
  stripeCheckoutStateCount?: number;
  deliveryRecoveryRecords?: DeliveryRecoveryRecord[];
}): CommerceD1Plan {
  const dropId = validateDropId(args.dropId, 'drop id');
  const targetAssignments = args.targetDocuments.filter((document) => document.kind === 'box_assignment');
  const targetDeliveryOrders = args.targetDocuments.filter((document) => document.kind === 'delivery_order');
  const claimCodesByDropId = sortStrings(args.claimDocuments.flatMap((document) =>
    normalizeStoredDropIdField(document.data.dropId) === dropId ? [document.documentId] : []
  ));
  const claimCodesFromAssignments = sortStrings(targetAssignments.flatMap((document) => {
    const code = normalizeClaimCode(document.data.irlClaimCode);
    return code ? [code] : [];
  }));
  const claimCodesFromDeliveryOrders = sortStrings(
    targetDeliveryOrders.flatMap((document) => extractClaimCodesFromDeliveryOrders(document.data)),
  );
  const claimCodesToInspect = sortStrings([
    ...claimCodesByDropId,
    ...claimCodesFromAssignments,
    ...claimCodesFromDeliveryOrders,
  ]);
  const inspectedCodes = new Set(claimCodesToInspect);
  const assignmentOwnerDropIdsByCode = new Map<string, Set<string>>();
  for (const document of args.assignmentDocuments) {
    const code = normalizeClaimCode(document.data.irlClaimCode);
    if (code && inspectedCodes.has(code) && document.dropId) {
      addClaimOwner(assignmentOwnerDropIdsByCode, code, document.dropId);
    }
  }
  for (const code of claimCodesFromAssignments) addClaimOwner(assignmentOwnerDropIdsByCode, code, dropId);
  const claimDocByCode = new Map(args.claimDocuments
    .filter((document) => inspectedCodes.has(document.documentId))
    .map((document) => [document.documentId, document]));
  const conflicts: string[] = [];
  const claimCodesByDropIdSet = new Set(claimCodesByDropId);
  const claimCodesFromAssignmentsSet = new Set(claimCodesFromAssignments);
  const claimCodesFromDeliveryOrdersSet = new Set(claimCodesFromDeliveryOrders);
  for (const code of claimCodesToInspect) {
    const document = claimDocByCode.get(code);
    if (!document) continue;
    const assignmentOwnerDropIds = sortStrings(assignmentOwnerDropIdsByCode.get(code) || []);
    const foreignAssignmentOwners = assignmentOwnerDropIds.filter((ownerDropId) => ownerDropId !== dropId);
    if (foreignAssignmentOwners.length) {
      conflicts.push(`claimCodes/${code} is referenced by drop(s): ${foreignAssignmentOwners.join(', ')}`);
      continue;
    }
    const explicitDropId = normalizeStoredDropIdField(document.data.dropId);
    if (explicitDropId && explicitDropId !== dropId) {
      conflicts.push(`claimCodes/${code} belongs to ${explicitDropId}`);
      continue;
    }
    if (!explicitDropId && !assignmentOwnerDropIds.includes(dropId)) {
      const sources = sortStrings([
        ...(claimCodesByDropIdSet.has(code) ? ['claimCodes.dropId query'] : []),
        ...(claimCodesFromAssignmentsSet.has(code) ? ['drops/<drop>/boxAssignments'] : []),
        ...(claimCodesFromDeliveryOrdersSet.has(code) ? ['drops/<drop>/deliveryOrders.irlClaims'] : []),
      ]);
      conflicts.push(
        `claimCodes/${code} has no dropId and no boxAssignments ownership signal (sources: ${sources.join(', ') || 'unknown'})`,
      );
    }
  }
  if (conflicts.length) {
    fail(
      `Refusing to wipe ${dropId} because some claim codes are not uniquely owned by that drop:\n` +
      conflicts.map((entry) => `- ${entry}`).join('\n'),
    );
  }
  const recoveryRecords = args.deliveryRecoveryRecords?.map(parseDeliveryRecoveryRecord);
  if (recoveryRecords && (new Set(recoveryRecords.map((record) => record.parentPath)).size !== recoveryRecords.length ||
    recoveryRecords.some((record) => !targetDeliveryOrders.some((document) => document.path === record.parentPath)))) {
    fail('Delivery recovery state does not match the wipe target.');
  }
  const claimDocumentsToDelete = [...claimDocByCode.values()];
  const documentsToDelete = [...new Map(
    [...args.targetDocuments, ...claimDocumentsToDelete].map((document) => [document.path, document]),
  ).values()]
    .map((document) => ({ path: document.path, version: document.version }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    authority: args.authority,
    dropId,
    inventory: args.inventory,
    claimCodesByDropId,
    claimCodesFromAssignments,
    claimCodesFromDeliveryOrders,
    claimCodesToDelete: sortStrings(claimDocByCode.keys()),
    documentsToDelete,
    missingClaimCodes: sortStrings(claimCodesToInspect.filter((code) => !claimDocByCode.has(code))),
    targetDocumentCount: args.targetDocuments.length,
    notificationOutboxCount: safeInteger(args.notificationOutboxCount ?? 0, 'Notification outbox count'),
    packStatusOutboxCount: args.packStatusOutboxCount === undefined
      ? null : safeInteger(args.packStatusOutboxCount, 'Pack-status outbox count'),
    stripeCheckoutStateCount: args.stripeCheckoutStateCount === undefined
      ? null : safeInteger(args.stripeCheckoutStateCount, 'Stripe checkout state count'),
    deliveryRecoveryStateCount: recoveryRecords?.length ?? null,
    deliveryRecoveryExpectations: (recoveryRecords ?? []).map(({ parentPath, generation, revision }) => ({ parentPath, generation, revision }))
      .sort((left, right) => left.parentPath.localeCompare(right.parentPath)),
  };
}

export function requireExecutableCommerceD1Wipe(authority: CommerceD1Authority): void {
  if (authority.state !== 'paused' || authority.pausedAtMs === null) {
    fail('Commerce D1 must be paused with commerce-authority-control before a drop can be wiped.');
  }
  if (authority.databaseNowMs - authority.pausedAtMs < COMMERCE_WIPE_D1_PAUSE_THRESHOLD_MS) {
    fail(`Commerce D1 must remain paused for at least ${COMMERCE_WIPE_MINIMUM_PAUSE_MS / 1000} seconds before a drop can be wiped.`);
  }
}

export function buildCommerceD1Plan(dropId: string): CommerceD1Plan {
  dropId = validateDropId(dropId, 'drop id');
  requireRemoteD1HistoryClear(dropId);
  return buildCommerceD1PlanFromDocuments({
    authority: readRemoteCommerceAuthority(),
    dropId,
    inventory: readRemoteCommerceInventory(dropId),
    notificationOutboxCount: safeInteger(queryRemoteCommerceD1(`SELECT COUNT(*) AS count
      FROM commerce_notification_outbox WHERE drop_id = ${sqlString(dropId)}`)[0]?.count, 'Notification outbox count'),
    packStatusOutboxCount: safeInteger(queryRemoteCommerceD1(`SELECT COUNT(*) AS count
        FROM commerce_pack_status_outbox WHERE drop_id = ${sqlString(dropId)}`)[0]?.count, 'Pack-status outbox count'),
    stripeCheckoutStateCount: safeInteger(queryRemoteCommerceD1(`SELECT COUNT(*) AS count
        FROM commerce_stripe_checkout_state WHERE ${stripeCheckoutDropPredicate(dropId)}`)[0]?.count, 'Stripe checkout state count'),
    deliveryRecoveryRecords: queryRemoteCommerceD1(`SELECT * FROM commerce_delivery_recovery WHERE ${deliveryRecoveryDropPredicate(dropId)}
          ORDER BY parent_path`).map(parseDeliveryRecoveryRow),
    targetDocuments: commerceDocuments(`drop_id = ${sqlString(dropId)}`),
    claimDocuments: commerceDocuments(`document_kind = 'claim_code'`),
    assignmentDocuments: commerceDocuments(`document_kind = 'box_assignment'`),
  });
}

function readRemoteCommerceInventory(dropId: string): CommerceD1InventorySnapshot {
  const rows = queryRemoteCommerceD1(`SELECT authority.dude_inventory_mode,
      inventory.generation, inventory.ready, inventory.drop_family, inventory.items_per_box,
      inventory.max_dude_id, inventory.initialized_at_ms,
      (SELECT COUNT(*) FROM commerce_available_dudes WHERE drop_id = ${sqlString(dropId)}) AS available_count
    FROM commerce_authority_control AS authority
    LEFT JOIN commerce_inventory_drops AS inventory ON inventory.drop_id = ${sqlString(dropId)}
    WHERE authority.singleton = 1`);
  if (rows.length !== 1) fail('Commerce D1 inventory state is invalid.');
  const row = rows[0];
  const mode = row.dude_inventory_mode;
  if (mode !== 'rows') fail('Commerce D1 inventory requires initialized rows mode.');
  const availableCount = safeInteger(row.available_count, 'Commerce available inventory count');
  if (row.generation === null) {
    if (availableCount !== 0) fail('Commerce D1 inventory metadata is missing.');
    return { mode, metadata: null, availableCount };
  }
  const generation = String(row.generation);
  const dropFamily = String(row.drop_family || '');
  const itemsPerBox = safeInteger(row.items_per_box, 'Commerce inventory items per box');
  const maxDudeId = safeInteger(row.max_dude_id, 'Commerce inventory maximum figure id');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(generation) ||
    !dropFamily || (row.ready !== 0 && row.ready !== 1) || itemsPerBox < 1 || maxDudeId < itemsPerBox
  ) fail('Commerce D1 inventory metadata is invalid.');
  return {
    mode,
    availableCount,
    metadata: {
      generation,
      ready: row.ready === 1,
      dropFamily,
      itemsPerBox,
      maxDudeId,
      initializedAtMs: safeInteger(row.initialized_at_ms, 'Commerce inventory initialization timestamp'),
    },
  };
}

export async function buildRepoPlan(args: {
  root: string;
  dropId: string;
}): Promise<RepoPlan> {
  const dropId = validateDropId(args.dropId, 'drop id');
  const registryPath = path.join(
    args.root,
    'shared',
    'deploymentRegistry.ts',
  );
  const registry = await readDeploymentDropRegistry(registryPath);
  const recoveryManifestPath = wipeRecoveryManifestPath(args.root, dropId);
  const parsedRecoveryManifest = parseWipeRecoveryManifest({
    filePath: recoveryManifestPath,
    dropId,
  });
  const existingRecoveryManifest = parsedRecoveryManifest?.manifest;
  const dropsNext = { ...registry.drops };
  delete dropsNext[dropId];
  const registryWillChange = Object.prototype.hasOwnProperty.call(
    registry.drops,
    dropId,
  );
  const registryDrop = registryWillChange
    ? registry.drops[dropId]
    : undefined;
  const tombstonesNext = { ...registry.tombstones };
  if (
    registryDrop &&
    ((registryDrop.solanaCluster === 'mainnet-beta' &&
      registryDrop.boxMinterProgramId ===
        '7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU') ||
      (registryDrop.solanaCluster === 'devnet' &&
        registryDrop.boxMinterProgramId ===
          '8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6'))
  ) {
    const boxMinterConfigPda = String(
      registryDrop.boxMinterConfigPda || '',
    ).trim();
    if (!boxMinterConfigPda) {
      fail(
        `Cannot tombstone current-generation drop ${dropId} without boxMinterConfigPda.`,
      );
    }
    const base = {
      solanaCluster: registryDrop.solanaCluster,
      dropId,
      dropSeed: createHash('sha256').update(dropId, 'utf8').digest('hex'),
      boxMinterProgramId: registryDrop.boxMinterProgramId,
      boxMinterConfigPda,
      collectionMint: registryDrop.collectionMint,
      reason: 'drop-wiped' as const,
    };
    const tombstone: BoxMinterConfigTombstone = registryDrop.paymentRouting
      ? {
          ...base,
          accountSize: 488,
          schema: 'split-payments-v1',
          paymentRouting: clonePaymentRoutingConfig(
            registryDrop.paymentRouting,
          ),
        }
      : {
          ...base,
          accountSize: 376,
          schema: 'legacy',
          treasury: registryDrop.treasury,
        };
    tombstonesNext[dropId] = tombstone;
    if (registryDrop.operationsConfig) {
      const operations = registryDrop.operationsConfig;
      tombstonesNext[operations.configId] = {
        ...tombstone,
        dropId: operations.configId,
        dropSeed: createHash('sha256').update(operations.configId, 'utf8').digest('hex'),
        boxMinterConfigPda: operations.boxMinterConfigPda,
      };
    }
  }
  const registryNextContent = registryWillChange
    ? renderDeploymentRegistryFileFromSource({
        filePath: registryPath,
        existingContent: registry.sourceContent,
        drops: dropsNext,
        tombstones: tombstonesNext,
      })
    : registry.sourceContent;
  const preservedDropFamily = registryDrop
    ? undefined
    : readPreservedDropFamily({
        root: args.root,
        dropId,
      });
  if (
    registryDrop &&
    existingRecoveryManifest &&
    ((existingRecoveryManifest.dropFamily != null &&
      existingRecoveryManifest.dropFamily !== registryDrop.dropFamily) ||
      (existingRecoveryManifest.discountMerkleRoot != null &&
      existingRecoveryManifest.discountMerkleRoot !==
        registryDrop.discountMerkleRoot))
  ) {
    fail(
      `Wipe recovery provenance disagrees with the live registry row for ${dropId}.`,
    );
  }
  if (
    existingRecoveryManifest &&
    existingRecoveryManifest.dropFamily != null &&
    preservedDropFamily != null &&
    existingRecoveryManifest.dropFamily !== preservedDropFamily
  ) {
    fail(
      `Wipe recovery provenance disagrees with the preserved/default drop family for ${dropId}: ` +
        `${existingRecoveryManifest.dropFamily} versus ${preservedDropFamily}.`,
    );
  }
  const recoveredDropFamily = registryDrop
    ? registryDrop.dropFamily
    : existingRecoveryManifest?.dropFamily ??
      preservedDropFamily;
  const removedReference =
    discountMerkleReference(
      registryDrop,
      path.relative(args.root, registryPath),
    ) ??
    (existingRecoveryManifest?.dropFamily &&
    existingRecoveryManifest.discountMerkleRoot
      ? {
          dropFamily: existingRecoveryManifest.dropFamily,
          rootHex: existingRecoveryManifest.discountMerkleRoot,
          source: path.relative(args.root, recoveryManifestPath),
        }
      : undefined);
  const remainingReferences = discountMerkleReferences(
    dropsNext,
    path.relative(args.root, registryPath),
  );
  const discountMerkleRemovalPlan =
    planCanonicalDiscountMerkleDatasetRemoval({
      removed: removedReference,
      remaining: remainingReferences,
    });

  if (!Object.keys(dropsNext).length) {
    fail(`Refusing to wipe ${dropId}: this would leave no configured drops.`);
  }

  const trackedFiles = listTrackedFiles(args.root);
  const recoveryTargetsByPath = new Map(
    (existingRecoveryManifest?.targets ?? []).map((target) => [
      target.relativePath,
      target,
    ]),
  );
  for (const [relativePath, target] of recoveryTargetsByPath) {
    const quarantinePath = path.join(
      args.root,
      ...(
        target.quarantineRelativePath ??
        deterministicQuarantineRelativePath(relativePath)
      ).split('/'),
    );
    if (!localPathEntryExists(quarantinePath)) continue;
    if (
      target.expectedSha256 == null ||
      target.expectedMode == null ||
      target.expectedKind == null
    ) {
      fail(
        `Wipe quarantine exists without complete recovery provenance: ${quarantinePath}`,
      );
    }
    let quarantineSnapshot: LocalFileSnapshot;
    try {
      quarantineSnapshot = snapshotLocalFile(quarantinePath);
    } catch {
      fail(
        `Wipe quarantine cannot be verified against stable recovery provenance: ${quarantinePath}`,
      );
    }
    if (
      !recoveryFingerprintMatchesSnapshot(
        quarantinePath,
        target,
        quarantineSnapshot,
      )
    ) {
      fail(
        `Wipe quarantine does not match stable recovery provenance: ${quarantinePath}`,
      );
    }
  }
  const authenticatedRecoveryTargetPaths = new Set(
    [...recoveryTargetsByPath.entries()]
      .filter(([, target]) =>
        recoveryTargetAuthenticatesLivePath({
          root: args.root,
          target,
        }),
      )
      .map(([relativePath]) => relativePath),
  );
  const discountMerkleDeleteRelPaths: string[] = [];
  const allowedDiscountMerkleRelPaths: string[] = [];
  if (discountMerkleRemovalPlan) {
    const canonicalRelPath = discountMerkleRemovalPlan.relativePath;
    const canonicalAbsPath = path.join(args.root, canonicalRelPath);
    allowedDiscountMerkleRelPaths.push(canonicalRelPath);
    if (localPathEntryExists(canonicalAbsPath)) {
      assertDiscountMerkleDatasetRoot(
        canonicalAbsPath,
        discountMerkleRemovalPlan.rootHex,
      );
    }
    if (
      discountMerkleRemovalPlan.deleteCanonicalFile &&
      (trackedFiles.includes(canonicalRelPath) ||
        (registryDrop != null &&
          localPathEntryExists(canonicalAbsPath)) ||
        authenticatedRecoveryTargetPaths.has(canonicalRelPath))
    ) {
      discountMerkleDeleteRelPaths.push(canonicalRelPath);
    }

    const legacyDropRelPath = `src/drops/discountMerkles/${dropId}.json`;
    if (legacyDropRelPath !== canonicalRelPath) {
      allowedDiscountMerkleRelPaths.push(legacyDropRelPath);
      const legacyDropAbsPath = path.join(args.root, legacyDropRelPath);
      if (
        (trackedFiles.includes(legacyDropRelPath) &&
          localPathEntryExists(legacyDropAbsPath)) ||
        authenticatedRecoveryTargetPaths.has(legacyDropRelPath)
      ) {
        if (localPathEntryExists(legacyDropAbsPath)) {
          assertDiscountMerkleDatasetRoot(legacyDropAbsPath, discountMerkleRemovalPlan.rootHex);
        }
        discountMerkleDeleteRelPaths.push(legacyDropRelPath);
      }
    }
  } else if (recoveredDropFamily) {
    const canonicalRelPath =
      `src/drops/discountMerkles/${recoveredDropFamily}.json`;
    const legacyDropRelPath =
      `src/drops/discountMerkles/${dropId}.json`;
    allowedDiscountMerkleRelPaths.push(
      canonicalRelPath,
      legacyDropRelPath,
    );

    if (
      legacyDropRelPath !== canonicalRelPath &&
      ((trackedFiles.includes(legacyDropRelPath) &&
        localPathEntryExists(path.join(args.root, legacyDropRelPath))) ||
        authenticatedRecoveryTargetPaths.has(legacyDropRelPath))
    ) {
      discountMerkleDeleteRelPaths.push(legacyDropRelPath);
    }
  } else {
    const legacyDropRelPath =
      `src/drops/discountMerkles/${dropId}.json`;
    allowedDiscountMerkleRelPaths.push(legacyDropRelPath);
    if (
      (trackedFiles.includes(legacyDropRelPath) &&
        localPathEntryExists(path.join(args.root, legacyDropRelPath))) ||
      authenticatedRecoveryTargetPaths.has(legacyDropRelPath)
    ) {
      discountMerkleDeleteRelPaths.push(legacyDropRelPath);
    }
  }
  const legacyDropRelPath =
    `src/drops/discountMerkles/${dropId}.json`;
  const sharedCanonicalMerkleRelPath =
    discountMerkleRemovalPlan &&
    !discountMerkleRemovalPlan.deleteCanonicalFile
      ? discountMerkleRemovalPlan.relativePath
      : undefined;
  const safeRecoveryTargetPaths = new Set<string>(
    [...recoveryTargetsByPath.keys()].filter(
      (relativePath) =>
        relativePath !== legacyDropRelPath ||
        (relativePath === sharedCanonicalMerkleRelPath &&
          recoveryTargetsByPath.get(relativePath)?.restoreOnly === true) ||
        (trackedFiles.includes(relativePath) &&
          localPathEntryExists(path.join(args.root, relativePath))) ||
        authenticatedRecoveryTargetPaths.has(relativePath),
    ),
  );
  const recoveryRestoreRelPaths: string[] = [];
  for (const relativePath of safeRecoveryTargetPaths) {
    const recoveryTarget = recoveryTargetsByPath.get(relativePath);
    const isDropOwnedPath =
      recoveryTarget?.restoreOnly !== true &&
      (isCanonicalDropFile(relativePath, dropId) ||
        relativePath === `scripts/discounts/${dropId}.csv` ||
        discountMerkleDeleteRelPaths.includes(relativePath));
    if (!isDropOwnedPath) {
      if (relativePath === sharedCanonicalMerkleRelPath) {
        const quarantinePath = path.join(
          args.root,
          ...deterministicQuarantineRelativePath(relativePath).split('/'),
        );
        if (localPathEntryExists(quarantinePath)) {
          recoveryRestoreRelPaths.push(relativePath);
        }
        safeRecoveryTargetPaths.delete(relativePath);
        continue;
      }
      fail(
        `Unsafe wipe recovery target is no longer exclusively owned by ${dropId}: ${relativePath}`,
      );
    }
  }
  const canonicalDeleteRelPaths = sortStrings(
    [
      ...trackedFiles.filter(
        (relPath) =>
          isCanonicalDropFile(relPath, dropId) ||
          relPath === `scripts/discounts/${dropId}.csv`,
      ),
      ...discountMerkleDeleteRelPaths,
      ...safeRecoveryTargetPaths,
    ],
  );
  const allowedReferencePaths = new Set<string>([
    path.relative(args.root, registryPath),
    ...canonicalDeleteRelPaths,
    ...allowedDiscountMerkleRelPaths,
  ]);
  const dropIdTokenRegex = buildDropIdTokenRegex(dropId);
  const extraReferences = sortStrings(
    trackedFiles.filter((relPath) => {
      if (allowedReferencePaths.has(relPath)) return false;
      if (isPreservedDropConfigFile(relPath)) return false;
      if (!existsSync(path.join(args.root, relPath))) return false;
      if (hasDropIdToken(relPath, dropIdTokenRegex)) return true;
      return fileContainsDropIdToken(path.join(args.root, relPath), dropIdTokenRegex);
    }),
  );
  const manifestTargets: WipeRecoveryManifest['targets'] = [];
  const recoveryRestoreTargets = recoveryRestoreRelPaths.map(
    (relativePath): CanonicalDeleteTarget => {
      const recoveryTarget = recoveryTargetsByPath.get(relativePath);
      if (
        recoveryTarget?.expectedSha256 == null ||
        recoveryTarget.expectedMode == null ||
        recoveryTarget.expectedKind == null
      ) {
        fail(
          `Shared Merkle quarantine lacks stable recovery provenance: ${relativePath}`,
        );
      }
      const absolutePath = path.join(args.root, relativePath);
      const quarantineRelativePath =
        deterministicQuarantineRelativePath(relativePath);
      const quarantinePath = path.join(
        args.root,
        ...quarantineRelativePath.split('/'),
      );
      const quarantineSnapshot = snapshotLocalFile(quarantinePath);
      if (!quarantineSnapshot.exists) {
        fail(
          `Shared Merkle quarantine disappeared while planning: ${quarantinePath}`,
        );
      }
      if (
        !recoveryFingerprintMatchesSnapshot(
          quarantinePath,
          recoveryTarget,
          quarantineSnapshot,
        )
      ) {
        fail(
          `Shared Merkle quarantine does not match stable recovery provenance: ${relativePath}`,
        );
      }
      if (discountMerkleRemovalPlan) {
        assertQuarantinedDiscountMerkleDatasetRoot({
          quarantinePath,
          canonicalPath: absolutePath,
          snapshot: quarantineSnapshot,
          expectedRoot: discountMerkleRemovalPlan.rootHex,
        });
      }
      manifestTargets.push({
        relativePath,
        quarantineRelativePath,
        restoreOnly: true,
        expectedSha256: recoveryTarget.expectedSha256,
        expectedMode: recoveryTarget.expectedMode,
        expectedKind: recoveryTarget.expectedKind,
        ...(recoveryTarget.expectedKind === 'symlink'
          ? {
              expectedSymlinkTarget:
                recoveryTarget.expectedSymlinkTarget,
            }
          : {}),
      });
      return {
        relativePath,
        absolutePath,
        quarantinePath,
        quarantineExpectedSha256:
          recoveryTarget.expectedSha256,
        quarantineExpectedMode: recoveryTarget.expectedMode,
        quarantineExpectedKind: recoveryTarget.expectedKind,
        ...(recoveryTarget.expectedKind === 'symlink'
          ? {
              quarantineExpectedSymlinkTarget:
                recoveryTarget.expectedSymlinkTarget,
            }
          : {}),
      };
    },
  );
  const canonicalDeleteTargets = canonicalDeleteRelPaths.map(
    (relativePath): CanonicalDeleteTarget => {
      const absolutePath = path.join(args.root, relativePath);
      const quarantineRelativePath =
        deterministicQuarantineRelativePath(relativePath);
      const quarantinePath = path.join(
        args.root,
        ...quarantineRelativePath.split('/'),
      );
      const recoveryTarget = recoveryTargetsByPath.get(relativePath);
      const canonicalSnapshot = snapshotLocalFile(absolutePath);
      const quarantineExists = localPathEntryExists(quarantinePath);
      if (quarantineExists) {
        if (
          recoveryTarget?.expectedSha256 == null ||
          recoveryTarget.expectedMode == null ||
          recoveryTarget.expectedKind == null
        ) {
          fail(
            `Wipe quarantine exists without complete recovery provenance: ${quarantinePath}`,
          );
        }
        if (recoveryTarget.restoreOnly === true) {
          fail(
            `Restore-only wipe quarantine cannot be adopted for deletion: ${quarantinePath}`,
          );
        }
      }
      const quarantineSnapshot = quarantineExists
        ? snapshotLocalFile(quarantinePath)
        : undefined;
      if (
        quarantineSnapshot?.exists &&
        (!recoveryTarget ||
          !recoveryFingerprintMatchesSnapshot(
            quarantinePath,
            recoveryTarget,
            quarantineSnapshot,
          ))
      ) {
        fail(
          `Wipe quarantine does not match stable recovery provenance: ${quarantinePath}`,
        );
      }
      if (
        quarantineSnapshot?.exists &&
        discountMerkleRemovalPlan &&
        relativePath.startsWith('src/drops/discountMerkles/')
      ) {
        assertQuarantinedDiscountMerkleDatasetRoot({
          quarantinePath,
          canonicalPath: absolutePath,
          snapshot: quarantineSnapshot,
          expectedRoot: discountMerkleRemovalPlan.rootHex,
        });
      }
      const canonicalFingerprint = canonicalSnapshot.exists
        ? {
            expectedSha256: sha256LocalSnapshot(
              absolutePath,
              canonicalSnapshot,
            ),
            expectedDevice: canonicalSnapshot.device,
            expectedInode: canonicalSnapshot.inode,
            expectedMode: canonicalSnapshot.mode,
            expectedKind: canonicalSnapshot.kind,
            ...(canonicalSnapshot.kind === 'symlink'
              ? { expectedSymlinkTarget: canonicalSnapshot.target }
              : {}),
          }
        : {};
      const quarantineFingerprint =
        quarantineSnapshot?.exists && recoveryTarget
          ? {
              quarantineExpectedSha256:
                recoveryTarget.expectedSha256,
              quarantineExpectedMode: recoveryTarget.expectedMode,
              quarantineExpectedKind: recoveryTarget.expectedKind,
              ...(recoveryTarget.expectedKind === 'symlink'
                ? {
                    quarantineExpectedSymlinkTarget:
                      recoveryTarget.expectedSymlinkTarget,
                  }
                : {}),
            }
          : {};
      manifestTargets.push({
        relativePath,
        quarantineRelativePath,
        ...(quarantineSnapshot?.exists && recoveryTarget
          ? {
              expectedSha256: recoveryTarget.expectedSha256,
              expectedMode: recoveryTarget.expectedMode,
              expectedKind: recoveryTarget.expectedKind,
              ...(recoveryTarget.expectedKind === 'symlink'
                ? {
                    expectedSymlinkTarget:
                      recoveryTarget.expectedSymlinkTarget,
                  }
                : {}),
            }
          : canonicalFingerprint),
      });
      return {
        relativePath,
        absolutePath,
        quarantinePath,
        ...canonicalFingerprint,
        ...quarantineFingerprint,
      };
    },
  );
  const recoveryIdentity = registryDrop ?? existingRecoveryManifest;
  const recoveryManifest: WipeRecoveryManifest = {
    version: 1,
    dropId,
    ...(recoveryIdentity?.dropFamily &&
    recoveryIdentity.discountMerkleRoot
      ? {
          dropFamily: recoveryIdentity.dropFamily,
          discountMerkleRoot: recoveryIdentity.discountMerkleRoot,
        }
      : {}),
    targets: manifestTargets,
  };

  return {
    registryPath,
    dropsNext,
    registryWillChange,
    registryExpectedContent: registry.sourceContent,
    registryNextContent,
    canonicalDeleteTargets,
    ...(recoveryRestoreTargets.length
      ? { recoveryRestoreTargets }
      : {}),
    extraReferences,
    recoveryManifest: {
      filePath: recoveryManifestPath,
      ...(parsedRecoveryManifest
        ? { expectedContent: parsedRecoveryManifest.sourceContent }
        : {}),
      content: renderWipeRecoveryManifest(recoveryManifest),
    },
  };
}

function extractClaimCodesFromDeliveryOrders(orderData: unknown): string[] {
  if (!orderData || typeof orderData !== 'object') return [];
  const irlClaims = Array.isArray((orderData as any).irlClaims) ? (orderData as any).irlClaims : [];
  return irlClaims
    .map((entry) => normalizeClaimCode((entry as any)?.code))
    .filter((code): code is string => Boolean(code));
}

function printPlan(args: {
  dropId: string;
  dryRun: boolean;
  repoPlan: RepoPlan;
  commercePlan: CommerceD1Plan;
}) {
  const { repoPlan, commercePlan } = args;

  console.log(`wipe-drop plan for ${args.dropId}`);
  console.log(`mode: ${args.dryRun ? 'dry-run' : 'execute after confirmation'}`);
  console.log('');

  console.log('codebase');
  if (repoPlan.registryWillChange) {
    console.log(`- update shared/deploymentRegistry.ts`);
  } else {
    console.log('- shared/deploymentRegistry.ts: no changes');
  }
  if (repoPlan.canonicalDeleteTargets.length) {
    repoPlan.canonicalDeleteTargets.forEach((target) => {
      console.log(`- delete ${target.relativePath}`);
    });
  } else {
    console.log('- canonical drop files: none found');
  }

  console.log('');
  console.log('commerce d1');
  console.log(`- authority revision: ${commercePlan.authority.revision}`);
  console.log(`- documents revision: ${commercePlan.authority.documentsRevision}`);
  console.log(`- notification outbox rows to delete: ${commercePlan.notificationOutboxCount}`);
  if (commercePlan.packStatusOutboxCount !== null) console.log(`- pack-status outbox rows to delete: ${commercePlan.packStatusOutboxCount}`);
  if (commercePlan.stripeCheckoutStateCount !== null) console.log(`- Stripe checkout state rows to delete: ${commercePlan.stripeCheckoutStateCount}`);
  if (commercePlan.deliveryRecoveryStateCount !== null) console.log(`- Delivery recovery state rows to delete: ${commercePlan.deliveryRecoveryStateCount}`);
  console.log(`- figure inventory mode: ${commercePlan.inventory.mode}`);
  console.log(`- available figure rows to delete: ${commercePlan.inventory.availableCount}`);
  if (commercePlan.inventory.metadata) {
    console.log(`- inventory generation to delete: ${commercePlan.inventory.metadata.generation}`);
  }
  console.log(`- drop-scoped documents to delete: ${commercePlan.targetDocumentCount}`);
  console.log(`- claimCodes where dropId == ${args.dropId}: ${commercePlan.claimCodesByDropId.length}`);
  console.log(`- claim codes from boxAssignments: ${commercePlan.claimCodesFromAssignments.length}`);
  console.log(`- claim codes from deliveryOrders.irlClaims: ${commercePlan.claimCodesFromDeliveryOrders.length}`);
  console.log(`- claimCodes docs to delete: ${commercePlan.claimCodesToDelete.length}`);
  if (commercePlan.missingClaimCodes.length) {
    console.log(`- referenced claimCodes already absent: ${commercePlan.missingClaimCodes.length}`);
  }
  console.log(`- total Commerce D1 documents to delete: ${commercePlan.documentsToDelete.length}`);
}

async function promptForConfirmation(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail('Interactive confirmation requires a TTY. Re-run with --yes or --dry-run.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Type 'wipe' to continue: ")).trim().toLowerCase();
    return answer === 'wipe';
  } finally {
    rl.close();
  }
}

function abortPreparedRepoAfterDataFailure<TPrepared>(args: {
  abortPreparedRepo?: (prepared: TPrepared) => void;
  dataError: unknown;
  prepared: TPrepared;
}): never {
  if (args.dataError instanceof CommerceD1WipeOutcomeUnknownError) throw args.dataError;
  if (args.abortPreparedRepo) {
    try {
      args.abortPreparedRepo(args.prepared);
    } catch (abortError) {
      throw new Error(
        `Commerce D1 wipe failed and prepared repository cleanup also failed: ${
          abortError instanceof Error ? abortError.message : String(abortError)
        }`,
        { cause: args.dataError },
      );
    }
  }
  throw args.dataError;
}

export async function applyWipePhases<TPrepared>(args: {
  prepareRepo: () => TPrepared;
  applyData: () => Promise<void>;
  applyPreparedRepo: (prepared: TPrepared) => void;
  abortPreparedRepo?: (prepared: TPrepared) => void;
}): Promise<void> {
  const prepared = args.prepareRepo();
  try {
    await args.applyData();
  } catch (dataError) {
    abortPreparedRepoAfterDataFailure({
      abortPreparedRepo: args.abortPreparedRepo,
      dataError,
      prepared,
    });
  }
  args.applyPreparedRepo(prepared);
}

export function applySynchronousWipePhases<TPrepared>(args: {
  prepareRepo: () => TPrepared;
  commitData: () => void;
  applyPreparedRepo: (prepared: TPrepared) => void;
  abortPreparedRepo?: (prepared: TPrepared) => void;
}): void {
  const prepared = args.prepareRepo();
  try {
    args.commitData();
  } catch (dataError) {
    abortPreparedRepoAfterDataFailure({
      abortPreparedRepo: args.abortPreparedRepo,
      dataError,
      prepared,
    });
  }
  args.applyPreparedRepo(prepared);
}

function stripeCheckoutDropPredicate(dropId: string): string {
  const prefix = `drops/${dropId}/stripeCheckouts/`;
  return `substr(document_path, 1, ${prefix.length}) = ${sqlString(prefix)}`;
}

function deliveryRecoveryDropPredicate(dropId: string): string {
  const prefix = `drops/${dropId}/deliveryOrders/`;
  return `substr(parent_path, 1, ${prefix.length}) = ${sqlString(prefix)}`;
}

export function buildCommerceD1WipeSql(plan: CommerceD1Plan, guardId: string, nowMs: number): string {
  requireExecutableCommerceD1Wipe(plan.authority);
  if (!guardId || !Number.isSafeInteger(nowMs) || nowMs < 0) fail('Commerce D1 wipe metadata is invalid.');
  const dropId = validateDropId(plan.dropId, 'drop id');
  const inventory = plan.inventory;
  const metadata = inventory.metadata;
  const metadataExpectation = metadata
    ? `EXISTS (SELECT 1 FROM commerce_inventory_drops
        WHERE drop_id = ${sqlString(dropId)} AND generation = ${sqlString(metadata.generation)}
          AND ready = ${metadata.ready ? 1 : 0} AND drop_family = ${sqlString(metadata.dropFamily)}
          AND items_per_box = ${metadata.itemsPerBox} AND max_dude_id = ${metadata.maxDudeId}
          AND initialized_at_ms = ${metadata.initializedAtMs})`
    : `NOT EXISTS (SELECT 1 FROM commerce_inventory_drops WHERE drop_id = ${sqlString(dropId)})`;
  const inventoryExpectation = `${metadataExpectation}
      AND (SELECT COUNT(*) FROM commerce_notification_outbox WHERE drop_id = ${sqlString(dropId)}) = ${plan.notificationOutboxCount}
      ${plan.packStatusOutboxCount === null ? '' : `AND (SELECT COUNT(*) FROM commerce_pack_status_outbox WHERE drop_id = ${sqlString(dropId)}) = ${plan.packStatusOutboxCount}`}
      ${plan.stripeCheckoutStateCount === null ? '' : `AND (SELECT COUNT(*) FROM commerce_stripe_checkout_state WHERE ${stripeCheckoutDropPredicate(dropId)}) = ${plan.stripeCheckoutStateCount}`}
      ${plan.deliveryRecoveryStateCount === null ? '' : `AND (SELECT COUNT(*) FROM commerce_delivery_recovery WHERE ${deliveryRecoveryDropPredicate(dropId)}) = ${plan.deliveryRecoveryStateCount}`}
      AND (SELECT COUNT(*) FROM commerce_available_dudes WHERE drop_id = ${sqlString(dropId)}) = ${inventory.availableCount}
      AND (SELECT dude_inventory_mode FROM commerce_authority_control WHERE singleton = 1) = ${sqlString(inventory.mode)}
      AND EXISTS (SELECT 1 FROM commerce_authority_control_lease
        WHERE singleton = 1 AND expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000)`;
  const expectations = plan.documentsToDelete.map((document) => ({
    path: document.path,
    version: document.version,
  }));
  const chunks = expectations.length
    ? Array.from(
        { length: Math.ceil(expectations.length / 50) },
        (_, index) => expectations.slice(index * 50, index * 50 + 50),
      )
    : [[]];
  const guardIds = chunks.map((_, index) => `${guardId}:${index}`);
  const guards = chunks.map((chunk, index) => `INSERT INTO commerce_wipe_guards (
    guard_id, expectations_json, expected_documents_revision,
    expected_authority_revision, created_at_ms${plan.deliveryRecoveryStateCount === null ? '' : ', delivery_recovery_expectations_json'}
  ) VALUES (
    ${sqlString(guardIds[index])}, ${sqlString(JSON.stringify(chunk))},
    CASE WHEN ${inventoryExpectation} THEN ${plan.authority.documentsRevision} ELSE -1 END,
    ${plan.authority.revision}, ${nowMs}${plan.deliveryRecoveryStateCount === null ? '' : `, ${sqlString(JSON.stringify(plan.deliveryRecoveryExpectations.filter((record) => chunk.some((document) => document.path === record.parentPath))))}`}
  );`).join('\n');
  const deletes = chunks.filter((chunk) => chunk.length).map((chunk) => `DELETE FROM commerce_documents
  WHERE document_path IN (${chunk.map((document) => sqlString(document.path)).join(', ')});`).join('\n');
  const scrubGuards = guardIds.map((id) =>
    `UPDATE commerce_wipe_guards SET expectations_json = '[]'${plan.deliveryRecoveryStateCount === null ? '' : ", delivery_recovery_expectations_json = '[]'"} WHERE guard_id = ${sqlString(id)};`
  ).join('\n');
  const advanceRevision = expectations.length || metadata || inventory.availableCount
    ? `UPDATE commerce_authority_control
  SET documents_revision = documents_revision + 1,
    updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE singleton = 1 AND authority_state = 'paused'
    AND revision = ${plan.authority.revision}
    AND documents_revision = ${plan.authority.documentsRevision};`
    : '';
  return `${guards}
  ${deletes}
  DELETE FROM commerce_available_dudes WHERE drop_id = ${sqlString(dropId)};
  DELETE FROM commerce_inventory_drops WHERE drop_id = ${sqlString(dropId)};
  ${advanceRevision}
  ${scrubGuards}`;
}

function readCommerceD1WipeOutcome(
  dropId: string,
  plan: CommerceD1Plan,
  operationGuardPrefix: string,
  queryCommerceD1: typeof queryRemoteCommerceD1 = queryRemoteCommerceD1,
): 'committed' | 'unknown' {
  const claimCountSql = plan.claimCodesToDelete.length
    ? `(SELECT COUNT(*) FROM commerce_documents
        WHERE document_kind = 'claim_code'
          AND document_id IN (${plan.claimCodesToDelete.map(sqlString).join(', ')}))`
    : '0';
  let rows: Record<string, unknown>[];
  try {
    rows = queryCommerceD1(`SELECT
      authority_state,
      dude_inventory_mode,
      revision,
      documents_revision,
      paused_at_ms,
      CAST(strftime('%s', 'now') AS INTEGER) * 1000 AS database_now_ms,
      (SELECT COUNT(*) FROM commerce_documents
        WHERE drop_id = ${sqlString(dropId)}) AS target_count,
      ${claimCountSql} AS claim_count,
      (SELECT COUNT(*) FROM commerce_notification_outbox
        WHERE drop_id = ${sqlString(dropId)}) AS notification_outbox_count,
      ${plan.packStatusOutboxCount === null ? '0' : `(SELECT COUNT(*) FROM commerce_pack_status_outbox WHERE drop_id = ${sqlString(dropId)})`} AS pack_status_outbox_count,
      ${plan.stripeCheckoutStateCount === null ? '0' : `(SELECT COUNT(*) FROM commerce_stripe_checkout_state WHERE ${stripeCheckoutDropPredicate(dropId)})`} AS stripe_checkout_state_count,
      ${plan.deliveryRecoveryStateCount === null ? '0' : `(SELECT COUNT(*) FROM commerce_delivery_recovery WHERE ${deliveryRecoveryDropPredicate(dropId)})`} AS delivery_recovery_state_count,
      (SELECT COUNT(*) FROM commerce_inventory_drops
        WHERE drop_id = ${sqlString(dropId)}) AS inventory_count,
      (SELECT COUNT(*) FROM commerce_available_dudes
        WHERE drop_id = ${sqlString(dropId)}) AS available_count,
      (SELECT COUNT(*) FROM commerce_wipe_guards
        WHERE substr(guard_id, 1, ${operationGuardPrefix.length}) = ${sqlString(operationGuardPrefix)}) AS guard_count
      FROM commerce_authority_control WHERE singleton = 1`);
  } catch {
    return 'unknown';
  }
  if (rows.length !== 1) return 'unknown';
  const row = rows[0];
  const revision = Number(row.revision);
  const documentsRevision = Number(row.documents_revision);
  const pausedAtMs = Number(row.paused_at_ms);
  const databaseNowMs = Number(row.database_now_ms);
  const targetCount = Number(row.target_count);
  const claimCount = Number(row.claim_count);
  const notificationOutboxCount = Number(row.notification_outbox_count);
  const packStatusOutboxCount = plan.packStatusOutboxCount === null ? 0 : Number(row.pack_status_outbox_count);
  const stripeCheckoutStateCount = plan.stripeCheckoutStateCount === null ? 0 : Number(row.stripe_checkout_state_count);
  const deliveryRecoveryStateCount = plan.deliveryRecoveryStateCount === null ? 0 : Number(row.delivery_recovery_state_count);
  const inventoryCount = Number(row.inventory_count);
  const availableCount = Number(row.available_count);
  const guardCount = Number(row.guard_count);
  if (
    row.authority_state !== 'paused' ||
    row.dude_inventory_mode !== plan.inventory.mode ||
    revision !== plan.authority.revision ||
    row.paused_at_ms === null ||
    !Number.isSafeInteger(documentsRevision) ||
    !Number.isSafeInteger(pausedAtMs) ||
    !Number.isSafeInteger(databaseNowMs) ||
    databaseNowMs - pausedAtMs < COMMERCE_WIPE_D1_PAUSE_THRESHOLD_MS ||
    !Number.isSafeInteger(targetCount) ||
    !Number.isSafeInteger(claimCount) ||
    !Number.isSafeInteger(notificationOutboxCount) ||
    !Number.isSafeInteger(packStatusOutboxCount) ||
    !Number.isSafeInteger(stripeCheckoutStateCount) ||
    !Number.isSafeInteger(deliveryRecoveryStateCount) ||
    !Number.isSafeInteger(inventoryCount) ||
    !Number.isSafeInteger(availableCount) ||
    !Number.isSafeInteger(guardCount)
  ) return 'unknown';
  const revisionDelta = plan.documentsToDelete.length || plan.inventory.metadata || plan.inventory.availableCount ? 1 : 0;
  const expectedGuardCount = Math.max(1, Math.ceil(plan.documentsToDelete.length / 50));
  if (
    documentsRevision === plan.authority.documentsRevision + revisionDelta &&
    targetCount === 0 &&
    claimCount === 0 &&
    notificationOutboxCount === 0 &&
    packStatusOutboxCount === 0 &&
    stripeCheckoutStateCount === 0 &&
    deliveryRecoveryStateCount === 0 &&
    inventoryCount === 0 &&
    availableCount === 0 &&
    guardCount === expectedGuardCount
  ) return 'committed';
  return 'unknown';
}

export function commitCommerceD1Wipe(
  dropId: string,
  plan: CommerceD1Plan,
  nowMs = Date.now(),
): string {
  dropId = validateDropId(dropId, 'drop id');
  if (dropId !== plan.dropId) fail('Commerce D1 wipe plan drop id does not match.');
  requireExecutableCommerceD1Wipe(plan.authority);
  const operationGuardId = `wipe:${dropId}:${crypto.randomUUID()}`;
  const operationGuardPrefix = `${operationGuardId}:`;
  const directory = mkdtempSync(path.join(tmpdir(), 'mons-shop-commerce-wipe-'));
  const filePath = path.join(directory, 'wipe.sql');
  try {
    writeFileSync(filePath, buildCommerceD1WipeSql(plan, operationGuardId, nowMs), {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      executeRemoteCommerceD1File(filePath);
    } catch (error) {
      if (readCommerceD1WipeOutcome(dropId, plan, operationGuardPrefix) === 'committed') {
        return operationGuardPrefix;
      }
      throw new CommerceD1WipeOutcomeUnknownError(error);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
  return operationGuardPrefix;
}

export function verifyCommerceD1Wipe(
  dropId: string,
  plan: CommerceD1Plan,
  operationGuardPrefix: string,
  queryCommerceD1: typeof queryRemoteCommerceD1 = queryRemoteCommerceD1,
): void {
  dropId = validateDropId(dropId, 'drop id');
  if (dropId !== plan.dropId) fail('Commerce D1 wipe plan drop id does not match.');
  if (readCommerceD1WipeOutcome(dropId, plan, operationGuardPrefix, queryCommerceD1) !== 'committed') {
    fail('Commerce D1 wipe verification failed.');
  }
  const dropGuardPrefix = `wipe:${dropId}:`;
  const deleted = queryCommerceD1(`DELETE FROM commerce_wipe_guards
    WHERE substr(guard_id, 1, ${dropGuardPrefix.length}) = ${sqlString(dropGuardPrefix)}
    RETURNING guard_id`);
  if (!deleted.some((row) => String(row.guard_id).startsWith(operationGuardPrefix))) {
    fail('Commerce D1 wipe guard cleanup could not be confirmed.');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const repoPlan = await buildRepoPlan({ root, dropId: args.dropId });

  if (repoPlan.extraReferences.length) {
    fail(
      `Found additional tracked references to ${args.dropId} outside the canonical wipe paths:\n` +
        repoPlan.extraReferences.map((relPath) => `- ${relPath}`).join('\n') +
        `\nRemove or rename those references first, then retry.`,
    );
  }
  if (!args.dryRun) {
    assertRepoWipeRegistryWritable(repoPlan);
  }

  const commercePlan = buildCommerceD1Plan(args.dropId);
  if (!args.dryRun) requireExecutableCommerceD1Wipe(commercePlan.authority);
  printPlan({ dropId: args.dropId, dryRun: args.dryRun, repoPlan, commercePlan });

  if (args.dryRun) {
    console.log('');
    console.log('dry-run complete; no changes made');
    return;
  }

  if (!args.yes) {
    console.log('');
    const confirmed = await promptForConfirmation();
    if (!confirmed) {
      console.log('cancelled');
      return;
    }
  }

  let releaseRegistryLock: (() => boolean) | undefined;
  let authorityLeaseActive = false;
  let requestedExitCode: number | undefined;
  const releaseOnExit = () => releaseRegistryLock?.();
  const handleSignal = (exitCode: number) => {
    if (authorityLeaseActive) {
      requestedExitCode ??= exitCode;
      return;
    }
    releaseRegistryLock?.();
    process.exit(exitCode);
  };
  const handleSigint = () => handleSignal(130);
  const handleSigterm = () => handleSignal(143);
  process.once('exit', releaseOnExit);
  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);

  try {
    releaseRegistryLock = acquireDeploymentRegistryMutationLock({
      root,
      operation: `wipe ${args.dropId}`,
    });
    authorityLeaseActive = true;
    try {
      await withCommerceWipeAuthorityLease({
        queryCommerceD1: queryRemoteCommerceD1,
        run: async (renewLease) => {
          const throwIfInterrupted = () => {
            if (requestedExitCode !== undefined) throw new WipeInterruptedError(requestedExitCode);
          };
          throwIfInterrupted();
          const lockedRepoPlan = await buildRepoPlan({ root, dropId: args.dropId });
          throwIfInterrupted();
          if (lockedRepoPlan.extraReferences.length) {
            fail(
              `Found additional tracked references to ${args.dropId} outside the canonical wipe paths:\n` +
                lockedRepoPlan.extraReferences.map((relPath) => `- ${relPath}`).join('\n') +
                `\nRemove or rename those references first, then retry.`,
            );
          }
          assertRepoWipeRegistryWritable(lockedRepoPlan);
          const lockedCommercePlan = buildCommerceD1Plan(args.dropId);
          await renewLease();
          throwIfInterrupted();
          requireExecutableCommerceD1Wipe(lockedCommercePlan.authority);
          if (
            !isDeepStrictEqual(lockedRepoPlan, repoPlan) ||
            !sameCommerceD1Plan(lockedCommercePlan, commercePlan)
          ) {
            fail('Repository or Commerce D1 state changed after the wipe plan was shown. Rerun to review a fresh plan.');
          }

          await renewLease();
          throwIfInterrupted();
          let operationGuardPrefix = '';
          applySynchronousWipePhases({
            prepareRepo: () => prepareRepoWipe(lockedRepoPlan),
            commitData: () => {
              operationGuardPrefix = commitCommerceD1Wipe(args.dropId, lockedCommercePlan);
            },
            applyPreparedRepo: (prepared) => applyPreparedRepoWipe(prepared),
            abortPreparedRepo: (prepared) => abortPreparedRepoWipe(prepared),
          });
          await renewLease();
          verifyCommerceD1Wipe(args.dropId, lockedCommercePlan, operationGuardPrefix);
          console.log('');
          console.log(
            `wipe complete: removed ${args.dropId} from local config, deleted ${lockedRepoPlan.canonicalDeleteTargets.length} canonical file(s), ` +
              `deleted ${lockedCommercePlan.documentsToDelete.length} Commerce D1 document(s), including ` +
              `${lockedCommercePlan.claimCodesToDelete.length} claimCodes doc(s)`,
          );
        },
      });
    } finally {
      authorityLeaseActive = false;
    }
    if (requestedExitCode !== undefined) process.exitCode = requestedExitCode;
  } finally {
    const released = releaseRegistryLock ? releaseRegistryLock() : true;
    if (!releaseRegistryLock || released) {
      process.removeListener('exit', releaseOnExit);
      process.removeListener('SIGINT', handleSigint);
      process.removeListener('SIGTERM', handleSigterm);
    }
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && path.resolve(entry) === fileURLToPath(import.meta.url));
}

if (isDirectRun()) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(err instanceof WipeInterruptedError ? err.exitCode : 1);
  });
}
