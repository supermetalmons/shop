import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  isOptimisticTextFilePostCommitVerificationError,
  writeOptimisticTextFile,
} from '../shared/optimisticTextFile.ts';
import {
  isDeploymentRegistryPostCommitVerificationError,
  writeDeploymentRegistryFile,
  type DeploymentDropConfigSerialized,
} from '../shared/deploymentRegistry.ts';
import { deterministicQuarantinePath } from './repoWipeRecovery.ts';
import {
  localFileHasSnapshotIdentity,
  localFileMatchesPreparedSnapshot,
  localFileMatchesSnapshot,
  localPathEntryExists,
  localPathMatchesSnapshot,
  restoreLocalFile,
  restoreLocalFileExclusively,
  sha256LocalSnapshot,
  snapshotLocalFile,
  type LocalFileSnapshot,
} from './repoWipeSnapshot.ts';

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

function fail(message: string): never {
  throw new Error(message);
}

function sortStrings(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values).filter(Boolean))).sort((a, b) => a.localeCompare(b));
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
      `Repository wipe plan conflict for ${args.target.relativePath}: prepared quarantine disappeared before the data wipe.`,
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
    } catch {}
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
        } catch {}
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
    } catch {}
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

function reconcileRecoveryRestoreTargetsAfterDataWipe(args: {
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
      } catch {}
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
        } catch {}
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

    return 'throw';
  }

  const inFlightIndex = args.stagedTargets.lastIndexOf(args.target);
  if (inFlightIndex >= 0) {
    args.stagedTargets.splice(inFlightIndex, 1);
  }

  if (!canonicalSnapshot.exists && !stagedSnapshot.exists) {

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
    } catch {}
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
        } catch {}
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
        } catch {}
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
      reconcileRecoveryRestoreTargetsAfterDataWipe({
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
