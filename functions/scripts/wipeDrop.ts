import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  planCanonicalDiscountMerkleDatasetRemoval,
  type DiscountMerkleDatasetReference,
} from '../../scripts/shared/discountMerkleDataset.ts';
import {
  createFirebaseCliFirestoreRestClient,
  decodeFirestoreRestDocument,
  type FirestoreRestDocument,
} from '../../scripts/shared/firebaseCliFirestoreRest.ts';
import {
  isOptimisticTextFilePostCommitVerificationError,
  writeOptimisticTextFile,
} from '../../scripts/shared/optimisticTextFile.ts';
import {
  acquireDeploymentRegistryMutationLock,
  defaultDropFamilyForDropId,
  isDeploymentRegistryPostCommitVerificationError,
  normalizeDropId,
  normalizeAndValidateDropId,
  readDeploymentDropRegistry,
  renderDeploymentRegistryFileFromSource,
  requireDropFamily,
  writeDeploymentRegistryFile,
  type DeploymentDropConfigSerialized,
  type FrontendDropConfigSerialized,
  type FunctionsDropConfigSerialized,
} from '../../scripts/shared/deploymentRegistry.ts';

type Args = {
  dropId: string;
  dryRun: boolean;
  yes: boolean;
};

export type CanonicalDeleteTarget = {
  relativePath: string;
  absolutePath: string;
  quarantinePath?: string;
  expectedSha256?: string;
  expectedDevice?: number;
  expectedInode?: number;
  expectedMode?: number;
  expectedKind?: 'file' | 'symlink';
  expectedSymlinkTarget?: string;
  quarantineExpectedSha256?: string;
  quarantineExpectedMode?: number;
  quarantineExpectedKind?: 'file' | 'symlink';
  quarantineExpectedSymlinkTarget?: string;
};

export type RepoPlan = {
  registryPath: string;
  dropsNext: Record<string, DeploymentDropConfigSerialized>;
  registryWillChange: boolean;
  registryExpectedContent: string;
  registryNextContent: string;
  canonicalDeleteTargets: CanonicalDeleteTarget[];
  recoveryRestoreTargets?: CanonicalDeleteTarget[];
  extraReferences: string[];
  recoveryManifest?: {
    filePath: string;
    expectedContent?: string;
    content: string;
  };
};

type FirestorePlan = {
  claimCodesByDropId: string[];
  claimCodesFromAssignments: string[];
  claimCodesFromDeliveryOrders: string[];
  claimCodesToDelete: string[];
  missingClaimCodes: string[];
  recursiveDeletePath: string;
};

type FirestoreDocRecord = FirestoreRestDocument;

type FirestoreClientMode = 'admin' | 'rest';
type FirestoreStringFilter =
  | {
      op?: 'EQUAL';
      value: string;
    }
  | {
      op: 'IN';
      values: string[];
    };

const PROJECT_ID = 'mons-shop';
const FIRESTORE_LIST_PAGE_SIZE = 1000;
const FIRESTORE_IN_QUERY_MAX_VALUES = 10;

let firestoreClientMode: FirestoreClientMode | undefined;
const firestoreRestClient = createFirebaseCliFirestoreRestClient({
  projectId: PROJECT_ID,
});

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

export function asFirestoreDocumentId(value: unknown): string | undefined {
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

function chunkStrings(values: string[], size: number): string[][] {
  if (!values.length || size < 1) return [];
  const out: string[][] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!items.length) return [];
  const out = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      out[current] = await fn(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
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
  const normalized = relPath.replace(/\\/g, '/');
  const parsed = path.posix.parse(normalized);
  return parsed.dir === 'src/drops' && parsed.name === dropId;
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

export function assertWipeRegistryConsistency(args: {
  dropId: string;
  frontendDrops: Record<string, Pick<FrontendDropConfigSerialized, 'dropId' | 'dropFamily' | 'discountMerkleRoot'>>;
  functionsDrops: Record<string, Pick<FunctionsDropConfigSerialized, 'dropId' | 'dropFamily' | 'discountMerkleRoot'>>;
}): void {
  const targetDropId = validateDropId(args.dropId, 'drop id');
  const dropIds = sortStrings([
    ...Object.keys(args.frontendDrops),
    ...Object.keys(args.functionsDrops),
  ]);
  for (const dropId of dropIds) {
    normalizeAndValidateDropId(dropId, 'deployment registry drop id');
    const frontend = Object.prototype.hasOwnProperty.call(args.frontendDrops, dropId)
      ? args.frontendDrops[dropId]
      : undefined;
    const functions = Object.prototype.hasOwnProperty.call(args.functionsDrops, dropId)
      ? args.functionsDrops[dropId]
      : undefined;
    if (!frontend || !functions) {
      if (dropId === targetDropId) continue;
      fail(
        `Refusing to wipe ${targetDropId}: unrelated drop ${dropId} is missing from the ${
          frontend ? 'Functions' : 'frontend'
        } deployment registry.`,
      );
    }
    if (
      frontend.dropFamily !== functions.dropFamily ||
      frontend.discountMerkleRoot !== functions.discountMerkleRoot
    ) {
      const targetLabel = dropId === targetDropId ? 'target' : 'unrelated';
      fail(
        `Refusing to wipe ${targetDropId}: ${targetLabel} drop ${dropId} has mismatched discount Merkle references.\n` +
          `- frontend : ${frontend.dropFamily}/${frontend.discountMerkleRoot}\n` +
          `- Functions: ${functions.dropFamily}/${functions.discountMerkleRoot}`,
      );
    }
  }
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

type WipeRecoveryManifest = {
  version: 1;
  dropId: string;
  dropFamily?: string;
  discountMerkleRoot?: string;
  targets: Array<{
    relativePath: string;
    quarantineRelativePath?: string;
    restoreOnly?: true;
    expectedSha256?: string;
    expectedDevice?: number;
    expectedInode?: number;
    expectedMode?: number;
    expectedKind?: 'file' | 'symlink';
    expectedSymlinkTarget?: string;
  }>;
};

function wipeRecoveryManifestPath(root: string, dropId: string): string {
  return path.join(root, '.cache', 'wipe-drop', `${dropId}.json`);
}

function deterministicQuarantineRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  const parsed = path.posix.parse(normalized);
  const digest = createHash('sha256')
    .update(`wipe-drop-quarantine\0${normalized}`)
    .digest('hex')
    .slice(0, 20);
  const directoryName = `.${parsed.base}.wipe-drop-${digest}`;
  return path.posix.join(parsed.dir, directoryName, parsed.base);
}

function deterministicQuarantinePath(args: {
  absolutePath: string;
  relativePath: string;
}): string {
  const relativePath = deterministicQuarantineRelativePath(
    args.relativePath,
  );
  const directoryName = path.posix.basename(path.posix.dirname(relativePath));
  return path.join(
    path.dirname(args.absolutePath),
    directoryName,
    path.basename(args.absolutePath),
  );
}

function recoveryFingerprintMatchesSnapshot(
  filePath: string,
  target: WipeRecoveryManifest['targets'][number],
  snapshot: LocalFileSnapshot,
): boolean {
  if (
    target.expectedSha256 == null ||
    target.expectedMode == null ||
    target.expectedKind == null ||
    !snapshot.exists
  ) {
    return false;
  }
  try {
    return (
      snapshot.kind === target.expectedKind &&
      snapshot.mode === target.expectedMode &&
      (target.expectedDevice == null ||
        snapshot.device === target.expectedDevice) &&
      (target.expectedInode == null ||
        snapshot.inode === target.expectedInode) &&
      (snapshot.kind !== 'symlink' ||
        snapshot.target === target.expectedSymlinkTarget) &&
      sha256LocalSnapshot(filePath, snapshot) ===
        target.expectedSha256
    );
  } catch {
    return false;
  }
}

function recoveryTargetMatchesSnapshot(
  filePath: string,
  target: WipeRecoveryManifest['targets'][number],
): boolean {
  if (target.restoreOnly === true) return false;
  try {
    return recoveryFingerprintMatchesSnapshot(
      filePath,
      target,
      snapshotLocalFile(filePath),
    );
  } catch {
    return false;
  }
}

function recoveryTargetAuthenticatesLivePath(args: {
  root: string;
  target: WipeRecoveryManifest['targets'][number];
}): boolean {
  try {
    const absolutePath = path.join(
      args.root,
      ...args.target.relativePath.split('/'),
    );
    const canonicalMatches =
      localPathEntryExists(absolutePath) &&
      recoveryTargetMatchesSnapshot(absolutePath, args.target);
    const quarantineRelativePath =
      args.target.quarantineRelativePath ??
      deterministicQuarantineRelativePath(args.target.relativePath);
    const quarantinePath = path.join(
      args.root,
      ...quarantineRelativePath.split('/'),
    );
    return (
      canonicalMatches ||
      recoveryTargetMatchesSnapshot(
        quarantinePath,
        args.target,
      )
    );
  } catch {
    return false;
  }
}

function validatedRecoveryTargetPaths(
  manifest: WipeRecoveryManifest,
): Set<string> {
  const canonicalMerklePath = manifest.dropFamily
    ? `src/drops/discountMerkles/${manifest.dropFamily}.json`
    : undefined;
  const legacyMerklePath =
    `src/drops/discountMerkles/${manifest.dropId}.json`;
  const allowed = new Set([
    ...(canonicalMerklePath ? [canonicalMerklePath] : []),
    legacyMerklePath,
    `scripts/discounts/${manifest.dropId}.csv`,
  ]);
  const paths = new Set<string>();
  for (const target of manifest.targets) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      fail(`Invalid wipe recovery target for ${manifest.dropId}.`);
    }
    if (
      typeof target.relativePath !== 'string' ||
      path.isAbsolute(target.relativePath) ||
      target.relativePath !== target.relativePath.replace(/\\/g, '/') ||
      target.relativePath.split('/').includes('..') ||
      (!allowed.has(target.relativePath) &&
        !isCanonicalDropFile(target.relativePath, manifest.dropId))
    ) {
      fail(
        `Invalid wipe recovery target for ${manifest.dropId}: ${String(target.relativePath)}`,
      );
    }
    if (
      target.quarantineRelativePath != null &&
      target.quarantineRelativePath !==
        deterministicQuarantineRelativePath(target.relativePath)
    ) {
      fail(
        `Invalid wipe recovery quarantine path for ${target.relativePath}.`,
      );
    }
    if (target.restoreOnly != null && target.restoreOnly !== true) {
      fail(
        `Invalid wipe recovery disposition for ${target.relativePath}.`,
      );
    }
    if (
      target.expectedSha256 != null &&
      !/^[0-9a-f]{64}$/.test(target.expectedSha256)
    ) {
      fail(
        `Invalid wipe recovery fingerprint for ${target.relativePath}.`,
      );
    }
    const identityValues = [
      target.expectedDevice,
      target.expectedInode,
      target.expectedMode,
    ];
    if (
      identityValues.some(
        (value) =>
          value != null &&
          (!Number.isSafeInteger(value) || value < 0),
      ) ||
      (target.expectedKind != null &&
        target.expectedKind !== 'file' &&
        target.expectedKind !== 'symlink') ||
      (target.expectedSymlinkTarget != null &&
        typeof target.expectedSymlinkTarget !== 'string')
    ) {
      fail(
        `Invalid wipe recovery identity for ${target.relativePath}.`,
      );
    }
    const hasCompleteIdentity =
      target.expectedMode != null &&
      target.expectedKind != null &&
      (target.expectedKind === 'file' ||
        target.expectedSymlinkTarget != null);
    if (
      (target.expectedSha256 != null) !== hasCompleteIdentity ||
      (target.expectedKind !== 'symlink' &&
        target.expectedSymlinkTarget != null)
    ) {
      fail(
        `Incomplete wipe recovery fingerprint for ${target.relativePath}.`,
      );
    }
    if (paths.has(target.relativePath)) {
      fail(`Duplicate wipe recovery target: ${target.relativePath}`);
    }
    paths.add(target.relativePath);
  }
  return paths;
}

type ParsedWipeRecoveryManifest = {
  manifest: WipeRecoveryManifest;
  sourceContent: string;
};

function isSupportedCanonicalDropFamily(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return requireDropFamily(value, 'wipe recovery dropFamily') === value;
  } catch {
    return false;
  }
}

function parseWipeRecoveryManifest(args: {
  filePath: string;
  dropId: string;
}): ParsedWipeRecoveryManifest | undefined {
  if (!existsSync(args.filePath)) return undefined;
  let sourceContent: string;
  let parsed: unknown;
  try {
    sourceContent = readFileSync(args.filePath, 'utf8');
    parsed = JSON.parse(sourceContent);
  } catch (error) {
    fail(
      `Could not read wipe recovery manifest ${args.filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`Invalid wipe recovery manifest: ${args.filePath}`);
  }
  const candidate = parsed as Partial<WipeRecoveryManifest>;
  const dropId = normalizeAndValidateDropId(
    candidate.dropId,
    'wipe recovery dropId',
  );
  if (
    candidate.version !== 1 ||
    candidate.dropId !== dropId ||
    dropId !== args.dropId ||
    (candidate.dropFamily != null &&
      !isSupportedCanonicalDropFamily(candidate.dropFamily)) ||
    (candidate.discountMerkleRoot != null &&
      (typeof candidate.discountMerkleRoot !== 'string' ||
        !/^[0-9a-f]{64}$/.test(candidate.discountMerkleRoot))) ||
    (candidate.dropFamily == null) !==
      (candidate.discountMerkleRoot == null) ||
    !Array.isArray(candidate.targets)
  ) {
    fail(`Invalid wipe recovery manifest: ${args.filePath}`);
  }
  const manifest = candidate as WipeRecoveryManifest;
  validatedRecoveryTargetPaths(manifest);
  return { manifest, sourceContent };
}

function renderWipeRecoveryManifest(
  manifest: WipeRecoveryManifest,
): string {
  return `${JSON.stringify(
    {
      ...manifest,
      targets: manifest.targets
        .slice()
        .sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath),
        )
        .map((target) => {
          const {
            expectedDevice: _expectedDevice,
            expectedInode: _expectedInode,
            ...stableTarget
          } = target;
          return {
            ...stableTarget,
            quarantineRelativePath:
              target.quarantineRelativePath ??
              deterministicQuarantineRelativePath(target.relativePath),
          };
        }),
    },
    null,
    2,
  )}\n`;
}

function adminDb() {
  const app = getApps()[0] || initializeApp({ projectId: PROJECT_ID });
  return getFirestore(app);
}

function normalizeFirestoreDocPath(pathValue: string): string {
  return String(pathValue || '').replace(/^\/+/, '');
}

async function listCollectionDocumentsViaRest(
  collectionPath: string,
  opts?: { maskFieldPaths?: string[]; showMissing?: boolean },
): Promise<FirestoreDocRecord[]> {
  const docs: FirestoreDocRecord[] = [];
  let pageToken: string | undefined;

  do {
    const url = firestoreRestClient.documentUrl(collectionPath);
    url.searchParams.set('pageSize', String(FIRESTORE_LIST_PAGE_SIZE));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    if (opts?.showMissing) url.searchParams.set('showMissing', 'true');
    (opts?.maskFieldPaths || []).forEach((fieldPath) => {
      url.searchParams.append('mask.fieldPaths', fieldPath);
    });
    const json = await firestoreRestClient.request({ url, allow404: true });
    const pageDocs = Array.isArray(json?.documents) ? json.documents : [];
    pageDocs.forEach((doc) => {
      const decoded = decodeFirestoreRestDocument(doc);
      if (decoded) docs.push(decoded);
    });
    pageToken = typeof json?.nextPageToken === 'string' && json.nextPageToken ? json.nextPageToken : undefined;
  } while (pageToken);

  return docs;
}

async function getDocumentViaRest(documentPath: string): Promise<FirestoreDocRecord | null> {
  const json = await firestoreRestClient.request({
    url: firestoreRestClient.documentUrl(documentPath),
    allow404: true,
  });
  if (!json) return null;
  return decodeFirestoreRestDocument(json) || null;
}

async function runCollectionQueryViaRest(args: {
  collectionId: string;
  fieldPath: string;
  filter: FirestoreStringFilter;
  parentPath?: string;
  allDescendants?: boolean;
  maskFieldPaths?: string[];
  limit?: number;
}): Promise<FirestoreDocRecord[]> {
  const url = args.parentPath
    ? firestoreRestClient.documentUrl(args.parentPath, ':runQuery')
    : firestoreRestClient.documentsUrl(':runQuery');
  const json = await firestoreRestClient.request({
    url,
    method: 'POST',
    body: {
      structuredQuery: {
        from: [
          {
            collectionId: args.collectionId,
            ...(args.allDescendants ? { allDescendants: true } : {}),
          },
        ],
        where: {
          fieldFilter: {
            field: { fieldPath: args.fieldPath },
            op: args.filter.op || 'EQUAL',
            value:
              args.filter.op === 'IN'
                ? {
                    arrayValue: {
                      values: args.filter.values.map((value) => ({ stringValue: value })),
                    },
                  }
                : { stringValue: args.filter.value },
          },
        },
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        ...(args.maskFieldPaths?.length
          ? {
              select: {
                fields: args.maskFieldPaths.map((fieldPath) => ({ fieldPath })),
              },
            }
          : {}),
      },
    },
  });
  return (Array.isArray(json) ? json : [])
    .map((entry) => decodeFirestoreRestDocument(entry?.document))
    .filter((doc): doc is FirestoreDocRecord => Boolean(doc));
}

async function listCollectionIdsViaRest(documentPath: string): Promise<string[]> {
  const collectionIds: string[] = [];
  let pageToken: string | undefined;

  do {
    const json = await firestoreRestClient.request({
      url: firestoreRestClient.documentUrl(documentPath, ':listCollectionIds'),
      method: 'POST',
      body: {
        pageSize: FIRESTORE_LIST_PAGE_SIZE,
        ...(pageToken ? { pageToken } : {}),
      },
      allow404: true,
    });
    collectionIds.push(...((Array.isArray(json?.collectionIds) ? json.collectionIds : []).filter(Boolean) as string[]));
    pageToken = typeof json?.nextPageToken === 'string' && json.nextPageToken ? json.nextPageToken : undefined;
  } while (pageToken);

  return sortStrings(collectionIds);
}

async function deleteDocumentViaRest(documentPath: string): Promise<void> {
  await firestoreRestClient.request({
    url: firestoreRestClient.documentUrl(documentPath),
    method: 'DELETE',
    allow404: true,
  });
}

async function recursiveDeleteDocumentViaRest(documentPath: string): Promise<void> {
  const normalizedPath = normalizeFirestoreDocPath(documentPath);
  const subcollectionIds = await listCollectionIdsViaRest(normalizedPath);

  for (const subcollectionId of subcollectionIds) {
    const nestedDocs = await listCollectionDocumentsViaRest(`${normalizedPath}/${subcollectionId}`, {
      maskFieldPaths: ['__name__'],
      showMissing: true,
    });
    await mapLimit(
      nestedDocs.map((doc) => doc.path),
      8,
      async (childDocPath) => recursiveDeleteDocumentViaRest(childDocPath),
    );
  }

  await deleteDocumentViaRest(normalizedPath);
}

function looksLikeFirestorePermissionError(message: string): boolean {
  return /permission[-_\s]?denied|missing or insufficient permissions/i.test(message);
}

async function withFirestoreFallback<T>(adminOp: () => Promise<T>, restOp: () => Promise<T>): Promise<T> {
  if (firestoreClientMode !== 'rest') {
    try {
      const result = await adminOp();
      firestoreClientMode = 'admin';
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!looksLikeFirestorePermissionError(message)) throw err;
      firestoreClientMode = 'rest';
    }
  }

  return restOp();
}

async function listDropIds(): Promise<string[]> {
  return withFirestoreFallback(
    async () => {
      const refs = await adminDb().collection('drops').listDocuments();
      return sortStrings(refs.map((ref) => asFirestoreDocumentId(ref.id)).filter((dropId): dropId is string => Boolean(dropId)));
    },
    async () => {
      const docs = await listCollectionDocumentsViaRest('drops', { maskFieldPaths: ['__name__'], showMissing: true });
      return sortStrings(docs.map((doc) => asFirestoreDocumentId(doc.id)).filter((dropId): dropId is string => Boolean(dropId)));
    },
  );
}

async function listClaimCodesByDropId(dropId: string): Promise<string[]> {
  return withFirestoreFallback(
    async () => {
      const snap = await adminDb().collection('claimCodes').where('dropId', '==', dropId).get();
      return sortStrings(snap.docs.map((doc) => doc.id));
    },
    async () => {
      const docs = await runCollectionQueryViaRest({
        collectionId: 'claimCodes',
        fieldPath: 'dropId',
        filter: { value: dropId },
        maskFieldPaths: ['dropId'],
      });
      return sortStrings(docs.map((doc) => doc.id));
    },
  );
}

async function listBoxAssignmentClaimCodes(dropId: string): Promise<string[]> {
  return withFirestoreFallback(
    async () => {
      const snap = await adminDb().collection(`drops/${dropId}/boxAssignments`).select('irlClaimCode').get();
      return sortStrings(
        snap.docs.map((doc) => normalizeClaimCode(doc.get('irlClaimCode'))).filter((code): code is string => Boolean(code)),
      );
    },
    async () => {
      const docs = await listCollectionDocumentsViaRest(`drops/${dropId}/boxAssignments`, { maskFieldPaths: ['irlClaimCode'] });
      return sortStrings(docs.map((doc) => normalizeClaimCode(doc.data.irlClaimCode)).filter((code): code is string => Boolean(code)));
    },
  );
}

async function listDeliveryOrderClaimCodes(dropId: string): Promise<string[]> {
  return withFirestoreFallback(
    async () => {
      const snap = await adminDb().collection(`drops/${dropId}/deliveryOrders`).select('irlClaims').get();
      return sortStrings(snap.docs.flatMap((doc) => extractClaimCodesFromDeliveryOrders(doc.data())));
    },
    async () => {
      const docs = await listCollectionDocumentsViaRest(`drops/${dropId}/deliveryOrders`, { maskFieldPaths: ['irlClaims'] });
      return sortStrings(docs.flatMap((doc) => extractClaimCodesFromDeliveryOrders(doc.data)));
    },
  );
}

async function findClaimCodesInBoxAssignments(dropId: string, codes: string[]): Promise<string[]> {
  const normalizedCodes = sortStrings(codes);
  if (!normalizedCodes.length) return [];

  return withFirestoreFallback(
    async () => {
      const chunks = chunkStrings(normalizedCodes, FIRESTORE_IN_QUERY_MAX_VALUES);
      const matches = await mapLimit(chunks, 4, async (chunk) => {
        const snap = await adminDb()
          .collection(`drops/${dropId}/boxAssignments`)
          .where('irlClaimCode', 'in', chunk)
          .select('irlClaimCode')
          .get();
        return snap.docs.map((doc) => normalizeClaimCode(doc.get('irlClaimCode'))).filter((code): code is string => Boolean(code));
      });
      return sortStrings(matches.flat());
    },
    async () => {
      const chunks = chunkStrings(normalizedCodes, FIRESTORE_IN_QUERY_MAX_VALUES);
      const matches = await mapLimit(chunks, 4, async (chunk) => {
        const docs = await runCollectionQueryViaRest({
          parentPath: `drops/${dropId}`,
          collectionId: 'boxAssignments',
          fieldPath: 'irlClaimCode',
          filter: { op: 'IN', values: chunk },
          maskFieldPaths: ['irlClaimCode'],
        });
        return docs.map((doc) => normalizeClaimCode(doc.data.irlClaimCode)).filter((code): code is string => Boolean(code));
      });
      return sortStrings(matches.flat());
    },
  );
}

async function findAssignmentOwnerDropIdsByCode(args: {
  dropIds: string[];
  targetDropId: string;
  targetClaimCodes: string[];
  codesToInspect: string[];
}): Promise<Map<string, Set<string>>> {
  const ownership = new Map<string, Set<string>>();
  const targetDropId = validateDropId(args.targetDropId, 'drop id');

  const addOwners = (ownerDropId: string, codes: string[]) => {
    codes.forEach((code) => {
      const owners = ownership.get(code) || new Set<string>();
      owners.add(ownerDropId);
      ownership.set(code, owners);
    });
  };

  addOwners(targetDropId, args.targetClaimCodes);

  const foreignDropIds = sortStrings(
    args.dropIds
      .map((dropId) => asFirestoreDocumentId(dropId))
      .filter(
        (dropId): dropId is string =>
          Boolean(dropId) && dropId !== targetDropId,
      ),
  );
  const codeChunks = chunkStrings(sortStrings(args.codesToInspect), FIRESTORE_IN_QUERY_MAX_VALUES);
  const queryTasks = foreignDropIds.flatMap((ownerDropId) => codeChunks.map((codes) => ({ ownerDropId, codes })));

  const results = await mapLimit(queryTasks, 8, async ({ ownerDropId, codes }) => ({
    ownerDropId,
    codes: await findClaimCodesInBoxAssignments(ownerDropId, codes),
  }));

  results.forEach(({ ownerDropId, codes }) => addOwners(ownerDropId, codes));
  return ownership;
}

async function loadClaimDocs(codes: string[]): Promise<Map<string, FirestoreDocRecord>> {
  if (!codes.length) return new Map<string, FirestoreDocRecord>();

  return withFirestoreFallback(
    async () => {
      const docs = await adminDb().getAll(...codes.map((code) => adminDb().doc(`claimCodes/${code}`)));
      return new Map<string, FirestoreDocRecord>(
        docs
          .filter((snap) => snap.exists)
          .map((snap) => [snap.id, { path: snap.ref.path, id: snap.id, data: snap.data() || {} }]),
      );
    },
    async () => {
      const docs = await mapLimit(codes, 8, async (code) => getDocumentViaRest(`claimCodes/${code}`));
      return new Map<string, FirestoreDocRecord>(
        docs.filter((doc): doc is FirestoreDocRecord => Boolean(doc)).map((doc) => [doc.id, doc]),
      );
    },
  );
}

export async function buildRepoPlan(args: {
  root: string;
  dropId: string;
}): Promise<RepoPlan> {
  const dropId = validateDropId(args.dropId, 'drop id');
  const registryPath = path.join(
    args.root,
    'functions',
    'src',
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
  const registryNextContent = registryWillChange
    ? renderDeploymentRegistryFileFromSource({
        filePath: registryPath,
        existingContent: registry.sourceContent,
        drops: dropsNext,
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
    // Without a registry or journal root, family Merkle ownership cannot be
    // proven. The exact drop-id legacy path remains exclusively drop-owned.
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

async function buildFirestorePlan(dropId: string, knownDropIds: string[]): Promise<FirestorePlan> {
  dropId = validateDropId(dropId, 'drop id');
  const [claimCodesByDropId, claimCodesFromAssignments, claimCodesFromDeliveryOrders, firestoreDropIds] = await Promise.all([
    listClaimCodesByDropId(dropId),
    listBoxAssignmentClaimCodes(dropId),
    listDeliveryOrderClaimCodes(dropId),
    listDropIds(),
  ]);

  const claimCodesByDropIdSet = new Set<string>(claimCodesByDropId);
  const claimCodesFromAssignmentsSet = new Set<string>(claimCodesFromAssignments);
  const claimCodesFromDeliveryOrdersSet = new Set<string>(claimCodesFromDeliveryOrders);
  const claimCodesToInspect = sortStrings([
    ...claimCodesByDropId,
    ...claimCodesFromAssignments,
    ...claimCodesFromDeliveryOrders,
  ]);

  const dropIdsToInspect = sortStrings([...knownDropIds, ...firestoreDropIds]);
  const assignmentOwnerDropIdsByCode = await findAssignmentOwnerDropIdsByCode({
    dropIds: dropIdsToInspect,
    targetDropId: dropId,
    targetClaimCodes: claimCodesFromAssignments,
    codesToInspect: claimCodesToInspect,
  });
  const claimDocByCode = await loadClaimDocs(claimCodesToInspect);

  const conflicts: string[] = [];
  for (const code of claimCodesToInspect) {
    const doc = claimDocByCode.get(code);
    if (!doc) continue;

    const assignmentOwnerDropIds = sortStrings(assignmentOwnerDropIdsByCode.get(code) || []);
    const foreignAssignmentOwners = assignmentOwnerDropIds.filter((ownerDropId) => ownerDropId !== dropId);
    if (foreignAssignmentOwners.length) {
      conflicts.push(`claimCodes/${code} is referenced by drop(s): ${foreignAssignmentOwners.join(', ')}`);
      continue;
    }

    const explicitDropId = normalizeStoredDropIdField(doc.data.dropId);
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
    claimCodesToDelete: sortStrings(claimDocByCode.keys()),
    missingClaimCodes: sortStrings(claimCodesToInspect.filter((code) => !claimDocByCode.has(code))),
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
  if (repoPlan.registryWillChange) {
    console.log(`- update functions/src/shared/deploymentRegistry.ts`);
  } else {
    console.log('- functions/src/shared/deploymentRegistry.ts: no changes');
  }
  if (repoPlan.canonicalDeleteTargets.length) {
    repoPlan.canonicalDeleteTargets.forEach((target) => {
      console.log(`- delete ${target.relativePath}`);
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

export type LocalFileSnapshot =
  | Readonly<{ exists: false }>
  | Readonly<{
      exists: true;
      kind: 'file';
      contentBase64: string;
      mode: number;
      device: number;
      inode: number;
    }>
  | Readonly<{
      exists: true;
      kind: 'symlink';
      target: string;
      mode: number;
      device: number;
      inode: number;
    }>;

function localPathEntryExists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

function snapshotLocalFile(filePath: string): LocalFileSnapshot {
  let fileStat;
  try {
    fileStat = lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { exists: false };
    }
    throw error;
  }
  if (fileStat.isSymbolicLink()) {
    return {
      exists: true,
      kind: 'symlink',
      target: readlinkSync(filePath),
      mode: fileStat.mode & 0o7777,
      device: fileStat.dev,
      inode: fileStat.ino,
    };
  }
  if (!fileStat.isFile()) {
    throw new Error(`Expected a regular file or symlink: ${filePath}`);
  }
  return {
    exists: true,
    kind: 'file',
    contentBase64: readFileSync(filePath).toString('base64'),
    mode: fileStat.mode & 0o7777,
    device: fileStat.dev,
    inode: fileStat.ino,
  };
}

function sha256LocalSnapshot(
  filePath: string,
  snapshot: Exclude<LocalFileSnapshot, { exists: false }>,
): string {
  return createHash('sha256')
    .update(
      snapshot.kind === 'symlink'
        ? Buffer.from(snapshot.target, 'utf8')
        : readFileSync(filePath),
    )
    .digest('hex');
}

function localFileMatchesSnapshot(
  filePath: string,
  snapshot: Exclude<LocalFileSnapshot, { exists: false }>,
): boolean {
  let fileStat;
  try {
    fileStat = lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
  const mode = fileStat.mode & 0o7777;
  if (snapshot.kind === 'symlink') {
    return (
      fileStat.isSymbolicLink() &&
      mode === snapshot.mode &&
      readlinkSync(filePath) === snapshot.target
    );
  }
  return (
    fileStat.isFile() &&
    mode === snapshot.mode &&
    readFileSync(filePath).equals(
      Buffer.from(snapshot.contentBase64, 'base64'),
    )
  );
}

function localFileHasSnapshotIdentity(
  filePath: string,
  snapshot: Exclude<LocalFileSnapshot, { exists: false }>,
): boolean {
  let fileStat;
  try {
    fileStat = lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
  return (
    fileStat.dev === snapshot.device &&
    fileStat.ino === snapshot.inode &&
    (snapshot.kind === 'symlink'
      ? fileStat.isSymbolicLink()
      : fileStat.isFile())
  );
}

function localFileMatchesPreparedSnapshot(
  filePath: string,
  snapshot: Exclude<LocalFileSnapshot, { exists: false }>,
): boolean {
  return (
    localFileHasSnapshotIdentity(filePath, snapshot) &&
    localFileMatchesSnapshot(filePath, snapshot)
  );
}

function localPathMatchesSnapshot(
  filePath: string,
  snapshot: LocalFileSnapshot,
): boolean {
  if (!snapshot.exists) return !localPathEntryExists(filePath);
  return localFileMatchesPreparedSnapshot(filePath, snapshot);
}

function restoreLocalFile(filePath: string, snapshot: LocalFileSnapshot): void {
  if (!snapshot.exists) return;
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (snapshot.kind === 'symlink') {
    try {
      symlinkSync(snapshot.target, filePath);
      if (!localFileMatchesSnapshot(filePath, snapshot)) {
        throw new Error(
          `Restored symlink does not match the original target and mode: ${filePath}`,
        );
      }
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException)?.code === 'EEXIST' &&
        localFileMatchesSnapshot(filePath, snapshot)
      ) {
        return;
      }
      throw error;
    }
    return;
  }
  try {
    writeFileSync(filePath, Buffer.from(snapshot.contentBase64, 'base64'), {
      mode: snapshot.mode,
      flag: 'wx',
    });
    chmodSync(filePath, snapshot.mode);
    if (!localFileMatchesSnapshot(filePath, snapshot)) {
      throw new Error(
        `Restored file does not match the original bytes and mode: ${filePath}`,
      );
    }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException)?.code === 'EEXIST' &&
      localFileMatchesSnapshot(filePath, snapshot)
    ) {
      return;
    }
    throw error;
  }
}

function restoreLocalFileExclusively(
  filePath: string,
  snapshot: Exclude<LocalFileSnapshot, { exists: false }>,
): Exclude<LocalFileSnapshot, { exists: false }> {
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (snapshot.kind === 'symlink') {
    symlinkSync(snapshot.target, filePath);
  } else {
    writeFileSync(
      filePath,
      Buffer.from(snapshot.contentBase64, 'base64'),
      {
        mode: snapshot.mode,
        flag: 'wx',
      },
    );
    chmodSync(filePath, snapshot.mode);
  }
  const restoredSnapshot = snapshotLocalFile(filePath);
  if (
    !restoredSnapshot.exists ||
    !localFileMatchesSnapshot(filePath, snapshot)
  ) {
    throw new Error(
      `Exclusively restored file does not match its prepared snapshot: ${filePath}`,
    );
  }
  return restoredSnapshot;
}

type RepoWipeIo = {
  durabilityRoot: string;
  writeRegistry: typeof writeDeploymentRegistryFile;
  stageFile: (sourcePath: string, stagedPath: string) => void;
  linkFile: (sourcePath: string, destinationPath: string) => void;
  removeFile: (filePath: string) => void;
  pathEntryExists: (filePath: string) => boolean;
  syncFile: (
    filePath: string,
    snapshot: Extract<LocalFileSnapshot, { exists: true; kind: 'file' }>,
  ) => void;
  syncDirectory: (directoryPath: string) => void;
};

const DEFAULT_REPO_WIPE_IO: RepoWipeIo = {
  durabilityRoot: path.parse(process.cwd()).root,
  writeRegistry: writeDeploymentRegistryFile,
  stageFile: renameSync,
  linkFile: linkSync,
  removeFile: (filePath) => unlinkSync(filePath),
  pathEntryExists: localPathEntryExists,
  syncFile: (filePath, snapshot) => {
    const fileFd = openSync(filePath, 'r');
    try {
      const fileStat = fstatSync(fileFd);
      if (
        !fileStat.isFile() ||
        fileStat.dev !== snapshot.device ||
        fileStat.ino !== snapshot.inode
      ) {
        throw new Error(
          `Refusing to sync a replaced wipe recovery file: ${filePath}`,
        );
      }
      fsyncSync(fileFd);
    } finally {
      closeSync(fileFd);
    }
  },
  syncDirectory: (directoryPath) => {
    const directoryFd = openSync(directoryPath, 'r');
    try {
      if (!fstatSync(directoryFd).isDirectory()) {
        throw new Error(
          `Refusing to sync a non-directory wipe recovery path: ${directoryPath}`,
        );
      }
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  },
};

function commonAncestorDirectory(filePaths: readonly string[]): string {
  const directories = filePaths.map((filePath) =>
    path.resolve(path.dirname(filePath)),
  );
  let ancestor = directories[0] ?? path.parse(process.cwd()).root;
  while (
    directories.some((directoryPath) => {
      const relativePath = path.relative(ancestor, directoryPath);
      return (
        relativePath === '..' ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      );
    })
  ) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return ancestor;
    ancestor = parent;
  }
  return ancestor;
}

function repoPlanDurabilityRoot(plan: RepoPlan): string {
  return commonAncestorDirectory([
    plan.registryPath,
    ...plan.canonicalDeleteTargets.flatMap((target) => [
      target.absolutePath,
      ...(target.quarantinePath ? [target.quarantinePath] : []),
    ]),
    ...(plan.recoveryRestoreTargets ?? []).flatMap((target) => [
      target.absolutePath,
      ...(target.quarantinePath ? [target.quarantinePath] : []),
    ]),
    ...(plan.recoveryManifest
      ? [plan.recoveryManifest.filePath]
      : []),
  ]);
}

function makeSnapshotDurable(
  filePath: string,
  snapshot: Exclude<LocalFileSnapshot, { exists: false }>,
  io: RepoWipeIo,
): void {
  if (snapshot.kind === 'file') {
    io.syncFile(filePath, snapshot);
  }
  io.syncDirectory(path.dirname(filePath));
  if (!localPathMatchesSnapshot(filePath, snapshot)) {
    throw new Error(
      `Wipe recovery entry changed while it was made durable: ${filePath}`,
    );
  }
}

function makePreparedEntryDurable(
  filePath: string,
  preparedSnapshot: Exclude<LocalFileSnapshot, { exists: false }>,
  io: RepoWipeIo,
): Exclude<LocalFileSnapshot, { exists: false }> {
  const liveSnapshot = snapshotLocalFile(filePath);
  if (
    !liveSnapshot.exists ||
    !localFileMatchesPreparedSnapshot(filePath, preparedSnapshot)
  ) {
    throw new Error(
      `Wipe recovery entry changed before it could be made durable: ${filePath}`,
    );
  }
  makeSnapshotDurable(filePath, liveSnapshot, io);
  if (!localFileMatchesPreparedSnapshot(filePath, preparedSnapshot)) {
    throw new Error(
      `Wipe recovery entry changed after it was made durable: ${filePath}`,
    );
  }
  return liveSnapshot;
}

function makeRestoredEntryDurable(
  filePath: string,
  expectedSnapshot: Exclude<LocalFileSnapshot, { exists: false }>,
  io: RepoWipeIo,
): Exclude<LocalFileSnapshot, { exists: false }> {
  const liveSnapshot = snapshotLocalFile(filePath);
  if (
    !liveSnapshot.exists ||
    !localFileMatchesSnapshot(filePath, expectedSnapshot)
  ) {
    throw new Error(
      `Restored wipe recovery entry changed before it could be made durable: ${filePath}`,
    );
  }
  makeSnapshotDurable(filePath, liveSnapshot, io);
  if (!localFileMatchesSnapshot(filePath, expectedSnapshot)) {
    throw new Error(
      `Restored wipe recovery entry changed after it was made durable: ${filePath}`,
    );
  }
  return liveSnapshot;
}

class DirectoryChainDurabilityCleanupError extends Error {
  constructor(cause: unknown, cleanupErrors: readonly unknown[]) {
    super(
      `Could not clean up a partially durable recovery directory chain:\n${cleanupErrors
        .map((error) => `- ${
          error instanceof Error ? error.message : String(error)
        }`)
        .join('\n')}`,
      { cause },
    );
    this.name = 'DirectoryChainDurabilityCleanupError';
  }
}

function ensureDirectoryChainDurable(
  directoryPath: string,
  io: RepoWipeIo,
): readonly string[] {
  const durabilityRoot = path.resolve(io.durabilityRoot);
  const resolvedDirectoryPath = path.resolve(directoryPath);
  const relativeDirectoryPath = path.relative(
    durabilityRoot,
    resolvedDirectoryPath,
  );
  if (
    relativeDirectoryPath === '..' ||
    relativeDirectoryPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeDirectoryPath)
  ) {
    throw new Error(
      `Wipe recovery directory is outside its durability root: ${resolvedDirectoryPath}`,
    );
  }
  const directoryChain: string[] = [];
  let directoryCursor = resolvedDirectoryPath;
  while (directoryCursor !== durabilityRoot) {
    directoryChain.push(directoryCursor);
    const parentDirectory = path.dirname(directoryCursor);
    if (parentDirectory === directoryCursor) {
      throw new Error(
        `Could not reach wipe durability root ${durabilityRoot} from ${resolvedDirectoryPath}`,
      );
    }
    directoryCursor = parentDirectory;
  }
  const createdDirectories: string[] = [];
  try {
    for (const chainDirectory of directoryChain.reverse()) {
      if (!localPathEntryExists(chainDirectory)) {
        try {
          mkdirSync(chainDirectory, { mode: 0o700 });
          createdDirectories.push(chainDirectory);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException)?.code !== 'EEXIST' ||
            !lstatSync(chainDirectory).isDirectory()
          ) {
            throw error;
          }
        }
      } else if (!lstatSync(chainDirectory).isDirectory()) {
        throw new Error(
          `Wipe recovery directory path is not a directory: ${chainDirectory}`,
        );
      }
      io.syncDirectory(path.dirname(chainDirectory));
    }
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const createdDirectory of createdDirectories.slice().reverse()) {
      try {
        rmdirSync(createdDirectory);
        io.syncDirectory(path.dirname(createdDirectory));
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length) {
      throw new DirectoryChainDurabilityCleanupError(
        error,
        cleanupErrors,
      );
    }
    throw error;
  }
  return Object.freeze(createdDirectories.slice().reverse());
}

function snapshotCanonicalDeleteTarget(
  target: CanonicalDeleteTarget,
): LocalFileSnapshot {
  let snapshot: LocalFileSnapshot;
  try {
    snapshot = snapshotLocalFile(target.absolutePath);
  } catch (error) {
    throw new Error(
      `Repository wipe plan conflict for ${target.relativePath}: target is unreadable or unsupported.`,
      { cause: error },
    );
  }
  if (!snapshot.exists) {
    return snapshot;
  }
  if (target.expectedSha256 == null) {
    throw new Error(
      `Repository wipe plan conflict for ${target.relativePath}: target appeared after the plan was prepared.`,
    );
  }

  let currentSha256: string;
  try {
    currentSha256 = sha256LocalSnapshot(
      target.absolutePath,
      snapshot,
    );
    if (
      snapshot.kind === 'symlink' &&
      currentSha256 !== target.expectedSha256
    ) {
      // Compatibility for callers that prepared a symlink fingerprint from
      // its referent before stable symlink-target fingerprints were added.
      currentSha256 = createHash('sha256')
        .update(readFileSync(target.absolutePath))
        .digest('hex');
    }
  } catch (error) {
    throw new Error(
      `Repository wipe plan conflict for ${target.relativePath}: target could not be re-read.`,
      { cause: error },
    );
  }
  if (currentSha256 !== target.expectedSha256) {
    throw new Error(
      `Repository wipe plan conflict for ${target.relativePath}: target changed after the plan was prepared.`,
    );
  }
  if (
    target.expectedKind != null &&
    (snapshot.kind !== target.expectedKind ||
      snapshot.device !== target.expectedDevice ||
      snapshot.inode !== target.expectedInode ||
      snapshot.mode !== target.expectedMode ||
      (snapshot.kind === 'symlink' &&
        snapshot.target !== target.expectedSymlinkTarget))
  ) {
    throw new Error(
      `Repository wipe plan conflict for ${target.relativePath}: target identity changed after the plan was prepared.`,
    );
  }
  try {
    if (!localFileMatchesSnapshot(target.absolutePath, snapshot)) {
      throw new Error('target changed while it was being verified');
    }
  } catch (error) {
    throw new Error(
      `Repository wipe plan conflict for ${target.relativePath}: target changed while it was being verified.`,
      { cause: error },
    );
  }
  return snapshot;
}

function assertPreparedTargetStillMatches(args: {
  relativePath: string;
  absolutePath: string;
  snapshot: LocalFileSnapshot;
}): void {
  let matches = false;
  try {
    matches = localPathMatchesSnapshot(args.absolutePath, args.snapshot);
  } catch (error) {
    throw new Error(
      `Repository wipe plan conflict for ${args.relativePath}: target could not be re-read during final preparation.`,
      { cause: error },
    );
  }
  if (!matches) {
    throw new Error(
      `Repository wipe plan conflict for ${args.relativePath}: target changed while the wipe was being prepared.`,
    );
  }
}

export function assertRepoWipeRegistryWritable(
  plan: Pick<RepoPlan, 'registryPath' | 'registryExpectedContent'>,
): void {
  writeDeploymentRegistryFile({
    filePath: plan.registryPath,
    expectedContent: plan.registryExpectedContent,
    nextContent: plan.registryExpectedContent,
  });
}

type RecoveryManifestHandle = Readonly<{
  filePath: string;
  content: string;
  snapshot: Exclude<LocalFileSnapshot, { exists: false }>;
  disposition: 'created' | 'updated' | 'adopted';
  previousContent?: string;
  createdDirectories: readonly string[];
}>;

export type PreparedRepoWipe = Readonly<{
  durabilityRoot: string;
  registryPath: string;
  registryWillChange: boolean;
  registryExpectedContent: string;
  registryNextContent: string;
  canonicalDeleteTargets: readonly Readonly<{
    relativePath: string;
    absolutePath: string;
    quarantinePath: string;
    snapshot: LocalFileSnapshot;
    quarantineSnapshot: LocalFileSnapshot;
  }>[];
  recoveryRestoreTargets: readonly Readonly<{
    relativePath: string;
    absolutePath: string;
    quarantinePath: string;
    canonicalSnapshot: LocalFileSnapshot;
    quarantineSnapshot: Exclude<LocalFileSnapshot, { exists: false }>;
  }>[];
  recoveryManifest?: RecoveryManifestHandle;
}>;

export class RepoWipePostCommitCleanupError extends Error {
  readonly residualPaths: readonly string[];
  readonly recoveryPaths: readonly string[];
  readonly uncertainPaths: readonly string[];

  constructor(
    residualPaths: Iterable<string>,
    options: {
      cause?: unknown;
      recoveryPaths?: Iterable<string>;
      uncertainPaths?: Iterable<string>;
    } = {},
  ) {
    const sortedResidualPaths = sortStrings(residualPaths);
    const sortedRecoveryPaths = sortStrings(options.recoveryPaths ?? []);
    const sortedUncertainPaths = sortStrings(options.uncertainPaths ?? []);
    const recoveryDetail = sortedRecoveryPaths.length
      ? `\nRecovery entries or paths requiring inspection remain:\n${sortedRecoveryPaths
          .map((recoveryPath) => `- ${recoveryPath}`)
          .join('\n')}`
      : '';
    const uncertainDetail = sortedUncertainPaths.length
      ? `\nDurability could not be verified for these surviving paths:\n${sortedUncertainPaths
          .map((uncertainPath) => `- ${uncertainPath}`)
          .join('\n')}`
      : '';
    super(
      `Repository wipe completed its registry phase, but preserved local path(s) that changed after preparation:\n${sortedResidualPaths
        .map((relativePath) => `- ${relativePath}`)
        .join('\n')}${recoveryDetail}${uncertainDetail}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'RepoWipePostCommitCleanupError';
    this.residualPaths = Object.freeze(sortedResidualPaths);
    this.recoveryPaths = Object.freeze(sortedRecoveryPaths);
    this.uncertainPaths = Object.freeze(sortedUncertainPaths);
  }
}

function snapshotPreparedQuarantineTarget(args: {
  target: CanonicalDeleteTarget;
  quarantinePath: string;
}): LocalFileSnapshot {
  let snapshot: LocalFileSnapshot;
  try {
    snapshot = snapshotLocalFile(args.quarantinePath);
  } catch (error) {
    throw new Error(
      `Repository wipe plan conflict for ${args.target.relativePath}: quarantine is unreadable or unsupported.`,
      { cause: error },
    );
  }
  if (!snapshot.exists) {
    if (args.target.quarantineExpectedSha256 == null) return snapshot;
    throw new Error(
      `Repository wipe plan conflict for ${args.target.relativePath}: prepared quarantine disappeared before Firestore.`,
    );
  }
  if (args.target.quarantineExpectedSha256 == null) {
    throw new Error(
      `Repository wipe plan conflict for ${args.target.relativePath}: an unjournaled quarantine appeared.`,
    );
  }
  const currentSha256 = sha256LocalSnapshot(
    args.quarantinePath,
    snapshot,
  );
  if (
    currentSha256 !== args.target.quarantineExpectedSha256 ||
    snapshot.mode !== args.target.quarantineExpectedMode ||
    snapshot.kind !== args.target.quarantineExpectedKind ||
    (snapshot.kind === 'symlink' &&
      snapshot.target !==
        args.target.quarantineExpectedSymlinkTarget)
  ) {
    throw new Error(
      `Repository wipe plan conflict for ${args.target.relativePath}: quarantine does not match stable recovery provenance.`,
    );
  }
  return snapshot;
}

function probeStagingParentWritable(parentPath: string): void {
  const probeDirectory = mkdtempSync(
    path.join(parentPath, '.wipe-drop-preflight-'),
  );
  rmdirSync(probeDirectory);
}

function assertPreparedStagingDirectorySafe(args: {
  relativePath: string;
  quarantinePath: string;
  quarantineSnapshot: LocalFileSnapshot;
}): void {
  const stagingDirectory = path.dirname(args.quarantinePath);
  let stagingDirectoryStat;
  try {
    stagingDirectoryStat = lstatSync(stagingDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw new Error(
      `Repository wipe plan conflict for ${args.relativePath}: deterministic quarantine directory is unreadable.`,
      { cause: error },
    );
  }
  if (!stagingDirectoryStat.isDirectory()) {
    throw new Error(
      `Repository wipe plan conflict for ${args.relativePath}: deterministic quarantine directory is not a directory.`,
    );
  }

  let entries: string[];
  try {
    entries = readdirSync(stagingDirectory);
  } catch (error) {
    throw new Error(
      `Repository wipe plan conflict for ${args.relativePath}: deterministic quarantine directory cannot be inspected.`,
      { cause: error },
    );
  }
  const expectedEntries = args.quarantineSnapshot.exists
    ? [path.basename(args.quarantinePath)]
    : [];
  if (
    entries.length !== expectedEntries.length ||
    entries.some((entry) => !expectedEntries.includes(entry))
  ) {
    throw new Error(
      `Repository wipe plan conflict for ${args.relativePath}: deterministic quarantine directory contains unexpected recovery entries.`,
    );
  }

  // Existing quarantines are retired through a fresh child directory. Verify
  // that operation can be prepared before the irreversible Firestore phase.
  if (args.quarantineSnapshot.exists) {
    probeStagingParentWritable(stagingDirectory);
  }
}

function assertPreparedRepoWipeStillMatches(args: {
  plan: Pick<RepoPlan, 'registryPath' | 'registryExpectedContent'>;
  canonicalDeleteTargets: PreparedRepoWipe['canonicalDeleteTargets'];
  recoveryRestoreTargets: PreparedRepoWipe['recoveryRestoreTargets'];
}): void {
  assertRepoWipeRegistryWritable(args.plan);
  args.canonicalDeleteTargets.forEach((target) => {
    assertPreparedTargetStillMatches(target);
    assertPreparedTargetStillMatches({
      relativePath: `${target.relativePath} quarantine`,
      absolutePath: target.quarantinePath,
      snapshot: target.quarantineSnapshot,
    });
    assertPreparedStagingDirectorySafe(target);
  });
  args.recoveryRestoreTargets.forEach((target) => {
    assertPreparedTargetStillMatches({
      relativePath: `${target.relativePath} shared canonical`,
      absolutePath: target.absolutePath,
      snapshot: target.canonicalSnapshot,
    });
    assertPreparedTargetStillMatches({
      relativePath: `${target.relativePath} shared quarantine`,
      absolutePath: target.quarantinePath,
      snapshot: target.quarantineSnapshot,
    });
    assertPreparedStagingDirectorySafe(target);
  });
}

export function prepareRepoWipe(
  plan: RepoPlan,
  ioOverrides: Partial<RepoWipeIo> = {},
): PreparedRepoWipe {
  const durabilityRoot = repoPlanDurabilityRoot(plan);
  const io = {
    ...DEFAULT_REPO_WIPE_IO,
    ...ioOverrides,
    durabilityRoot,
  };
  // The caller holds the deployment-registry mutation lock. Opening the
  // registry with an expected-content no-op verifies both its bytes and
  // writability before Firestore can be touched.
  assertRepoWipeRegistryWritable(plan);

  const canonicalDeleteTargets = plan.canonicalDeleteTargets.map((target) => {
    const expectedQuarantinePath = deterministicQuarantinePath({
      absolutePath: target.absolutePath,
      relativePath: target.relativePath,
    });
    const quarantinePath =
      target.quarantinePath ?? expectedQuarantinePath;
    if (
      quarantinePath !== expectedQuarantinePath
    ) {
      throw new Error(
        `Invalid wipe quarantine location for ${target.relativePath}: ${quarantinePath}`,
      );
    }
    return Object.freeze({
      relativePath: target.relativePath,
      absolutePath: target.absolutePath,
      quarantinePath,
      snapshot: Object.freeze(snapshotCanonicalDeleteTarget(target)),
      quarantineSnapshot: Object.freeze(
        snapshotPreparedQuarantineTarget({ target, quarantinePath }),
      ),
    });
  });
  const recoveryRestoreTargets = (plan.recoveryRestoreTargets ?? []).map(
    (target) => {
      const expectedQuarantinePath = deterministicQuarantinePath({
        absolutePath: target.absolutePath,
        relativePath: target.relativePath,
      });
      const quarantinePath =
        target.quarantinePath ?? expectedQuarantinePath;
      if (quarantinePath !== expectedQuarantinePath) {
        throw new Error(
          `Invalid shared wipe quarantine location for ${target.relativePath}: ${quarantinePath}`,
        );
      }
      const quarantineSnapshot = snapshotPreparedQuarantineTarget({
        target,
        quarantinePath,
      });
      if (!quarantineSnapshot.exists) {
        throw new Error(
          `Repository wipe plan conflict for ${target.relativePath}: shared recovery quarantine disappeared.`,
        );
      }
      const canonicalSnapshot = snapshotLocalFile(target.absolutePath);
      return Object.freeze({
        relativePath: target.relativePath,
        absolutePath: target.absolutePath,
        quarantinePath,
        canonicalSnapshot: Object.freeze(canonicalSnapshot),
        quarantineSnapshot: Object.freeze(quarantineSnapshot),
      });
    },
  );

  const stagingParents = new Set(
    [...canonicalDeleteTargets, ...recoveryRestoreTargets]
      .map((target) => path.dirname(target.absolutePath)),
  );
  stagingParents.forEach(probeStagingParentWritable);

  // Snapshotting can take long enough for an editor or another process to
  // replace an earlier path. Recheck the registry and every target after all
  // snapshots have been collected.
  assertPreparedRepoWipeStillMatches({
    plan,
    canonicalDeleteTargets,
    recoveryRestoreTargets,
  });

  let recoveryManifest: RecoveryManifestHandle | undefined;
  try {
    recoveryManifest = ensureRecoveryManifest(plan.recoveryManifest, io);
    assertPreparedRepoWipeStillMatches({
      plan,
      canonicalDeleteTargets,
      recoveryRestoreTargets,
    });
  } catch (preparationError) {
    if (recoveryManifest) {
      try {
        abortRecoveryManifestPreparation(recoveryManifest, io);
      } catch (cleanupError) {
        throw new Error(
          `Repository wipe preparation failed and its recovery journal could not be cleaned up: ${
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError)
          }`,
          { cause: preparationError },
        );
      }
    }
    throw preparationError;
  }

  return Object.freeze({
    durabilityRoot,
    registryPath: plan.registryPath,
    registryWillChange: plan.registryWillChange,
    registryExpectedContent: plan.registryExpectedContent,
    registryNextContent: plan.registryNextContent,
    canonicalDeleteTargets: Object.freeze(canonicalDeleteTargets),
    recoveryRestoreTargets: Object.freeze(recoveryRestoreTargets),
    ...(recoveryManifest
      ? { recoveryManifest: Object.freeze(recoveryManifest) }
      : {}),
  });
}

function liveRegistryMatchesNextContent(prepared: PreparedRepoWipe): boolean {
  try {
    return readFileSync(prepared.registryPath).equals(
      Buffer.from(prepared.registryNextContent, 'utf8'),
    );
  } catch {
    return false;
  }
}

function localFileContentEquals(
  filePath: string,
  expectedContent: string,
): boolean {
  try {
    return readFileSync(filePath, 'utf8') === expectedContent;
  } catch {
    return false;
  }
}

type StagedCanonicalTarget = {
  relativePath: string;
  absolutePath: string;
  stagedDirectory: string;
  stagedPath: string;
  snapshot: Exclude<LocalFileSnapshot, { exists: false }>;
  ownedByInvocation: boolean;
};

function ensureRecoveryManifest(
  manifest: RepoPlan['recoveryManifest'],
  io: RepoWipeIo,
): RecoveryManifestHandle | undefined {
  if (!manifest) return undefined;
  const manifestDirectory = path.dirname(manifest.filePath);
  const createdDirectories = ensureDirectoryChainDurable(
    manifestDirectory,
    io,
  );
  const existed = localPathEntryExists(manifest.filePath);
  if (!existed) {
    if (manifest.expectedContent != null) {
      fail(
        `Wipe recovery manifest disappeared after planning: ${manifest.filePath}`,
      );
    }
    writeFileSync(manifest.filePath, manifest.content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } else {
    const expectedContent =
      manifest.expectedContent ?? manifest.content;
    const currentContent = readFileSync(manifest.filePath, 'utf8');
    if (currentContent !== expectedContent) {
      fail(
        `Wipe recovery manifest changed after planning: ${manifest.filePath}`,
      );
    }
    if (currentContent !== manifest.content) {
      try {
        writeOptimisticTextFile({
          filePath: manifest.filePath,
          expectedContent: currentContent,
          nextContent: manifest.content,
          targetLabel: 'wipe recovery manifest',
        });
      } catch (error) {
        if (
          !isOptimisticTextFilePostCommitVerificationError(error) ||
          !localFileContentEquals(
            manifest.filePath,
            manifest.content,
          )
        ) {
          throw error;
        }
      }
    }
  }
  const snapshot = snapshotLocalFile(manifest.filePath);
  if (
    !snapshot.exists ||
    snapshot.kind !== 'file' ||
    readFileSync(manifest.filePath, 'utf8') !== manifest.content
  ) {
    fail(
      `Wipe recovery manifest changed or is invalid: ${manifest.filePath}`,
    );
  }
  const handle: RecoveryManifestHandle = {
    filePath: manifest.filePath,
    content: manifest.content,
    snapshot,
    disposition: !existed
      ? 'created'
      : manifest.expectedContent != null &&
          manifest.expectedContent !== manifest.content
        ? 'updated'
        : 'adopted',
    ...(existed &&
    manifest.expectedContent != null &&
    manifest.expectedContent !== manifest.content
      ? { previousContent: manifest.expectedContent }
      : {}),
    createdDirectories: Object.freeze(createdDirectories),
  };
  try {
    makePreparedEntryDurable(manifest.filePath, snapshot, io);
  } catch (preparationError) {
    if (handle.disposition !== 'adopted') {
      try {
        abortRecoveryManifestPreparation(handle, io);
      } catch (cleanupError) {
        throw new Error(
          `Wipe recovery journal could not be made durable or restored: ${
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError)
          }`,
          { cause: preparationError },
        );
      }
    }
    throw preparationError;
  }
  return handle;
}

function addUniquePath(paths: string[], filePath: string): void {
  if (!paths.includes(filePath)) paths.push(filePath);
}

function addDurableRecoveryPath(
  recoveryPaths: string[],
  uncertainPaths: string[],
  filePath: string,
): void {
  const uncertainIndex = uncertainPaths.indexOf(filePath);
  if (uncertainIndex >= 0) uncertainPaths.splice(uncertainIndex, 1);
  addUniquePath(recoveryPaths, filePath);
}

function addUncertainPath(
  recoveryPaths: string[],
  uncertainPaths: string[],
  filePath: string,
): void {
  if (!recoveryPaths.includes(filePath)) {
    addUniquePath(uncertainPaths, filePath);
  }
}

function removeRecoveryManifest(
  handle: RecoveryManifestHandle | undefined,
  recoveryPaths: string[],
  uncertainPaths: string[],
  io: RepoWipeIo,
): boolean {
  if (!handle) return false;
  let retirementDirectory: string | undefined;
  let retirementPath: string | undefined;
  let retirementDurable = false;
  let manifestBytesRemoved = false;
  try {
    let liveManifestMatches = false;
    try {
      liveManifestMatches = localFileMatchesPreparedSnapshot(
        handle.filePath,
        handle.snapshot,
      );
    } catch {
      // Persist the prepared bytes below without touching an unreadable path.
    }
    if (!liveManifestMatches) {
      const recovery = persistSnapshotForRecovery({
        preferredPath: handle.filePath,
        snapshot: handle.snapshot,
        io,
      });
      addUncertainPath(
        recoveryPaths,
        uncertainPaths,
        handle.filePath,
      );
      addSnapshotRecoveryPaths(
        recoveryPaths,
        uncertainPaths,
        recovery,
      );
      return false;
    }
    retirementDirectory = mkdtempSync(
      path.join(
        path.dirname(handle.filePath),
        `.${path.basename(handle.filePath)}.wipe-drop-retire-`,
      ),
    );
    io.syncDirectory(path.dirname(retirementDirectory));
    retirementPath = path.join(
      retirementDirectory,
      path.basename(handle.filePath),
    );
    renameSync(handle.filePath, retirementPath);
    const retiredSnapshot = snapshotLocalFile(retirementPath);
    if (
      !retiredSnapshot.exists ||
      !localFileMatchesPreparedSnapshot(
        retirementPath,
        handle.snapshot,
      )
    ) {
      if (retiredSnapshot.exists) {
        try {
          ensureDirectoryChainDurable(
            path.dirname(handle.filePath),
            io,
          );
          restoreLocalFile(handle.filePath, retiredSnapshot);
          makeRestoredEntryDurable(
            handle.filePath,
            retiredSnapshot,
            io,
          );
        } catch {
          // A concurrent live replacement is preserved below.
        }
      }
      const preparedRecoveryPath = `${retirementPath}.prepared`;
      try {
        ensureDirectoryChainDurable(
          path.dirname(preparedRecoveryPath),
          io,
        );
        restoreLocalFile(preparedRecoveryPath, handle.snapshot);
        makeRestoredEntryDurable(
          preparedRecoveryPath,
          handle.snapshot,
          io,
        );
        addDurableRecoveryPath(
          recoveryPaths,
          uncertainPaths,
          preparedRecoveryPath,
        );
      } catch {
        try {
          ensureDirectoryChainDurable(
            path.dirname(handle.filePath),
            io,
          );
          restoreLocalFile(handle.filePath, handle.snapshot);
          makeRestoredEntryDurable(
            handle.filePath,
            handle.snapshot,
            io,
          );
          addDurableRecoveryPath(
            recoveryPaths,
            uncertainPaths,
            handle.filePath,
          );
        } catch {
          addUncertainPath(
            recoveryPaths,
            uncertainPaths,
            preparedRecoveryPath,
          );
        }
      }
      addUncertainPath(
        recoveryPaths,
        uncertainPaths,
        handle.filePath,
      );
      if (retiredSnapshot.exists) {
        addUncertainPath(
          recoveryPaths,
          uncertainPaths,
          retirementPath,
        );
      }
      return false;
    }
    makePreparedEntryDurable(retirementPath, handle.snapshot, io);
    io.syncDirectory(path.dirname(handle.filePath));
    if (
      !localFileMatchesPreparedSnapshot(
        retirementPath,
        handle.snapshot,
      )
    ) {
      addUncertainPath(
        recoveryPaths,
        uncertainPaths,
        retirementPath,
      );
      return false;
    }
    retirementDurable = true;
    let liveManifestExists: boolean;
    try {
      liveManifestExists = localPathEntryExists(handle.filePath);
    } catch {
      addUncertainPath(
        recoveryPaths,
        uncertainPaths,
        handle.filePath,
      );
      addDurableRecoveryPath(
        recoveryPaths,
        uncertainPaths,
        retirementPath,
      );
      return false;
    }
    if (liveManifestExists) {
      addUncertainPath(
        recoveryPaths,
        uncertainPaths,
        handle.filePath,
      );
      addDurableRecoveryPath(
        recoveryPaths,
        uncertainPaths,
        retirementPath,
      );
      return false;
    }
    unlinkSync(retirementPath);
    manifestBytesRemoved = true;
    io.syncDirectory(retirementDirectory);
    try {
      rmdirSync(retirementDirectory);
      io.syncDirectory(path.dirname(retirementDirectory));
    } catch {
      addUncertainPath(
        recoveryPaths,
        uncertainPaths,
        retirementDirectory,
      );
    }
    for (const createdDirectory of handle.createdDirectories) {
      try {
        rmdirSync(createdDirectory);
        io.syncDirectory(path.dirname(createdDirectory));
      } catch (error) {
        if (
          !['ENOENT', 'ENOTEMPTY'].includes(
            String((error as NodeJS.ErrnoException)?.code),
          )
        ) {
          addUncertainPath(
            recoveryPaths,
            uncertainPaths,
            createdDirectory,
          );
        }
      }
    }
    return true;
  } catch {
    if (retirementDirectory && !manifestBytesRemoved) {
      let retirementEntryExists = false;
      try {
        retirementEntryExists =
          retirementPath != null &&
          localPathEntryExists(retirementPath);
      } catch {
        retirementEntryExists = true;
      }
      if (!retirementEntryExists) {
        try {
          rmdirSync(retirementDirectory);
          io.syncDirectory(path.dirname(retirementDirectory));
          retirementDirectory = undefined;
          retirementPath = undefined;
        } catch {
          addUncertainPath(
            recoveryPaths,
            uncertainPaths,
            retirementDirectory,
          );
        }
      }
    }
    const recoveryPath = retirementPath ?? handle.filePath;
    if (retirementPath && retirementDurable) {
      addDurableRecoveryPath(
        recoveryPaths,
        uncertainPaths,
        recoveryPath,
      );
    } else if (recoveryPath === handle.filePath && !manifestBytesRemoved) {
      addDurableRecoveryPath(
        recoveryPaths,
        uncertainPaths,
        recoveryPath,
      );
    } else {
      addUncertainPath(
        recoveryPaths,
        uncertainPaths,
        recoveryPath,
      );
    }
    return manifestBytesRemoved;
  }
}

function restoreRemovedRecoveryManifest(
  handle: RecoveryManifestHandle | undefined,
  recoveryPaths: string[],
  uncertainPaths: string[],
  io: RepoWipeIo,
): void {
  if (!handle) return;
  try {
    ensureDirectoryChainDurable(
      path.dirname(handle.filePath),
      io,
    );
    restoreLocalFile(handle.filePath, handle.snapshot);
    makeRestoredEntryDurable(handle.filePath, handle.snapshot, io);
  } catch {
    addUncertainPath(
      recoveryPaths,
      uncertainPaths,
      handle.filePath,
    );
  }
}

function abortRecoveryManifestPreparation(
  handle: RecoveryManifestHandle,
  io: RepoWipeIo,
): void {
  if (handle.disposition === 'adopted') return;
  if (handle.disposition === 'created') {
    const recoveryPaths: string[] = [];
    const uncertainPaths: string[] = [];
    const removed = removeRecoveryManifest(
      handle,
      recoveryPaths,
      uncertainPaths,
      io,
    );
    if (
      removed &&
      (recoveryPaths.length || uncertainPaths.length)
    ) {
      restoreRemovedRecoveryManifest(
        handle,
        recoveryPaths,
        uncertainPaths,
        io,
      );
    }
    if (
      !removed ||
      recoveryPaths.length ||
      uncertainPaths.length
    ) {
      throw new Error(
        `Could not remove prepared wipe recovery journal:\n${[
          ...recoveryPaths,
          ...uncertainPaths,
        ]
          .map((filePath) => `- ${filePath}`)
          .join('\n')}`,
      );
    }
    return;
  }
  if (handle.previousContent == null) {
    throw new Error(
      `Prepared wipe recovery journal is missing its previous content: ${handle.filePath}`,
    );
  }
  if (!localFileMatchesPreparedSnapshot(handle.filePath, handle.snapshot)) {
    throw new Error(
      `Prepared wipe recovery journal changed before it could be restored: ${handle.filePath}`,
    );
  }
  try {
    writeOptimisticTextFile({
      filePath: handle.filePath,
      expectedContent: handle.content,
      nextContent: handle.previousContent,
      targetLabel: 'wipe recovery manifest',
    });
  } catch (error) {
    if (
      !isOptimisticTextFilePostCommitVerificationError(error) ||
      !localFileContentEquals(
        handle.filePath,
        handle.previousContent,
      )
    ) {
      throw error;
    }
  }
  const restoredSnapshot = snapshotLocalFile(handle.filePath);
  if (
    !restoredSnapshot.exists ||
    restoredSnapshot.kind !== 'file' ||
    readFileSync(handle.filePath, 'utf8') !== handle.previousContent
  ) {
    throw new Error(
      `Prepared wipe recovery journal did not restore its previous bytes: ${handle.filePath}`,
    );
  }
  makeSnapshotDurable(handle.filePath, restoredSnapshot, io);
}

export function abortPreparedRepoWipe(
  prepared: PreparedRepoWipe,
  ioOverrides: Partial<RepoWipeIo> = {},
): void {
  const io = {
    ...DEFAULT_REPO_WIPE_IO,
    ...ioOverrides,
    durabilityRoot: prepared.durabilityRoot,
  };
  if (prepared.recoveryManifest) {
    abortRecoveryManifestPreparation(prepared.recoveryManifest, io);
  }
}

function createStagingLocation(
  quarantinePath: string,
  io: RepoWipeIo,
): {
  stagedDirectory: string;
  stagedPath: string;
} {
  const stagedDirectory = path.dirname(quarantinePath);
  if (localPathEntryExists(stagedDirectory)) {
    rmdirSync(stagedDirectory);
  }
  mkdirSync(stagedDirectory, { mode: 0o700 });
  try {
    io.syncDirectory(path.dirname(stagedDirectory));
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      rmdirSync(stagedDirectory);
      io.syncDirectory(path.dirname(stagedDirectory));
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length) {
      throw new DirectoryChainDurabilityCleanupError(
        error,
        cleanupErrors,
      );
    }
    throw error;
  }
  return {
    stagedDirectory,
    stagedPath: quarantinePath,
  };
}

function removeEmptyStagingDirectory(
  stagedDirectory: string,
  io: RepoWipeIo,
): void {
  try {
    rmdirSync(stagedDirectory);
    io.syncDirectory(path.dirname(stagedDirectory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
}

function restoreUnexpectedStagedEntry(args: {
  absolutePath: string;
  stagedPath: string;
  io: RepoWipeIo;
}): void {
  const unexpectedSnapshot = snapshotLocalFile(args.stagedPath);
  if (!unexpectedSnapshot.exists) return;
  if (!localPathEntryExists(args.absolutePath)) {
    // Exclusive creation preserves a concurrent recreation and leaves the
    // exact moved inode in quarantine until the operator resolves the error.
    ensureDirectoryChainDurable(
      path.dirname(args.absolutePath),
      args.io,
    );
    restoreLocalFile(args.absolutePath, unexpectedSnapshot);
    makeRestoredEntryDurable(
      args.absolutePath,
      unexpectedSnapshot,
      args.io,
    );
  }
}

type SnapshotRecoveryResult = Readonly<{
  durableRecoveryPaths: readonly string[];
  uncertainPaths: readonly string[];
}>;

function addSnapshotRecoveryPaths(
  recoveryPaths: string[],
  uncertainPaths: string[],
  recovery: SnapshotRecoveryResult,
): void {
  recovery.durableRecoveryPaths.forEach((recoveryPath) => {
    addDurableRecoveryPath(
      recoveryPaths,
      uncertainPaths,
      recoveryPath,
    );
  });
  recovery.uncertainPaths.forEach((uncertainPath) => {
    addUncertainPath(
      recoveryPaths,
      uncertainPaths,
      uncertainPath,
    );
  });
}

function describeSnapshotRecovery(
  recovery: SnapshotRecoveryResult,
): string {
  if (recovery.durableRecoveryPaths.length) {
    const durableDescription =
      recovery.durableRecoveryPaths.join(', ');
    return recovery.uncertainPaths.length
      ? `${durableDescription}; durability is uncertain for ${recovery.uncertainPaths.join(', ')}`
      : durableDescription;
  }
  if (recovery.uncertainPaths.length) {
    return `${recovery.uncertainPaths.join(', ')} (durability could not be verified)`;
  }
  return 'no recovery copy could be preserved';
}

function persistSnapshotForRecovery(args: {
  preferredPath: string;
  snapshot: Exclude<LocalFileSnapshot, { exists: false }>;
  io: RepoWipeIo;
}): SnapshotRecoveryResult {
  const candidatePaths = [
    args.preferredPath,
    `${args.preferredPath}.prepared`,
  ];
  let durableRecoveryPath: string | undefined;
  for (const recoveryPath of candidatePaths) {
    try {
      ensureDirectoryChainDurable(
        path.dirname(recoveryPath),
        args.io,
      );
      restoreLocalFile(recoveryPath, args.snapshot);
      makeRestoredEntryDurable(
        recoveryPath,
        args.snapshot,
        args.io,
      );
      if (localFileMatchesSnapshot(recoveryPath, args.snapshot)) {
        durableRecoveryPath = recoveryPath;
        break;
      }
    } catch (error) {
      if (error instanceof DirectoryChainDurabilityCleanupError) {
        break;
      }
      // Preserve any concurrent entry and try the exclusive recovery sibling.
    }
  }
  const survivingPaths = candidatePaths.filter((candidatePath) => {
    try {
      return localPathEntryExists(candidatePath);
    } catch {
      return true;
    }
  });
  return Object.freeze({
    durableRecoveryPaths: Object.freeze(
      durableRecoveryPath ? [durableRecoveryPath] : [],
    ),
    uncertainPaths: Object.freeze(
      survivingPaths.filter(
        (survivingPath) =>
          survivingPath !== durableRecoveryPath,
      ),
    ),
  });
}

function retirePreparedQuarantine(args: {
  target: StagedCanonicalTarget;
  io: RepoWipeIo;
  recoveryPaths: string[];
  uncertainPaths: string[];
}): void {
  let retirementDirectory: string | undefined;
  let retirementPath: string | undefined;
  const persistPreparedSnapshot = () => {
    const recovery = persistSnapshotForRecovery({
      preferredPath: args.target.stagedPath,
      snapshot: args.target.snapshot,
      io: args.io,
    });
    addSnapshotRecoveryPaths(
      args.recoveryPaths,
      args.uncertainPaths,
      recovery,
    );
    return recovery;
  };

  try {
    retirementDirectory = mkdtempSync(
      path.join(
        args.target.stagedDirectory,
        `.${path.basename(args.target.stagedPath)}.retire-`,
      ),
    );
    args.io.syncDirectory(args.target.stagedDirectory);
    retirementPath = path.join(
      retirementDirectory,
      path.basename(args.target.stagedPath),
    );
    renameSync(args.target.stagedPath, retirementPath);
  } catch (error) {
    const recovery = persistPreparedSnapshot();
    if (retirementDirectory) {
      try {
        rmdirSync(retirementDirectory);
        args.io.syncDirectory(
          path.dirname(retirementDirectory),
        );
      } catch {
        addUniquePath(args.recoveryPaths, retirementDirectory);
      }
    }
    throw new Error(
      `Could not atomically retire wipe quarantine ${args.target.relativePath}; recovery status: ${describeSnapshotRecovery(recovery)}.`,
      { cause: error },
    );
  }

  let retiredSnapshot: LocalFileSnapshot;
  let retiredMatches = false;
  try {
    retiredSnapshot = snapshotLocalFile(retirementPath);
    retiredMatches =
      retiredSnapshot.exists &&
      localFileMatchesPreparedSnapshot(
        retirementPath,
        args.target.snapshot,
      );
  } catch (error) {
    addUniquePath(args.recoveryPaths, retirementPath);
    persistPreparedSnapshot();
    throw new Error(
      `Could not verify atomically retired wipe quarantine ${args.target.relativePath}.`,
      { cause: error },
    );
  }
  if (!retiredMatches) {
    if (retiredSnapshot.exists) {
      const racedRecovery = persistSnapshotForRecovery({
        preferredPath: args.target.stagedPath,
        snapshot: retiredSnapshot,
        io: args.io,
      });
      addSnapshotRecoveryPaths(
        args.recoveryPaths,
        args.uncertainPaths,
        racedRecovery,
      );
      addUniquePath(args.recoveryPaths, retirementPath);
    }
    const preparedRecovery = persistPreparedSnapshot();
    throw new Error(
      `Wipe quarantine changed while it was atomically retired for ${args.target.relativePath}; raced bytes remain at ${retirementPath}; prepared recovery status: ${describeSnapshotRecovery(preparedRecovery)}.`,
    );
  }
  makePreparedEntryDurable(
    retirementPath,
    args.target.snapshot,
    args.io,
  );
  args.io.syncDirectory(args.target.stagedDirectory);
  if (
    !localFileMatchesPreparedSnapshot(
      retirementPath,
      args.target.snapshot,
    )
  ) {
    addUniquePath(args.recoveryPaths, retirementPath);
    const preparedRecovery = persistPreparedSnapshot();
    throw new Error(
      `Wipe quarantine changed after its retirement rename became durable for ${args.target.relativePath}; prepared recovery status: ${describeSnapshotRecovery(preparedRecovery)}.`,
    );
  }

  try {
    args.io.removeFile(retirementPath);
    args.io.syncDirectory(retirementDirectory);
  } catch (error) {
    const recovery = persistPreparedSnapshot();
    // A fault-injecting adapter may fail before unlinking. Once an exclusive
    // copy is safely back at the deterministic quarantine, retire the now
    // redundant private copy directly when it is still the prepared inode.
    // The private directory prevents a pathname-swap race with normal
    // concurrent editors.
    try {
      if (
        recovery.durableRecoveryPaths.includes(
          args.target.stagedPath,
        ) &&
        localFileMatchesSnapshot(
          args.target.stagedPath,
          args.target.snapshot,
        )
      ) {
        if (
          localPathEntryExists(retirementPath) &&
          localFileMatchesPreparedSnapshot(
            retirementPath,
            args.target.snapshot,
          )
        ) {
          unlinkSync(retirementPath);
          args.io.syncDirectory(retirementDirectory);
        }
        if (!localPathEntryExists(retirementPath)) {
          rmdirSync(retirementDirectory);
          args.io.syncDirectory(args.target.stagedDirectory);
          retirementDirectory = undefined;
          retirementPath = undefined;
        }
      }
    } catch {
      // Both copies remain discoverable below.
    }
    if (retirementPath) {
      addUniquePath(args.recoveryPaths, retirementPath);
    }
    throw new Error(
      `Could not remove atomically retired wipe quarantine ${args.target.relativePath}; recovery status: ${describeSnapshotRecovery(recovery)}.`,
      { cause: error },
    );
  }

  let retiredStillExists = false;
  try {
    retiredStillExists = localPathEntryExists(retirementPath);
  } catch (error) {
    addUniquePath(args.recoveryPaths, retirementPath);
    persistPreparedSnapshot();
    throw new Error(
      `Could not verify removal of atomically retired wipe quarantine ${args.target.relativePath}.`,
      { cause: error },
    );
  }
  if (retiredStillExists) {
    addUniquePath(args.recoveryPaths, retirementPath);
    const recovery = persistPreparedSnapshot();
    throw new Error(
      `Atomically retired wipe quarantine still exists for ${args.target.relativePath}; recovery status: ${describeSnapshotRecovery(recovery)}.`,
    );
  }

  try {
    rmdirSync(retirementDirectory);
    args.io.syncDirectory(args.target.stagedDirectory);
  } catch (error) {
    addUniquePath(args.recoveryPaths, retirementDirectory);
    const recovery = persistPreparedSnapshot();
    throw new Error(
      `Could not remove private wipe retirement directory for ${args.target.relativePath}; recovery status: ${describeSnapshotRecovery(recovery)}.`,
      { cause: error },
    );
  }

  let replacementExists = false;
  try {
    replacementExists = localPathEntryExists(args.target.stagedPath);
  } catch (error) {
    addUniquePath(args.recoveryPaths, args.target.stagedPath);
    const recovery = persistPreparedSnapshot();
    throw new Error(
      `Could not inspect wipe quarantine after atomic retirement for ${args.target.relativePath}; recovery status: ${describeSnapshotRecovery(recovery)}.`,
      { cause: error },
    );
  }
  if (replacementExists) {
    addUniquePath(args.recoveryPaths, args.target.stagedPath);
    const recovery = persistPreparedSnapshot();
    throw new Error(
      `A concurrent wipe quarantine replacement was preserved for ${args.target.relativePath}; recovery status: ${describeSnapshotRecovery(recovery)}.`,
    );
  }
  try {
    removeEmptyStagingDirectory(args.target.stagedDirectory, args.io);
  } catch (error) {
    addUniquePath(
      args.recoveryPaths,
      args.target.stagedDirectory,
    );
    const recovery = persistPreparedSnapshot();
    throw new Error(
      `Could not remove wipe staging directory for ${args.target.relativePath}; recovery status: ${describeSnapshotRecovery(recovery)}.`,
      { cause: error },
    );
  }
}

type OwnedStagedRestoreDisposition =
  | 'linked-original'
  | 'exact-recreation'
  | 'snapshot-required';

function linkOwnedStagedFileForRollback(args: {
  target: StagedCanonicalTarget;
  io: RepoWipeIo;
}): OwnedStagedRestoreDisposition {
  if (
    args.target.snapshot.kind !== 'file' ||
    !localFileMatchesPreparedSnapshot(
      args.target.stagedPath,
      args.target.snapshot,
    )
  ) {
    return 'snapshot-required';
  }

  try {
    args.io.linkFile(
      args.target.stagedPath,
      args.target.absolutePath,
    );
  } catch (error) {
    if (
      localFileHasSnapshotIdentity(
        args.target.absolutePath,
        args.target.snapshot,
      )
    ) {
      // The link syscall completed before an injected adapter reported an
      // error. Its exact inode proves this invocation restored the source.
      return 'linked-original';
    }
    if (
      (error as NodeJS.ErrnoException)?.code === 'EEXIST' &&
      localFileMatchesSnapshot(
        args.target.absolutePath,
        args.target.snapshot,
      )
    ) {
      return 'exact-recreation';
    }
    throw error;
  }

  if (
    !localFileHasSnapshotIdentity(
      args.target.absolutePath,
      args.target.snapshot,
    )
  ) {
    throw new Error(
      `Rollback hard link did not restore the prepared inode: ${args.target.absolutePath}`,
    );
  }
  return 'linked-original';
}

function rollbackStagedTargets(args: {
  stagedTargets: StagedCanonicalTarget[];
  mutationError: unknown;
  io: RepoWipeIo;
  recoveryPaths: string[];
  uncertainPaths: string[];
}): never {
  const rollbackErrors: string[] = [];
  for (const target of args.stagedTargets.slice().reverse()) {
    if (!target.ownedByInvocation) continue;
    try {
      let restoreDisposition: OwnedStagedRestoreDisposition =
        'snapshot-required';
      if (!localPathEntryExists(target.absolutePath)) {
        ensureDirectoryChainDurable(
          path.dirname(target.absolutePath),
          args.io,
        );
        restoreDisposition = linkOwnedStagedFileForRollback({
          target,
          io: args.io,
        });
        if (restoreDisposition === 'snapshot-required') {
          restoreLocalFile(target.absolutePath, target.snapshot);
        }
      } else if (!localFileMatchesSnapshot(target.absolutePath, target.snapshot)) {
        throw new Error(
          `canonical path was concurrently recreated; original remains at ${target.stagedPath}`,
        );
      }
      if (restoreDisposition === 'linked-original') {
        makePreparedEntryDurable(
          target.absolutePath,
          target.snapshot,
          args.io,
        );
      } else {
        makeRestoredEntryDurable(
          target.absolutePath,
          target.snapshot,
          args.io,
        );
      }

      if (localPathEntryExists(target.stagedPath)) {
        retirePreparedQuarantine({
          target,
          io: args.io,
          recoveryPaths: args.recoveryPaths,
          uncertainPaths: args.uncertainPaths,
        });
      } else {
        removeEmptyStagingDirectory(
          target.stagedDirectory,
          args.io,
        );
      }
    } catch (rollbackError) {
      const recovery = persistSnapshotForRecovery({
        preferredPath: target.stagedPath,
        snapshot: target.snapshot,
        io: args.io,
      });
      addSnapshotRecoveryPaths(
        args.recoveryPaths,
        args.uncertainPaths,
        recovery,
      );
      rollbackErrors.push(
        `${target.relativePath}: ${
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError)
        } (recovery status: ${describeSnapshotRecovery(recovery)})`,
      );
    }
  }
  rollbackErrors.push(
    ...args.recoveryPaths.map(
      (recoveryPath) =>
        `preserved recovery entry remains at ${recoveryPath}`,
    ),
  );
  rollbackErrors.push(
    ...args.uncertainPaths.map(
      (uncertainPath) =>
        `recovery path durability is uncertain: ${uncertainPath}`,
    ),
  );
  if (rollbackErrors.length) {
    throw new Error(
      `Repository wipe failed and rollback was incomplete.\n${rollbackErrors
        .map((entry) => `- ${entry}`)
        .join('\n')}`,
      { cause: args.mutationError },
    );
  }
  throw args.mutationError;
}

function recheckCanonicalPaths(
  prepared: PreparedRepoWipe,
  residualPaths: string[],
  cleanupErrors: unknown[],
  io: RepoWipeIo,
): void {
  for (const target of prepared.canonicalDeleteTargets) {
    try {
      if (io.pathEntryExists(target.absolutePath)) {
        addUniquePath(residualPaths, target.relativePath);
      }
    } catch (error) {
      addUniquePath(residualPaths, target.relativePath);
      cleanupErrors.push(
        new Error(
          `Could not recheck canonical wipe path ${target.relativePath}.`,
          { cause: error },
        ),
      );
    }
  }
}

function purgeCommittedStagedTargets(args: {
  stagedTargets: StagedCanonicalTarget[];
  io: RepoWipeIo;
  recoveryPaths: string[];
  uncertainPaths: string[];
}): void {
  for (const target of args.stagedTargets) {
    try {
      retirePreparedQuarantine({
        target,
        io: args.io,
        recoveryPaths: args.recoveryPaths,
        uncertainPaths: args.uncertainPaths,
      });
    } catch {
      addUniquePath(args.recoveryPaths, target.stagedDirectory);
    }
  }
}

function reconcileStagedTargetsBeforeRegistry(
  stagedTargets: StagedCanonicalTarget[],
  recoveryPaths: string[],
  uncertainPaths: string[],
  io: RepoWipeIo,
): void {
  for (let targetIndex = 0; targetIndex < stagedTargets.length; targetIndex += 1) {
    const target = stagedTargets[targetIndex];
    let stagedExists: boolean;
    try {
      stagedExists = localPathEntryExists(target.stagedPath);
    } catch (error) {
      addUniquePath(recoveryPaths, target.stagedPath);
      throw new Error(
        `Could not recheck wipe quarantine before the registry write: ${target.relativePath}`,
        { cause: error },
      );
    }
    if (!stagedExists) {
      if (target.ownedByInvocation) {
        try {
          ensureDirectoryChainDurable(
            path.dirname(target.absolutePath),
            io,
          );
          restoreLocalFile(target.absolutePath, target.snapshot);
          makeRestoredEntryDurable(
            target.absolutePath,
            target.snapshot,
            io,
          );
          removeEmptyStagingDirectory(
            target.stagedDirectory,
            io,
          );
          stagedTargets.splice(targetIndex, 1);
        } catch (error) {
          const recovery = persistSnapshotForRecovery({
            preferredPath: target.stagedPath,
            snapshot: target.snapshot,
            io,
          });
          addSnapshotRecoveryPaths(
            recoveryPaths,
            uncertainPaths,
            recovery,
          );
          throw new Error(
            `Owned wipe quarantine disappeared and its canonical path could not be restored before the registry write: ${target.relativePath}. ` +
              `Original snapshot recovery: ${describeSnapshotRecovery(recovery)}`,
            { cause: error },
          );
        }
        throw new Error(
          `Owned wipe quarantine disappeared before the registry write; its canonical path was safely restored: ${target.relativePath}`,
        );
      }
      try {
        ensureDirectoryChainDurable(
          path.dirname(target.stagedPath),
          io,
        );
        restoreLocalFile(target.stagedPath, target.snapshot);
        makeRestoredEntryDurable(
          target.stagedPath,
          target.snapshot,
          io,
        );
      } catch (error) {
        addUniquePath(recoveryPaths, target.stagedPath);
        throw new Error(
          `Wipe quarantine disappeared and could not be reconstructed before the registry write: ${target.relativePath}`,
          { cause: error },
        );
      }
      throw new Error(
        `Wipe quarantine disappeared before the registry write and was safely reconstructed: ${target.relativePath}`,
      );
    }
    try {
      if (
        !localFileMatchesPreparedSnapshot(
          target.stagedPath,
          target.snapshot,
        )
      ) {
        addUniquePath(recoveryPaths, target.stagedPath);
        throw new Error(
          `Wipe quarantine changed before the registry write: ${target.relativePath}`,
        );
      }
    } catch (error) {
      addUniquePath(recoveryPaths, target.stagedPath);
      throw error;
    }
  }
}

function makeStagedTargetDurable(
  target: StagedCanonicalTarget,
  io: RepoWipeIo,
): void {
  makePreparedEntryDurable(target.stagedPath, target.snapshot, io);
  for (const directoryPath of new Set([
    path.dirname(target.absolutePath),
    path.dirname(target.stagedDirectory),
  ])) {
    io.syncDirectory(directoryPath);
  }
  if (
    !localFileMatchesPreparedSnapshot(
      target.stagedPath,
      target.snapshot,
    )
  ) {
    throw new Error(
      `Wipe quarantine changed after its source directory was made durable: ${target.relativePath}`,
    );
  }
}

function recheckQuarantinePaths(
  prepared: PreparedRepoWipe,
  recoveryPaths: string[],
  uncertainPaths: string[],
  cleanupErrors: unknown[],
  io: RepoWipeIo,
): void {
  const quarantinePaths = new Set([
    ...prepared.canonicalDeleteTargets.map(
      (target) => target.quarantinePath,
    ),
    ...prepared.recoveryRestoreTargets.map(
      (target) => target.quarantinePath,
    ),
  ]);
  for (const quarantinePath of quarantinePaths) {
    try {
      if (io.pathEntryExists(quarantinePath)) {
        const snapshot = snapshotLocalFile(quarantinePath);
        if (!snapshot.exists) {
          addUniquePath(uncertainPaths, quarantinePath);
          continue;
        }
        makeSnapshotDurable(quarantinePath, snapshot, io);
        const uncertainIndex =
          uncertainPaths.indexOf(quarantinePath);
        if (uncertainIndex >= 0) {
          uncertainPaths.splice(uncertainIndex, 1);
        }
        addUniquePath(recoveryPaths, quarantinePath);
      }
    } catch (error) {
      addUniquePath(uncertainPaths, quarantinePath);
      cleanupErrors.push(
        new Error(
          `Could not recheck wipe quarantine ${quarantinePath}.`,
          { cause: error },
        ),
      );
    }
  }
}

type ReconciledRecoveryRestoreTarget = {
  relativePath: string;
  absolutePath: string;
  quarantinePath: string;
  quarantineSnapshot: Exclude<LocalFileSnapshot, { exists: false }>;
  canonicalSnapshot?: Exclude<LocalFileSnapshot, { exists: false }>;
  cleanupEligible: boolean;
  publicQuarantineMatches: boolean;
  durableQuarantinePaths: readonly string[];
};

function preserveRecoveryRestoreQuarantine(args: {
  target: Pick<
    PreparedRepoWipe['recoveryRestoreTargets'][number],
    'quarantinePath' | 'quarantineSnapshot'
  >;
  recoveryPaths: string[];
  uncertainPaths: string[];
  io: RepoWipeIo;
}): SnapshotRecoveryResult {
  const recovery = persistSnapshotForRecovery({
    preferredPath: args.target.quarantinePath,
    snapshot: args.target.quarantineSnapshot,
    io: args.io,
  });
  addSnapshotRecoveryPaths(
    args.recoveryPaths,
    args.uncertainPaths,
    recovery,
  );
  return recovery;
}

function reconcileRecoveryRestoreTargetsAfterFirestore(args: {
  prepared: PreparedRepoWipe;
  recoveryManifestMatches: boolean;
  residualPaths: string[];
  recoveryPaths: string[];
  uncertainPaths: string[];
  io: RepoWipeIo;
}): ReconciledRecoveryRestoreTarget[] {
  return args.prepared.recoveryRestoreTargets.map(
    (target): ReconciledRecoveryRestoreTarget => {
      let quarantineMatches = false;
      try {
        quarantineMatches = localFileMatchesPreparedSnapshot(
          target.quarantinePath,
          target.quarantineSnapshot,
        );
      } catch {
        // Preserve the immutable snapshot at a no-clobber recovery path below.
      }
      let durableQuarantinePaths: readonly string[] = quarantineMatches
        ? [target.quarantinePath]
        : [];
      if (!quarantineMatches) {
        const recovery = preserveRecoveryRestoreQuarantine({
          target,
          recoveryPaths: args.recoveryPaths,
          uncertainPaths: args.uncertainPaths,
          io: args.io,
        });
        durableQuarantinePaths = recovery.durableRecoveryPaths;
        if (!durableQuarantinePaths.length) {
          throw new Error(
            `Shared wipe quarantine could not be made durable before the registry write: ${target.relativePath}`,
          );
        }
      }
      const quarantineDurability = {
        publicQuarantineMatches: quarantineMatches,
        durableQuarantinePaths: Object.freeze(
          [...durableQuarantinePaths],
        ),
      };

      let currentCanonicalSnapshot: LocalFileSnapshot;
      try {
        currentCanonicalSnapshot = snapshotLocalFile(
          target.absolutePath,
        );
      } catch {
        addUniquePath(args.residualPaths, target.relativePath);
        addUniquePath(args.recoveryPaths, target.quarantinePath);
        return {
          relativePath: target.relativePath,
          absolutePath: target.absolutePath,
          quarantinePath: target.quarantinePath,
          quarantineSnapshot: target.quarantineSnapshot,
          canonicalSnapshot: target.canonicalSnapshot.exists
            ? target.canonicalSnapshot
            : undefined,
          cleanupEligible: false,
          ...quarantineDurability,
        };
      }

      if (target.canonicalSnapshot.exists) {
        let canonicalMatches = false;
        try {
          canonicalMatches = localFileMatchesPreparedSnapshot(
            target.absolutePath,
            target.canonicalSnapshot,
          );
        } catch {
          // Treat unreadable state as a concurrent change.
        }
        if (canonicalMatches) {
          return {
            ...target,
            canonicalSnapshot: target.canonicalSnapshot,
            cleanupEligible:
              args.recoveryManifestMatches && quarantineMatches,
            ...quarantineDurability,
          };
        }

        addUniquePath(args.residualPaths, target.relativePath);
        addUniquePath(args.recoveryPaths, target.quarantinePath);
        if (!currentCanonicalSnapshot.exists && quarantineMatches) {
          ensureDirectoryChainDurable(
            path.dirname(target.absolutePath),
            args.io,
          );
          let restoredSnapshot:
            | Exclude<LocalFileSnapshot, { exists: false }>
            | undefined;
          try {
            restoredSnapshot = restoreLocalFileExclusively(
              target.absolutePath,
              target.quarantineSnapshot,
            );
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException)?.code !== 'EEXIST'
            ) {
              throw error;
            }
            // A concurrent canonical entry is preserved by exclusive creation.
          }
          if (restoredSnapshot) {
            makeSnapshotDurable(
              target.absolutePath,
              restoredSnapshot,
              args.io,
            );
            return {
              ...target,
              canonicalSnapshot: restoredSnapshot,
              cleanupEligible: false,
              ...quarantineDurability,
            };
          }
        }
        return {
          ...target,
          canonicalSnapshot: currentCanonicalSnapshot.exists
            ? currentCanonicalSnapshot
            : undefined,
          cleanupEligible: false,
          ...quarantineDurability,
        };
      }

      if (currentCanonicalSnapshot.exists) {
        addUniquePath(args.residualPaths, target.relativePath);
        addUniquePath(args.recoveryPaths, target.quarantinePath);
        return {
          ...target,
          canonicalSnapshot: currentCanonicalSnapshot,
          cleanupEligible: false,
          ...quarantineDurability,
        };
      }

      if (!quarantineMatches || !args.recoveryManifestMatches) {
        addUniquePath(args.residualPaths, target.relativePath);
        addUniquePath(args.recoveryPaths, target.quarantinePath);
        return {
          relativePath: target.relativePath,
          absolutePath: target.absolutePath,
          quarantinePath: target.quarantinePath,
          quarantineSnapshot: target.quarantineSnapshot,
          cleanupEligible: false,
          ...quarantineDurability,
        };
      }

      ensureDirectoryChainDurable(
        path.dirname(target.absolutePath),
        args.io,
      );
      let restoredSnapshot:
        | Exclude<LocalFileSnapshot, { exists: false }>
        | undefined;
      try {
        restoredSnapshot = restoreLocalFileExclusively(
          target.absolutePath,
          target.quarantineSnapshot,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
          throw error;
        }
      }
      if (restoredSnapshot) {
        makeSnapshotDurable(
          target.absolutePath,
          restoredSnapshot,
          args.io,
        );
        return {
          ...target,
          canonicalSnapshot: restoredSnapshot,
          cleanupEligible: true,
          ...quarantineDurability,
        };
      }
      addUniquePath(args.residualPaths, target.relativePath);
      addUniquePath(args.recoveryPaths, target.quarantinePath);
      return {
        relativePath: target.relativePath,
        absolutePath: target.absolutePath,
        quarantinePath: target.quarantinePath,
        quarantineSnapshot: target.quarantineSnapshot,
        cleanupEligible: false,
        ...quarantineDurability,
      };
    },
  );
}

function recheckRecoveryRestoreTargets(args: {
  targets: ReconciledRecoveryRestoreTarget[];
  residualPaths: string[];
  recoveryPaths: string[];
  uncertainPaths: string[];
  cleanupErrors: unknown[];
  io: RepoWipeIo;
}): void {
  for (const target of args.targets) {
    if (!target.cleanupEligible || !target.canonicalSnapshot) continue;
    let canonicalMatches = false;
    let quarantineMatches = false;
    try {
      canonicalMatches = localFileMatchesPreparedSnapshot(
        target.absolutePath,
        target.canonicalSnapshot,
      );
      quarantineMatches = localFileMatchesPreparedSnapshot(
        target.quarantinePath,
        target.quarantineSnapshot,
      );
    } catch (error) {
      args.cleanupErrors.push(error);
    }
    if (!canonicalMatches || !quarantineMatches) {
      target.cleanupEligible = false;
      addUniquePath(args.residualPaths, target.relativePath);
      preserveRecoveryRestoreQuarantine({
        target,
        recoveryPaths: args.recoveryPaths,
        uncertainPaths: args.uncertainPaths,
        io: args.io,
      });
    }
  }
}

function recheckRecoveryRestoreCanonicalsAfterPurge(args: {
  targets: ReconciledRecoveryRestoreTarget[];
  residualPaths: string[];
  recoveryPaths: string[];
  uncertainPaths: string[];
  cleanupErrors: unknown[];
  io: RepoWipeIo;
}): void {
  for (const target of args.targets) {
    if (!target.canonicalSnapshot) continue;
    let canonicalMatches = false;
    try {
      canonicalMatches = localFileMatchesPreparedSnapshot(
        target.absolutePath,
        target.canonicalSnapshot,
      );
    } catch (error) {
      args.cleanupErrors.push(error);
    }
    if (!canonicalMatches) {
      addUniquePath(args.residualPaths, target.relativePath);
      preserveRecoveryRestoreQuarantine({
        target,
        recoveryPaths: args.recoveryPaths,
        uncertainPaths: args.uncertainPaths,
        io: args.io,
      });
    }
  }
}

function recheckPostCommitRepoPaths(args: {
  prepared: PreparedRepoWipe;
  targets: ReconciledRecoveryRestoreTarget[];
  residualPaths: string[];
  recoveryPaths: string[];
  uncertainPaths: string[];
  cleanupErrors: unknown[];
  io: RepoWipeIo;
}): void {
  recheckRecoveryRestoreCanonicalsAfterPurge(args);
  recheckCanonicalPaths(
    args.prepared,
    args.residualPaths,
    args.cleanupErrors,
    args.io,
  );
  recheckQuarantinePaths(
    args.prepared,
    args.recoveryPaths,
    args.uncertainPaths,
    args.cleanupErrors,
    args.io,
  );
}

function reconcileStageFileError(args: {
  target: StagedCanonicalTarget;
  stagedTargets: StagedCanonicalTarget[];
  stageError: unknown;
  residualPaths: string[];
  recoveryPaths: string[];
  cleanupErrors: unknown[];
  io: RepoWipeIo;
}): 'continue' | 'throw' {
  let canonicalSnapshot: LocalFileSnapshot;
  let stagedSnapshot: LocalFileSnapshot;
  try {
    canonicalSnapshot = snapshotLocalFile(args.target.absolutePath);
    stagedSnapshot = snapshotLocalFile(args.target.stagedPath);
  } catch {
    // The owned record stays in place so rollback cannot mistake an
    // unreadable quarantine for a target this invocation never moved.
    addUniquePath(args.recoveryPaths, args.target.stagedPath);
    return 'throw';
  }

  const stagedMatches =
    stagedSnapshot.exists &&
    localFileMatchesPreparedSnapshot(
      args.target.stagedPath,
      args.target.snapshot,
    );
  if (stagedMatches) {
    // rename(2) completed before the adapter raised. Keep the ownership
    // record so the ordinary rollback path restores only these exact bytes.
    return 'throw';
  }

  const inFlightIndex = args.stagedTargets.lastIndexOf(args.target);
  if (inFlightIndex >= 0) {
    args.stagedTargets.splice(inFlightIndex, 1);
  }

  if (!canonicalSnapshot.exists && !stagedSnapshot.exists) {
    // The source vanished independently and nothing reached our quarantine.
    // Treat that as the same idempotent outcome as an already-missing target.
    try {
      removeEmptyStagingDirectory(
        args.target.stagedDirectory,
        args.io,
      );
    } catch (cleanupError) {
      addUniquePath(args.residualPaths, args.target.relativePath);
      addUniquePath(
        args.recoveryPaths,
        args.target.stagedDirectory,
      );
      args.cleanupErrors.push(cleanupError);
    }
    return 'continue';
  }

  if (stagedSnapshot.exists) {
    addUniquePath(args.recoveryPaths, args.target.stagedPath);
    if (!canonicalSnapshot.exists) {
      try {
        restoreUnexpectedStagedEntry({
          absolutePath: args.target.absolutePath,
          stagedPath: args.target.stagedPath,
          io: args.io,
        });
      } catch (restoreError) {
        args.cleanupErrors.push(restoreError);
      }
    }
    addUniquePath(args.residualPaths, args.target.relativePath);
    args.cleanupErrors.push(args.stageError);
    return 'continue';
  }

  let canonicalMatches = false;
  if (canonicalSnapshot.exists) {
    try {
      canonicalMatches = localFileMatchesPreparedSnapshot(
        args.target.absolutePath,
        args.target.snapshot,
      );
    } catch {
      // Treat an unreadable or replaced source as a concurrent residual.
    }
  }
  if (!canonicalMatches) {
    addUniquePath(args.residualPaths, args.target.relativePath);
    args.cleanupErrors.push(args.stageError);
    try {
      removeEmptyStagingDirectory(
        args.target.stagedDirectory,
        args.io,
      );
    } catch (cleanupError) {
      addUniquePath(
        args.recoveryPaths,
        args.target.stagedDirectory,
      );
      args.cleanupErrors.push(cleanupError);
    }
    return 'continue';
  }

  try {
    removeEmptyStagingDirectory(
      args.target.stagedDirectory,
      args.io,
    );
  } catch {
    addUniquePath(args.recoveryPaths, args.target.stagedDirectory);
  }
  return 'throw';
}

export function applyPreparedRepoWipe(
  prepared: PreparedRepoWipe,
  ioOverrides: Partial<RepoWipeIo> = {},
): void {
  const io = {
    ...DEFAULT_REPO_WIPE_IO,
    ...ioOverrides,
    durabilityRoot: prepared.durabilityRoot,
  };
  const stagedTargets: StagedCanonicalTarget[] = [];
  const residualPaths: string[] = [];
  const recoveryPaths: string[] = [];
  const uncertainPaths: string[] = [];
  const cleanupErrors: unknown[] = [];
  const recoveryManifestHandle = prepared.recoveryManifest;
  let recoveryManifestMatches = true;
  let reconciledRecoveryRestoreTargets: ReconciledRecoveryRestoreTarget[] =
    [];

  try {
    if (recoveryManifestHandle) {
      try {
        recoveryManifestMatches =
          localFileMatchesPreparedSnapshot(
            recoveryManifestHandle.filePath,
            recoveryManifestHandle.snapshot,
          );
      } catch {
        recoveryManifestMatches = false;
      }
      if (!recoveryManifestMatches) {
        addUniquePath(
          uncertainPaths,
          recoveryManifestHandle.filePath,
        );
      }
    }

    for (const target of prepared.canonicalDeleteTargets) {
      if (!recoveryManifestMatches) {
        try {
          if (io.pathEntryExists(target.absolutePath)) {
            addUniquePath(residualPaths, target.relativePath);
          }
        } catch {
          addUniquePath(residualPaths, target.relativePath);
        }
        continue;
      }

      if (target.quarantineSnapshot.exists) {
        let quarantineMatches = false;
        try {
          quarantineMatches = localFileMatchesPreparedSnapshot(
            target.quarantinePath,
            target.quarantineSnapshot,
          );
        } catch {
          // Preserve and report an unreadable quarantine.
        }
        if (quarantineMatches) {
          stagedTargets.push({
            relativePath: target.relativePath,
            absolutePath: target.absolutePath,
            stagedDirectory: path.dirname(target.quarantinePath),
            stagedPath: target.quarantinePath,
            snapshot: target.quarantineSnapshot,
            ownedByInvocation: false,
          });
        } else {
          addUniquePath(recoveryPaths, target.quarantinePath);
        }
        try {
          if (io.pathEntryExists(target.absolutePath)) {
            addUniquePath(residualPaths, target.relativePath);
          }
        } catch {
          addUniquePath(residualPaths, target.relativePath);
        }
        continue;
      }

      try {
        if (io.pathEntryExists(target.quarantinePath)) {
          addUniquePath(recoveryPaths, target.quarantinePath);
          addUniquePath(residualPaths, target.relativePath);
          continue;
        }
      } catch {
        addUniquePath(recoveryPaths, target.quarantinePath);
        addUniquePath(residualPaths, target.relativePath);
        continue;
      }

      if (!target.snapshot.exists) {
        try {
          if (io.pathEntryExists(target.absolutePath)) {
            addUniquePath(residualPaths, target.relativePath);
          }
        } catch {
          addUniquePath(residualPaths, target.relativePath);
        }
        continue;
      }

      let targetStillMatches = false;
      try {
        targetStillMatches = localFileMatchesPreparedSnapshot(
          target.absolutePath,
          target.snapshot,
        );
      } catch {
        addUniquePath(residualPaths, target.relativePath);
        continue;
      }
      if (!targetStillMatches) {
        try {
          if (io.pathEntryExists(target.absolutePath)) {
            addUniquePath(residualPaths, target.relativePath);
          }
        } catch {
          addUniquePath(residualPaths, target.relativePath);
        }
        continue;
      }

      const staging = createStagingLocation(
        target.quarantinePath,
        io,
      );
      const inFlightTarget: StagedCanonicalTarget = {
        ...staging,
        relativePath: target.relativePath,
        absolutePath: target.absolutePath,
        snapshot: target.snapshot,
        ownedByInvocation: true,
      };
      stagedTargets.push(inFlightTarget);
      try {
        io.stageFile(target.absolutePath, staging.stagedPath);
      } catch (error) {
        if (
          reconcileStageFileError({
            target: inFlightTarget,
            stagedTargets,
            stageError: error,
            residualPaths,
            recoveryPaths,
            cleanupErrors,
            io,
          }) === 'continue'
        ) {
          continue;
        }
        throw error;
      }

      let stagedEntryExists: boolean;
      try {
        stagedEntryExists = io.pathEntryExists(staging.stagedPath);
      } catch (error) {
        throw new Error(
          `Could not inspect staged wipe target ${target.relativePath}.`,
          { cause: error },
        );
      }
      if (!stagedEntryExists) {
        throw new Error(
          `Staged wipe target disappeared before it could be verified: ${target.relativePath}`,
        );
      }
      let stagedTargetMatches = false;
      try {
        stagedTargetMatches = localFileMatchesPreparedSnapshot(
          staging.stagedPath,
          target.snapshot,
        );
      } catch (error) {
        throw new Error(
          `Could not verify staged wipe target ${target.relativePath}.`,
          { cause: error },
        );
      }
      if (!stagedTargetMatches) {
        stagedTargets.pop();
        addUniquePath(residualPaths, target.relativePath);
        addUniquePath(recoveryPaths, staging.stagedPath);
        try {
          restoreUnexpectedStagedEntry({
            absolutePath: target.absolutePath,
            stagedPath: staging.stagedPath,
            io,
          });
        } catch {
          // The raced-in entry remains at its deterministic recovery path.
        }
      }

      try {
        if (io.pathEntryExists(target.absolutePath)) {
          addUniquePath(residualPaths, target.relativePath);
        }
      } catch {
        addUniquePath(residualPaths, target.relativePath);
      }
    }
    reconciledRecoveryRestoreTargets =
      reconcileRecoveryRestoreTargetsAfterFirestore({
        prepared,
        recoveryManifestMatches,
        residualPaths,
        recoveryPaths,
        uncertainPaths,
        io,
      });
    reconcileStagedTargetsBeforeRegistry(
      stagedTargets,
      recoveryPaths,
      uncertainPaths,
      io,
    );
    for (const target of stagedTargets) {
      makeStagedTargetDurable(target, io);
    }
    for (const target of reconciledRecoveryRestoreTargets) {
      for (const durableQuarantinePath of target.durableQuarantinePaths) {
        if (
          target.publicQuarantineMatches &&
          durableQuarantinePath === target.quarantinePath
        ) {
          makePreparedEntryDurable(
            durableQuarantinePath,
            target.quarantineSnapshot,
            io,
          );
        } else {
          makeRestoredEntryDurable(
            durableQuarantinePath,
            target.quarantineSnapshot,
            io,
          );
        }
      }
      if (!target.cleanupEligible || !target.canonicalSnapshot) continue;
      makePreparedEntryDurable(
        target.absolutePath,
        target.canonicalSnapshot,
        io,
      );
    }
    reconcileStagedTargetsBeforeRegistry(
      stagedTargets,
      recoveryPaths,
      uncertainPaths,
      io,
    );
    recheckRecoveryRestoreTargets({
      targets: reconciledRecoveryRestoreTargets,
      residualPaths,
      recoveryPaths,
      cleanupErrors,
      uncertainPaths,
      io,
    });
  } catch (stagingError) {
    rollbackStagedTargets({
      stagedTargets,
      mutationError: stagingError,
      io,
      recoveryPaths,
      uncertainPaths,
    });
  }

  let writerError: unknown;
  try {
    io.writeRegistry({
      filePath: prepared.registryPath,
      expectedContent: prepared.registryExpectedContent,
      nextContent: prepared.registryNextContent,
    });
  } catch (error) {
    writerError = error;
  }

  const liveRegistryCommitted = liveRegistryMatchesNextContent(prepared);
  const visiblePostCommitError =
    writerError != null &&
    isDeploymentRegistryPostCommitVerificationError(writerError) &&
    liveRegistryCommitted;
  if (
    (writerError != null && !visiblePostCommitError) ||
    (writerError == null && !liveRegistryCommitted)
  ) {
    const rollbackError =
      writerError ??
      new Error(
        `Canonical deployment registry changed after the wipe writer returned: ${prepared.registryPath}`,
      );
    rollbackStagedTargets({
      stagedTargets,
      mutationError: rollbackError,
      io,
      recoveryPaths,
      uncertainPaths,
    });
  }

  recheckCanonicalPaths(prepared, residualPaths, cleanupErrors, io);
  recheckRecoveryRestoreTargets({
    targets: reconciledRecoveryRestoreTargets,
    residualPaths,
    recoveryPaths,
    uncertainPaths,
    cleanupErrors,
    io,
  });
  purgeCommittedStagedTargets({
    stagedTargets: stagedTargets.filter(
      (target) => !residualPaths.includes(target.relativePath),
    ),
    io,
    recoveryPaths,
    uncertainPaths,
  });
  purgeCommittedStagedTargets({
    stagedTargets: reconciledRecoveryRestoreTargets
      .filter((target) => target.cleanupEligible)
      .map((target) => ({
        relativePath: target.relativePath,
        absolutePath: target.absolutePath,
        stagedDirectory: path.dirname(target.quarantinePath),
        stagedPath: target.quarantinePath,
        snapshot: target.quarantineSnapshot,
        ownedByInvocation: false,
      })),
    io,
    recoveryPaths,
    uncertainPaths,
  });
  recheckPostCommitRepoPaths({
    prepared,
    targets: reconciledRecoveryRestoreTargets,
    residualPaths,
    recoveryPaths,
    cleanupErrors,
    uncertainPaths,
    io,
  });
  let recoveryManifestRemoved = false;
  if (
    !residualPaths.length &&
    !recoveryPaths.length &&
    !uncertainPaths.length
  ) {
    recoveryManifestRemoved = removeRecoveryManifest(
      recoveryManifestHandle,
      recoveryPaths,
      uncertainPaths,
      io,
    );
  }
  recheckPostCommitRepoPaths({
    prepared,
    targets: reconciledRecoveryRestoreTargets,
    residualPaths,
    recoveryPaths,
    cleanupErrors,
    uncertainPaths,
    io,
  });
  if (recoveryManifestRemoved && recoveryManifestHandle) {
    try {
      if (io.pathEntryExists(recoveryManifestHandle.filePath)) {
        addUniquePath(
          recoveryPaths,
          recoveryManifestHandle.filePath,
        );
      }
    } catch (error) {
      addUniquePath(
        recoveryPaths,
        recoveryManifestHandle.filePath,
      );
      cleanupErrors.push(error);
    }
  }
  if (
    recoveryManifestRemoved &&
    (residualPaths.length ||
      recoveryPaths.length ||
      uncertainPaths.length)
  ) {
    restoreRemovedRecoveryManifest(
      recoveryManifestHandle,
      recoveryPaths,
      uncertainPaths,
      io,
    );
  }
  if (
    residualPaths.length ||
    recoveryPaths.length ||
    uncertainPaths.length
  ) {
    throw new RepoWipePostCommitCleanupError(residualPaths, {
      cause: writerError ?? cleanupErrors[0],
      recoveryPaths,
      uncertainPaths,
    });
  }
  if (writerError != null) throw writerError;
}

export function applyRepoWipe(
  plan: RepoPlan,
  ioOverrides: Partial<RepoWipeIo> = {},
): void {
  applyPreparedRepoWipe(
    prepareRepoWipe(plan, ioOverrides),
    ioOverrides,
  );
}

export async function applyWipePhases<TPrepared>(args: {
  prepareRepo: () => TPrepared;
  applyFirestore: () => Promise<void>;
  applyPreparedRepo: (prepared: TPrepared) => void;
  abortPreparedRepo?: (prepared: TPrepared) => void;
}): Promise<void> {
  const prepared = args.prepareRepo();
  try {
    await args.applyFirestore();
  } catch (firestoreError) {
    if (args.abortPreparedRepo) {
      try {
        args.abortPreparedRepo(prepared);
      } catch (abortError) {
        throw new Error(
          `Firestore wipe failed and prepared repository cleanup also failed: ${
            abortError instanceof Error
              ? abortError.message
              : String(abortError)
          }`,
          { cause: firestoreError },
        );
      }
    }
    throw firestoreError;
  }
  args.applyPreparedRepo(prepared);
}

async function applyFirestoreWipe(dropId: string, plan: FirestorePlan): Promise<void> {
  dropId = validateDropId(dropId, 'drop id');
  await withFirestoreFallback(
    async () => {
      const db = adminDb();

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
    },
    async () => {
      await mapLimit(plan.claimCodesToDelete, 8, async (code) => deleteDocumentViaRest(`claimCodes/${code}`));
      await recursiveDeleteDocumentViaRest(`drops/${dropId}`);
    },
  );
}

function looksLikeCredentialError(message: string): boolean {
  return /Could not load the default credentials|Failed to determine service account|credential implementation provided|Failed to read credentials from file|No Firebase CLI refresh token available|firebase login:list failed/i.test(
    message,
  );
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

  const knownDropIds = sortStrings([
    ...Object.keys(repoPlan.dropsNext),
    args.dropId,
  ]);
  const firestorePlan = await buildFirestorePlan(args.dropId, knownDropIds);
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

  let releaseRegistryLock: (() => boolean) | undefined;
  const releaseOnExit = () => releaseRegistryLock?.();
  const handleSigint = () => {
    releaseRegistryLock?.();
    process.exit(130);
  };
  const handleSigterm = () => {
    releaseRegistryLock?.();
    process.exit(143);
  };
  process.once('exit', releaseOnExit);
  process.once('SIGINT', handleSigint);
  process.once('SIGTERM', handleSigterm);

  try {
    releaseRegistryLock = acquireDeploymentRegistryMutationLock({
      root,
      operation: `wipe ${args.dropId}`,
    });
    const lockedRepoPlan = await buildRepoPlan({ root, dropId: args.dropId });
    if (lockedRepoPlan.extraReferences.length) {
      fail(
        `Found additional tracked references to ${args.dropId} outside the canonical wipe paths:\n` +
          lockedRepoPlan.extraReferences.map((relPath) => `- ${relPath}`).join('\n') +
          `\nRemove or rename those references first, then retry.`,
      );
    }
    assertRepoWipeRegistryWritable(lockedRepoPlan);
    const lockedKnownDropIds = sortStrings([
      ...Object.keys(lockedRepoPlan.dropsNext),
      args.dropId,
    ]);
    const lockedFirestorePlan = await buildFirestorePlan(args.dropId, lockedKnownDropIds);
    if (
      !isDeepStrictEqual(lockedRepoPlan, repoPlan) ||
      !isDeepStrictEqual(lockedFirestorePlan, firestorePlan)
    ) {
      fail('Repository or Firestore state changed after the wipe plan was shown. Rerun to review a fresh plan.');
    }

    await applyWipePhases({
      prepareRepo: () => prepareRepoWipe(lockedRepoPlan),
      applyFirestore: () => applyFirestoreWipe(args.dropId, lockedFirestorePlan),
      applyPreparedRepo: (prepared) => applyPreparedRepoWipe(prepared),
      abortPreparedRepo: (prepared) => abortPreparedRepoWipe(prepared),
    });

    console.log('');
    console.log(
      `wipe complete: removed ${args.dropId} from local config, deleted ${lockedRepoPlan.canonicalDeleteTargets.length} canonical file(s), ` +
      `deleted ${lockedFirestorePlan.claimCodesToDelete.length} claimCodes doc(s), and recursively deleted ${lockedFirestorePlan.recursiveDeletePath}`,
    );
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
    if (looksLikeCredentialError(message)) {
      console.error(
        'Firestore access is unavailable. Set GOOGLE_APPLICATION_CREDENTIALS/local ADC or authenticate with `firebase login`, then retry.',
      );
    }
    console.error(message);
    process.exit(1);
  });
}
