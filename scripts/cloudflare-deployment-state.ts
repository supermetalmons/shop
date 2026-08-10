import { spawnSync } from 'node:child_process';
import { cloudflareVersionIdPattern } from './finalize-cloudflare-release.ts';

export type CloudflareDeploymentStatus = {
  id: string;
  strategy: 'percentage';
  versions: Array<{
    percentage: number;
    versionId: string;
  }>;
};

export type CloudflareDeploymentStatusReader = () =>
  CloudflareDeploymentStatus | Promise<CloudflareDeploymentStatus>;

export type CloudflareSleep = (milliseconds: number) => Promise<void>;

export type WranglerOutputRunner = (
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  label: string,
  timeoutMs: number,
) => string;

type WranglerOutputProcessResult = {
  error?: Error;
  signal: NodeJS.Signals | null;
  status: number | null;
  stdout: string;
};

type WranglerOutputSpawner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    encoding: 'utf8';
    env: NodeJS.ProcessEnv;
    killSignal: 'SIGKILL';
    shell: false;
    stdio: ['ignore', 'pipe', 'inherit'];
    timeout: number;
  },
) => WranglerOutputProcessResult;

export const cloudflareStatusReconciliationDelaysMs = [0, 500, 1_500, 3_000] as const;
export const wranglerDeploymentStatusTimeoutMs = 15_000;

export class CloudflareDeploymentStateError extends Error {
  readonly kind: 'invalid' | 'non-stable' | 'concurrent';

  constructor(message: string, kind: 'invalid' | 'non-stable' | 'concurrent' = 'invalid', options?: ErrorOptions) {
    super(message, options);
    this.name = 'CloudflareDeploymentStateError';
    this.kind = kind;
  }
}

export class CloudflareProcessFailure extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CloudflareProcessFailure';
    this.exitCode = exitCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeVersionId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !cloudflareVersionIdPattern.test(value)) {
    throw new CloudflareDeploymentStateError(`${label} was not an exact Cloudflare version UUID.`);
  }
  return value.toLowerCase();
}

export function parseCloudflareDeploymentStatus(output: string): CloudflareDeploymentStatus {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new CloudflareDeploymentStateError('Wrangler deployment status did not return valid JSON.', 'invalid', {
      cause: error,
    });
  }
  if (!isRecord(value)) {
    throw new CloudflareDeploymentStateError('Wrangler deployment status was not an object.');
  }
  if (value.strategy !== 'percentage') {
    throw new CloudflareDeploymentStateError('Wrangler deployment status did not use percentage routing.');
  }
  if (!Array.isArray(value.versions) || value.versions.length < 1 || value.versions.length > 2) {
    throw new CloudflareDeploymentStateError('Wrangler deployment status did not contain one or two versions.');
  }
  const versions = value.versions.map((version, index) => {
    if (!isRecord(version)) {
      throw new CloudflareDeploymentStateError(`Wrangler deployment status version ${index + 1} was invalid.`);
    }
    const percentage = version.percentage;
    if (typeof percentage !== 'number' || !Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
      throw new CloudflareDeploymentStateError(`Wrangler deployment status version ${index + 1} had an invalid percentage.`);
    }
    return {
      percentage,
      versionId: normalizeVersionId(version.version_id, `Wrangler deployment status version ${index + 1}`),
    };
  });
  if (new Set(versions.map((version) => version.versionId)).size !== versions.length) {
    throw new CloudflareDeploymentStateError('Wrangler deployment status repeated a version ID.');
  }
  const percentageTotal = versions.reduce((total, version) => total + version.percentage, 0);
  if (percentageTotal !== 100) {
    throw new CloudflareDeploymentStateError('Wrangler deployment status percentages did not total 100.');
  }
  return {
    id: normalizeVersionId(value.id, 'Wrangler deployment status deployment ID'),
    strategy: 'percentage',
    versions,
  };
}

export function stableCloudflareVersionId(status: CloudflareDeploymentStatus): string {
  if (status.versions.length !== 1 || status.versions[0].percentage !== 100) {
    const traffic = status.versions
      .map((version) => `${version.versionId}@${version.percentage}%`)
      .join(', ');
    throw new CloudflareDeploymentStateError(
      `Cloudflare production was not a stable single-version deployment: ${traffic}.`,
      'non-stable',
    );
  }
  return status.versions[0].versionId;
}

export function runWranglerForOutput(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  label: string,
  timeoutMs: number,
  spawn: WranglerOutputSpawner = spawnSync,
): string {
  const result = spawn(command, args, {
    cwd,
    encoding: 'utf8',
    env: environment,
    killSignal: 'SIGKILL',
    shell: false,
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: timeoutMs,
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new CloudflareProcessFailure(`${label} timed out after ${timeoutMs}ms.`, 1, { cause: result.error });
    }
    throw new CloudflareProcessFailure(`${label} could not start: ${result.error.message}`, 1, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new CloudflareProcessFailure(
      `${label} failed with exit code ${result.status ?? 1}${result.signal ? ` after signal ${result.signal}` : ''}.`,
      result.status ?? 1,
    );
  }
  return result.stdout;
}

export function readWranglerDeploymentStatus(
  options: {
    configArgs: readonly string[];
    cwd: string;
    environment: NodeJS.ProcessEnv;
    wranglerBinary: string;
  },
  runner: WranglerOutputRunner = runWranglerForOutput,
): CloudflareDeploymentStatus {
  const output = runner(
    options.wranglerBinary,
    ['deployments', 'status', '--json', ...options.configArgs],
    options.environment,
    options.cwd,
    'Wrangler deployment status',
    wranglerDeploymentStatusTimeoutMs,
  );
  return parseCloudflareDeploymentStatus(output.trim());
}

export function guardCloudflareReleaseStart(input: {
  candidateVersionId: string;
  expectedCurrentVersionId: string;
  liveVersionId: string;
  workerLabel: string;
}): { baselineVersionId: string; resumeCandidate: boolean } {
  const candidateVersionId = normalizeVersionId(input.candidateVersionId, 'Requested candidate version ID');
  const expectedCurrentVersionId = normalizeVersionId(input.expectedCurrentVersionId, 'Tracked production version ID');
  const liveVersionId = normalizeVersionId(input.liveVersionId, 'Live production version ID');
  if (liveVersionId === candidateVersionId) {
    return { baselineVersionId: expectedCurrentVersionId, resumeCandidate: true };
  }
  if (liveVersionId === expectedCurrentVersionId) {
    return { baselineVersionId: liveVersionId, resumeCandidate: false };
  }
  throw new CloudflareDeploymentStateError(
    `${input.workerLabel} live version ${liveVersionId} matched neither tracked production ${expectedCurrentVersionId} nor requested candidate ${candidateVersionId}.`,
    'concurrent',
  );
}

export async function reconcileCloudflareStableVersion(options: {
  allowedPendingVersionIds: readonly string[];
  delaysMs?: readonly number[];
  preferredVersionId: string;
  read: CloudflareDeploymentStatusReader;
  requireAllPendingObservations?: boolean;
  sleep: CloudflareSleep;
  workerLabel: string;
}): Promise<string> {
  const preferredVersionId = normalizeVersionId(options.preferredVersionId, 'Preferred version ID');
  const allowedPendingVersionIds = new Set(
    options.allowedPendingVersionIds.map((versionId) => normalizeVersionId(versionId, 'Pending version ID')),
  );
  const delaysMs = options.delaysMs ?? cloudflareStatusReconciliationDelaysMs;
  let lastError: unknown;
  let lastAllowedVersionId: string | undefined;
  let pendingObservationsWereContinuous = true;
  for (const delayMs of delaysMs) {
    if (delayMs) await options.sleep(delayMs);
    let status: CloudflareDeploymentStatus;
    try {
      status = await options.read();
    } catch (error) {
      lastError = error;
      lastAllowedVersionId = undefined;
      pendingObservationsWereContinuous = false;
      continue;
    }
    const liveVersionId = stableCloudflareVersionId(status);
    if (liveVersionId === preferredVersionId) return liveVersionId;
    if (!allowedPendingVersionIds.has(liveVersionId)) {
      throw new CloudflareDeploymentStateError(
        `${options.workerLabel} changed concurrently to unexpected version ${liveVersionId}.`,
        'concurrent',
      );
    }
    lastAllowedVersionId = liveVersionId;
    lastError = undefined;
  }
  if (lastAllowedVersionId && (!options.requireAllPendingObservations || pendingObservationsWereContinuous)) {
    return lastAllowedVersionId;
  }
  throw new CloudflareDeploymentStateError(
    `${options.workerLabel} deployment state could not be read after bounded retries.`,
    'invalid',
    { cause: lastError },
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

export function formatCloudflareReleaseError(error: unknown): string {
  const seen = new Set<unknown>();
  const format = (current: unknown, indent: string): string[] => {
    if ((typeof current === 'object' && current !== null) || typeof current === 'function') {
      if (seen.has(current)) return [`${indent}[circular error]`];
      seen.add(current);
    }
    const lines = [`${indent}${errorMessage(current)}`];
    if (current instanceof AggregateError) {
      for (const [index, nested] of Array.from(current.errors).entries()) {
        const nestedLines = format(nested, `${indent}    `);
        lines.push(`${indent}  ${index + 1}. ${nestedLines[0].trimStart()}`, ...nestedLines.slice(1));
      }
    }
    if (current instanceof Error && current.cause !== undefined) {
      const causeLines = format(current.cause, `${indent}    `);
      lines.push(`${indent}  Caused by: ${causeLines[0].trimStart()}`, ...causeLines.slice(1));
    }
    return lines;
  };
  return format(error, '').join('\n');
}

export function cloudflareReleaseExitCode(error: unknown): number {
  const seen = new Set<unknown>();
  const find = (current: unknown): number | undefined => {
    if ((typeof current === 'object' && current !== null) || typeof current === 'function') {
      if (seen.has(current)) return undefined;
      seen.add(current);
    }
    if (current instanceof AggregateError) {
      for (const nested of Array.from(current.errors)) {
        const nestedExitCode = find(nested);
        if (nestedExitCode !== undefined) return nestedExitCode;
      }
    }
    if (isRecord(current)) {
      const exitCode = current.exitCode;
      if (typeof exitCode === 'number' && Number.isSafeInteger(exitCode) && exitCode > 0 && exitCode <= 255) {
        return exitCode;
      }
    }
    if (current instanceof Error && current.cause !== undefined) return find(current.cause);
    return undefined;
  };
  return find(error) ?? 1;
}
