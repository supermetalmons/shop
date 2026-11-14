import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BOX_MINTER_CONFIG_TOMBSTONES,
  type BoxMinterConfigTombstone,
  type ReceiptPoolDeployment,
} from '../../shared/deploymentRegistry.ts';
import {
  findUniqueExportedConst,
  renderDeploymentRegistryFileFromSource,
  renderReceiptPoolDeploymentsFileFromSource,
} from './deploymentRegistrySource.ts';
import type { DeploymentDropConfigSerialized, DeploymentDropRegistry } from './deploymentRegistryTypes.ts';
import {
  assertNoBoxMinterConfigRegistryCollisions,
  assertReceiptPoolDropRelations,
  assertValidCanonicalRegistryRow,
  assertValidReceiptPoolDeployment,
  isPlainRecord,
  normalizeBoxMinterConfigTombstone,
  normalizeDeploymentDropForRegistry,
  normalizeReceiptPoolDeployment,
} from './deploymentRegistryValidation.ts';
import {
  isOptimisticTextFilePostCommitVerificationError,
  writeOptimisticTextFile,
  type OptimisticTextFileWriteIo,
} from './optimisticTextFile.ts';

export function acquireDeploymentRegistryMutationLock(args: {
  root: string;
  operation: string;
}): () => boolean {
  const lockPath = join(
    args.root,
    '.cache',
    'deployment-registry-mutation.lock',
  );
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = `${JSON.stringify(
    {
      operation: args.operation,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      token,
    },
    null,
    2,
  )}\n`;
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    writeFileSync(lockPath, payload, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
    let owner = 'owner details unavailable';
    try {
      const existing = JSON.parse(readFileSync(lockPath, 'utf8')) as {
        operation?: unknown;
        pid?: unknown;
        startedAt?: unknown;
      };
      owner =
        `operation=${String(existing.operation ?? 'unknown')}, ` +
        `pid=${String(existing.pid ?? 'unknown')}, ` +
        `startedAt=${String(existing.startedAt ?? 'unknown')}`;
    } catch {}
    throw new Error(
      `Another deployment-registry operation may still be running (${owner}).\n` +
        `Lock: ${lockPath}\n` +
        `Concurrent deploy/wipe operations are blocked so proof and registry files cannot race.\n` +
        `If no matching process is running, remove this stale lock file and rerun.`,
    );
  }

  let released = false;
  return () => {
    if (released) return true;
    try {
      if (!existsSync(lockPath)) {
        released = true;
        return true;
      }
      const current = JSON.parse(readFileSync(lockPath, 'utf8')) as {
        token?: unknown;
      };
      if (current.token !== token) {
        released = true;
        try {
          console.warn(
            `⚠️  Preserved deployment-registry lock because its owner changed: ${lockPath}`,
          );
        } catch {}
        return true;
      }
      unlinkSync(lockPath);
      released = true;
      return true;
    } catch (err) {
      try {
        console.warn(
          `⚠️  Failed to remove deployment-registry lock ${lockPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } catch {}
      return false;
    }
  };
}

async function importModuleFresh(
  filePath: string,
): Promise<Record<string, unknown>> {
  const href = pathToFileURL(filePath).href;
  const mtimeMs = existsSync(filePath)
    ? statSync(filePath).mtimeMs
    : Date.now();
  return (await import(
    `${href}?t=${mtimeMs}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  )) as Record<string, unknown>;
}

async function readModule(filePath: string, label: string) {
  try {
    return await importModuleFresh(filePath);
  } catch (err) {
    throw new Error(
      `Failed to load existing ${label} at ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export async function readDeploymentDropRegistry(
  filePath: string,
): Promise<DeploymentDropRegistry> {
  if (!existsSync(filePath)) {
    throw new Error(`Missing canonical deployment registry: ${filePath}`);
  }
  const sourceBeforeImport = readFileSync(filePath, 'utf8');
  findUniqueExportedConst({
    exportName: 'DEPLOYMENT_DROPS',
    filePath,
    content: sourceBeforeImport,
  });
  findUniqueExportedConst({
    exportName: 'BOX_MINTER_CONFIG_TOMBSTONES',
    filePath,
    content: sourceBeforeImport,
  });
  const drops: Record<string, DeploymentDropConfigSerialized> = {};
  const tombstones: Record<string, BoxMinterConfigTombstone> = {};
  const mod = await readModule(filePath, 'deployment registry');
  const sourceContent = readFileSync(filePath, 'utf8');
  if (sourceContent !== sourceBeforeImport) {
    throw new Error(
      `Canonical deployment registry changed while it was being loaded: ${filePath}`,
    );
  }
  if (
    !Object.prototype.hasOwnProperty.call(mod, 'DEPLOYMENT_DROPS') ||
    !mod.DEPLOYMENT_DROPS ||
    typeof mod.DEPLOYMENT_DROPS !== 'object' ||
    Array.isArray(mod.DEPLOYMENT_DROPS) ||
    !isPlainRecord(mod.DEPLOYMENT_DROPS)
  ) {
    throw new Error(
      `Canonical deployment registry must export DEPLOYMENT_DROPS as an object: ${filePath}`,
    );
  }
  findUniqueExportedConst({
    exportName: 'DEPLOYMENT_DROPS',
    filePath,
    content: sourceContent,
  });
  const candidate = mod.DEPLOYMENT_DROPS;
  for (const [registryKey, value] of Object.entries(
    candidate as Record<string, unknown>,
  )) {
    if (
      isPlainRecord(value) &&
      Object.prototype.hasOwnProperty.call(value, 'dropId') &&
      value.dropId !== registryKey
    ) {
      throw new Error(
        `Canonical deployment registry key ${registryKey} does not match embedded dropId ${String(value.dropId)}: ${filePath}`,
      );
    }
    const rowArgs = { registryKey, value, filePath };
    assertValidCanonicalRegistryRow(rowArgs);
    const normalized = normalizeDeploymentDropForRegistry(rowArgs.value);
    if (!normalized) {
      throw new Error(
        `Invalid canonical deployment registry row ${registryKey}: ${filePath}`,
      );
    }
    const embeddedDropId = rowArgs.value.dropId;
    if (
      embeddedDropId !== registryKey ||
      registryKey !== normalized.dropId
    ) {
      throw new Error(
        `Canonical deployment registry key ${registryKey} does not match embedded dropId ${String(embeddedDropId)}: ${filePath}`,
      );
    }
    Object.defineProperty(drops, registryKey, {
      value: normalized,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }

  const tombstoneCandidate = mod.BOX_MINTER_CONFIG_TOMBSTONES;
  if (!isPlainRecord(tombstoneCandidate)) {
    throw new Error(
      `Canonical deployment registry must export BOX_MINTER_CONFIG_TOMBSTONES as an object: ${filePath}`,
    );
  }
  findUniqueExportedConst({
    exportName: 'BOX_MINTER_CONFIG_TOMBSTONES',
    filePath,
    content: sourceContent,
  });
  for (const [registryKey, value] of Object.entries(
    tombstoneCandidate,
  )) {
    const tombstone = normalizeBoxMinterConfigTombstone({
      registryKey,
      value,
      filePath,
    });
    Object.defineProperty(tombstones, registryKey, {
      value: tombstone,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
  assertNoBoxMinterConfigRegistryCollisions({
    drops,
    tombstones,
    filePath,
  });

  const receiptPools: Record<string, ReceiptPoolDeployment> = {};
  const receiptPoolCandidate = mod.RECEIPT_POOL_DEPLOYMENTS;
  if (
    receiptPoolCandidate !== undefined &&
    !isPlainRecord(receiptPoolCandidate)
  ) {
    throw new Error(
      `Canonical deployment registry RECEIPT_POOL_DEPLOYMENTS must be an object: ${filePath}`,
    );
  }
  for (const [registryKey, value] of Object.entries(
    receiptPoolCandidate ?? {},
  )) {
    const rowArgs = { registryKey, value, filePath };
    assertValidReceiptPoolDeployment(rowArgs);
    Object.defineProperty(receiptPools, registryKey, {
      value: normalizeReceiptPoolDeployment(rowArgs.value),
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }

  // Validate the mutation boundary while the source is still unchanged. This
  // rejects a missing or malformed declaration before deploy or wipe can mutate
  // remote state without requiring rendered formatting to equal hand-written
  // source byte-for-byte.
  renderDeploymentRegistryFileFromSource({
    filePath,
    existingContent: sourceContent,
    drops,
    tombstones,
  });
  if (receiptPoolCandidate !== undefined) {
    renderReceiptPoolDeploymentsFileFromSource({
      filePath,
      existingContent: sourceContent,
      receiptPools,
    });
  }
  assertReceiptPoolDropRelations({ drops, receiptPools });
  return { drops, tombstones, receiptPools, sourceContent };
}

function canonicalRegistryTemplatePath(): string {
  return fileURLToPath(
    new URL(
      '../../shared/deploymentRegistry.ts',
      import.meta.url,
    ),
  );
}

export function renderDeploymentRegistryFile(args: {
  drops: Record<string, DeploymentDropConfigSerialized>;
  tombstones?: Record<string, BoxMinterConfigTombstone>;
}): string {
  const templatePath = canonicalRegistryTemplatePath();
  return renderDeploymentRegistryFileFromSource({
    filePath: templatePath,
    existingContent: readFileSync(templatePath, 'utf8'),
    drops: args.drops,
    tombstones: args.tombstones ?? BOX_MINTER_CONFIG_TOMBSTONES,
  });
}

export class DeploymentRegistryPostCommitVerificationError extends Error {
  constructor(filePath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Canonical deployment registry was durably committed, but post-commit verification failed for ${filePath}: ${detail}`,
      { cause },
    );
    this.name = 'DeploymentRegistryPostCommitVerificationError';
  }
}

export function isDeploymentRegistryPostCommitVerificationError(
  error: unknown,
): error is DeploymentRegistryPostCommitVerificationError {
  return error instanceof DeploymentRegistryPostCommitVerificationError;
}

export function writeDeploymentRegistryFile(args: {
  filePath: string;
  expectedContent: string;
  nextContent: string;
}, ioOverrides: Partial<OptimisticTextFileWriteIo> = {}): void {
  try {
    writeOptimisticTextFile(
      {
        ...args,
        targetLabel: 'canonical deployment registry',
      },
      ioOverrides,
    );
  } catch (error) {
    if (isOptimisticTextFilePostCommitVerificationError(error)) {
      throw new DeploymentRegistryPostCommitVerificationError(
        args.filePath,
        error.cause,
      );
    }
    throw error;
  }
}
