import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cloudflareVersionIdPattern as versionIdPattern,
  readReleaseManifest,
  recordFrontendProductionVersion,
  writeProductionEvidence,
  type ReleaseManifest,
  type ReleaseVersionPair,
} from './finalize-cloudflare-release.ts';
import {
  cloudflareReleaseExitCode,
  formatCloudflareReleaseError,
  guardCloudflareReleaseStart,
  readWranglerDeploymentStatus,
  reconcileCloudflareStableVersion,
  stableCloudflareVersionId,
  type CloudflareDeploymentStatus,
  type CloudflareSleep,
} from './cloudflare-deployment-state.ts';

type DeployMode = 'dry-run' | 'preview' | 'production';

type CliOptions = {
  mode: DeployMode;
  tokenFile?: string;
  versionId?: string;
};

type FrontendUploadMetadata = {
  versionId: string;
  previewUrl: string;
};

type VerifiedFrontendCandidate = FrontendUploadMetadata & {
  htmlSha256: string;
};

type FrontendCandidateRecord = FrontendUploadMetadata & {
  workerName: 'mons-shop';
  testedAt: string;
  htmlSha256: string;
  sourceCommit: string;
};

type FrontendSmokeDependencies = {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
};

type FrontendProductionSequenceInput = {
  candidateHtmlSha256: string;
  expectedCurrentVersionId: string;
  verifyBeforeMutation?: () => Promise<void>;
  verifyBeforePromotion?: () => Promise<void>;
  versionId: string;
  wranglerEnvironment: NodeJS.ProcessEnv;
};

type FrontendProductionSequenceDependencies = {
  deployment: (environment: NodeJS.ProcessEnv) => CloudflareDeploymentStatus | Promise<CloudflareDeploymentStatus>;
  evidence: typeof writeProductionEvidence;
  run: typeof run;
  sleep: CloudflareSleep;
  smoke: typeof smokeFrontendOrigin;
};

type FrontendProductionCandidateDependencies = {
  readCandidate: (versionId: string) => FrontendCandidateRecord | undefined;
};

type FrontendCandidateUploadInput = {
  authenticatedEnvironment: NodeJS.ProcessEnv;
  sourceCommit?: string;
  unauthenticatedEnvironment: NodeJS.ProcessEnv;
  validationEnvironment: NodeJS.ProcessEnv;
  wranglerLogDirectory: string;
};

type FrontendCandidateUploadDependencies = {
  run: typeof run;
  smoke: typeof smokeFrontendOrigin;
  sourceCommit: typeof readCleanSourceCommit;
  validate: typeof runFrontendValidation;
  writeCandidate: typeof writeFrontendCandidateRecord;
};

type CompleteFrontendReleaseInput = FrontendCandidateUploadInput & {
  tokenFile?: string;
  versionId?: string;
};

type CompleteFrontendReleaseDependencies = {
  apiDeployment: (environment: NodeJS.ProcessEnv) => CloudflareDeploymentStatus | Promise<CloudflareDeploymentStatus>;
  commit: typeof commitFrontendReleaseManifest;
  frontendDeployment: (environment: NodeJS.ProcessEnv) => CloudflareDeploymentStatus | Promise<CloudflareDeploymentStatus>;
  manifest: () => ReleaseManifest;
  production: typeof runFrontendProductionSequence;
  record: typeof recordFrontendProductionVersion;
  resolveCandidate: typeof resolveFrontendProductionCandidate;
  smoke: typeof smokeFrontendOrigin;
  source: typeof readCleanProductionSource;
  triggerDryRun: (environment: NodeJS.ProcessEnv) => void;
  upload: typeof uploadFrontendCandidate;
};

type GitWorktreeInspection = {
  error?: Error;
  output: string;
  status: number | null;
};

type GitSource = {
  branch: string;
  commit: string;
};

class DeployFailure extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'DeployFailure';
    this.exitCode = exitCode;
  }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const npmBinary = isWindows ? 'npm.cmd' : 'npm';
const wranglerBinary = resolve(repoRoot, 'node_modules', '.bin', isWindows ? 'wrangler.cmd' : 'wrangler');
const frontendConfigArgs = ['--config', 'wrangler.jsonc'] as const;
const apiConfigArgs = [
  '--config',
  'cloud/workers/api/wrangler.jsonc',
  '--env-file',
  'cloud/workers/api/release.env',
] as const;
const workersDevSubdomain = 'lil-org.workers.dev';
const frontendWorkerName = 'mons-shop';
const frontendAccountId = 'e25f90fc073ea309b54b8b5144bf28e0';
const frontendProductionOrigins = ['https://mons.shop', 'https://www.mons.shop'] as const;
const frontendCandidateRecordDirectory = resolve(repoRoot, '.cache', 'mons-shop-frontend-candidates');
const frontendCandidateMaxAgeMs = 6 * 60 * 60 * 1000;
const frontendCandidateClockSkewMs = 5 * 60 * 1000;
const frontendSmokeResponseLimit = 256 * 1024;
const frontendSmokeAssetResponseLimit = 2 * 1024 * 1024;
const frontendSmokeRetryDelaysMs = [0, 500, 1_500] as const;
const frontendProductionPropagationDelaysMs = [0, 500, 1_500, 3_000, 5_000, 10_000, 20_000, 30_000] as const;
const gitCommitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const releaseManifestRelativePath = 'cloud/release-manifest.json';
const frontendValidationSteps = [
  { args: ['run', 'typecheck'], label: 'Frontend typecheck' },
  { args: ['test'], label: 'Frontend tests' },
  { args: ['run', 'build'], label: 'Frontend build' },
  { args: ['run', 'validate:browser-bundle'], label: 'Frontend bundle validation' },
] as const;

function usage(): string {
  return [
    'Build and deploy the mons.shop frontend with the pinned local Wrangler.',
    '',
    'Usage:',
    '  npm run deploy -- dry-run',
    '  npm run deploy -- preview --token-file /path/to/cloudflare-token',
    '  npm run deploy -- production [--token-file /path/to/cloudflare-token]',
    '  npm run deploy -- production --version-id <uuid> --token-file /path/to/cloudflare-token',
    '',
    'Production without --version-id validates, uploads, verifies, promotes, records, and commits one exact frontend version.',
    'Use --version-id to promote or resume an existing candidate from the same clean Git commit.',
    '',
    'Authentication:',
    '  Pass --token-file, or set CLOUDFLARE_API_TOKEN in the shell.',
    '  The token is only provided to the Wrangler subprocess and is never printed.',
  ].join('\n');
}

function fail(message: string, exitCode = 1): never {
  throw new DeployFailure(message, exitCode);
}

function normalizeVersionId(value: string, label = 'version ID'): string {
  if (!versionIdPattern.test(value)) fail(`${label} must be an exact UUID.`);
  return value.toLowerCase();
}

export function expectedFrontendPreviewOrigin(versionId: string): string {
  const normalized = normalizeVersionId(versionId);
  return `https://${normalized.slice(0, 8)}-${frontendWorkerName}.${workersDevSubdomain}`;
}

export function parseFrontendUploadMetadata(path: string): FrontendUploadMetadata {
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/).reverse();
  const record = lines.flatMap((line) => {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      return value.type === 'version-upload' ? [value] : [];
    } catch {
      return [];
    }
  })[0];
  if (
    !record ||
    record.worker_name !== frontendWorkerName ||
    typeof record.version_id !== 'string' ||
    !versionIdPattern.test(record.version_id)
  ) {
    fail('Wrangler did not report a valid uploaded version for the mons-shop Worker.');
  }
  const versionId = record.version_id.toLowerCase();
  const previewUrl = expectedFrontendPreviewOrigin(versionId);
  if (record.preview_url !== previewUrl) {
    fail('Wrangler reported an unexpected frontend Version Preview URL.');
  }
  return { versionId, previewUrl };
}

export function parseFrontendDeployArgs(argv: string[]): CliOptions {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(usage());
    process.exit(0);
  }

  const mode = argv[0];
  if (mode !== 'dry-run' && mode !== 'preview' && mode !== 'production') {
    fail(`Expected one deployment mode: dry-run, preview, or production.\n\n${usage()}`, 2);
  }

  let tokenFile: string | undefined;
  let versionId: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--token-file') {
      if (tokenFile !== undefined) fail('--token-file may only be provided once.', 2);
      const value = argv[++i];
      if (!value) fail('Missing value for --token-file.', 2);
      tokenFile = value;
      continue;
    }
    if (arg === '--version-id') {
      if (versionId !== undefined) fail('--version-id may only be provided once.', 2);
      const value = argv[++i];
      if (!value) fail('Missing value for --version-id.', 2);
      versionId = normalizeVersionId(value, '--version-id');
      continue;
    }
    fail(`Unknown argument: ${arg}\n\n${usage()}`, 2);
  }

  if (mode !== 'production' && versionId) fail('--version-id is only valid for production promotion.', 2);
  return { mode, tokenFile, versionId };
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, label: string): void {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${label} failed with exit code ${result.status ?? 1}.`, result.status ?? 1);
  }
}

function inspectGitWorktree(): GitWorktreeInspection {
  const result = spawnSync(
    'git',
    ['status', '--porcelain', '--untracked-files=normal'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: credentialFreeEnvironment(process.env),
      shell: false,
    },
  );
  return {
    ...(result.error ? { error: result.error } : {}),
    output: result.stdout || '',
    status: result.status,
  };
}

function assertCleanProductionWorktree(
  inspect: () => GitWorktreeInspection = inspectGitWorktree,
): void {
  const result = inspect();
  if (result.error) fail(`Git worktree check could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`Git worktree check failed with exit code ${result.status ?? 1}.`);
  if (result.output.trim()) {
    fail('Production deployment requires a clean Git worktree. Commit or stash all changes first.');
  }
}

function inspectGitHead(): GitWorktreeInspection {
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: credentialFreeEnvironment(process.env),
    shell: false,
  });
  return {
    ...(result.error ? { error: result.error } : {}),
    output: result.stdout || '',
    status: result.status,
  };
}

function inspectGitBranch(): GitWorktreeInspection {
  const result = spawnSync('git', ['symbolic-ref', '--quiet', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: credentialFreeEnvironment(process.env),
    shell: false,
  });
  return {
    ...(result.error ? { error: result.error } : {}),
    output: result.stdout || '',
    status: result.status,
  };
}

function readAttachedProductionBranch(
  inspect: () => GitWorktreeInspection = inspectGitBranch,
): string {
  const result = inspect();
  if (result.error) fail(`Git branch check could not start: ${result.error.message}`);
  if (result.status === 1) fail('Production deployment requires an attached Git branch.');
  if (result.status !== 0) fail(`Git branch check failed with exit code ${result.status ?? 1}.`);
  if (!result.output.trim().startsWith('refs/heads/')) fail('Production deployment requires an attached Git branch.');
  return result.output.trim();
}

function readGitHeadCommit(
  inspect: () => GitWorktreeInspection = inspectGitHead,
): string {
  const result = inspect();
  if (result.error) fail(`Git HEAD check could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`Git HEAD check failed with exit code ${result.status ?? 1}.`);
  const sourceCommit = result.output.trim().toLowerCase();
  if (!gitCommitPattern.test(sourceCommit)) fail('Git HEAD did not resolve to an exact commit.');
  return sourceCommit;
}

function readCleanSourceCommit(
  inspectWorktree: () => GitWorktreeInspection = inspectGitWorktree,
  inspectHead: () => GitWorktreeInspection = inspectGitHead,
): string {
  assertCleanProductionWorktree(inspectWorktree);
  return readGitHeadCommit(inspectHead);
}

function readProductionGitPosition(
  inspectBranch: () => GitWorktreeInspection = inspectGitBranch,
  inspectHead: () => GitWorktreeInspection = inspectGitHead,
): GitSource {
  return {
    branch: readAttachedProductionBranch(inspectBranch),
    commit: readGitHeadCommit(inspectHead),
  };
}

function readCleanProductionSource(
  inspectBranch: () => GitWorktreeInspection = inspectGitBranch,
  inspectWorktree: () => GitWorktreeInspection = inspectGitWorktree,
  inspectHead: () => GitWorktreeInspection = inspectGitHead,
): GitSource {
  return {
    branch: readAttachedProductionBranch(inspectBranch),
    commit: readCleanSourceCommit(inspectWorktree, inspectHead),
  };
}

function readFrontendDeploymentStatus(environment: NodeJS.ProcessEnv): CloudflareDeploymentStatus {
  return readWranglerDeploymentStatus({
    configArgs: frontendConfigArgs,
    cwd: repoRoot,
    environment,
    wranglerBinary,
  });
}

function readApiDeploymentStatus(environment: NodeJS.ProcessEnv): CloudflareDeploymentStatus {
  return readWranglerDeploymentStatus({
    configArgs: apiConfigArgs,
    cwd: repoRoot,
    environment,
    wranglerBinary,
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function readApiToken(tokenFile?: string): string {
  if (tokenFile) {
    let value: string;
    try {
      value = readFileSync(resolve(tokenFile), 'utf8').trim();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fail(`Unable to read --token-file: ${detail}`);
    }
    if (!value) fail('The Cloudflare token file is empty.');
    return value;
  }

  const value = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
  if (!value) fail('Missing Cloudflare authentication. Pass --token-file or set CLOUDFLARE_API_TOKEN.');
  return value;
}

function credentialFreeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    const normalized = name.toUpperCase();
    if (
      normalized.startsWith('VITE_') ||
      normalized.startsWith('CLOUDFLARE_') ||
      normalized.startsWith('CF_') ||
      normalized.startsWith('WRANGLER_') ||
      normalized === 'HELIUS_API_KEY' ||
      normalized === 'RESEND_CONTACTS_API_KEY' ||
      normalized === 'DOTENV_KEY' ||
      normalized === 'STRIPE_TEST_UNIT_AMOUNT_CENTS'
    ) {
      delete environment[name];
    }
  }
  return environment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

export function isExactFrontendDeploymentConfig(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    value.name !== frontendWorkerName ||
    value.account_id !== frontendAccountId ||
    value.workers_dev !== false ||
    value.preview_urls !== true ||
    !Array.isArray(value.routes) ||
    value.routes.length !== frontendProductionOrigins.length
  ) {
    return false;
  }
  const routes = value.routes.flatMap((route) => {
    if (!isRecord(route) || !hasExactKeys(route, ['pattern', 'custom_domain']) || route.custom_domain !== true) {
      return [];
    }
    return typeof route.pattern === 'string' ? [route.pattern] : [];
  });
  return (
    routes.length === frontendProductionOrigins.length &&
    routes.sort().join('\0') === frontendProductionOrigins.map((origin) => new URL(origin).hostname).sort().join('\0')
  );
}

function readFrontendDeploymentConfig(path = resolve(repoRoot, 'wrangler.jsonc')): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Unable to read frontend Wrangler config: ${detail}`);
  }
}

export function assertFrontendDeploymentConfig(path = resolve(repoRoot, 'wrangler.jsonc')): void {
  if (!isExactFrontendDeploymentConfig(readFrontendDeploymentConfig(path))) {
    fail(
      'Frontend Wrangler config must target only the mons-shop Worker, account e25f90fc073ea309b54b8b5144bf28e0, and the mons.shop/www.mons.shop custom domains.',
    );
  }
}

export function frontendCandidateRecordPath(
  versionId: string,
  directory = frontendCandidateRecordDirectory,
): string {
  return resolve(directory, `${normalizeVersionId(versionId)}.json`);
}

export function isFrontendCandidateRecord(
  value: unknown,
  now = new Date(),
): value is FrontendCandidateRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['workerName', 'versionId', 'previewUrl', 'testedAt', 'htmlSha256', 'sourceCommit'])
  ) {
    return false;
  }
  if (
    value.workerName !== frontendWorkerName ||
    typeof value.versionId !== 'string' ||
    !versionIdPattern.test(value.versionId) ||
    value.versionId !== value.versionId.toLowerCase() ||
    value.previewUrl !== expectedFrontendPreviewOrigin(value.versionId) ||
    typeof value.testedAt !== 'string' ||
    typeof value.htmlSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.htmlSha256) ||
    typeof value.sourceCommit !== 'string' ||
    !gitCommitPattern.test(value.sourceCommit)
  ) {
    return false;
  }
  const testedAt = Date.parse(value.testedAt);
  return (
    Number.isFinite(testedAt) &&
    testedAt <= now.getTime() + frontendCandidateClockSkewMs &&
    testedAt >= now.getTime() - frontendCandidateMaxAgeMs
  );
}

export function writeFrontendCandidateRecord(
  metadata: FrontendUploadMetadata & { htmlSha256: string; sourceCommit: string },
  options: { directory?: string; now?: Date } = {},
): FrontendCandidateRecord {
  const now = options.now ?? new Date();
  const record: FrontendCandidateRecord = {
    workerName: frontendWorkerName,
    versionId: normalizeVersionId(metadata.versionId),
    previewUrl: metadata.previewUrl,
    testedAt: now.toISOString(),
    htmlSha256: metadata.htmlSha256,
    sourceCommit: metadata.sourceCommit.toLowerCase(),
  };
  if (!isFrontendCandidateRecord(record, now)) fail('Refusing to write invalid frontend candidate evidence.');
  const directory = options.directory ?? frontendCandidateRecordDirectory;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileSync(frontendCandidateRecordPath(record.versionId, directory), `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return record;
}

export function requireFrontendCandidateRecord(
  versionId: string,
  options: { directory?: string; now?: Date } = {},
): FrontendCandidateRecord {
  const normalized = normalizeVersionId(versionId);
  const path = frontendCandidateRecordPath(normalized, options.directory);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    fail(`Frontend production promotion requires fresh candidate evidence for version ${normalized}.`);
  }
  const now = options.now ?? new Date();
  if (!isFrontendCandidateRecord(value, now) || value.versionId !== normalized) {
    fail(`Frontend candidate evidence for version ${normalized} is invalid or stale.`);
  }
  return value;
}

function readFrontendCandidateRecordIfValid(
  versionId: string,
  options: { directory?: string; now?: Date } = {},
): FrontendCandidateRecord | undefined {
  const normalized = normalizeVersionId(versionId);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(frontendCandidateRecordPath(normalized, options.directory), 'utf8')) as unknown;
  } catch {
    return undefined;
  }
  const now = options.now ?? new Date();
  return isFrontendCandidateRecord(value, now) && value.versionId === normalized ? value : undefined;
}

async function resolveFrontendProductionCandidate(
  input: {
    expectedCurrentVersionId: string;
    versionId: string;
    wranglerEnvironment: NodeJS.ProcessEnv;
  },
  dependencies: FrontendProductionCandidateDependencies = {
    readCandidate: readFrontendCandidateRecordIfValid,
  },
): Promise<{ previewUrl: string; recordedHtmlSha256: string; sourceCommit: string }> {
  const candidateVersionId = normalizeVersionId(input.versionId);
  const candidate = dependencies.readCandidate(candidateVersionId);
  if (candidate) {
    return {
      previewUrl: candidate.previewUrl,
      recordedHtmlSha256: candidate.htmlSha256,
      sourceCommit: candidate.sourceCommit,
    };
  }
  fail(`Frontend production promotion requires source-bound candidate evidence for version ${candidateVersionId}.`);
}

async function readBoundedSmokeBody(
  response: Response,
  maxBytes = frontendSmokeResponseLimit,
): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsed = Number.parseInt(contentLength, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > maxBytes) {
      fail('Frontend smoke response exceeded the allowed size.');
    }
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        fail('Frontend smoke response exceeded the allowed size.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

type FrontendAssetReference = {
  path: string;
  contentType: 'javascript' | 'text/css';
};

function frontendAssetReferences(html: string): FrontendAssetReference[] {
  const references = new Map<string, FrontendAssetReference>();
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/gi) ?? []) {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(/\b([a-z-]+)\s*=\s*(["'])(.*?)\2/gi)) {
      attributes.set(match[1].toLowerCase(), match[3]);
    }
    const type = attributes.get('type')?.toLowerCase();
    const rel = attributes.get('rel')?.toLowerCase().split(/\s+/) ?? [];
    const path = tag.toLowerCase().startsWith('<script')
      ? type === 'module' ? attributes.get('src') : undefined
      : rel.includes('stylesheet') || rel.includes('modulepreload') ? attributes.get('href') : undefined;
    if (!path) continue;
    references.set(path, {
      path,
      contentType: rel.includes('stylesheet') ? 'text/css' : 'javascript',
    });
  }
  const values = [...references.values()];
  if (!values.some((reference) => reference.contentType === 'javascript')) {
    fail('Frontend smoke response did not reference a module asset.');
  }
  return values;
}

async function fetchFrontendSmokeResponse(
  fetchImpl: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
  url: string,
): Promise<Response> {
  for (let attempt = 0; attempt < frontendSmokeRetryDelaysMs.length; attempt++) {
    const delay = frontendSmokeRetryDelaysMs[attempt];
    if (delay) await sleep(delay);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: '*/*' },
        cache: 'no-store',
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      if (
        (response.status === 404 || response.status === 502 || response.status === 504) &&
        attempt + 1 < frontendSmokeRetryDelaysMs.length
      ) {
        await response.body?.cancel();
        continue;
      }
      return response;
    } catch (error) {
      if (attempt + 1 === frontendSmokeRetryDelaysMs.length) throw error;
    }
  }
  fail(`Frontend smoke request failed for ${url}.`);
}

export async function smokeFrontendOrigin(
  origin: string,
  dependencies: FrontendSmokeDependencies = {},
): Promise<string> {
  const fetchImpl = dependencies.fetch ?? fetch;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  }));
  const url = `${origin}/`;
  for (let attempt = 0; attempt < frontendSmokeRetryDelaysMs.length; attempt++) {
    const delay = frontendSmokeRetryDelaysMs[attempt];
    if (delay) await sleep(delay);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'text/html' },
        cache: 'no-store',
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (attempt + 1 < frontendSmokeRetryDelaysMs.length) continue;
      const detail = error instanceof Error ? error.message : String(error);
      fail(`Frontend smoke request failed for ${origin}: ${detail}`);
    }
    if (
      (response.status === 404 || response.status === 502 || response.status === 504) &&
      attempt + 1 < frontendSmokeRetryDelaysMs.length
    ) {
      await response.body?.cancel();
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      fail(`Frontend smoke request for ${origin} returned HTTP ${response.status}.`);
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('text/html')) {
      await response.body?.cancel();
      fail(`Frontend smoke request for ${origin} did not return HTML.`);
    }
    const body = await readBoundedSmokeBody(response);
    if (!/<title>mons\.shop<\/title>/i.test(body) || !/<div\s+id=["']root["']/i.test(body)) {
      fail(`Frontend smoke request for ${origin} returned unexpected HTML.`);
    }
    for (const reference of frontendAssetReferences(body)) {
      const assetUrl = new URL(reference.path, url);
      if (assetUrl.origin !== origin || !assetUrl.pathname.startsWith('/assets/')) {
        fail(`Frontend smoke response for ${origin} referenced an unexpected asset URL.`);
      }
      let assetResponse: Response;
      try {
        assetResponse = await fetchFrontendSmokeResponse(fetchImpl, sleep, assetUrl.href);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        fail(`Frontend asset smoke request failed for ${assetUrl.href}: ${detail}`);
      }
      if (assetResponse.status !== 200) {
        await assetResponse.body?.cancel();
        fail(`Frontend asset smoke request for ${assetUrl.href} returned HTTP ${assetResponse.status}.`);
      }
      const contentType = assetResponse.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.includes(reference.contentType)) {
        await assetResponse.body?.cancel();
        fail(`Frontend asset smoke request for ${assetUrl.href} returned an unexpected content type.`);
      }
      if (!(await readBoundedSmokeBody(assetResponse, frontendSmokeAssetResponseLimit))) {
        fail(`Frontend asset smoke request for ${assetUrl.href} returned an empty body.`);
      }
    }
    return createHash('sha256').update(body).digest('hex');
  }
  fail(`Frontend smoke request failed for ${origin}.`);
}

export function frontendProductionWranglerCommands(versionId: string): readonly {
  label: string;
  args: string[];
}[] {
  const normalized = normalizeVersionId(versionId);
  return [
    {
      label: 'Frontend trigger deployment',
      args: ['triggers', 'deploy', '--config', 'wrangler.jsonc'],
    },
    {
      label: 'Frontend exact-version promotion',
      args: [
        'versions',
        'deploy',
        '--version-id',
        normalized,
        '--percentage',
        '100',
        '--yes',
        '--config',
        'wrangler.jsonc',
      ],
    },
  ];
}

function deployFrontendTriggers(
  input: FrontendProductionSequenceInput,
  dependencies: FrontendProductionSequenceDependencies,
): void {
  const [trigger] = frontendProductionWranglerCommands(input.versionId);
  if (!trigger) fail('Frontend production sequence was missing its trigger deployment.');
  try {
    dependencies.run(wranglerBinary, trigger.args, input.wranglerEnvironment, trigger.label);
  } catch (firstError) {
    try {
      dependencies.run(
        wranglerBinary,
        trigger.args,
        input.wranglerEnvironment,
        'Frontend trigger deployment retry',
      );
      console.log('[deploy] Frontend trigger deployment converged on its declarative retry.');
    } catch (retryError) {
      throw new AggregateError(
        [firstError, retryError],
        'Frontend trigger deployment failed twice; no new Worker version was promoted.',
      );
    }
  }
}

async function exactFrontendLiveVersion(
  input: FrontendProductionSequenceInput,
  dependencies: FrontendProductionSequenceDependencies,
): Promise<string> {
  return stableCloudflareVersionId(await dependencies.deployment(input.wranglerEnvironment));
}

async function assertFrontendLiveVersion(
  expectedVersionId: string,
  input: FrontendProductionSequenceInput,
  dependencies: FrontendProductionSequenceDependencies,
  label: string,
): Promise<void> {
  const liveVersionId = await exactFrontendLiveVersion(input, dependencies);
  if (liveVersionId !== expectedVersionId) {
    throw new Error(`${label} expected ${expectedVersionId}, but Cloudflare reported ${liveVersionId}.`);
  }
}

async function reconcileFrontendVersion(
  preferredVersionId: string,
  allowedPendingVersionIds: readonly string[],
  input: FrontendProductionSequenceInput,
  dependencies: FrontendProductionSequenceDependencies,
  requireAllPendingObservations = false,
): Promise<string> {
  return reconcileCloudflareStableVersion({
    allowedPendingVersionIds,
    preferredVersionId,
    read: () => dependencies.deployment(input.wranglerEnvironment),
    requireAllPendingObservations,
    sleep: dependencies.sleep,
    workerLabel: frontendWorkerName,
  });
}

async function smokeFrontendProduction(
  dependencies: FrontendProductionSequenceDependencies,
): Promise<void> {
  for (const origin of frontendProductionOrigins) {
    console.log(`[deploy] Production smoke: ${origin}`);
    await dependencies.smoke(origin);
  }
}

async function smokeExactFrontendProduction(
  input: FrontendProductionSequenceInput,
  dependencies: FrontendProductionSequenceDependencies,
): Promise<void> {
  for (const origin of frontendProductionOrigins) {
    let lastError: unknown;
    let lastHash: string | undefined;
    for (const delayMs of frontendProductionPropagationDelaysMs) {
      if (delayMs) await dependencies.sleep(delayMs);
      try {
        console.log(`[deploy] Exact production smoke: ${origin}`);
        lastHash = await dependencies.smoke(origin);
        lastError = undefined;
        if (lastHash === input.candidateHtmlSha256) break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastHash !== input.candidateHtmlSha256) {
      throw new Error(
        `Frontend production smoke for ${origin} did not serve the exact promoted candidate after bounded propagation retries${lastHash ? `; last HTML SHA-256 was ${lastHash}` : ''}.`,
        { cause: lastError },
      );
    }
  }
}

async function recoverFrontendProduction(
  releaseError: unknown,
  baselineVersionId: string,
  candidateVersionId: string,
  input: FrontendProductionSequenceInput,
  dependencies: FrontendProductionSequenceDependencies,
): Promise<never> {
  let observedVersionId: string;
  try {
    observedVersionId = await reconcileFrontendVersion(
      candidateVersionId,
      [baselineVersionId],
      input,
      dependencies,
    );
  } catch (stateError) {
    throw new AggregateError(
      [releaseError, stateError],
      'Frontend release failed after the candidate became mutation-eligible, and live state was unsafe to overwrite. No blind rollback was attempted; inspect deployment status and recover manually.',
    );
  }

  let rollbackCommandError: unknown;
  const recoveryVerificationErrors: unknown[] = [];
  let baselineConfirmed = observedVersionId === baselineVersionId;
  if (observedVersionId === candidateVersionId && candidateVersionId !== baselineVersionId) {
    try {
      await assertFrontendLiveVersion(
        candidateVersionId,
        input,
        dependencies,
        'Frontend pre-rollback candidate guard',
      );
    } catch (stateError) {
      throw new AggregateError(
        [releaseError, stateError],
        'Frontend release failed, but the candidate changed after reconciliation; automatic rollback was suppressed. Inspect deployment status and recover manually.',
      );
    }
    try {
      dependencies.run(
        wranglerBinary,
        [
          'rollback',
          baselineVersionId,
          '--yes',
          '--message',
          'Automatic recovery after failed mons-shop frontend release',
          '--config',
          'wrangler.jsonc',
        ],
        input.wranglerEnvironment,
        'Frontend compensating rollback',
      );
    } catch (rollbackError) {
      rollbackCommandError = rollbackError;
    }
    try {
      const recoveredVersionId = await reconcileFrontendVersion(
        baselineVersionId,
        [candidateVersionId],
        input,
        dependencies,
      );
      if (recoveredVersionId !== baselineVersionId) {
        recoveryVerificationErrors.push(new Error(
          `Frontend compensating rollback did not make baseline ${baselineVersionId} live; ${recoveredVersionId} remained active.`,
        ));
      } else {
        baselineConfirmed = true;
      }
    } catch (stateError) {
      recoveryVerificationErrors.push(stateError);
    }
  }

  if (baselineConfirmed) {
    try {
      await smokeFrontendProduction(dependencies);
    } catch (smokeError) {
      recoveryVerificationErrors.push(smokeError);
    }
    try {
      await assertFrontendLiveVersion(
        baselineVersionId,
        input,
        dependencies,
        'Frontend recovery verification',
      );
    } catch (stateError) {
      recoveryVerificationErrors.push(stateError);
    }
  }

  if (recoveryVerificationErrors.length > 0) {
    throw new AggregateError(
      [releaseError, ...(rollbackCommandError === undefined ? [] : [rollbackCommandError]), ...recoveryVerificationErrors],
      'Frontend production release failed and exact baseline recovery was not cleanly verified. No further automatic mutation was attempted; inspect deployment status and recover manually.',
    );
  }
  if (rollbackCommandError !== undefined) {
    console.log(`[deploy] Automatic frontend recovery verified at version ${baselineVersionId} despite a rollback command failure.`);
    throw new AggregateError(
      [releaseError, rollbackCommandError],
      'Frontend production release failed; baseline recovery was verified, but the rollback command reported failure.',
    );
  }
  console.log(`[deploy] Automatic frontend recovery verified at version ${baselineVersionId}.`);
  throw releaseError;
}

function resumedFrontendReleaseFailure(error: unknown, candidateVersionId: string): Error {
  return new Error(
    `Frontend candidate ${candidateVersionId} was already live when this command started. Automatic rollback was suppressed because this invocation did not capture its predecessor; inspect production and rerun the same production command after resolving the failure.`,
    { cause: error },
  );
}

function frontendEvidenceFailure(error: unknown, candidateVersionId: string): Error {
  return new Error(
    `Frontend candidate ${candidateVersionId} remains live and verified, but production evidence could not be written. No rollback was attempted; rerun the same production command with this version ID to regenerate evidence through guarded resume.`,
    { cause: error },
  );
}

async function runFrontendProductionSequence(
  input: FrontendProductionSequenceInput,
  dependencies: FrontendProductionSequenceDependencies = {
    deployment: readFrontendDeploymentStatus,
    evidence: writeProductionEvidence,
    run,
    sleep,
    smoke: smokeFrontendOrigin,
  },
): Promise<void> {
  const candidateVersionId = normalizeVersionId(input.versionId);
  const initialLiveVersionId = await exactFrontendLiveVersion(input, dependencies);
  const releaseStart = guardCloudflareReleaseStart({
    candidateVersionId,
    expectedCurrentVersionId: input.expectedCurrentVersionId,
    liveVersionId: initialLiveVersionId,
    workerLabel: frontendWorkerName,
  });

  if (releaseStart.resumeCandidate) {
    try {
      await input.verifyBeforeMutation?.();
      deployFrontendTriggers(input, dependencies);
      await input.verifyBeforePromotion?.();
    } catch (error) {
      throw resumedFrontendReleaseFailure(error, candidateVersionId);
    }
  } else {
    await input.verifyBeforeMutation?.();
    deployFrontendTriggers(input, dependencies);
    await smokeFrontendProduction(dependencies);
    await assertFrontendLiveVersion(
      releaseStart.baselineVersionId,
      input,
      dependencies,
      'Frontend pre-promotion baseline recheck',
    );
    await input.verifyBeforePromotion?.();

    const commands = frontendProductionWranglerCommands(candidateVersionId);
    const promotion = commands.find((command) => command.label === 'Frontend exact-version promotion');
    if (!promotion) fail('Frontend production sequence was missing its exact-version promotion.');
    let promotionError: unknown;
    try {
      dependencies.run(wranglerBinary, promotion.args, input.wranglerEnvironment, promotion.label);
    } catch (error) {
      promotionError = error;
    }

    let observedVersionId: string;
    try {
      observedVersionId = await reconcileFrontendVersion(
        candidateVersionId,
        [releaseStart.baselineVersionId],
        input,
        dependencies,
        true,
      );
    } catch (stateError) {
      if (promotionError !== undefined) {
        throw new AggregateError(
          [promotionError, stateError],
          'Frontend exact-version promotion failed and live mutation state could not be safely reconciled. No blind rollback was attempted; inspect deployment status and recover manually.',
        );
      }
      throw new Error(
        'Frontend exact-version promotion returned, but live mutation state could not be safely reconciled. No blind rollback was attempted; inspect deployment status and recover manually.',
        { cause: stateError },
      );
    }
    if (observedVersionId !== candidateVersionId) {
      if (promotionError !== undefined) throw promotionError;
      throw new Error(`Frontend exact-version promotion left baseline ${observedVersionId} live.`);
    }
    if (promotionError !== undefined) {
      await recoverFrontendProduction(
        promotionError,
        releaseStart.baselineVersionId,
        candidateVersionId,
        input,
        dependencies,
      );
    }
  }

  try {
    await smokeExactFrontendProduction(input, dependencies);
    await assertFrontendLiveVersion(
      candidateVersionId,
      input,
      dependencies,
      'Frontend production commit verification',
    );
  } catch (error) {
    if (releaseStart.resumeCandidate) {
      throw resumedFrontendReleaseFailure(error, candidateVersionId);
    }
    await recoverFrontendProduction(
      error,
      releaseStart.baselineVersionId,
      candidateVersionId,
      input,
      dependencies,
    );
  }
  try {
    dependencies.evidence('frontend', candidateVersionId);
  } catch (error) {
    throw frontendEvidenceFailure(error, candidateVersionId);
  }
}

function runFrontendValidation(environment: NodeJS.ProcessEnv): void {
  console.log('[deploy] Validation: typecheck, tests, build, and bundle scan (isolated environment)');
  const viteEnvironmentDirectory = mkdtempSync(join(tmpdir(), 'mons-shop-vite-env-'));
  const buildEnvironment = {
    ...environment,
    MONS_SHOP_VITE_ENV_DIR: viteEnvironmentDirectory,
    VITE_BUILD_DATETIME: String(Math.floor(Date.now() / 1000)),
  };
  try {
    for (const step of frontendValidationSteps) run(npmBinary, [...step.args], buildEnvironment, step.label);
  } finally {
    rmSync(viteEnvironmentDirectory, { force: true, recursive: true });
  }
}

function runFrontendTriggerDryRun(environment: NodeJS.ProcessEnv): void {
  run(
    wranglerBinary,
    ['triggers', 'deploy', '--dry-run', ...frontendConfigArgs],
    environment,
    'Frontend trigger dry run',
  );
}

async function uploadFrontendCandidate(
  input: FrontendCandidateUploadInput,
  dependencies: FrontendCandidateUploadDependencies = {
    run,
    smoke: smokeFrontendOrigin,
    sourceCommit: readCleanSourceCommit,
    validate: runFrontendValidation,
    writeCandidate: writeFrontendCandidateRecord,
  },
): Promise<VerifiedFrontendCandidate> {
  const sourceCommit = input.sourceCommit || dependencies.sourceCommit();
  dependencies.validate(input.validationEnvironment);
  dependencies.run(
    wranglerBinary,
    ['triggers', 'deploy', '--dry-run', ...frontendConfigArgs],
    input.unauthenticatedEnvironment,
    'Frontend trigger dry run',
  );
  const validatedSourceCommit = dependencies.sourceCommit();
  if (validatedSourceCommit !== sourceCommit) {
    fail(
      `Frontend source changed during validation: expected Git commit ${sourceCommit}, ` +
      `but found ${validatedSourceCommit}.`,
    );
  }
  mkdirSync(input.wranglerLogDirectory, { recursive: true });
  const outputFile = resolve(
    input.wranglerLogDirectory,
    `frontend-preview-${process.pid}-${Date.now()}.json`,
  );
  const uploadEnvironment: NodeJS.ProcessEnv = {
    ...input.authenticatedEnvironment,
    WRANGLER_OUTPUT_FILE_PATH: outputFile,
  };
  let metadata: FrontendUploadMetadata | undefined;
  let uploadError: unknown;
  try {
    dependencies.run(
      wranglerBinary,
      ['versions', 'upload', '--preview-alias', 'candidate', ...frontendConfigArgs],
      uploadEnvironment,
      'Frontend version upload',
    );
    metadata = parseFrontendUploadMetadata(outputFile);
  } catch (error) {
    uploadError = error;
  }
  let cleanupError: unknown;
  try {
    rmSync(outputFile, { force: true });
  } catch (error) {
    cleanupError = error;
  }
  if (uploadError && cleanupError) {
    throw new AggregateError([uploadError, cleanupError], 'Frontend upload and output cleanup both failed.');
  }
  if (uploadError) throw uploadError;
  if (cleanupError) throw cleanupError;
  if (!metadata) fail('Frontend version upload completed without version metadata.');
  console.log(`[deploy] Frontend version ID: ${metadata.versionId}`);
  console.log(`[deploy] Version Preview: ${metadata.previewUrl}`);
  const htmlSha256 = await dependencies.smoke(metadata.previewUrl);
  dependencies.writeCandidate({ ...metadata, htmlSha256, sourceCommit });
  console.log('[deploy] Exact-version frontend candidate evidence recorded.');
  return { ...metadata, htmlSha256 };
}

async function readStableReleasePair(
  environment: NodeJS.ProcessEnv,
  dependencies: Pick<CompleteFrontendReleaseDependencies, 'apiDeployment' | 'frontendDeployment'>,
): Promise<ReleaseVersionPair> {
  const [apiStatus, frontendStatus] = await Promise.all([
    dependencies.apiDeployment(environment),
    dependencies.frontendDeployment(environment),
  ]);
  return {
    apiVersionId: stableCloudflareVersionId(apiStatus),
    frontendVersionId: stableCloudflareVersionId(frontendStatus),
  };
}

function assertReleasePair(
  actual: ReleaseVersionPair,
  expected: ReleaseVersionPair,
  label: string,
): void {
  if (
    actual.apiVersionId !== expected.apiVersionId.toLowerCase() ||
    actual.frontendVersionId !== expected.frontendVersionId.toLowerCase()
  ) {
    fail(
      `${label} expected API ${expected.apiVersionId} and frontend ${expected.frontendVersionId}, ` +
      `but Cloudflare reported API ${actual.apiVersionId} and frontend ${actual.frontendVersionId}.`,
    );
  }
}

function assertAdvancedReleaseStartPair(
  actual: ReleaseVersionPair,
  expected: ReleaseVersionPair,
  candidateVersionId: string,
): void {
  const expectedApiVersionId = expected.apiVersionId.toLowerCase();
  const expectedFrontendVersionId = expected.frontendVersionId.toLowerCase();
  if (
    actual.apiVersionId !== expectedApiVersionId ||
    (actual.frontendVersionId !== expectedFrontendVersionId && actual.frontendVersionId !== candidateVersionId)
  ) {
    fail(
      `Frontend release preflight expected API ${expected.apiVersionId} and frontend ` +
      `${expected.frontendVersionId} or candidate ${candidateVersionId}, but Cloudflare reported ` +
      `API ${actual.apiVersionId} and frontend ${actual.frontendVersionId}.`,
    );
  }
}

function frontendManifestRecoveryCommand(versionId: string, tokenFile?: string): string {
  const tokenFileArgument = tokenFile ? ` --token-file ${JSON.stringify(tokenFile)}` : '';
  return `npm run deploy -- production --version-id ${versionId}${tokenFileArgument}`;
}

function frontendManifestCommitMessage(versionId: string): string {
  return `release frontend ${normalizeVersionId(versionId)}`;
}

function frontendManifestCommitRecoveryCommand(versionId: string): string {
  return `git commit --only -m ${JSON.stringify(frontendManifestCommitMessage(versionId))} -- ${releaseManifestRelativePath}`;
}

function commitFrontendReleaseManifest(
  versionId: string,
  expectedSource: GitSource,
  runCommand: typeof run = run,
  readPosition: typeof readProductionGitPosition = readProductionGitPosition,
): void {
  const normalizedVersionId = normalizeVersionId(versionId);
  const currentSource = readPosition();
  if (
    currentSource.branch !== expectedSource.branch ||
    currentSource.commit !== expectedSource.commit
  ) {
    fail(
      `Git position changed before the release manifest commit: expected ${expectedSource.branch} at ` +
      `${expectedSource.commit}, but found ${currentSource.branch} at ${currentSource.commit}.`,
    );
  }
  runCommand(
    'git',
    [
      'commit',
      '--only',
      '-m',
      frontendManifestCommitMessage(normalizedVersionId),
      '--',
      releaseManifestRelativePath,
    ],
    credentialFreeEnvironment(process.env),
    'Release manifest commit',
  );
  console.log(`[deploy] Committed release manifest for frontend ${normalizedVersionId}.`);
}

async function runCompleteFrontendRelease(
  input: CompleteFrontendReleaseInput,
  dependencies: CompleteFrontendReleaseDependencies = {
    apiDeployment: readApiDeploymentStatus,
    commit: commitFrontendReleaseManifest,
    frontendDeployment: readFrontendDeploymentStatus,
    manifest: readReleaseManifest,
    production: runFrontendProductionSequence,
    record: recordFrontendProductionVersion,
    resolveCandidate: resolveFrontendProductionCandidate,
    smoke: smokeFrontendOrigin,
    source: readCleanProductionSource,
    triggerDryRun: runFrontendTriggerDryRun,
    upload: uploadFrontendCandidate,
  },
): Promise<VerifiedFrontendCandidate> {
  const source = dependencies.source();
  const expectedCurrentProduction = dependencies.manifest().currentProduction;
  const initialLivePair = await readStableReleasePair(input.authenticatedEnvironment, dependencies);
  const requestedVersionId = input.versionId ? normalizeVersionId(input.versionId) : undefined;
  if (requestedVersionId) {
    assertAdvancedReleaseStartPair(initialLivePair, expectedCurrentProduction, requestedVersionId);
  } else {
    assertReleasePair(initialLivePair, expectedCurrentProduction, 'Frontend release preflight');
  }

  let candidate: VerifiedFrontendCandidate;
  if (requestedVersionId) {
    dependencies.triggerDryRun(input.unauthenticatedEnvironment);
    const resolved = await dependencies.resolveCandidate({
      expectedCurrentVersionId: expectedCurrentProduction.frontendVersionId,
      versionId: requestedVersionId,
      wranglerEnvironment: input.authenticatedEnvironment,
    });
    if (resolved.sourceCommit !== source.commit) {
      fail(
        `Frontend candidate ${requestedVersionId} was built from Git commit ${resolved.sourceCommit}, ` +
        `but the current commit is ${source.commit}.`,
      );
    }
    console.log(`[deploy] Re-smoke exact Version Preview: ${resolved.previewUrl}`);
    const htmlSha256 = await dependencies.smoke(resolved.previewUrl);
    if (resolved.recordedHtmlSha256 && htmlSha256 !== resolved.recordedHtmlSha256) {
      fail('Exact frontend Version Preview no longer matches its tested candidate evidence.');
    }
    candidate = { versionId: requestedVersionId, previewUrl: resolved.previewUrl, htmlSha256 };
  } else {
    candidate = await dependencies.upload({ ...input, sourceCommit: source.commit });
  }

  const assertSourceUnchanged = (phase: string): void => {
    const current = dependencies.source();
    if (current.branch !== source.branch || current.commit !== source.commit) {
      fail(
        `Frontend source changed ${phase}: expected ${source.branch} at Git commit ${source.commit}, ` +
        `but found ${current.branch} at Git commit ${current.commit}.`,
      );
    }
  };
  await dependencies.production({
    candidateHtmlSha256: candidate.htmlSha256,
    expectedCurrentVersionId: expectedCurrentProduction.frontendVersionId,
    verifyBeforeMutation: async () => assertSourceUnchanged('before production mutation'),
    verifyBeforePromotion: async () => {
      assertSourceUnchanged('before promotion');
      const apiVersionId = stableCloudflareVersionId(
        await dependencies.apiDeployment(input.authenticatedEnvironment),
      );
      if (apiVersionId !== expectedCurrentProduction.apiVersionId.toLowerCase()) {
        fail(
          `API changed before frontend promotion: expected ${expectedCurrentProduction.apiVersionId}, ` +
          `but Cloudflare reported ${apiVersionId}.`,
        );
      }
    },
    versionId: candidate.versionId,
    wranglerEnvironment: input.authenticatedEnvironment,
  });

  const finalLivePair = await readStableReleasePair(input.authenticatedEnvironment, dependencies);
  assertReleasePair(finalLivePair, {
    apiVersionId: expectedCurrentProduction.apiVersionId,
    frontendVersionId: candidate.versionId,
  }, 'Frontend release commit verification');
  try {
    assertSourceUnchanged('during release');
  } catch (error) {
    throw new Error(
      `Frontend version ${candidate.versionId} is live and verified, but release metadata was not updated because ` +
      `the source changed. Restore ${source.branch} at Git commit ${source.commit}, then reconcile it by running: ` +
      frontendManifestRecoveryCommand(candidate.versionId, input.tokenFile),
      { cause: error },
    );
  }
  try {
    dependencies.record(candidate.versionId, { expectedCurrentProduction });
  } catch (error) {
    throw new Error(
      `Frontend version ${candidate.versionId} is live and verified, but ${releaseManifestRelativePath} was not updated. ` +
      `Reconcile it with the same authentication by running: ` +
      frontendManifestRecoveryCommand(candidate.versionId, input.tokenFile),
      { cause: error },
    );
  }
  try {
    dependencies.commit(candidate.versionId, source);
  } catch (error) {
    throw new Error(
      `Frontend version ${candidate.versionId} is live and verified and ${releaseManifestRelativePath} was updated, ` +
      `but the release manifest was not committed. Restore ${source.branch} at Git commit ${source.commit}, ` +
      `then commit it by running: ` +
      frontendManifestCommitRecoveryCommand(candidate.versionId),
      { cause: error },
    );
  }
  return candidate;
}

async function main(): Promise<void> {
  const options = parseFrontendDeployArgs(process.argv.slice(2));
  const [nodeMajor = Number.NaN, nodeMinor = Number.NaN] = process.versions.node
    .split('.')
    .slice(0, 2)
    .map((part) => Number.parseInt(part, 10));
  if (
    !Number.isFinite(nodeMajor) ||
    !Number.isFinite(nodeMinor) ||
    nodeMajor < 22 ||
    (nodeMajor === 22 && nodeMinor < 12)
  ) {
    fail(`Node 22.12 or newer is required; current version is ${process.versions.node}.`);
  }
  if (!existsSync(wranglerBinary)) fail('Pinned Wrangler binary not found. Run npm install --legacy-peer-deps first.');

  assertFrontendDeploymentConfig();
  const validationEnvironment = credentialFreeEnvironment(process.env);
  const wranglerLogDirectory = resolve(repoRoot, '.cache', 'wrangler-logs');
  mkdirSync(wranglerLogDirectory, { recursive: true });
  const unauthenticatedWranglerEnvironment: NodeJS.ProcessEnv = {
    ...validationEnvironment,
    WRANGLER_LOG_PATH: wranglerLogDirectory,
    WRANGLER_LOG_SANITIZE: 'true',
    WRANGLER_SEND_ERROR_REPORTS: 'false',
    WRANGLER_SEND_METRICS: 'false',
  };

  console.log(`[deploy] Mode: ${options.mode}`);
  if (options.mode === 'dry-run') {
    runFrontendValidation(validationEnvironment);
    run(
      wranglerBinary,
      ['deploy', '--dry-run', '--config', 'wrangler.jsonc'],
      unauthenticatedWranglerEnvironment,
      'Frontend Worker dry run',
    );
    run(
      wranglerBinary,
      ['triggers', 'deploy', '--dry-run', '--config', 'wrangler.jsonc'],
      unauthenticatedWranglerEnvironment,
      'Frontend trigger dry run',
    );
    return;
  }

  if (options.mode === 'preview') {
    const authenticatedEnvironment: NodeJS.ProcessEnv = {
      ...unauthenticatedWranglerEnvironment,
      CLOUDFLARE_API_TOKEN: readApiToken(options.tokenFile),
    };
    await uploadFrontendCandidate({
      authenticatedEnvironment,
      unauthenticatedEnvironment: unauthenticatedWranglerEnvironment,
      validationEnvironment,
      wranglerLogDirectory,
    });
    return;
  }

  const authenticatedEnvironment: NodeJS.ProcessEnv = {
    ...unauthenticatedWranglerEnvironment,
    CLOUDFLARE_API_TOKEN: readApiToken(options.tokenFile),
  };
  const candidate = await runCompleteFrontendRelease({
    authenticatedEnvironment,
    tokenFile: options.tokenFile,
    unauthenticatedEnvironment: unauthenticatedWranglerEnvironment,
    validationEnvironment,
    versionId: options.versionId,
    wranglerLogDirectory,
  });
  console.log(`[deploy] Frontend production version ${candidate.versionId} deployed, verified, recorded, and committed.`);
}

export const frontendDeployTestHooks = {
  assertCleanProductionWorktree,
  commitFrontendReleaseManifest,
  frontendValidationSteps,
  credentialFreeEnvironment,
  expectedFrontendPreviewOrigin,
  frontendCandidateRecordPath,
  frontendProductionOrigins,
  frontendProductionWranglerCommands,
  isExactFrontendDeploymentConfig,
  isFrontendCandidateRecord,
  readAttachedProductionBranch,
  readCleanSourceCommit,
  readCleanProductionSource,
  readStableReleasePair,
  requireFrontendCandidateRecord,
  resolveFrontendProductionCandidate,
  runCompleteFrontendRelease,
  runFrontendProductionSequence,
  uploadFrontendCandidate,
  writeFrontendCandidateRecord,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = formatCloudflareReleaseError(error);
    const exitCode = cloudflareReleaseExitCode(error);
    console.error(`\n[deploy] ${message}\n`);
    process.exitCode = exitCode;
  });
}
