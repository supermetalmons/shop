import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeAndValidateDropId, requireDropFamily } from '../shared/deploymentRegistry.ts';
import {
  localPathEntryExists,
  sha256LocalSnapshot,
  snapshotLocalFile,
  type LocalFileSnapshot,
} from './repoWipeSnapshot.ts';

function fail(message: string): never {
  throw new Error(message);
}

export function isCanonicalDropFile(relPath: string, dropId: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  const parsed = path.posix.parse(normalized);
  return parsed.dir === 'src/drops' && parsed.name === dropId;
}

export type WipeRecoveryManifest = {
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

export function wipeRecoveryManifestPath(root: string, dropId: string): string {
  return path.join(root, '.cache', 'wipe-drop', `${dropId}.json`);
}

export function deterministicQuarantineRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  const parsed = path.posix.parse(normalized);
  const digest = createHash('sha256')
    .update(`wipe-drop-quarantine\0${normalized}`)
    .digest('hex')
    .slice(0, 20);
  const directoryName = `.${parsed.base}.wipe-drop-${digest}`;
  return path.posix.join(parsed.dir, directoryName, parsed.base);
}

export function deterministicQuarantinePath(args: {
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

export function recoveryFingerprintMatchesSnapshot(
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

export function recoveryTargetAuthenticatesLivePath(args: {
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

export function parseWipeRecoveryManifest(args: {
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

export function renderWipeRecoveryManifest(
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
