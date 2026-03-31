import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  normalizeDropId,
  readFrontendDropRegistry,
  readFunctionsDropRegistry,
  writeFrontendDeploymentRegistryFile,
  writeFunctionsDeploymentRegistryFile,
  type FrontendDropConfigSerialized,
  type FunctionsDropConfigSerialized,
} from '../../scripts/shared/deploymentRegistry.ts';

type Args = {
  dropId: string;
  newDefault?: string;
  dryRun: boolean;
  yes: boolean;
};

type RepoPlan = {
  frontendConfigPath: string;
  functionsConfigPath: string;
  frontendDropsNext: Record<string, FrontendDropConfigSerialized>;
  functionsDropsNext: Record<string, FunctionsDropConfigSerialized>;
  frontendConfigWillChange: boolean;
  functionsConfigWillChange: boolean;
  frontendDefaultNext: string;
  functionsDefaultNext: string;
  canonicalDeleteRelPaths: string[];
  canonicalDeleteAbsPaths: string[];
  extraReferences: string[];
};

type FirestorePlan = {
  claimCodesByDropId: string[];
  claimCodesFromAssignments: string[];
  claimCodesFromDeliveryOrders: string[];
  claimCodesToDelete: string[];
  missingClaimCodes: string[];
  recursiveDeletePath: string;
};

const PROJECT_ID = 'mons-shop';
const DROP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function usage(): string {
  return [
    'Wipe one drop from local config/data and Firestore.',
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
    '  --new-default <id>  Replacement default drop when needed',
    '  --dry-run           Preview only; do not mutate',
    '  --yes               Skip interactive confirmation',
    '  -h, --help          Show this help',
  ].join('\n');
}

function fail(message: string): never {
  throw new Error(message);
}

function validateDropId(raw: string, label: string): string {
  const normalized = normalizeDropId(raw);
  if (!DROP_ID_PATTERN.test(normalized)) {
    fail(`Invalid ${label}: ${raw}`);
  }
  return normalized;
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
  let newDefault: string | undefined;
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

    if (arg === '--new-default' || arg.startsWith('--new-default=')) {
      const { value, nextIndex } = readValue(
        '--new-default',
        i,
        arg.startsWith('--new-default=') ? arg.slice('--new-default='.length) : undefined,
      );
      newDefault = value;
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
  const newDefaultFromNpmConfig = readNpmConfigString(['new_default', 'new-default']);
  const finalDropIdRaw = dropId ?? positionalDropId ?? dropIdFromNpmConfig;
  const finalNewDefaultRaw = newDefault ?? newDefaultFromNpmConfig;

  if (!finalDropIdRaw) {
    fail(`Missing drop id.\n\n${usage()}`);
  }

  const normalizedDropId = validateDropId(finalDropIdRaw, 'drop id');
  const normalizedNewDefault = finalNewDefaultRaw ? validateDropId(finalNewDefaultRaw, 'new default drop id') : undefined;
  if (normalizedNewDefault && normalizedNewDefault === normalizedDropId) {
    fail('--new-default must refer to a different drop');
  }

  return {
    dropId: normalizedDropId,
    ...(normalizedNewDefault ? { newDefault: normalizedNewDefault } : {}),
    dryRun,
    yes,
  };
}

function normalizeMaybeDropId(value: unknown): string | undefined {
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
  // A drop id token must not be surrounded by drop-id characters, so `abc` does not match `abc_devnet`.
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

function isCanonicalDropFile(relPath: string, dropId: string): boolean {
  if (!relPath.startsWith('src/drops/')) return false;
  return path.parse(relPath).name === dropId;
}

function dropIdFromDropSubcollectionPath(pathValue: string, subcollection: string): string | undefined {
  const parts = String(pathValue || '').split('/');
  if (parts.length !== 4) return undefined;
  if (parts[0] !== 'drops' || parts[2] !== subcollection) return undefined;
  return normalizeMaybeDropId(parts[1]);
}

async function buildRepoPlan(args: {
  root: string;
  dropId: string;
  newDefault?: string;
}): Promise<RepoPlan> {
  const frontendConfigPath = path.join(args.root, 'src', 'config', 'deployment.ts');
  const functionsConfigPath = path.join(args.root, 'functions', 'src', 'config', 'deployment.ts');

  const [frontendRegistry, functionsRegistry] = await Promise.all([
    readFrontendDropRegistry(frontendConfigPath),
    readFunctionsDropRegistry(functionsConfigPath),
  ]);

  const frontendDropsNext = { ...frontendRegistry.drops };
  delete frontendDropsNext[args.dropId];
  const functionsDropsNext = { ...functionsRegistry.drops };
  delete functionsDropsNext[args.dropId];

  const nextFrontendDropIds = Object.keys(frontendDropsNext).sort((a, b) => a.localeCompare(b));
  const nextFunctionsDropIds = Object.keys(functionsDropsNext).sort((a, b) => a.localeCompare(b));

  if (!nextFrontendDropIds.length || !nextFunctionsDropIds.length) {
    fail(
      `Refusing to wipe ${args.dropId}: this would leave ${
        !nextFrontendDropIds.length && !nextFunctionsDropIds.length
          ? 'no configured drops'
          : !nextFrontendDropIds.length
            ? 'the frontend deployment config with no drops'
            : 'the functions deployment config with no drops'
      }.`,
    );
  }

  const targetIsFrontendDefault = frontendRegistry.defaultDropId === args.dropId;
  const targetIsFunctionsDefault = functionsRegistry.defaultDropId === args.dropId;
  const requiresNewDefault = targetIsFrontendDefault || targetIsFunctionsDefault;

  let frontendDefaultNext = frontendRegistry.defaultDropId || '';
  let functionsDefaultNext = functionsRegistry.defaultDropId || '';

  if (args.newDefault) {
    if (!frontendDropsNext[args.newDefault] || !functionsDropsNext[args.newDefault]) {
      const frontendChoices = nextFrontendDropIds.join(', ') || '(none)';
      const functionsChoices = nextFunctionsDropIds.join(', ') || '(none)';
      fail(
        `Invalid --new-default ${args.newDefault}.\n` +
          `Frontend remaining drops : ${frontendChoices}\n` +
          `Functions remaining drops: ${functionsChoices}`,
      );
    }
    frontendDefaultNext = args.newDefault;
    functionsDefaultNext = args.newDefault;
  } else {
    if (requiresNewDefault) {
      fail(
        `Drop ${args.dropId} is currently a default drop. Pass --new-default <remainingDropId>.\n` +
          `Remaining frontend drops : ${nextFrontendDropIds.join(', ')}\n` +
          `Remaining functions drops: ${nextFunctionsDropIds.join(', ')}`,
      );
    }
    if (!frontendDefaultNext || !frontendDropsNext[frontendDefaultNext]) {
      fail(`Frontend default drop would be invalid after wiping ${args.dropId}. Pass --new-default <remainingDropId>.`);
    }
    if (!functionsDefaultNext || !functionsDropsNext[functionsDefaultNext]) {
      fail(`Functions default drop would be invalid after wiping ${args.dropId}. Pass --new-default <remainingDropId>.`);
    }
  }

  const trackedFiles = listTrackedFiles(args.root);
  const canonicalDeleteRelPaths = sortStrings(
    trackedFiles.filter((relPath) => isCanonicalDropFile(relPath, args.dropId) || relPath === `scripts/discounts/${args.dropId}.csv`),
  );
  const allowedReferencePaths = new Set<string>([
    path.relative(args.root, frontendConfigPath),
    path.relative(args.root, functionsConfigPath),
    ...canonicalDeleteRelPaths,
  ]);
  const dropIdTokenRegex = buildDropIdTokenRegex(args.dropId);
  const extraReferences = sortStrings(
    trackedFiles.filter((relPath) => {
      if (allowedReferencePaths.has(relPath)) return false;
      if (hasDropIdToken(relPath, dropIdTokenRegex)) return true;
      return fileContainsDropIdToken(path.join(args.root, relPath), dropIdTokenRegex);
    }),
  );

  return {
    frontendConfigPath,
    functionsConfigPath,
    frontendDropsNext,
    functionsDropsNext,
    frontendConfigWillChange:
      Boolean(frontendRegistry.drops[args.dropId]) || frontendDefaultNext !== (frontendRegistry.defaultDropId || ''),
    functionsConfigWillChange:
      Boolean(functionsRegistry.drops[args.dropId]) || functionsDefaultNext !== (functionsRegistry.defaultDropId || ''),
    frontendDefaultNext,
    functionsDefaultNext,
    canonicalDeleteRelPaths,
    canonicalDeleteAbsPaths: canonicalDeleteRelPaths.map((relPath) => path.join(args.root, relPath)),
    extraReferences,
  };
}

function extractClaimCodesFromDeliveryOrders(orderData: unknown): string[] {
  if (!orderData || typeof orderData !== 'object') return [];
  const irlClaims = Array.isArray((orderData as any).irlClaims) ? (orderData as any).irlClaims : [];
  return irlClaims
    .map((entry) => normalizeClaimCode((entry as any)?.code))
    .filter((code): code is string => Boolean(code));
}

async function buildFirestorePlan(dropId: string): Promise<FirestorePlan> {
  const app = getApps()[0] || initializeApp({ projectId: PROJECT_ID });
  const db = getFirestore(app);

  const [claimCodesByDropSnap, boxAssignmentsSnap, deliveryOrdersSnap] = await Promise.all([
    db.collection('claimCodes').where('dropId', '==', dropId).get(),
    db.collection(`drops/${dropId}/boxAssignments`).select('irlClaimCode').get(),
    db.collection(`drops/${dropId}/deliveryOrders`).select('irlClaims').get(),
  ]);

  const claimCodesByDropId = sortStrings(claimCodesByDropSnap.docs.map((doc) => doc.id));
  const claimCodesFromAssignments = sortStrings(
    boxAssignmentsSnap.docs.map((doc) => normalizeClaimCode(doc.get('irlClaimCode'))).filter((code): code is string => Boolean(code)),
  );
  const claimCodesFromDeliveryOrders = sortStrings(
    deliveryOrdersSnap.docs.flatMap((doc) => extractClaimCodesFromDeliveryOrders(doc.data())),
  );
  const claimCodesByDropIdSet = new Set<string>(claimCodesByDropId);
  const claimCodesFromAssignmentsSet = new Set<string>(claimCodesFromAssignments);
  const claimCodesFromDeliveryOrdersSet = new Set<string>(claimCodesFromDeliveryOrders);
  const claimCodesToInspect = sortStrings([
    ...claimCodesByDropId,
    ...claimCodesFromAssignments,
    ...claimCodesFromDeliveryOrders,
  ]);

  const claimDocSnapshots = claimCodesToInspect.length
    ? await db.getAll(...claimCodesToInspect.map((code) => db.doc(`claimCodes/${code}`)))
    : [];
  const claimDocByCode = new Map<string, FirebaseFirestore.DocumentSnapshot>(
    claimDocSnapshots.map((snap) => [snap.id, snap]),
  );

  const conflicts: string[] = [];
  for (const code of claimCodesToInspect) {
    const snap = claimDocByCode.get(code);
    if (!snap?.exists) continue;

    const assignmentRefs = await db.collectionGroup('boxAssignments').where('irlClaimCode', '==', code).get();
    const assignmentOwnerDropIds = sortStrings(
      assignmentRefs.docs
        .map((doc) => dropIdFromDropSubcollectionPath(doc.ref.path, 'boxAssignments'))
        .filter((ownerDropId): ownerDropId is string => Boolean(ownerDropId)),
    );
    const foreignAssignmentOwners = assignmentOwnerDropIds.filter((ownerDropId) => ownerDropId !== dropId);
    if (foreignAssignmentOwners.length) {
      conflicts.push(`claimCodes/${code} is referenced by drop(s): ${foreignAssignmentOwners.join(', ')}`);
      continue;
    }

    const explicitDropId = normalizeMaybeDropId(snap.get('dropId'));
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

  return {
    claimCodesByDropId,
    claimCodesFromAssignments,
    claimCodesFromDeliveryOrders,
    claimCodesToDelete: sortStrings(claimDocSnapshots.filter((snap) => snap.exists).map((snap) => snap.id)),
    missingClaimCodes: sortStrings(claimCodesToInspect.filter((code) => !claimDocByCode.get(code)?.exists)),
    recursiveDeletePath: `drops/${dropId}`,
  };
}

function printPlan(args: {
  dropId: string;
  dryRun: boolean;
  repoPlan: RepoPlan;
  firestorePlan: FirestorePlan;
}) {
  const { repoPlan, firestorePlan } = args;

  console.log(`wipe-drop plan for ${args.dropId}`);
  console.log(`mode: ${args.dryRun ? 'dry-run' : 'execute after confirmation'}`);
  console.log('');

  console.log('codebase');
  if (repoPlan.frontendConfigWillChange) {
    console.log(`- update src/config/deployment.ts`);
    console.log(`  next frontend default: ${repoPlan.frontendDefaultNext}`);
  } else {
    console.log('- src/config/deployment.ts: no changes');
  }
  if (repoPlan.functionsConfigWillChange) {
    console.log(`- update functions/src/config/deployment.ts`);
    console.log(`  next functions default: ${repoPlan.functionsDefaultNext}`);
  } else {
    console.log('- functions/src/config/deployment.ts: no changes');
  }
  if (repoPlan.canonicalDeleteRelPaths.length) {
    repoPlan.canonicalDeleteRelPaths.forEach((relPath) => {
      console.log(`- delete ${relPath}`);
    });
  } else {
    console.log('- canonical drop files: none found');
  }

  console.log('');
  console.log('firestore');
  console.log(`- claimCodes where dropId == ${args.dropId}: ${firestorePlan.claimCodesByDropId.length}`);
  console.log(`- claim codes from boxAssignments: ${firestorePlan.claimCodesFromAssignments.length}`);
  console.log(`- claim codes from deliveryOrders.irlClaims: ${firestorePlan.claimCodesFromDeliveryOrders.length}`);
  console.log(`- claimCodes docs to delete: ${firestorePlan.claimCodesToDelete.length}`);
  if (firestorePlan.missingClaimCodes.length) {
    console.log(`- referenced claimCodes already absent: ${firestorePlan.missingClaimCodes.length}`);
  }
  console.log(`- recursive delete: ${firestorePlan.recursiveDeletePath}`);
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

function applyRepoWipe(plan: RepoPlan): void {
  if (plan.frontendConfigWillChange) {
    writeFrontendDeploymentRegistryFile({
      filePath: plan.frontendConfigPath,
      defaultDropId: plan.frontendDefaultNext,
      drops: plan.frontendDropsNext,
    });
  }
  if (plan.functionsConfigWillChange) {
    writeFunctionsDeploymentRegistryFile({
      filePath: plan.functionsConfigPath,
      defaultDropId: plan.functionsDefaultNext,
      drops: plan.functionsDropsNext,
    });
  }
  plan.canonicalDeleteAbsPaths.forEach((absPath) => {
    if (existsSync(absPath)) rmSync(absPath, { force: true });
  });
}

async function applyFirestoreWipe(dropId: string, plan: FirestorePlan): Promise<void> {
  const app = getApps()[0] || initializeApp({ projectId: PROJECT_ID });
  const db = getFirestore(app);

  if (plan.claimCodesToDelete.length) {
    const writer = db.bulkWriter();
    writer.onWriteError((err) => {
      console.error(`claimCodes delete failed for ${err.documentRef.path}: ${err.message}`);
      return false;
    });
    plan.claimCodesToDelete.forEach((code) => {
      writer.delete(db.doc(`claimCodes/${code}`));
    });
    await writer.close();
  }

  await db.recursiveDelete(db.doc(`drops/${dropId}`));
}

function looksLikeCredentialError(message: string): boolean {
  return /Could not load the default credentials|Failed to determine service account|credential implementation provided|Failed to read credentials from file/i.test(
    message,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const repoPlan = await buildRepoPlan({ root, dropId: args.dropId, newDefault: args.newDefault });

  if (repoPlan.extraReferences.length) {
    fail(
      `Found additional tracked references to ${args.dropId} outside the canonical wipe paths:\n` +
        repoPlan.extraReferences.map((relPath) => `- ${relPath}`).join('\n') +
        `\nRemove or rename those references first, then retry.`,
    );
  }

  const firestorePlan = await buildFirestorePlan(args.dropId);
  printPlan({ dropId: args.dropId, dryRun: args.dryRun, repoPlan, firestorePlan });

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

  applyRepoWipe(repoPlan);
  await applyFirestoreWipe(args.dropId, firestorePlan);

  console.log('');
  console.log(
    `wipe complete: removed ${args.dropId} from local config, deleted ${repoPlan.canonicalDeleteRelPaths.length} canonical file(s), ` +
      `deleted ${firestorePlan.claimCodesToDelete.length} claimCodes doc(s), and recursively deleted ${firestorePlan.recursiveDeletePath}`,
  );
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (looksLikeCredentialError(message)) {
    console.error('Firebase admin credentials are not available. Set GOOGLE_APPLICATION_CREDENTIALS or local ADC, then retry.');
  }
  console.error(message);
  process.exit(1);
});
