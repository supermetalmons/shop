import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  benchmarkApi,
  benchmarkApiTestHooks,
  parseApiBenchmarkArgs,
} from '../../../../scripts/benchmark-cloudflare-api.ts';
import { deployApiTestHooks } from '../../../../scripts/deploy-cloudflare-api.ts';
import {
  frontendDeployTestHooks,
  parseFrontendDeployArgs,
  parseFrontendUploadMetadata,
  smokeFrontendOrigin,
} from '../../../../scripts/deploy-cloudflare.ts';
import {
  finalizeReleaseManifest,
  isProductionEvidence,
  parseFinalizeReleaseArgs,
  recordApiProductionVersion,
  recordFrontendProductionVersion,
  writeProductionEvidence,
} from '../../../../scripts/finalize-cloudflare-release.ts';
import {
  CloudflareProcessFailure,
  cloudflareReleaseExitCode,
  formatCloudflareReleaseError,
  guardCloudflareReleaseStart,
  parseCloudflareDeploymentStatus,
  readWranglerDeploymentStatus,
  reconcileCloudflareStableVersion,
  runWranglerForOutput,
  stableCloudflareVersionId,
  wranglerDeploymentStatusTimeoutMs,
  type CloudflareDeploymentStatus,
} from '../../../../scripts/cloudflare-deployment-state.ts';

const OWNER = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const EMPTY_NEW_API_SECRET_ENV = {
  FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON: '',
  ADDRESS_DECRYPTION_SECRET: '',
  SHIPSTATION_API_KEY: '',
  SHIPSTATION_SHIP_FROM: '',
  STRIPE_SECRET_KEY: '',
  STRIPE_RESTRICTED_KEY: '',
  STRIPE_SECRET_KEY_LIVE: '',
  STRIPE_RESTRICTED_KEY_LIVE: '',
};

const SOURCE_BRANCH = 'refs/heads/main';
const SOURCE_COMMIT = 'a'.repeat(40);
const FIRESTORE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  project_id: 'mons-shop',
  client_email: 'mons-shop-cloudflare-reader@mons-shop.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\ntest-key\n-----END PRIVATE KEY-----\n',
});
const FIRESTORE_WRITER_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON = JSON.stringify({
  project_id: 'mons-shop',
  client_email: 'mons-shop-cloudflare-writer@mons-shop.iam.gserviceaccount.com',
  private_key: FIRESTORE_WRITER_PRIVATE_KEY,
});
type DeploymentObservation = CloudflareDeploymentStatus | Error | string;

function stableDeployment(versionId: string): CloudflareDeploymentStatus {
  return {
    id: randomUUID(),
    strategy: 'percentage',
    versions: [{ percentage: 100, versionId: versionId.toLowerCase() }],
  };
}

function deploymentReader(
  observations: readonly DeploymentObservation[],
  events?: string[],
): () => Promise<CloudflareDeploymentStatus> {
  let index = 0;
  return async () => {
    events?.push('deployment-status');
    const observation = observations[Math.min(index, observations.length - 1)];
    index += 1;
    if (observation === undefined) throw new Error('Deployment test fixture had no observation.');
    if (observation instanceof Error) throw observation;
    return typeof observation === 'string' ? stableDeployment(observation) : observation;
  };
}

function splitDeployment(firstVersionId: string, secondVersionId: string): CloudflareDeploymentStatus {
  return {
    id: randomUUID(),
    strategy: 'percentage',
    versions: [
      { percentage: 50, versionId: firstVersionId },
      { percentage: 50, versionId: secondVersionId },
    ],
  };
}

async function verifyFrontendProductionGuards(input: {
  verifyBeforeMutation?: () => Promise<void>;
  verifyBeforePromotion?: () => Promise<void>;
}): Promise<void> {
  await input.verifyBeforeMutation?.();
  await input.verifyBeforePromotion?.();
}

test('release CLI starts under its production TypeScript runner', () => {
  const result = spawnSync(process.execPath, [
    '--import',
    'tsx',
    resolve('scripts/deploy-cloudflare-api.ts'),
    '--help',
  ], {
    cwd: resolve('.'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Release, update, or roll back the mons-shop-api Worker/);
});

test('Wrangler deployment status parsing requires exact percentage state and captures the pinned command', () => {
  const deploymentId = randomUUID();
  const versionId = randomUUID();
  const rawStatus = JSON.stringify({
    id: deploymentId.toUpperCase(),
    strategy: 'percentage',
    versions: [{ percentage: 100, version_id: versionId.toUpperCase() }],
  });
  const environment = deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token');
  let captured: unknown;
  const status = readWranglerDeploymentStatus({
    configArgs: ['--config', 'wrangler.jsonc'],
    cwd: '/repo',
    environment,
    wranglerBinary: '/repo/node_modules/.bin/wrangler',
  }, (command, args, runnerEnvironment, cwd, label, timeoutMs) => {
    captured = { command, args, runnerEnvironment, cwd, label, timeoutMs };
    return rawStatus;
  });
  assert.deepEqual(status, {
    id: deploymentId,
    strategy: 'percentage',
    versions: [{ percentage: 100, versionId }],
  });
  assert.equal(stableCloudflareVersionId(status), versionId);
  assert.deepEqual(captured, {
    command: '/repo/node_modules/.bin/wrangler',
    args: ['deployments', 'status', '--json', '--config', 'wrangler.jsonc'],
    runnerEnvironment: environment,
    cwd: '/repo',
    label: 'Wrangler deployment status',
    timeoutMs: wranglerDeploymentStatusTimeoutMs,
  });
  assert.throws(
    () => stableCloudflareVersionId(splitDeployment(versionId, randomUUID())),
    /not a stable single-version deployment/,
  );
  assert.throws(
    () => stableCloudflareVersionId({
      ...status,
      versions: [{ percentage: 99.999_999, versionId }],
    }),
    /not a stable single-version deployment/,
  );
  assert.throws(
    () => parseCloudflareDeploymentStatus(JSON.stringify({
      id: deploymentId,
      strategy: 'percentage',
      versions: [
        { percentage: 60, version_id: versionId },
        { percentage: 30, version_id: randomUUID() },
      ],
    })),
    /did not total 100/,
  );
  assert.throws(
    () => parseCloudflareDeploymentStatus(JSON.stringify({
      id: deploymentId,
      strategy: 'percentage',
      versions: [{ percentage: 100, version_id: 'latest' }],
    })),
    /was not an exact Cloudflare version UUID/,
  );
  assert.throws(
    () => parseCloudflareDeploymentStatus(JSON.stringify({
      id: deploymentId,
      strategy: 'percentage',
      versions: [
        { percentage: 50, version_id: versionId },
        { percentage: 50, version_id: versionId.toUpperCase() },
      ],
    })),
    /repeated a version ID/,
  );
  assert.throws(() => parseCloudflareDeploymentStatus('not json'), /did not return valid JSON/);
});

test('Wrangler deployment status subprocesses are killed and classified after their deadline', () => {
  const timeoutError = Object.assign(new Error('spawnSync timed out'), { code: 'ETIMEDOUT' });
  const environment = { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV };
  let capturedOptions: unknown;
  assert.throws(
    () => runWranglerForOutput(
      '/repo/node_modules/.bin/wrangler',
      ['deployments', 'status', '--json'],
      environment,
      '/repo',
      'Wrangler deployment status',
      25,
      (_command, _args, options) => {
        capturedOptions = options;
        return { error: timeoutError, signal: 'SIGKILL', status: null, stdout: '' };
      },
    ),
    (error) => error instanceof CloudflareProcessFailure &&
      error.message === 'Wrangler deployment status timed out after 25ms.' &&
      error.cause === timeoutError,
  );
  assert.deepEqual(capturedOptions, {
    cwd: '/repo',
    encoding: 'utf8',
    env: environment,
    killSignal: 'SIGKILL',
    shell: false,
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 25,
  });
});

test('release start permits only tracked baseline or requested-candidate guarded resume', () => {
  const baselineVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  assert.deepEqual(guardCloudflareReleaseStart({
    candidateVersionId,
    expectedCurrentVersionId: baselineVersionId,
    liveVersionId: baselineVersionId,
    workerLabel: 'test-worker',
  }), { baselineVersionId, resumeCandidate: false });
  assert.deepEqual(guardCloudflareReleaseStart({
    candidateVersionId,
    expectedCurrentVersionId: baselineVersionId,
    liveVersionId: candidateVersionId,
    workerLabel: 'test-worker',
  }), { baselineVersionId, resumeCandidate: true });
  assert.deepEqual(guardCloudflareReleaseStart({
    candidateVersionId,
    expectedCurrentVersionId: candidateVersionId,
    liveVersionId: candidateVersionId,
    workerLabel: 'test-worker',
  }), { baselineVersionId: candidateVersionId, resumeCandidate: true });
  assert.throws(
    () => guardCloudflareReleaseStart({
      candidateVersionId,
      expectedCurrentVersionId: baselineVersionId,
      liveVersionId: randomUUID(),
      workerLabel: 'test-worker',
    }),
    /matched neither tracked production nor requested candidate|matched neither tracked production/,
  );
});

test('bounded status reconciliation is strict for untouched-baseline decisions and tolerant before preferred success', async () => {
  const baselineVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const strictSleeps: number[] = [];
  await assert.rejects(
    () => reconcileCloudflareStableVersion({
      allowedPendingVersionIds: [baselineVersionId],
      preferredVersionId: candidateVersionId,
      read: deploymentReader([
        baselineVersionId,
        new Error('transient status failure'),
        baselineVersionId,
        baselineVersionId,
      ]),
      requireAllPendingObservations: true,
      sleep: async (milliseconds) => {
        strictSleeps.push(milliseconds);
      },
      workerLabel: 'test-worker',
    }),
    /could not be read after bounded retries/,
  );
  assert.deepEqual(strictSleeps, [500, 1_500, 3_000]);

  const preferredSleeps: number[] = [];
  assert.equal(await reconcileCloudflareStableVersion({
    allowedPendingVersionIds: [baselineVersionId],
    preferredVersionId: candidateVersionId,
    read: deploymentReader([new Error('transient status failure'), candidateVersionId]),
    sleep: async (milliseconds) => {
      preferredSleeps.push(milliseconds);
    },
    workerLabel: 'test-worker',
  }), candidateVersionId);
  assert.deepEqual(preferredSleeps, [500]);
});

test('release diagnostics recurse through aggregates and causes and retain nested process exit codes', () => {
  const processFailure = new CloudflareProcessFailure('Wrangler failed with exit code 17.', 17);
  const wrapped = new Error('promotion wrapper', { cause: processFailure });
  const releaseError = new AggregateError([new Error('smoke failed'), wrapped], 'release failed');
  assert.equal(cloudflareReleaseExitCode(releaseError), 17);
  assert.match(formatCloudflareReleaseError(releaseError), /release failed[\s\S]*1\. smoke failed[\s\S]*2\. promotion wrapper[\s\S]*Caused by: Wrangler failed with exit code 17/);
});

test('standalone benchmark requires an explicit HTTPS API origin and a valid owner', () => {
  assert.throws(() => parseApiBenchmarkArgs(['--owner', OWNER]), /--api-origin is required/);
  assert.throws(
    () => parseApiBenchmarkArgs(['--api-origin', 'http://api.mons.shop', '--owner', OWNER]),
    /HTTPS origin/,
  );
  assert.throws(
    () => parseApiBenchmarkArgs(['--api-origin', 'https://api.mons.shop', '--owner', 'invalid']),
    /valid 32-byte Solana address/,
  );
  assert.deepEqual(
    parseApiBenchmarkArgs(['--api-origin', 'https://api.mons.shop/', '--owner', OWNER, '--runs', '5']),
    { apiOrigin: 'https://api.mons.shop', includeDevnet: false, owner: OWNER, runs: 5 },
  );
  assert.deepEqual(
    parseApiBenchmarkArgs(['--include-devnet', '--api-origin', 'https://api.mons.shop', '--owner', OWNER]),
    { apiOrigin: 'https://api.mons.shop', includeDevnet: true, owner: OWNER, runs: 5 },
  );
});

test('candidate promotion evidence is exact, version-keyed, and owner-bound', () => {
  const versionId = randomUUID();
  const path = deployApiTestHooks.candidateRecordPath(versionId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const record = {
    includeDevnet: true,
    workerName: 'mons-shop-api',
    versionId,
    previewUrl: deployApiTestHooks.expectedPreviewOrigin(versionId),
    smokeOwner: OWNER,
    testedAt: new Date().toISOString(),
    runs: 5,
    workerMedianMs: 10,
    legacyMedianMs: 20,
  };
  try {
    writeFileSync(path, JSON.stringify(record), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    assert.equal(deployApiTestHooks.isCandidateRecord(record), true);
    assert.equal(deployApiTestHooks.isCandidateRecord({ ...record, testedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString() }), false);
    assert.equal(deployApiTestHooks.isCandidateRecord({ ...record, previewUrl: 'https://candidate-mons-shop-api.lil-org.workers.dev' }), false);
    assert.equal(deployApiTestHooks.requireCandidateRecord(versionId, OWNER).versionId, versionId);
    assert.throws(
      () => deployApiTestHooks.requireCandidateRecord(versionId, '11111111111111111111111111111111'),
      /does not match/,
    );
    assert.throws(
      () => deployApiTestHooks.requireCandidateRecord(randomUUID(), OWNER),
      /requires the local candidate record/,
    );
  } finally {
    rmSync(path, { force: true });
  }
});

test('Wrangler upload metadata parsing requires the exact Worker and preview host', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mons-shop-api-release-test-'));
  const path = join(directory, 'upload.jsonl');
  const versionId = randomUUID();
  try {
    writeFileSync(path, `${JSON.stringify({
      type: 'version-upload',
      worker_name: 'mons-shop-api',
      version_id: versionId,
      preview_url: deployApiTestHooks.expectedPreviewOrigin(versionId),
    })}\n`, { encoding: 'utf8', mode: 0o600 });
    assert.deepEqual(deployApiTestHooks.parseUploadMetadata(path), {
      versionId,
      previewUrl: deployApiTestHooks.expectedPreviewOrigin(versionId),
    });
    writeFileSync(path, JSON.stringify({
      type: 'version-upload',
      worker_name: 'mons-shop',
      version_id: versionId,
      preview_url: 'https://candidate-mons-shop.lil-org.workers.dev',
    }));
    assert.throws(() => deployApiTestHooks.parseUploadMetadata(path), /valid uploaded Worker version/);
    writeFileSync(path, JSON.stringify({
      type: 'version-upload',
      worker_name: 'mons-shop-api',
      version_id: versionId,
      preview_url: 'https://candidate-mons-shop-api.lil-org.workers.dev',
    }));
    assert.throws(() => deployApiTestHooks.parseUploadMetadata(path), /unexpected version preview URL/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('frontend Wrangler metadata parsing requires the exact upload, Worker, and version preview', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mons-shop-frontend-release-test-'));
  const path = join(directory, 'upload.jsonl');
  const versionId = randomUUID();
  try {
    writeFileSync(path, `${JSON.stringify({
      type: 'version-upload',
      worker_name: 'mons-shop',
      version_id: versionId,
      preview_url: frontendDeployTestHooks.expectedFrontendPreviewOrigin(versionId),
    })}\n`, { encoding: 'utf8', mode: 0o600 });
    assert.deepEqual(parseFrontendUploadMetadata(path), {
      versionId,
      previewUrl: frontendDeployTestHooks.expectedFrontendPreviewOrigin(versionId),
    });
    writeFileSync(path, JSON.stringify({
      type: 'version-upload',
      worker_name: 'mons-shop-api',
      version_id: versionId,
      preview_url: frontendDeployTestHooks.expectedFrontendPreviewOrigin(versionId),
    }));
    assert.throws(() => parseFrontendUploadMetadata(path), /valid uploaded version/);
    writeFileSync(path, JSON.stringify({
      type: 'version-upload',
      worker_name: 'mons-shop',
      version_id: versionId,
      preview_url: 'https://candidate-mons-shop.lil-org.workers.dev',
    }));
    assert.throws(() => parseFrontendUploadMetadata(path), /unexpected frontend Version Preview URL/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('frontend production supports one-step release and exact version-keyed recovery evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mons-shop-frontend-candidate-test-'));
  const versionId = randomUUID();
  const now = new Date('2026-08-10T12:34:56.000Z');
  const metadata = {
    versionId,
    previewUrl: frontendDeployTestHooks.expectedFrontendPreviewOrigin(versionId),
    htmlSha256: 'a'.repeat(64),
    sourceCommit: SOURCE_COMMIT,
  };
  try {
    assert.deepEqual(
      parseFrontendDeployArgs(['production', '--version-id', versionId, '--token-file', '/tmp/token']),
      { mode: 'production', versionId, tokenFile: '/tmp/token' },
    );
    assert.deepEqual(
      parseFrontendDeployArgs(['production', '--token-file', '/tmp/token']),
      { mode: 'production', versionId: undefined, tokenFile: '/tmp/token' },
    );
    assert.throws(
      () => parseFrontendDeployArgs(['preview', '--version-id', versionId]),
      /only valid for production/,
    );
    const record = frontendDeployTestHooks.writeFrontendCandidateRecord(metadata, { directory, now });
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(
      statSync(frontendDeployTestHooks.frontendCandidateRecordPath(versionId, directory)).mode & 0o777,
      0o600,
    );
    assert.equal(frontendDeployTestHooks.isFrontendCandidateRecord(record, now), true);
    assert.equal(
      frontendDeployTestHooks.requireFrontendCandidateRecord(versionId, { directory, now }).versionId,
      versionId,
    );
    assert.throws(
      () => frontendDeployTestHooks.requireFrontendCandidateRecord(randomUUID(), { directory, now }),
      /requires fresh candidate evidence/,
    );
    assert.throws(
      () => frontendDeployTestHooks.requireFrontendCandidateRecord(versionId, {
        directory,
        now: new Date(now.getTime() + 7 * 60 * 60 * 1000),
      }),
      /invalid or stale/,
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('frontend release manifest commit includes only the tracked manifest', () => {
  const versionId = randomUUID();
  const source = { branch: SOURCE_BRANCH, commit: SOURCE_COMMIT };
  let invocation: {
    command: string;
    args: string[];
    label: string;
  } | undefined;
  frontendDeployTestHooks.commitFrontendReleaseManifest(
    versionId.toUpperCase(),
    source,
    (command, args, _environment, label) => {
      invocation = { command, args, label };
    },
    () => source,
  );
  assert.deepEqual(invocation, {
    command: 'git',
    args: [
      'commit',
      '--only',
      '-m',
      `release frontend ${versionId}`,
      '--',
      'cloud/release-manifest.json',
    ],
    label: 'Release manifest commit',
  });
  assert.throws(
    () => frontendDeployTestHooks.commitFrontendReleaseManifest(
      versionId,
      source,
      () => assert.fail('source drift reached Git commit'),
      () => ({ branch: 'refs/heads/release', commit: SOURCE_COMMIT }),
    ),
    /Git position changed before the release manifest commit/,
  );
});

test('frontend production requires a clean Git worktree and attached branch', () => {
  assert.doesNotThrow(() => frontendDeployTestHooks.assertCleanProductionWorktree(
    () => ({ output: '', status: 0 }),
  ));
  for (const output of [' M src/App.tsx', 'M  src/App.tsx', '?? src/new.ts']) {
    assert.throws(
      () => frontendDeployTestHooks.assertCleanProductionWorktree(
        () => ({ output, status: 0 }),
      ),
      /requires a clean Git worktree/,
    );
  }
  assert.throws(
    () => frontendDeployTestHooks.assertCleanProductionWorktree(
      () => ({ error: new Error('missing git'), output: '', status: null }),
    ),
    /could not start/,
  );
  assert.throws(
    () => frontendDeployTestHooks.assertCleanProductionWorktree(
      () => ({ output: '', status: 128 }),
    ),
    /failed with exit code 128/,
  );
  assert.equal(
    frontendDeployTestHooks.readCleanSourceCommit(
      () => ({ output: '', status: 0 }),
      () => ({ output: SOURCE_COMMIT.toUpperCase(), status: 0 }),
    ),
    SOURCE_COMMIT,
  );
  assert.equal(
    frontendDeployTestHooks.readAttachedProductionBranch(
      () => ({ output: `${SOURCE_BRANCH}\n`, status: 0 }),
    ),
    SOURCE_BRANCH,
  );
  assert.deepEqual(
    frontendDeployTestHooks.readCleanProductionSource(
      () => ({ output: `${SOURCE_BRANCH}\n`, status: 0 }),
      () => ({ output: '', status: 0 }),
      () => ({ output: SOURCE_COMMIT, status: 0 }),
    ),
    { branch: SOURCE_BRANCH, commit: SOURCE_COMMIT },
  );
  assert.throws(
    () => frontendDeployTestHooks.readCleanProductionSource(
      () => ({ output: '', status: 1 }),
      () => ({ output: '', status: 0 }),
      () => ({ output: SOURCE_COMMIT, status: 0 }),
    ),
    /requires an attached Git branch/,
  );
});

test('frontend candidate upload validates, dry-runs triggers, uploads, smokes, records, and cleans output', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mons-shop-frontend-upload-test-'));
  const versionId = randomUUID();
  const previewUrl = frontendDeployTestHooks.expectedFrontendPreviewOrigin(versionId);
  const htmlSha256 = 'a'.repeat(64);
  const events: string[] = [];
  try {
    const candidate = await frontendDeployTestHooks.uploadFrontendCandidate({
      authenticatedEnvironment: { CLOUDFLARE_API_TOKEN: 'scoped-token', HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
      unauthenticatedEnvironment: { CLOUDFLARE_API_TOKEN: '', HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
      validationEnvironment: { CI: 'true', HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
      wranglerLogDirectory: directory,
    }, {
      run: (_command, args, environment, label) => {
        events.push(label);
        if (label === 'Frontend trigger dry run') {
          assert.deepEqual(args, ['triggers', 'deploy', '--dry-run', '--config', 'wrangler.jsonc']);
          assert.equal(environment.CLOUDFLARE_API_TOKEN, '');
          return;
        }
        assert.equal(label, 'Frontend version upload');
        assert.deepEqual(args, ['versions', 'upload', '--preview-alias', 'candidate', '--config', 'wrangler.jsonc']);
        assert.equal(environment.CLOUDFLARE_API_TOKEN, 'scoped-token');
        const outputPath = environment.WRANGLER_OUTPUT_FILE_PATH;
        assert.equal(typeof outputPath, 'string');
        writeFileSync(outputPath!, JSON.stringify({
          type: 'version-upload',
          worker_name: 'mons-shop',
          version_id: versionId,
          preview_url: previewUrl,
        }));
      },
      smoke: async (origin) => {
        events.push('preview-smoke');
        assert.equal(origin, previewUrl);
        return htmlSha256;
      },
      sourceCommit: () => {
        events.push('source-commit');
        return SOURCE_COMMIT;
      },
      validate: (environment) => {
        events.push('validation');
        assert.equal(environment.CI, 'true');
      },
      writeCandidate: (metadata) => {
        events.push('candidate-evidence');
        assert.deepEqual(metadata, { versionId, previewUrl, htmlSha256, sourceCommit: SOURCE_COMMIT });
        return {
          ...metadata,
          workerName: 'mons-shop',
          testedAt: new Date().toISOString(),
        };
      },
    });
    assert.deepEqual(candidate, { versionId, previewUrl, htmlSha256 });
    assert.deepEqual(events, [
      'source-commit',
      'validation',
      'Frontend trigger dry run',
      'source-commit',
      'Frontend version upload',
      'preview-smoke',
      'candidate-evidence',
    ]);
    assert.deepEqual(readdirSync(directory), []);
    let uploadReached = false;
    await assert.rejects(
      () => frontendDeployTestHooks.uploadFrontendCandidate({
        authenticatedEnvironment: { CLOUDFLARE_API_TOKEN: 'scoped-token', HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        sourceCommit: SOURCE_COMMIT,
        unauthenticatedEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        validationEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        wranglerLogDirectory: directory,
      }, {
        run: (_command, _args, _environment, label) => {
          if (label === 'Frontend trigger dry run') return;
          uploadReached = true;
        },
        smoke: async () => assert.fail('source drift reached preview smoke'),
        sourceCommit: () => 'b'.repeat(40),
        validate: () => {},
        writeCandidate: () => assert.fail('source drift wrote candidate evidence'),
      }),
      /Frontend source changed during validation/,
    );
    assert.equal(uploadReached, false);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('frontend production capability check requires the profile-state API contract', async () => {
  let request: RequestInit | undefined;
  await frontendDeployTestHooks.smokeProfileStateApi({
    fetch: async (input, init) => {
      assert.equal(String(input), 'https://api.mons.shop/profile/state');
      request = init;
      return Response.json({
        ok: false,
        error: { code: 'unauthenticated', message: 'Authentication is required.' },
      }, {
        status: 401,
        headers: {
          'Access-Control-Allow-Origin': 'https://mons.shop',
          'Cache-Control': 'no-store',
        },
      });
    },
  });
  assert.equal(request?.method, 'POST');
  assert.equal(request?.body, '{}');
  await assert.rejects(
    () => frontendDeployTestHooks.smokeProfileStateApi({
      fetch: async () => Response.json({ ok: false, error: 'not-found' }, { status: 404 }),
    }),
    /incompatible response/,
  );
});

test('API production candidate resolution permits cache-free resume only for the exact live version', async () => {
  const baselineVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const wranglerEnvironment = deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token');
  const input = {
    expectedCurrentVersionId: baselineVersionId,
    smokeOwner: OWNER,
    versionId: candidateVersionId,
    wranglerEnvironment,
  };

  assert.equal(
    await deployApiTestHooks.resolveApiProductionPreviewUrl(input, {
      deployment: deploymentReader([candidateVersionId]),
      readCandidate: () => undefined,
    }),
    deployApiTestHooks.expectedPreviewOrigin(candidateVersionId),
  );
  await assert.rejects(
    () => deployApiTestHooks.resolveApiProductionPreviewUrl(input, {
      deployment: deploymentReader([baselineVersionId]),
      readCandidate: () => undefined,
    }),
    /requires a fresh local candidate record/,
  );
  await assert.rejects(
    () => deployApiTestHooks.resolveApiProductionPreviewUrl(input, {
      deployment: deploymentReader([splitDeployment(baselineVersionId, candidateVersionId)]),
      readCandidate: () => undefined,
    }),
    /not a stable single-version deployment/,
  );
});

test('frontend production candidate resolution requires source-bound local evidence', async () => {
  const baselineVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const wranglerEnvironment = deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token');
  const input = {
    expectedCurrentVersionId: baselineVersionId,
    versionId: candidateVersionId,
    wranglerEnvironment,
  };

  assert.deepEqual(
    await frontendDeployTestHooks.resolveFrontendProductionCandidate(input, {
      readCandidate: () => ({
        htmlSha256: 'b'.repeat(64),
        previewUrl: frontendDeployTestHooks.expectedFrontendPreviewOrigin(candidateVersionId),
        sourceCommit: SOURCE_COMMIT,
        testedAt: new Date().toISOString(),
        versionId: candidateVersionId,
        workerName: 'mons-shop',
      }),
    }),
    {
      previewUrl: frontendDeployTestHooks.expectedFrontendPreviewOrigin(candidateVersionId),
      recordedHtmlSha256: 'b'.repeat(64),
      sourceCommit: SOURCE_COMMIT,
    },
  );
  await assert.rejects(
    () => frontendDeployTestHooks.resolveFrontendProductionCandidate(input, {
      readCandidate: () => undefined,
    }),
    /requires source-bound candidate evidence/,
  );
});

test('frontend deployment validates exact Worker and custom-domain targets before mutation', () => {
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8')) as Record<string, unknown>;
  assert.equal(frontendDeployTestHooks.isExactFrontendDeploymentConfig(config), true);
  assert.equal(
    frontendDeployTestHooks.isExactFrontendDeploymentConfig({ ...config, name: 'mons-shop-api' }),
    false,
  );
  assert.equal(
    frontendDeployTestHooks.isExactFrontendDeploymentConfig({
      ...config,
      routes: [
        ...(config.routes as unknown[]),
        { pattern: 'unexpected.mons.shop', custom_domain: true },
      ],
    }),
    false,
  );
  assert.equal(
    frontendDeployTestHooks.isExactFrontendDeploymentConfig({
      ...config,
      routes: [{ pattern: 'mons.shop', custom_domain: true }],
    }),
    false,
  );
});

test('API deployment validates exact Worker and custom-domain targets before mutation', () => {
  const config = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8')) as Record<string, unknown>;
  assert.equal(deployApiTestHooks.isExactApiDeploymentConfig(config), true);
  assert.equal(
    deployApiTestHooks.isExactApiDeploymentConfig({ ...config, account_id: randomUUID() }),
    false,
  );
  assert.equal(
    deployApiTestHooks.isExactApiDeploymentConfig({ ...config, ratelimits: [] }),
    false,
  );
  assert.equal(
    deployApiTestHooks.isExactApiDeploymentConfig({
      ...config,
      queues: { producers: [{ binding: 'NOTIFICATION_EMAIL_QUEUE', queue: 'unexpected-queue' }] },
    }),
    false,
  );
  assert.equal(
    deployApiTestHooks.isExactApiDeploymentConfig({
      ...config,
      routes: [
        ...(config.routes as unknown[]),
        { pattern: 'unexpected.mons.shop', custom_domain: true },
      ],
    }),
    false,
  );
  assert.equal(
    deployApiTestHooks.isExactApiDeploymentConfig({
      ...config,
      routes: [{ pattern: 'api.mons.shop', custom_domain: true, zone_name: 'mons.shop' }],
    }),
    false,
  );
});

test('frontend production deploys reviewed triggers before exact promotion', () => {
  const versionId = randomUUID();
  assert.deepEqual(frontendDeployTestHooks.frontendProductionWranglerCommands(versionId), [
    {
      label: 'Frontend trigger deployment',
      args: ['triggers', 'deploy', '--config', 'wrangler.jsonc'],
    },
    {
      label: 'Frontend exact-version promotion',
      args: [
        'versions', 'deploy', '--version-id', versionId, '--percentage', '100', '--yes',
        '--config', 'wrangler.jsonc',
      ],
    },
  ]);
  assert.deepEqual(frontendDeployTestHooks.frontendProductionOrigins, [
    'https://mons.shop',
    'https://www.mons.shop',
  ]);
});

test('frontend production reconciles exact state and retries hash propagation before evidence', async () => {
  const baselineVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const candidateHtmlSha256 = 'a'.repeat(64);
  const wranglerEnvironment = deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token');
  const events: string[] = [];
  const sleeps: number[] = [];
  let smokeCalls = 0;

  await frontendDeployTestHooks.runFrontendProductionSequence(
    {
      candidateHtmlSha256,
      expectedCurrentVersionId: baselineVersionId,
      verifyBeforeMutation: async () => {
        events.push('mutation-guard');
      },
      versionId: candidateVersionId,
      wranglerEnvironment,
    },
    {
      deployment: deploymentReader([
        baselineVersionId,
        baselineVersionId,
        candidateVersionId,
        candidateVersionId,
      ], events),
      run: (_command, args, environment, label) => {
        assert.equal(environment, wranglerEnvironment);
        events.push(label);
        if (label === 'Frontend trigger deployment') {
          assert.deepEqual(args, ['triggers', 'deploy', '--config', 'wrangler.jsonc']);
        }
        if (label === 'Frontend exact-version promotion') {
          assert.deepEqual(args.slice(0, 7), [
            'versions', 'deploy', '--version-id', candidateVersionId, '--percentage', '100', '--yes',
          ]);
        }
      },
      smoke: async (origin) => {
        smokeCalls += 1;
        events.push(`smoke:${origin}`);
        if (smokeCalls >= 3 && smokeCalls <= 6) return 'b'.repeat(64);
        return candidateHtmlSha256;
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      evidence: (kind, versionId) => {
        assert.equal(kind, 'frontend');
        assert.equal(versionId, candidateVersionId);
        events.push('evidence');
        return {
          schemaVersion: 1,
          kind: 'frontend',
          workerName: 'mons-shop',
          versionId,
          verifiedAt: new Date().toISOString(),
        };
      },
    },
  );
  assert.deepEqual(sleeps, [500, 1_500, 3_000, 5_000]);
  assert.deepEqual(events, [
    'deployment-status',
    'mutation-guard',
    'Frontend trigger deployment',
    'smoke:https://mons.shop',
    'smoke:https://www.mons.shop',
    'deployment-status',
    'Frontend exact-version promotion',
    'deployment-status',
    'smoke:https://mons.shop',
    'smoke:https://mons.shop',
    'smoke:https://mons.shop',
    'smoke:https://mons.shop',
    'smoke:https://mons.shop',
    'smoke:https://www.mons.shop',
    'deployment-status',
    'evidence',
  ]);
});

test('frontend trigger deployment gets exactly one declarative retry before promotion', async () => {
  const baselineVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const labels: string[] = [];
  let triggerAttempts = 0;

  await frontendDeployTestHooks.runFrontendProductionSequence(
    {
      candidateHtmlSha256: 'a'.repeat(64),
      expectedCurrentVersionId: baselineVersionId,
      versionId: candidateVersionId,
      wranglerEnvironment: deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token'),
    },
    {
      deployment: deploymentReader([
        baselineVersionId,
        baselineVersionId,
        candidateVersionId,
        candidateVersionId,
      ]),
      run: (_command, _args, _environment, label) => {
        labels.push(label);
        if (label.startsWith('Frontend trigger deployment')) {
          triggerAttempts += 1;
          if (triggerAttempts === 1) throw new Error('transient trigger failure');
        }
      },
      smoke: async () => 'a'.repeat(64),
      sleep: async () => undefined,
      evidence: (_kind, versionId) => ({
        schemaVersion: 1,
        kind: 'frontend',
        workerName: 'mons-shop',
        versionId,
        verifiedAt: new Date().toISOString(),
      }),
    },
  );
  assert.deepEqual(labels, [
    'Frontend trigger deployment',
    'Frontend trigger deployment retry',
    'Frontend exact-version promotion',
  ]);
});

test('frontend guarded resume never rolls back when its trigger retry fails', async () => {
  const baselineVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const labels: string[] = [];

  await assert.rejects(
    () => frontendDeployTestHooks.runFrontendProductionSequence(
      {
        candidateHtmlSha256: 'a'.repeat(64),
        expectedCurrentVersionId: baselineVersionId,
        versionId: candidateVersionId,
        wranglerEnvironment: deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token'),
      },
      {
        deployment: deploymentReader([candidateVersionId]),
        run: (_command, _args, _environment, label) => {
          labels.push(label);
          if (label === 'Frontend compensating rollback') assert.fail('guarded resume attempted rollback');
          throw new Error('injected trigger failure');
        },
        smoke: async () => assert.fail('guarded resume smoked after failed triggers'),
        sleep: async () => undefined,
        evidence: () => assert.fail('guarded resume wrote evidence after failed triggers'),
      },
    ),
    /already live[\s\S]*Automatic rollback was suppressed/,
  );
  assert.deepEqual(labels, ['Frontend trigger deployment', 'Frontend trigger deployment retry']);
});

test('frontend guarded resume never rolls back when candidate verification fails', async () => {
  const candidateVersionId = randomUUID();
  const labels: string[] = [];

  await assert.rejects(
    () => frontendDeployTestHooks.runFrontendProductionSequence(
      {
        candidateHtmlSha256: 'a'.repeat(64),
        expectedCurrentVersionId: candidateVersionId,
        versionId: candidateVersionId,
        wranglerEnvironment: deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token'),
      },
      {
        deployment: deploymentReader([candidateVersionId]),
        run: (_command, _args, _environment, label) => {
          labels.push(label);
          if (label === 'Frontend compensating rollback') assert.fail('guarded resume attempted rollback');
        },
        smoke: async () => {
          throw new Error('injected candidate smoke failure');
        },
        sleep: async () => undefined,
        evidence: () => assert.fail('guarded resume wrote evidence after failed smoke'),
      },
    ),
    /already live[\s\S]*Automatic rollback was suppressed/,
  );
  assert.deepEqual(labels, ['Frontend trigger deployment']);
});

test('frontend recovery rechecks the candidate immediately before exact rollback', async () => {
  const baselineVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const promotionError = new Error('injected frontend promotion failure');
  const labels: string[] = [];
  const statusEvents: string[] = [];

  await assert.rejects(
    () => frontendDeployTestHooks.runFrontendProductionSequence(
      {
        candidateHtmlSha256: 'a'.repeat(64),
        expectedCurrentVersionId: baselineVersionId,
        versionId: candidateVersionId,
        wranglerEnvironment: deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token'),
      },
      {
        deployment: deploymentReader([
          baselineVersionId,
          baselineVersionId,
          candidateVersionId,
          candidateVersionId,
          candidateVersionId,
          baselineVersionId,
          baselineVersionId,
        ], statusEvents),
        run: (_command, args, _environment, label) => {
          labels.push(label);
          if (label === 'Frontend exact-version promotion') throw promotionError;
          if (label === 'Frontend compensating rollback') {
            assert.equal(statusEvents.length, 5);
            assert.deepEqual(args.slice(0, 2), ['rollback', baselineVersionId]);
          }
        },
        smoke: async () => 'a'.repeat(64),
        sleep: async () => undefined,
        evidence: () => assert.fail('frontend recovery wrote production evidence'),
      },
    ),
    (error) => error === promotionError,
  );
  assert.equal(statusEvents.length, 7);
  assert.deepEqual(labels, [
    'Frontend trigger deployment',
    'Frontend exact-version promotion',
    'Frontend compensating rollback',
  ]);
});

test('frontend recovery refuses rollback when the candidate guard observes concurrent drift', async () => {
  const baselineVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const concurrentVersionId = randomUUID();
  const labels: string[] = [];

  await assert.rejects(
    () => frontendDeployTestHooks.runFrontendProductionSequence(
      {
        candidateHtmlSha256: 'a'.repeat(64),
        expectedCurrentVersionId: baselineVersionId,
        versionId: candidateVersionId,
        wranglerEnvironment: deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token'),
      },
      {
        deployment: deploymentReader([
          baselineVersionId,
          baselineVersionId,
          candidateVersionId,
          candidateVersionId,
          concurrentVersionId,
        ]),
        run: (_command, _args, _environment, label) => {
          labels.push(label);
          if (label === 'Frontend exact-version promotion') {
            throw new Error('injected frontend promotion failure');
          }
          if (label === 'Frontend compensating rollback') assert.fail('concurrent drift was overwritten');
        },
        smoke: async () => 'a'.repeat(64),
        sleep: async () => undefined,
        evidence: () => assert.fail('concurrent release wrote production evidence'),
      },
    ),
    /candidate changed after reconciliation; automatic rollback was suppressed/,
  );
  assert.deepEqual(labels, ['Frontend trigger deployment', 'Frontend exact-version promotion']);
});

test('frontend evidence failure leaves the verified candidate live for guarded resume', async () => {
  const baselineVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const labels: string[] = [];

  await assert.rejects(
    () => frontendDeployTestHooks.runFrontendProductionSequence(
      {
        candidateHtmlSha256: 'a'.repeat(64),
        expectedCurrentVersionId: baselineVersionId,
        versionId: candidateVersionId,
        wranglerEnvironment: deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token'),
      },
      {
        deployment: deploymentReader([candidateVersionId, candidateVersionId]),
        run: (_command, _args, _environment, label) => {
          labels.push(label);
          if (label.includes('rollback') || label.includes('promotion')) {
            assert.fail('guarded evidence retry mutated the live version');
          }
        },
        smoke: async () => 'a'.repeat(64),
        sleep: async () => undefined,
        evidence: () => {
          throw new Error('injected evidence failure');
        },
      },
    ),
    /remains live and verified[\s\S]*rerun the same production command[\s\S]*guarded resume/,
  );
  assert.deepEqual(labels, ['Frontend trigger deployment']);
});

test('API startup profiling passes the nested Worker config through Wrangler build args', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts?.['startup:api'],
    'node -e "require(\'fs\').mkdirSync(\'.cache\',{recursive:true})" && ' +
      'wrangler check startup --args="--config cloud/workers/api/wrangler.jsonc ' +
      '--env-file cloud/workers/api/release.env" --outfile .cache/mons-shop-api-startup.cpuprofile',
  );
});

test('frontend smoke requires the expected production HTML', async () => {
  const calls: string[] = [];
  const html = [
    '<!doctype html><title>mons.shop</title>',
    '<script type="module" src="/assets/index-test.js"></script>',
    '<link rel="stylesheet" href="/assets/index-test.css">',
    '<div id="root"></div>',
  ].join('');
  const htmlSha256 = await smokeFrontendOrigin('https://preview.example', {
    fetch: async (input) => {
      calls.push(String(input));
      if (String(input).endsWith('.js')) {
        return new Response('export {};', {
          status: 200,
          headers: { 'content-type': 'application/javascript' },
        });
      }
      if (String(input).endsWith('.css')) {
        return new Response('body {}', {
          status: 200,
          headers: { 'content-type': 'text/css' },
        });
      }
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
    sleep: async () => undefined,
  });
  assert.deepEqual(calls, [
    'https://preview.example/',
    'https://preview.example/assets/index-test.js',
    'https://preview.example/assets/index-test.css',
  ]);
  assert.match(htmlSha256, /^[0-9a-f]{64}$/);
  await assert.rejects(
    () => smokeFrontendOrigin('https://preview.example', {
      fetch: async () => new Response('<title>another site</title>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
      sleep: async () => undefined,
    }),
    /unexpected HTML/,
  );
  await assert.rejects(
    () => smokeFrontendOrigin('https://preview.example', {
      fetch: async (input) => String(input).endsWith('.js')
        ? new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })
        : new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
      sleep: async () => undefined,
    }),
    /unexpected content type/,
  );
});

test('validation environments exclude deployment and provider credentials', () => {
  const source = {
    PATH: '/bin',
    CLOUDFLARE_API_TOKEN: 'cloudflare-secret',
    CF_API_TOKEN: 'cloudflare-secret-two',
    HELIUS_API_KEY: 'helius-secret',
    RESEND_CONTACTS_API_KEY: '',
    NOTIFICATION_ENQUEUE_SECRET: 'notification-enqueue-secret',
    FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV,
    ADDRESS_DECRYPTION_SECRET: '',
    SHIPSTATION_API_KEY: '',
    SHIPSTATION_SHIP_FROM: '',
    STRIPE_SECRET_KEY: '',
    STRIPE_RESTRICTED_KEY: '',
    STRIPE_SECRET_KEY_LIVE: '',
    STRIPE_RESTRICTED_KEY_LIVE: '',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/google-credentials.json',
    VITE_HELIUS_API_KEY: 'vite-helius-secret',
    WRANGLER_OUTPUT_FILE_PATH: '/tmp/output',
    DOTENV_KEY: 'dotenv-secret',
  };
  const validation = deployApiTestHooks.validationEnvironment(source);
  assert.equal(validation.PATH, '/bin');
  assert.equal(validation.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(validation.CF_API_TOKEN, undefined);
  assert.equal(validation.HELIUS_API_KEY, undefined);
  assert.equal(validation.RESEND_CONTACTS_API_KEY, undefined);
  assert.equal(validation.NOTIFICATION_ENQUEUE_SECRET, undefined);
  assert.equal(validation.FIRESTORE_SERVICE_ACCOUNT_JSON, undefined);
  assert.equal(validation.FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON, undefined);
  assert.equal(validation.SHIPSTATION_API_KEY, undefined);
  assert.equal(validation.SHIPSTATION_SHIP_FROM, undefined);
  assert.equal(validation.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(validation.VITE_HELIUS_API_KEY, undefined);
  assert.equal(validation.WRANGLER_OUTPUT_FILE_PATH, undefined);
  assert.equal(validation.DOTENV_KEY, undefined);
  let childEnvironment: NodeJS.ProcessEnv | undefined;
  deployApiTestHooks.runApiValidation(source, (_command, args, environment) => {
    assert.deepEqual(args, ['run', 'check:api']);
    childEnvironment = environment;
  });
  assert.equal(childEnvironment?.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(childEnvironment?.HELIUS_API_KEY, undefined);
  assert.equal(childEnvironment?.RESEND_CONTACTS_API_KEY, undefined);
  assert.equal(childEnvironment?.NOTIFICATION_ENQUEUE_SECRET, undefined);
  assert.equal(childEnvironment?.FIRESTORE_SERVICE_ACCOUNT_JSON, undefined);
  assert.equal(childEnvironment?.FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON, undefined);
  assert.equal(childEnvironment?.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(childEnvironment?.VITE_HELIUS_API_KEY, undefined);
  const authenticated = deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token', source);
  assert.equal(authenticated.CLOUDFLARE_API_TOKEN, 'scoped-token');
  assert.equal(authenticated.HELIUS_API_KEY, undefined);
  assert.equal(authenticated.RESEND_CONTACTS_API_KEY, undefined);
  assert.equal(authenticated.NOTIFICATION_ENQUEUE_SECRET, undefined);
  assert.equal(authenticated.FIRESTORE_SERVICE_ACCOUNT_JSON, undefined);
  assert.equal(authenticated.FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON, undefined);
  assert.equal(authenticated.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(authenticated.VITE_HELIUS_API_KEY, undefined);
  const frontendValidation = frontendDeployTestHooks.credentialFreeEnvironment({
    ...source,
    VITE_MONS_API_ORIGIN: 'https://untrusted.example',
  });
  assert.equal(frontendValidation.PATH, '/bin');
  assert.equal(frontendValidation.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(frontendValidation.CF_API_TOKEN, undefined);
  assert.equal(frontendValidation.HELIUS_API_KEY, undefined);
  assert.equal(frontendValidation.RESEND_CONTACTS_API_KEY, undefined);
  assert.equal(frontendValidation.FIRESTORE_SERVICE_ACCOUNT_JSON, undefined);
  assert.equal(frontendValidation.FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON, undefined);
  assert.equal(frontendValidation.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(frontendValidation.WRANGLER_OUTPUT_FILE_PATH, undefined);
  assert.equal(frontendValidation.DOTENV_KEY, undefined);
  assert.equal(frontendValidation.VITE_MONS_API_ORIGIN, undefined);
});

test('termination cleanup handles both signals and removes its listeners', () => {
  for (const [signal, expectedExitCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    const emitter = new EventEmitter();
    let cleanupCalls = 0;
    let exitCode: number | undefined;
    const host = {
      once: (event: 'SIGINT' | 'SIGTERM', listener: () => void) => emitter.once(event, listener),
      removeListener: (event: 'SIGINT' | 'SIGTERM', listener: () => void) => emitter.removeListener(event, listener),
      exit: (code: number) => {
        exitCode = code;
      },
    };
    deployApiTestHooks.installTerminationCleanup(() => {
      cleanupCalls += 1;
    }, host);
    emitter.emit(signal);
    assert.equal(cleanupCalls, 1);
    assert.equal(exitCode, expectedExitCode);
    assert.equal(emitter.listenerCount('SIGINT'), 0);
    assert.equal(emitter.listenerCount('SIGTERM'), 0);
  }
});

test('termination cleanup failures are surfaced without leaking details', () => {
  const emitter = new EventEmitter();
  let exitCode: number | undefined;
  let logged = '';
  const originalError = console.error;
  console.error = (value?: unknown) => {
    logged = String(value);
  };
  try {
    deployApiTestHooks.installTerminationCleanup(() => {
      throw new Error('release-test-secret');
    }, {
      once: (event, listener) => emitter.once(event, listener),
      removeListener: (event, listener) => emitter.removeListener(event, listener),
      exit: (code) => {
        exitCode = code;
      },
    });
    emitter.emit('SIGINT');
  } finally {
    console.error = originalError;
  }
  assert.equal(exitCode, 1);
  assert.match(logged, /cleanup failed/);
  assert.doesNotMatch(logged, /release-test-secret/);
});

test('frontend deployment gates upload on typechecking, tests, build, and bundle validation', () => {
  assert.deepEqual(
    frontendDeployTestHooks.frontendValidationSteps.map((step) => step.args),
    [['run', 'typecheck'], ['test'], ['run', 'build'], ['run', 'validate:browser-bundle']],
  );
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.match(packageJson.scripts['check:api'], /dry-run:api:triggers/);
});

test('API observability samples custom logs without automatic invocation logs', () => {
  const config = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8')) as {
    observability?: {
      enabled?: boolean;
      logs?: {
        enabled?: boolean;
        head_sampling_rate?: number;
        invocation_logs?: boolean;
      };
    };
  };
  assert.equal(config.observability?.enabled, true);
  assert.equal(config.observability?.logs?.enabled, true);
  assert.equal(config.observability?.logs?.head_sampling_rate, 0.1);
  assert.equal(config.observability?.logs?.invocation_logs, false);
});

test('benchmark warms both paths and alternates measured request order', async () => {
  const calls: string[] = [];
  const includeDevnetValues: boolean[] = [];
  let clock = 0;
  const result = await benchmarkApi(
    { apiOrigin: 'https://api.mons.shop', includeDevnet: true, owner: OWNER, runs: 3 },
    'helius-test-key',
    {
      now: () => clock,
      workerInventory: async (_origin, _owner, _network, includeDevnet) => {
        calls.push('worker');
        includeDevnetValues.push(includeDevnet === true);
        clock += 1;
        return [];
      },
      legacyInventory: async (_apiKey, _owner, _network, includeDevnet) => {
        calls.push('legacy');
        includeDevnetValues.push(includeDevnet === true);
        clock += 3;
        return [];
      },
    },
  );
  assert.deepEqual(calls, ['worker', 'legacy', 'worker', 'legacy', 'legacy', 'worker', 'worker', 'legacy']);
  assert.equal(includeDevnetValues.every((value) => value === true), true);
  assert.equal(result.runs, 3);
  assert.equal(result.workerMedianMs, 1);
  assert.equal(result.legacyMedianMs, 3);
});

test('direct benchmark uses bounded cursor requests and keeps a successful size-down limit', async () => {
  const requests: Array<{ id: string; params: Record<string, unknown> }> = [];
  const scheduledTimeouts: number[] = [];
  const clearedTimers: unknown[] = [];
  let nextTimer = 0;
  const items = await benchmarkApiTestHooks.legacyInventory('helius-test-key', OWNER, {
    clearTimer: (handle) => clearedTimers.push(handle),
    fetch: async (_input, init) => {
      const rpc = JSON.parse(String(init?.body)) as { id: string; params: Record<string, unknown> };
      requests.push(rpc);
      if (requests.length === 1) {
        return new Response('', {
          status: 200,
          headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) },
        });
      }
      const result = requests.length === 2
        ? { items: [{ id: OWNER }], cursor: 'next-cursor', total: 1 }
        : { items: [] };
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    },
    randomUint32: () => 0,
    scheduleTimer: (_callback, milliseconds) => {
      scheduledTimeouts.push(milliseconds);
      nextTimer += 1;
      return nextTimer;
    },
    sleep: async () => assert.fail('size-down pagination must not use transient retry sleep'),
  });
  assert.deepEqual(items, []);
  assert.deepEqual(requests.slice(0, 3).map((request) => request.params.limit), [250, 125, 125]);
  assert.equal(requests[0].params.cursor, undefined);
  assert.equal(requests[1].params.cursor, undefined);
  assert.equal(requests[2].params.cursor, 'next-cursor');
  assert.deepEqual(requests[0].params.sortBy, { sortBy: 'id', sortDirection: 'asc' });
  assert.deepEqual(requests[0].params.options, { showUnverifiedCollections: true });
  assert.equal(Object.hasOwn(requests[0].params, 'page'), false);
  assert.equal(requests.some((request) => !request.params.grouping), false);
  assert.equal(scheduledTimeouts[0], benchmarkApiTestHooks.legacyInventoryTimeoutMs);
  assert.equal(
    scheduledTimeouts.slice(1).every((timeout) => timeout === benchmarkApiTestHooks.heliusAttemptTimeoutMs),
    true,
  );
  assert.equal(clearedTimers.length, scheduledTimeouts.length);
});

test('direct benchmark never invokes whole-wallet fallback for successful empty grouped scopes', async () => {
  const requests: Array<{ params: Record<string, unknown> }> = [];
  let nextTimer = 0;
  const items = await benchmarkApiTestHooks.legacyInventory('helius-test-key', OWNER, {
    clearTimer: () => undefined,
    fetch: async (_input, init) => {
      const rpc = JSON.parse(String(init?.body)) as { id: string; params: Record<string, unknown> };
      requests.push(rpc);
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { items: [] } });
    },
    scheduleTimer: () => {
      nextTimer += 1;
      return nextTimer;
    },
    sleep: async () => assert.fail('successful empty scopes must not retry'),
  });
  assert.deepEqual(items, []);
  assert.equal(requests.length > 0, true);
  assert.equal(requests.some((request) => !request.params.grouping), false);
});

test('direct benchmark includes both Helius clusters when devnet is enabled', async () => {
  const origins = new Set<string>();
  let nextTimer = 0;
  await benchmarkApiTestHooks.legacyInventory('helius-test-key', OWNER, {
    clearTimer: () => undefined,
    fetch: async (input, init) => {
      origins.add(new URL(String(input)).hostname);
      const rpc = JSON.parse(String(init?.body)) as { id: string };
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { items: [] } });
    },
    scheduleTimer: () => {
      nextTimer += 1;
      return nextTimer;
    },
  }, true);
  assert.deepEqual([...origins].sort(), ['devnet.helius-rpc.com', 'mainnet.helius-rpc.com']);
});

test('direct benchmark retains cluster fallback after an initial grouped provider failure', async () => {
  const requests: Array<{ id: string; params: Record<string, unknown> }> = [];
  const retryDelays: number[] = [];
  let nextTimer = 0;
  await benchmarkApiTestHooks.legacyInventory('helius-test-key', OWNER, {
    clearTimer: () => undefined,
    fetch: async (_input, init) => {
      const rpc = JSON.parse(String(init?.body)) as { id: string; params: Record<string, unknown> };
      requests.push(rpc);
      if (requests.length <= 2) {
        return new Response(null, { status: 503, headers: { 'Retry-After': '0' } });
      }
      const result = !rpc.params.grouping && !rpc.params.cursor
        ? { items: [{ id: OWNER }], cursor: 'fallback-cursor' }
        : { items: [] };
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    },
    randomUint32: () => 0,
    scheduleTimer: () => {
      nextTimer += 1;
      return nextTimer;
    },
    sleep: async (milliseconds) => {
      retryDelays.push(milliseconds);
    },
  });
  assert.deepEqual(requests[0].params, requests[1].params);
  assert.deepEqual(retryDelays, [0]);
  const wholeWalletRequests = requests.filter((request) => !request.params.grouping);
  assert.equal(wholeWalletRequests.length, 2);
  assert.equal(wholeWalletRequests[0].params.limit, benchmarkApiTestHooks.pageLimits[0]);
  assert.equal(wholeWalletRequests[0].params.cursor, undefined);
  assert.equal(wholeWalletRequests[1].params.cursor, 'fallback-cursor');
  assert.equal(Object.hasOwn(wholeWalletRequests[0].params, 'page'), false);
});

test('direct benchmark does not hide a malformed grouped result behind whole-wallet fallback', async () => {
  let providerCalls = 0;
  await assert.rejects(
    () => benchmarkApiTestHooks.legacyInventory('helius-test-key', OWNER, {
      clearTimer: () => undefined,
      fetch: async (_input, init) => {
        providerCalls += 1;
        const rpc = JSON.parse(String(init?.body)) as { id: string };
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { unexpected: [] } });
      },
      scheduleTimer: () => providerCalls,
    }),
    /invalid result/,
  );
  assert.equal(providerCalls, 1);
});

test('benchmark Worker inventory request outlives the Worker overall deadline', async () => {
  const scheduledTimeouts: number[] = [];
  const clearedTimers: unknown[] = [];
  let requestBody: unknown;
  await benchmarkApiTestHooks.workerInventory('https://preview.example', OWNER, {
    clearTimer: (handle) => clearedTimers.push(handle),
    fetch: async (_input, init) => {
      assert.ok(init?.signal instanceof AbortSignal);
      requestBody = JSON.parse(String(init?.body)) as unknown;
      return Response.json({ ok: true, items: [] });
    },
    scheduleTimer: (_callback, milliseconds) => {
      scheduledTimeouts.push(milliseconds);
      return milliseconds;
    },
  }, true);
  assert.deepEqual(scheduledTimeouts, [benchmarkApiTestHooks.workerInventoryTimeoutMs]);
  assert.deepEqual(clearedTimers, [benchmarkApiTestHooks.workerInventoryTimeoutMs]);
  assert.deepEqual(requestBody, { owner: OWNER, includeDevnet: true });
});

test('API smoke grants inventory routes the Worker deadline while keeping other checks short', async () => {
  const bodies = new Map<string, unknown>();
  const timeouts = new Map<string, number>();
  await deployApiTestHooks.smokeApi('https://preview.example', {
    expectedInventoryDropId: deployApiTestHooks.expectedReleaseDropId,
    forbiddenInventoryDropId: 'clear_cards_devnet',
    includeDevnet: true,
    includeNotificationSubscription: true,
    includePackStatus: true,
    includeProfileState: true,
    owner: OWNER,
  }, {
    fetchSmoke: async (url, init, _label, timeoutMs = deployApiTestHooks.defaultSmokeTimeoutMs) => {
      const pathname = new URL(url).pathname;
      const method = init.method || 'GET';
      timeouts.set(`${method}:${pathname}`, timeoutMs);
      if (method === 'POST' && (pathname === '/inventory' || pathname === '/pending-open-boxes')) {
        bodies.set(pathname, JSON.parse(String(init.body)) as unknown);
      }
      if (method === 'POST' && pathname === '/notifications/subscribe') {
        bodies.set(pathname, JSON.parse(String(init.body)) as unknown);
      }
      const headers = new Headers({
        'Cache-Control': 'no-store',
        'Server-Timing': 'app;dur=1',
      });
      if (method === 'OPTIONS' && pathname === '/inventory') {
        headers.set('Access-Control-Allow-Origin', '*');
        return { response: new Response(null, { status: 204, headers }), durationMs: 1 };
      }
      if (method === 'OPTIONS' && pathname === '/rpc/mainnet-beta') {
        return { response: new Response(null, { status: 403, headers }), durationMs: 1 };
      }
      if (method === 'OPTIONS' && pathname === '/rpc/devnet') {
        headers.set('Access-Control-Allow-Origin', 'https://mons.shop');
        headers.set('Access-Control-Allow-Headers', 'content-type, solana-client');
        return { response: new Response(null, { status: 204, headers }), durationMs: 1 };
      }
      if (method === 'POST' && pathname === '/inventory') {
        return {
          response: Response.json({
            ok: true,
            items: [{ id: OWNER, dropId: deployApiTestHooks.expectedReleaseDropId, name: 'Clear Card', kind: 'box' }],
          }, { status: 200, headers }),
          durationMs: 1,
        };
      }
      if (method === 'POST' && pathname === '/pending-open-boxes') {
        return { response: Response.json({ ok: true, items: [] }, { status: 200, headers }), durationMs: 1 };
      }
      if (method === 'POST' && pathname === '/notifications/subscribe') {
        return { response: Response.json({ subscribed: true }, { status: 200, headers }), durationMs: 1 };
      }
      if (method === 'POST' && [
        '/profile/state',
        '/profile/addresses',
        '/admin/delivery-order-owners',
        '/fulfillment/orders',
        '/fulfillment/order-address',
        '/fulfillment/order-status',
        '/fulfillment/manual-review-checkouts',
        '/fulfillment/shipstation-label',
        '/fulfillment/shipstation-rates',
        '/fulfillment/shipstation-shipment',
      ].includes(pathname)) {
        headers.set('Access-Control-Allow-Origin', 'https://mons.shop');
        return {
          response: Response.json({
            ok: false,
            error: { code: 'unauthenticated', message: 'Authentication is required.' },
          }, { status: 401, headers }),
          durationMs: 1,
        };
      }
      if (method === 'GET' && pathname === '/pack-status/card_nft_2') {
        return {
          response: Response.json({
            ok: true,
            packStatus: {
              dropId: 'card_nft_2',
              total: 30,
              totalInitialSupply: 10,
              totalCards: 30,
              cardsPerPack: 3,
              unsealedOnline: 1,
              unsealedCards: 3,
              redeemedIrl: 1,
              redeemedIrlNormal: 1,
              redeemedIrlStripe: 0,
              redeemedUnsealedCards: 0,
              redeemedCards: 3,
              items: [
                { key: 'unsealed', label: 'Unpacked', amount: 3, percentage: 10 },
                { key: 'redeemed', label: 'Redeemed', amount: 3, percentage: 10 },
                { key: 'total', label: 'Total', amount: 30, percentage: 100 },
              ],
            },
          }, { status: 200, headers }),
          durationMs: 1,
        };
      }
      if (method === 'POST' && pathname.startsWith('/rpc/')) {
        const cluster = pathname.endsWith('/devnet') ? 'devnet' : 'mainnet-beta';
        headers.set('Access-Control-Allow-Origin', 'https://mons.shop');
        return {
          response: Response.json({
            jsonrpc: '2.0',
            id: `smoke-${cluster}`,
            result: { value: { blockhash: OWNER, lastValidBlockHeight: 1 } },
          }, { status: 200, headers }),
          durationMs: 1,
        };
      }
      return { response: Response.json({ ok: true }, { status: 200, headers }), durationMs: 1 };
    },
  });
  assert.equal(timeouts.get('POST:/inventory'), deployApiTestHooks.inventorySmokeTimeoutMs);
  assert.equal(timeouts.get('POST:/pending-open-boxes'), deployApiTestHooks.inventorySmokeTimeoutMs);
  assert.deepEqual(bodies.get('/inventory'), { owner: OWNER, includeDevnet: true });
  assert.deepEqual(bodies.get('/pending-open-boxes'), { owner: OWNER, includeDevnet: true });
  assert.deepEqual(bodies.get('/notifications/subscribe'), {
    email: deployApiTestHooks.notificationSmokeEmail,
  });
  assert.equal(timeouts.get('POST:/profile/state'), deployApiTestHooks.defaultSmokeTimeoutMs);
  for (const [request, timeoutMs] of timeouts) {
    if (request === 'POST:/inventory' || request === 'POST:/pending-open-boxes') continue;
    assert.equal(timeoutMs, deployApiTestHooks.defaultSmokeTimeoutMs);
  }
  assert.throws(
    () => deployApiTestHooks.assertInventorySmokeDrops([], {
      expectedInventoryDropId: deployApiTestHooks.expectedReleaseDropId,
    }),
    /did not contain clear_cards_devnet_v2/,
  );
  assert.throws(
    () => deployApiTestHooks.assertInventorySmokeDrops([{ dropId: 'clear_cards_devnet' }], {
      forbiddenInventoryDropId: 'clear_cards_devnet',
    }),
    /still contained clear_cards_devnet/,
  );
});

test('complete API release blocks stale API or frontend state before upload', async () => {
  const apiVersionId = randomUUID();
  const frontendVersionId = randomUUID();
  const manifest = {
    ...deployApiTestHooks.readReleaseManifest(),
    currentProduction: { apiVersionId, frontendVersionId },
  };
  for (const livePair of [
    { apiVersionId: randomUUID(), frontendVersionId },
    { apiVersionId, frontendVersionId: randomUUID() },
  ]) {
    let uploaded = false;
    await assert.rejects(
      () => deployApiTestHooks.runCompleteApiRelease({
        apiToken: 'scoped-token',
        checkEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        firestoreServiceAccountJson: 'firestore-test-credential',
        firestoreWriterServiceAccountJson: 'firestore-writer-test-credential',
        heliusApiKey: 'helius-test-key',
        logsDirectory: '/tmp/logs',
        smokeOwner: OWNER,
        wranglerEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
      }, {
        apiDeployment: async () => stableDeployment(livePair.apiVersionId),
        frontendDeployment: async () => stableDeployment(livePair.frontendVersionId),
        manifest: () => manifest,
        production: async () => assert.fail('stale preflight reached production'),
        record: () => assert.fail('stale preflight wrote release metadata'),
        triggerDryRun: () => assert.fail('stale preflight ran trigger validation'),
        upload: async () => {
          uploaded = true;
          assert.fail('stale preflight uploaded a candidate');
        },
        validate: () => assert.fail('stale preflight ran local validation'),
      }),
      /Release preflight expected API/,
    );
    assert.equal(uploaded, false);
  }
});

test('complete frontend release verifies the production pair around upload, promotion, manifest recording, and commit', async () => {
  const apiVersionId = randomUUID();
  const frontendVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const candidate = {
    htmlSha256: 'a'.repeat(64),
    previewUrl: frontendDeployTestHooks.expectedFrontendPreviewOrigin(candidateVersionId),
    versionId: candidateVersionId,
  };
  const events: string[] = [];
  const manifest = {
    ...deployApiTestHooks.readReleaseManifest(),
    currentProduction: { apiVersionId, frontendVersionId },
  };
  const apiStatuses = [apiVersionId, apiVersionId, apiVersionId];
  const frontendStatuses = [frontendVersionId, candidateVersionId];
  const result = await frontendDeployTestHooks.runCompleteFrontendRelease({
    authenticatedEnvironment: { CLOUDFLARE_API_TOKEN: 'scoped-token', HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
    unauthenticatedEnvironment: { CLOUDFLARE_API_TOKEN: '', HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
    validationEnvironment: { CI: 'true', HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
    wranglerLogDirectory: '/tmp/logs',
  }, {
    apiDeployment: async () => {
      events.push('api-status');
      return stableDeployment(apiStatuses.shift() || assert.fail('unexpected API status read'));
    },
    commit: (versionId, source) => {
      events.push('commit');
      assert.equal(versionId, candidateVersionId);
      assert.deepEqual(source, { branch: SOURCE_BRANCH, commit: SOURCE_COMMIT });
    },
    frontendDeployment: async () => {
      events.push('frontend-status');
      return stableDeployment(frontendStatuses.shift() || assert.fail('unexpected frontend status read'));
    },
    manifest: () => {
      events.push('manifest');
      return manifest;
    },
    profileApi: async () => {
      events.push('profile-api');
    },
    production: async (input) => {
      events.push('production');
      assert.equal(input.candidateHtmlSha256, candidate.htmlSha256);
      assert.equal(input.expectedCurrentVersionId, frontendVersionId);
      assert.equal(input.versionId, candidateVersionId);
      await input.verifyBeforeMutation?.();
      await input.verifyBeforePromotion?.();
      events.push('promotion-guard-passed');
    },
    record: (versionId, options) => {
      events.push('record');
      assert.equal(versionId, candidateVersionId);
      assert.deepEqual(options.expectedCurrentProduction, { apiVersionId, frontendVersionId });
      return {
        ...manifest,
        currentProduction: { apiVersionId, frontendVersionId: versionId },
      };
    },
    resolveCandidate: async () => assert.fail('one-step release resolved an existing candidate'),
    smoke: async () => assert.fail('one-step release repeated the upload helper smoke'),
    triggerDryRun: () => assert.fail('one-step release bypassed the upload helper trigger dry-run'),
    upload: async (input) => {
      events.push('upload');
      assert.equal(input.validationEnvironment.CI, 'true');
      return candidate;
    },
    source: () => {
      events.push('source-commit');
      return { branch: SOURCE_BRANCH, commit: SOURCE_COMMIT };
    },
  });
  assert.deepEqual(result, candidate);
  assert.deepEqual(events, [
    'source-commit',
    'manifest',
    'api-status',
    'frontend-status',
    'profile-api',
    'upload',
    'production',
    'source-commit',
    'source-commit',
    'api-status',
    'promotion-guard-passed',
    'api-status',
    'frontend-status',
    'source-commit',
    'record',
    'commit',
  ]);
});

test('complete frontend release blocks stale state before uploading or promoting', async () => {
  const apiVersionId = randomUUID();
  const frontendVersionId = randomUUID();
  const manifest = {
    ...deployApiTestHooks.readReleaseManifest(),
    currentProduction: { apiVersionId, frontendVersionId },
  };
  for (const livePair of [
    { apiVersionId: randomUUID(), frontendVersionId },
    { apiVersionId, frontendVersionId: randomUUID() },
  ]) {
    await assert.rejects(
      () => frontendDeployTestHooks.runCompleteFrontendRelease({
        authenticatedEnvironment: { CLOUDFLARE_API_TOKEN: 'scoped-token', HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        unauthenticatedEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        validationEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        wranglerLogDirectory: '/tmp/logs',
      }, {
        apiDeployment: async () => stableDeployment(livePair.apiVersionId),
        commit: () => assert.fail('stale preflight committed release metadata'),
        frontendDeployment: async () => stableDeployment(livePair.frontendVersionId),
        manifest: () => manifest,
        production: async () => assert.fail('stale preflight reached production'),
        record: () => assert.fail('stale preflight recorded release metadata'),
        resolveCandidate: async () => assert.fail('stale preflight resolved a candidate'),
        smoke: async () => assert.fail('stale preflight smoked a candidate'),
        triggerDryRun: () => assert.fail('stale preflight ran trigger validation'),
        upload: async () => assert.fail('stale preflight uploaded a candidate'),
        source: () => ({ branch: SOURCE_BRANCH, commit: SOURCE_COMMIT }),
      }),
      /Frontend release preflight expected API/,
    );
  }
});

test('complete frontend release retains exact-version recovery and commits the resumed candidate', async () => {
  const apiVersionId = randomUUID();
  const frontendVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const previewUrl = frontendDeployTestHooks.expectedFrontendPreviewOrigin(candidateVersionId);
  const htmlSha256 = 'b'.repeat(64);
  const events: string[] = [];
  const manifest = {
    ...deployApiTestHooks.readReleaseManifest(),
    currentProduction: { apiVersionId, frontendVersionId },
  };
  const apiStatuses = [apiVersionId, apiVersionId, apiVersionId];
  const frontendStatuses = [candidateVersionId, candidateVersionId];
  await frontendDeployTestHooks.runCompleteFrontendRelease({
    authenticatedEnvironment: { CLOUDFLARE_API_TOKEN: 'scoped-token', HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
    unauthenticatedEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
    validationEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
    versionId: candidateVersionId,
    wranglerLogDirectory: '/tmp/logs',
  }, {
    apiDeployment: async () => stableDeployment(apiStatuses.shift() || assert.fail('unexpected API status read')),
    commit: (versionId, source) => {
      events.push('commit');
      assert.equal(versionId, candidateVersionId);
      assert.deepEqual(source, { branch: SOURCE_BRANCH, commit: SOURCE_COMMIT });
    },
    frontendDeployment: async () => stableDeployment(frontendStatuses.shift() || assert.fail('unexpected frontend status read')),
    manifest: () => manifest,
    production: async (input) => {
      events.push('production');
      assert.equal(input.versionId, candidateVersionId);
      await input.verifyBeforeMutation?.();
      await input.verifyBeforePromotion?.();
    },
    record: (versionId, options) => {
      events.push('record');
      assert.equal(versionId, candidateVersionId);
      assert.deepEqual(options.expectedCurrentProduction, manifest.currentProduction);
      return {
        ...manifest,
        currentProduction: { apiVersionId, frontendVersionId: versionId },
      };
    },
    resolveCandidate: async () => {
      events.push('resolve-candidate');
      return { previewUrl, recordedHtmlSha256: htmlSha256, sourceCommit: SOURCE_COMMIT };
    },
    smoke: async (origin) => {
      events.push('preview-smoke');
      assert.equal(origin, previewUrl);
      return htmlSha256;
    },
    triggerDryRun: () => events.push('trigger-dry-run'),
    upload: async () => assert.fail('exact-version recovery uploaded a new candidate'),
    source: () => {
      events.push('source-commit');
      return { branch: SOURCE_BRANCH, commit: SOURCE_COMMIT };
    },
  });
  assert.deepEqual(events, [
    'source-commit',
    'trigger-dry-run',
    'resolve-candidate',
    'preview-smoke',
    'production',
    'source-commit',
    'source-commit',
    'source-commit',
    'record',
    'commit',
  ]);
});

test('complete frontend release rejects a candidate from another Git commit', async () => {
  const apiVersionId = randomUUID();
  const frontendVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const manifest = {
    ...deployApiTestHooks.readReleaseManifest(),
    currentProduction: { apiVersionId, frontendVersionId },
  };
  await assert.rejects(
    () => frontendDeployTestHooks.runCompleteFrontendRelease({
      authenticatedEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
      unauthenticatedEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
      validationEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
      versionId: candidateVersionId,
      wranglerLogDirectory: '/tmp/logs',
    }, {
      apiDeployment: async () => stableDeployment(apiVersionId),
      commit: () => assert.fail('source mismatch committed release metadata'),
      frontendDeployment: async () => stableDeployment(frontendVersionId),
      manifest: () => manifest,
      production: async () => assert.fail('source mismatch reached production'),
      record: () => assert.fail('source mismatch recorded release metadata'),
      resolveCandidate: async () => ({
        previewUrl: frontendDeployTestHooks.expectedFrontendPreviewOrigin(candidateVersionId),
        recordedHtmlSha256: 'b'.repeat(64),
        sourceCommit: SOURCE_COMMIT,
      }),
      smoke: async () => assert.fail('source mismatch smoked the candidate'),
      source: () => ({ branch: SOURCE_BRANCH, commit: 'b'.repeat(40) }),
      triggerDryRun: () => {},
      upload: async () => assert.fail('source mismatch uploaded a candidate'),
    }),
    /was built from Git commit .* but the current commit is/,
  );
});

test('complete frontend release rejects API drift and reports exact recovery after manifest or commit failure', async () => {
  const apiVersionId = randomUUID();
  const frontendVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const candidate = {
    htmlSha256: 'c'.repeat(64),
    previewUrl: frontendDeployTestHooks.expectedFrontendPreviewOrigin(candidateVersionId),
    versionId: candidateVersionId,
  };
  const manifest = {
    ...deployApiTestHooks.readReleaseManifest(),
    currentProduction: { apiVersionId, frontendVersionId },
  };
  {
    const apiStatuses = [apiVersionId, randomUUID()];
    await assert.rejects(
      () => frontendDeployTestHooks.runCompleteFrontendRelease({
        authenticatedEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        unauthenticatedEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        validationEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        wranglerLogDirectory: '/tmp/logs',
      }, {
        apiDeployment: async () => stableDeployment(apiStatuses.shift()!),
        commit: () => assert.fail('API drift committed release metadata'),
        frontendDeployment: async () => stableDeployment(frontendVersionId),
        manifest: () => manifest,
        production: verifyFrontendProductionGuards,
        record: () => assert.fail('API drift recorded release metadata'),
        resolveCandidate: async () => assert.fail('one-step release resolved a candidate'),
        smoke: async () => assert.fail('one-step release repeated preview smoke'),
        triggerDryRun: () => assert.fail('one-step release bypassed upload'),
        upload: async () => candidate,
        source: () => ({ branch: SOURCE_BRANCH, commit: SOURCE_COMMIT }),
      }),
      /API changed before frontend promotion/,
    );
  }
  {
    const apiStatuses = [apiVersionId, apiVersionId, apiVersionId];
    const frontendStatuses = [frontendVersionId, randomUUID()];
    await assert.rejects(
      () => frontendDeployTestHooks.runCompleteFrontendRelease({
        authenticatedEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        unauthenticatedEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        validationEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        wranglerLogDirectory: '/tmp/logs',
      }, {
        apiDeployment: async () => stableDeployment(apiStatuses.shift()!),
        commit: () => assert.fail('final pair drift committed release metadata'),
        frontendDeployment: async () => stableDeployment(frontendStatuses.shift()!),
        manifest: () => manifest,
        production: verifyFrontendProductionGuards,
        record: () => assert.fail('final pair drift recorded release metadata'),
        resolveCandidate: async () => assert.fail('one-step release resolved a candidate'),
        smoke: async () => assert.fail('one-step release repeated preview smoke'),
        triggerDryRun: () => assert.fail('one-step release bypassed upload'),
        upload: async () => candidate,
        source: () => ({ branch: SOURCE_BRANCH, commit: SOURCE_COMMIT }),
      }),
      /Frontend release commit verification expected API/,
    );
  }
  {
    const apiStatuses = [apiVersionId, apiVersionId, apiVersionId];
    const frontendStatuses = [frontendVersionId, candidateVersionId];
    const sourceBranches = [SOURCE_BRANCH, 'refs/heads/release'];
    await assert.rejects(
      () => frontendDeployTestHooks.runCompleteFrontendRelease({
        authenticatedEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        unauthenticatedEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        validationEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        wranglerLogDirectory: '/tmp/logs',
      }, {
        apiDeployment: async () => stableDeployment(apiStatuses.shift()!),
        commit: () => assert.fail('source drift committed release metadata'),
        frontendDeployment: async () => stableDeployment(frontendStatuses.shift()!),
        manifest: () => manifest,
        production: verifyFrontendProductionGuards,
        record: () => assert.fail('source drift recorded release metadata'),
        resolveCandidate: async () => assert.fail('one-step release resolved a candidate'),
        smoke: async () => assert.fail('one-step release repeated preview smoke'),
        triggerDryRun: () => assert.fail('one-step release bypassed upload'),
        upload: async () => candidate,
        source: () => ({ branch: sourceBranches.shift()!, commit: SOURCE_COMMIT }),
      }),
      /Frontend source changed before production mutation/,
    );
  }
  {
    const apiStatuses = [apiVersionId, apiVersionId, apiVersionId];
    const frontendStatuses = [frontendVersionId, candidateVersionId];
    const sourceCommits = [SOURCE_COMMIT, SOURCE_COMMIT, 'b'.repeat(40)];
    await assert.rejects(
      () => frontendDeployTestHooks.runCompleteFrontendRelease({
        authenticatedEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        unauthenticatedEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        validationEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        wranglerLogDirectory: '/tmp/logs',
      }, {
        apiDeployment: async () => stableDeployment(apiStatuses.shift()!),
        commit: () => assert.fail('source drift committed release metadata'),
        frontendDeployment: async () => stableDeployment(frontendStatuses.shift()!),
        manifest: () => manifest,
        production: verifyFrontendProductionGuards,
        record: () => assert.fail('source drift recorded release metadata'),
        resolveCandidate: async () => assert.fail('one-step release resolved a candidate'),
        smoke: async () => assert.fail('one-step release repeated preview smoke'),
        triggerDryRun: () => assert.fail('one-step release bypassed upload'),
        upload: async () => candidate,
        source: () => ({ branch: SOURCE_BRANCH, commit: sourceCommits.shift()! }),
      }),
      /Frontend source changed before promotion/,
    );
  }
  {
    const apiStatuses = [apiVersionId, apiVersionId, apiVersionId];
    const frontendStatuses = [frontendVersionId, candidateVersionId];
    const sourceCommits = [SOURCE_COMMIT, SOURCE_COMMIT, SOURCE_COMMIT, 'b'.repeat(40)];
    await assert.rejects(
      () => frontendDeployTestHooks.runCompleteFrontendRelease({
        authenticatedEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        unauthenticatedEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        validationEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        wranglerLogDirectory: '/tmp/logs',
      }, {
        apiDeployment: async () => stableDeployment(apiStatuses.shift()!),
        commit: () => assert.fail('source drift committed release metadata'),
        frontendDeployment: async () => stableDeployment(frontendStatuses.shift()!),
        manifest: () => manifest,
        production: verifyFrontendProductionGuards,
        record: () => assert.fail('source drift recorded release metadata'),
        resolveCandidate: async () => assert.fail('one-step release resolved a candidate'),
        smoke: async () => assert.fail('one-step release repeated preview smoke'),
        triggerDryRun: () => assert.fail('one-step release bypassed upload'),
        upload: async () => candidate,
        source: () => ({ branch: SOURCE_BRANCH, commit: sourceCommits.shift()! }),
      }),
      new RegExp(
        `Frontend version ${candidateVersionId} is live and verified[\\s\\S]*` +
        `Restore ${SOURCE_BRANCH} at Git commit ${SOURCE_COMMIT}[\\s\\S]*` +
        `production --version-id ${candidateVersionId}`,
      ),
    );
  }
  {
    const apiStatuses = [apiVersionId, apiVersionId, apiVersionId];
    const frontendStatuses = [frontendVersionId, candidateVersionId];
    await assert.rejects(
      () => frontendDeployTestHooks.runCompleteFrontendRelease({
        authenticatedEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        tokenFile: '/tmp/cloudflare token',
        unauthenticatedEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        validationEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        wranglerLogDirectory: '/tmp/logs',
      }, {
        apiDeployment: async () => stableDeployment(apiStatuses.shift()!),
        commit: () => assert.fail('manifest write failure committed release metadata'),
        frontendDeployment: async () => stableDeployment(frontendStatuses.shift()!),
        manifest: () => manifest,
        production: verifyFrontendProductionGuards,
        record: () => {
          throw new Error('injected manifest write failure');
        },
        resolveCandidate: async () => assert.fail('one-step release resolved a candidate'),
        smoke: async () => assert.fail('one-step release repeated preview smoke'),
        triggerDryRun: () => assert.fail('one-step release bypassed upload'),
        upload: async () => candidate,
        source: () => ({ branch: SOURCE_BRANCH, commit: SOURCE_COMMIT }),
      }),
      new RegExp(
        `Frontend version ${candidateVersionId} is live and verified[\\s\\S]*` +
        `production --version-id ${candidateVersionId}[\\s\\S]*cloudflare token`,
      ),
    );
  }
  {
    const apiStatuses = [apiVersionId, apiVersionId, apiVersionId];
    const frontendStatuses = [frontendVersionId, candidateVersionId];
    const events: string[] = [];
    await assert.rejects(
      () => frontendDeployTestHooks.runCompleteFrontendRelease({
        authenticatedEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        unauthenticatedEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        validationEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        wranglerLogDirectory: '/tmp/logs',
      }, {
        apiDeployment: async () => stableDeployment(apiStatuses.shift()!),
        commit: () => {
          events.push('commit');
          throw new Error('injected commit failure');
        },
        frontendDeployment: async () => stableDeployment(frontendStatuses.shift()!),
        manifest: () => manifest,
        production: verifyFrontendProductionGuards,
        record: () => {
          events.push('record');
          return {
            ...manifest,
            currentProduction: { apiVersionId, frontendVersionId: candidateVersionId },
          };
        },
        resolveCandidate: async () => assert.fail('one-step release resolved a candidate'),
        smoke: async () => assert.fail('one-step release repeated preview smoke'),
        triggerDryRun: () => assert.fail('one-step release bypassed upload'),
        upload: async () => candidate,
        source: () => ({ branch: SOURCE_BRANCH, commit: SOURCE_COMMIT }),
      }),
      new RegExp(
        `Frontend version ${candidateVersionId} is live and verified[\\s\\S]*` +
        `release manifest was not committed[\\s\\S]*${SOURCE_BRANCH}[\\s\\S]*${SOURCE_COMMIT}[\\s\\S]*` +
        `git commit --only[\\s\\S]*cloud/release-manifest.json`,
      ),
    );
    assert.deepEqual(events, ['record', 'commit']);
  }
});

test('complete API release verifies the full pair around one exact API promotion', async () => {
  const apiVersionId = randomUUID();
  const frontendVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const events: string[] = [];
  const manifest = {
    ...deployApiTestHooks.readReleaseManifest(),
    currentProduction: { apiVersionId, frontendVersionId },
  };
  const apiStatuses = [apiVersionId, candidateVersionId];
  const frontendStatuses = [frontendVersionId, frontendVersionId, frontendVersionId];
  const metadata = await deployApiTestHooks.runCompleteApiRelease({
    apiToken: 'scoped-token',
    checkEnvironment: { CI: 'true', HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
    firestoreServiceAccountJson: 'firestore-test-credential',
    firestoreWriterServiceAccountJson: 'firestore-writer-test-credential',
    heliusApiKey: 'helius-test-key',
    logsDirectory: '/tmp/logs',
    smokeOwner: OWNER,
    wranglerEnvironment: { CLOUDFLARE_API_TOKEN: 'scoped-token', HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
  }, {
    apiDeployment: async () => {
      events.push('api-status');
      return stableDeployment(apiStatuses.shift() || assert.fail('unexpected API status read'));
    },
    frontendDeployment: async () => {
      events.push('frontend-status');
      return stableDeployment(frontendStatuses.shift() || assert.fail('unexpected frontend status read'));
    },
    manifest: () => {
      events.push('manifest');
      return manifest;
    },
    production: async (input) => {
      events.push('production');
      assert.deepEqual(input.candidateSmoke, {
        expectedInventoryDropId: deployApiTestHooks.expectedReleaseDropId,
        forbiddenInventoryDropId: 'clear_cards_devnet',
        includeDevnet: true,
        includeNotificationSubscription: true,
        includePackStatus: true,
        includeProfileState: true,
        owner: OWNER,
      });
      await input.verifyBeforePromotion?.();
      events.push('promotion-guard-passed');
    },
    record: (versionId, options) => {
      events.push('record');
      assert.equal(versionId, candidateVersionId);
      assert.deepEqual(options.expectedCurrentProduction, { apiVersionId, frontendVersionId });
      return {
        ...manifest,
        currentProduction: { apiVersionId: versionId, frontendVersionId },
      };
    },
    triggerDryRun: (environment) => {
      assert.equal(environment.CI, 'true');
      events.push('trigger-dry-run');
    },
    upload: async (input) => {
      events.push('upload');
      assert.equal(input.candidateSmoke.includeDevnet, true);
      return {
        previewUrl: deployApiTestHooks.expectedPreviewOrigin(candidateVersionId),
        versionId: candidateVersionId,
      };
    },
    validate: () => events.push('validate'),
  });
  assert.equal(metadata.versionId, candidateVersionId);
  assert.deepEqual(events, [
    'manifest',
    'api-status',
    'frontend-status',
    'validate',
    'trigger-dry-run',
    'upload',
    'production',
    'frontend-status',
    'promotion-guard-passed',
    'api-status',
    'frontend-status',
    'record',
  ]);
});

test('complete API release refuses post-promotion pair drift and manifest-write ambiguity', async () => {
  const apiVersionId = randomUUID();
  const frontendVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const manifest = {
    ...deployApiTestHooks.readReleaseManifest(),
    currentProduction: { apiVersionId, frontendVersionId },
  };
  {
    const frontendStatuses = [frontendVersionId, randomUUID()];
    let recorded = false;
    await assert.rejects(
      () => deployApiTestHooks.runCompleteApiRelease({
        apiToken: 'scoped-token',
        checkEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        firestoreServiceAccountJson: 'firestore-test-credential',
        firestoreWriterServiceAccountJson: 'firestore-writer-test-credential',
        heliusApiKey: 'helius-test-key',
        logsDirectory: '/tmp/logs',
        smokeOwner: OWNER,
        wranglerEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
      }, {
        apiDeployment: async () => stableDeployment(apiVersionId),
        frontendDeployment: async () => stableDeployment(frontendStatuses.shift()!),
        manifest: () => manifest,
        production: async (input) => input.verifyBeforePromotion?.(),
        record: () => {
          recorded = true;
          return manifest;
        },
        triggerDryRun: () => undefined,
        upload: async () => ({
          previewUrl: deployApiTestHooks.expectedPreviewOrigin(candidateVersionId),
          versionId: candidateVersionId,
        }),
        validate: () => undefined,
      }),
      /Frontend changed before API promotion/,
    );
    assert.equal(recorded, false);
  }
  for (const finalPair of [
    { apiVersionId, frontendVersionId },
    { apiVersionId: candidateVersionId, frontendVersionId: randomUUID() },
  ]) {
    const apiStatuses = [apiVersionId, finalPair.apiVersionId];
    const frontendStatuses = [frontendVersionId, frontendVersionId, finalPair.frontendVersionId];
    let recorded = false;
    await assert.rejects(
      () => deployApiTestHooks.runCompleteApiRelease({
        apiToken: 'scoped-token',
        checkEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
        firestoreServiceAccountJson: 'firestore-test-credential',
        firestoreWriterServiceAccountJson: 'firestore-writer-test-credential',
        heliusApiKey: 'helius-test-key',
        logsDirectory: '/tmp/logs',
        smokeOwner: OWNER,
        wranglerEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
      }, {
        apiDeployment: async () => stableDeployment(apiStatuses.shift()!),
        frontendDeployment: async () => stableDeployment(frontendStatuses.shift()!),
        manifest: () => manifest,
        production: async (input) => input.verifyBeforePromotion?.(),
        record: () => {
          recorded = true;
          return manifest;
        },
        triggerDryRun: () => undefined,
        upload: async () => ({
          previewUrl: deployApiTestHooks.expectedPreviewOrigin(candidateVersionId),
          versionId: candidateVersionId,
        }),
        validate: () => undefined,
      }),
      /Release commit verification expected API/,
    );
    assert.equal(recorded, false);
  }

  const apiStatuses = [apiVersionId, candidateVersionId];
  const frontendStatuses = [frontendVersionId, frontendVersionId, frontendVersionId];
  await assert.rejects(
    () => deployApiTestHooks.runCompleteApiRelease({
      apiToken: 'scoped-token',
      checkEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
      firestoreServiceAccountJson: 'firestore-test-credential',
      firestoreWriterServiceAccountJson: 'firestore-writer-test-credential',
      heliusApiKey: 'helius-test-key',
      logsDirectory: '/tmp/logs',
      smokeOwner: OWNER,
      wranglerEnvironment: { HELIUS_API_KEY: '', RESEND_CONTACTS_API_KEY: '', NOTIFICATION_ENQUEUE_SECRET: '', FIRESTORE_SERVICE_ACCOUNT_JSON: '', ...EMPTY_NEW_API_SECRET_ENV },
    }, {
      apiDeployment: async () => stableDeployment(apiStatuses.shift()!),
      frontendDeployment: async () => stableDeployment(frontendStatuses.shift()!),
      manifest: () => manifest,
      production: async (input) => input.verifyBeforePromotion?.(),
      record: () => {
        throw new Error('injected manifest write failure');
      },
      triggerDryRun: () => undefined,
      upload: async () => ({
        previewUrl: deployApiTestHooks.expectedPreviewOrigin(candidateVersionId),
        versionId: candidateVersionId,
      }),
      validate: () => undefined,
    }),
    new RegExp(`API version ${candidateVersionId} is live and verified[\\s\\S]*release:finalize[\\s\\S]*${frontendVersionId}`),
  );
});

test('API production benchmarks the exact preview before mutation and writes evidence last', async () => {
  const baselineVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const previewUrl = deployApiTestHooks.expectedPreviewOrigin(candidateVersionId);
  const events: string[] = [];
  const smokeOptions: Array<{
    expectedInventoryDropId?: string;
    forbiddenInventoryDropId?: string;
    includeNotificationSubscription?: boolean;
    includePackStatus?: boolean;
    includeProfileState?: boolean;
  }> = [];
  const wranglerEnvironment = deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token');
  await deployApiTestHooks.runProductionSequence(
    {
      candidateSmoke: {
        expectedInventoryDropId: deployApiTestHooks.expectedReleaseDropId,
        forbiddenInventoryDropId: 'clear_cards_devnet',
        includeDevnet: true,
        includeNotificationSubscription: true,
        includePackStatus: true,
        includeProfileState: true,
        owner: OWNER,
      },
      expectedCurrentVersionId: baselineVersionId,
      heliusApiKey: 'helius-test-key',
      previewUrl,
      smokeOwner: OWNER,
      versionId: candidateVersionId,
      wranglerEnvironment,
    },
    {
      deployment: deploymentReader([
        baselineVersionId,
        baselineVersionId,
        candidateVersionId,
        candidateVersionId,
      ], events),
      smoke: async (origin, options) => {
        assert.equal(options.owner, OWNER);
        assert.equal(options.includeDevnet, true);
        smokeOptions.push(options);
        events.push(`smoke:${origin}`);
      },
      benchmark: async (options, apiKey) => {
        assert.deepEqual(options, { apiOrigin: previewUrl, includeDevnet: true, owner: OWNER, runs: 5 });
        assert.equal(apiKey, 'helius-test-key');
        events.push(`benchmark:${options.apiOrigin}`);
        return { runs: 5, workerMedianMs: 10, legacyMedianMs: 20 };
      },
      wrangler: (args, environment, label) => {
        assert.equal(environment, wranglerEnvironment);
        events.push(label);
        if (label === 'Exact version promotion') {
          assert.deepEqual(args.slice(0, 7), [
            'versions', 'deploy', '--version-id', candidateVersionId, '--percentage', '100', '--yes',
          ]);
        } else {
          assert.deepEqual(args.slice(0, 2), ['triggers', 'deploy']);
        }
      },
      evidence: (kind, evidenceVersionId) => {
        assert.equal(kind, 'api');
        assert.equal(evidenceVersionId, candidateVersionId);
        events.push(`evidence:${evidenceVersionId}`);
        return {
          schemaVersion: 1,
          kind: 'api',
          workerName: 'mons-shop-api',
          versionId: candidateVersionId,
          verifiedAt: new Date().toISOString(),
        };
      },
      sleep: async () => undefined,
    },
  );
  assert.deepEqual(events, [
    `smoke:${previewUrl}`,
    `benchmark:${previewUrl}`,
    'deployment-status',
    'Reviewed trigger deployment',
    'smoke:https://api.mons.shop',
    'deployment-status',
    'Exact version promotion',
    'deployment-status',
    'smoke:https://api.mons.shop',
    'deployment-status',
    `evidence:${candidateVersionId}`,
  ]);
  assert.deepEqual(smokeOptions.map((options) => ({
    expectedInventoryDropId: options.expectedInventoryDropId,
    forbiddenInventoryDropId: options.forbiddenInventoryDropId,
    includeNotificationSubscription: options.includeNotificationSubscription,
    includePackStatus: options.includePackStatus,
    includeProfileState: options.includeProfileState,
  })), [
    {
      expectedInventoryDropId: deployApiTestHooks.expectedReleaseDropId,
      forbiddenInventoryDropId: 'clear_cards_devnet',
      includeNotificationSubscription: true,
      includePackStatus: true,
      includeProfileState: true,
    },
    {
      expectedInventoryDropId: undefined,
      forbiddenInventoryDropId: undefined,
      includeNotificationSubscription: undefined,
      includePackStatus: undefined,
      includeProfileState: undefined,
    },
    {
      expectedInventoryDropId: deployApiTestHooks.expectedReleaseDropId,
      forbiddenInventoryDropId: 'clear_cards_devnet',
      includeNotificationSubscription: true,
      includePackStatus: true,
      includeProfileState: true,
    },
  ]);
});

test('API production benchmark failure performs no deployment mutation', async () => {
  const versionId = randomUUID();
  const previewUrl = deployApiTestHooks.expectedPreviewOrigin(versionId);
  const events: string[] = [];
  const wranglerEnvironment = deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token');
  await assert.rejects(
    () => deployApiTestHooks.runProductionSequence(
      {
        expectedCurrentVersionId: randomUUID(),
        heliusApiKey: 'helius-test-key',
        previewUrl,
        smokeOwner: OWNER,
        versionId,
        wranglerEnvironment,
      },
      {
        smoke: async (origin) => {
          if (origin !== previewUrl) assert.fail('production smoke ran after a failed benchmark');
          events.push(`smoke:${origin}`);
        },
        benchmark: async (options) => {
          events.push(`benchmark:${options.apiOrigin}`);
          throw new Error('injected benchmark failure');
        },
        deployment: async () => assert.fail('deployment state was read after a failed benchmark'),
        wrangler: () => assert.fail('Wrangler mutation ran after a failed benchmark'),
        evidence: () => assert.fail('production evidence was written after a failed benchmark'),
        sleep: async () => undefined,
      },
    ),
    /injected benchmark failure/,
  );
  assert.deepEqual(events, [`smoke:${previewUrl}`, `benchmark:${previewUrl}`]);
});

test('API trigger deployment gets exactly one declarative retry before promotion', async () => {
  const baselineVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const labels: string[] = [];
  let triggerAttempts = 0;

  await deployApiTestHooks.runProductionSequence(
    {
      expectedCurrentVersionId: baselineVersionId,
      heliusApiKey: 'helius-test-key',
      previewUrl: deployApiTestHooks.expectedPreviewOrigin(candidateVersionId),
      smokeOwner: OWNER,
      versionId: candidateVersionId,
      wranglerEnvironment: deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token'),
    },
    {
      deployment: deploymentReader([
        baselineVersionId,
        baselineVersionId,
        candidateVersionId,
        candidateVersionId,
      ]),
      smoke: async () => undefined,
      benchmark: async () => ({ runs: 5, workerMedianMs: 10, legacyMedianMs: 20 }),
      wrangler: (_args, _environment, label) => {
        labels.push(label);
        if (label.startsWith('Reviewed trigger deployment')) {
          triggerAttempts += 1;
          if (triggerAttempts === 1) throw new Error('transient API trigger failure');
        }
      },
      evidence: (_kind, versionId) => ({
        schemaVersion: 1,
        kind: 'api',
        workerName: 'mons-shop-api',
        versionId,
        verifiedAt: new Date().toISOString(),
      }),
      sleep: async () => undefined,
    },
  );
  assert.deepEqual(labels, [
    'Reviewed trigger deployment',
    'Reviewed trigger deployment retry',
    'Exact version promotion',
  ]);
});

test('API guarded resume never rolls back when its trigger retry fails', async () => {
  const candidateVersionId = randomUUID();
  const labels: string[] = [];

  await assert.rejects(
    () => deployApiTestHooks.runProductionSequence(
      {
        expectedCurrentVersionId: candidateVersionId,
        heliusApiKey: 'helius-test-key',
        previewUrl: deployApiTestHooks.expectedPreviewOrigin(candidateVersionId),
        smokeOwner: OWNER,
        versionId: candidateVersionId,
        wranglerEnvironment: deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token'),
      },
      {
        deployment: deploymentReader([candidateVersionId]),
        smoke: async () => undefined,
        benchmark: async () => ({ runs: 5, workerMedianMs: 10, legacyMedianMs: 20 }),
        wrangler: (_args, _environment, label) => {
          labels.push(label);
          if (label === 'API compensating rollback') assert.fail('guarded resume attempted rollback');
          throw new Error('injected resumed API trigger failure');
        },
        evidence: () => assert.fail('guarded resume wrote evidence after failed triggers'),
        sleep: async () => undefined,
      },
    ),
    /already live[\s\S]*Automatic rollback was suppressed/,
  );
  assert.deepEqual(labels, ['Reviewed trigger deployment', 'Reviewed trigger deployment retry']);
});

test('API guarded resume never rolls back when candidate verification fails', async () => {
  const candidateVersionId = randomUUID();
  const labels: string[] = [];
  let smokeCalls = 0;

  await assert.rejects(
    () => deployApiTestHooks.runProductionSequence(
      {
        expectedCurrentVersionId: candidateVersionId,
        heliusApiKey: 'helius-test-key',
        previewUrl: deployApiTestHooks.expectedPreviewOrigin(candidateVersionId),
        smokeOwner: OWNER,
        versionId: candidateVersionId,
        wranglerEnvironment: deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token'),
      },
      {
        deployment: deploymentReader([candidateVersionId]),
        smoke: async () => {
          smokeCalls += 1;
          if (smokeCalls === 2) throw new Error('injected resumed API smoke failure');
        },
        benchmark: async () => ({ runs: 5, workerMedianMs: 10, legacyMedianMs: 20 }),
        wrangler: (_args, _environment, label) => {
          labels.push(label);
          if (label === 'API compensating rollback') assert.fail('guarded resume attempted rollback');
        },
        evidence: () => assert.fail('guarded resume wrote evidence after failed smoke'),
        sleep: async () => undefined,
      },
    ),
    /already live[\s\S]*Automatic rollback was suppressed/,
  );
  assert.deepEqual(labels, ['Reviewed trigger deployment']);
});

test('API recovery confirms the candidate immediately before exact rollback and verifies baseline', async () => {
  const baselineVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const promotionError = new Error('injected API promotion failure');
  const labels: string[] = [];
  const statusEvents: string[] = [];

  await assert.rejects(
    () => deployApiTestHooks.runProductionSequence(
      {
        expectedCurrentVersionId: baselineVersionId,
        heliusApiKey: 'helius-test-key',
        previewUrl: deployApiTestHooks.expectedPreviewOrigin(candidateVersionId),
        smokeOwner: OWNER,
        versionId: candidateVersionId,
        wranglerEnvironment: deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token'),
      },
      {
        deployment: deploymentReader([
          baselineVersionId,
          baselineVersionId,
          candidateVersionId,
          candidateVersionId,
          candidateVersionId,
          baselineVersionId,
          baselineVersionId,
        ], statusEvents),
        smoke: async () => undefined,
        benchmark: async () => ({ runs: 5, workerMedianMs: 10, legacyMedianMs: 20 }),
        wrangler: (args, _environment, label) => {
          labels.push(label);
          if (label === 'Exact version promotion') throw promotionError;
          if (label === 'API compensating rollback') {
            assert.equal(statusEvents.length, 5);
            assert.deepEqual(args, [
              'rollback',
              baselineVersionId,
              '--yes',
              '--message',
              'Automatic recovery after failed mons-shop-api release',
              '--config',
              'cloud/workers/api/wrangler.jsonc',
              '--env-file',
              'cloud/workers/api/release.env',
            ]);
          }
        },
        evidence: () => assert.fail('API recovery wrote production evidence'),
        sleep: async () => undefined,
      },
    ),
    (error) => error === promotionError,
  );
  assert.equal(statusEvents.length, 7);
  assert.deepEqual(labels, [
    'Reviewed trigger deployment',
    'Exact version promotion',
    'API compensating rollback',
  ]);
});

test('API recovery verifies a committed rollback while retaining the rollback command failure', async () => {
  const baselineVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const promotionError = new Error('injected API promotion failure');
  const rollbackError = new CloudflareProcessFailure('injected API rollback command failure', 19);
  const statusEvents: string[] = [];
  let smokeCalls = 0;

  await assert.rejects(
    () => deployApiTestHooks.runProductionSequence(
      {
        expectedCurrentVersionId: baselineVersionId,
        heliusApiKey: 'helius-test-key',
        previewUrl: deployApiTestHooks.expectedPreviewOrigin(candidateVersionId),
        smokeOwner: OWNER,
        versionId: candidateVersionId,
        wranglerEnvironment: deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token'),
      },
      {
        deployment: deploymentReader([
          baselineVersionId,
          baselineVersionId,
          candidateVersionId,
          candidateVersionId,
          candidateVersionId,
          baselineVersionId,
          baselineVersionId,
        ], statusEvents),
        smoke: async () => {
          smokeCalls += 1;
        },
        benchmark: async () => ({ runs: 5, workerMedianMs: 10, legacyMedianMs: 20 }),
        wrangler: (_args, _environment, label) => {
          if (label === 'Exact version promotion') throw promotionError;
          if (label === 'API compensating rollback') throw rollbackError;
        },
        evidence: () => assert.fail('ambiguous rollback wrote production evidence'),
        sleep: async () => undefined,
      },
    ),
    (error) => error instanceof AggregateError &&
      /baseline recovery was verified, but the rollback command reported failure/.test(error.message) &&
      error.errors[0] === promotionError &&
      error.errors[1] === rollbackError &&
      cloudflareReleaseExitCode(error) === 19,
  );
  assert.equal(statusEvents.length, 7);
  assert.equal(smokeCalls, 3);
});

test('API refuses rollback when failed promotion has any unreadable baseline observation', async () => {
  const baselineVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const labels: string[] = [];
  const sleeps: number[] = [];

  await assert.rejects(
    () => deployApiTestHooks.runProductionSequence(
      {
        expectedCurrentVersionId: baselineVersionId,
        heliusApiKey: 'helius-test-key',
        previewUrl: deployApiTestHooks.expectedPreviewOrigin(candidateVersionId),
        smokeOwner: OWNER,
        versionId: candidateVersionId,
        wranglerEnvironment: deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token'),
      },
      {
        deployment: deploymentReader([
          baselineVersionId,
          baselineVersionId,
          baselineVersionId,
          new Error('injected unreadable deployment state'),
          baselineVersionId,
          baselineVersionId,
        ]),
        smoke: async () => undefined,
        benchmark: async () => ({ runs: 5, workerMedianMs: 10, legacyMedianMs: 20 }),
        wrangler: (_args, _environment, label) => {
          labels.push(label);
          if (label === 'Exact version promotion') throw new Error('injected API promotion failure');
          if (label === 'API compensating rollback') assert.fail('unreadable state was overwritten');
        },
        evidence: () => assert.fail('unreadable release wrote production evidence'),
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      },
    ),
    /live mutation state could not be safely reconciled/,
  );
  assert.deepEqual(labels, ['Reviewed trigger deployment', 'Exact version promotion']);
  assert.deepEqual(sleeps, [500, 1_500, 3_000]);
});

test('API successful promotion command reports manual intervention for ambiguous live state', async () => {
  const baselineVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const labels: string[] = [];

  await assert.rejects(
    () => deployApiTestHooks.runProductionSequence(
      {
        expectedCurrentVersionId: baselineVersionId,
        heliusApiKey: 'helius-test-key',
        previewUrl: deployApiTestHooks.expectedPreviewOrigin(candidateVersionId),
        smokeOwner: OWNER,
        versionId: candidateVersionId,
        wranglerEnvironment: deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token'),
      },
      {
        deployment: deploymentReader([
          baselineVersionId,
          baselineVersionId,
          splitDeployment(baselineVersionId, candidateVersionId),
        ]),
        smoke: async () => undefined,
        benchmark: async () => ({ runs: 5, workerMedianMs: 10, legacyMedianMs: 20 }),
        wrangler: (_args, _environment, label) => {
          labels.push(label);
          if (label === 'API compensating rollback') assert.fail('ambiguous split state was overwritten');
        },
        evidence: () => assert.fail('ambiguous split state wrote production evidence'),
        sleep: async () => undefined,
      },
    ),
    /No blind rollback was attempted; inspect deployment status and recover manually/,
  );
  assert.deepEqual(labels, ['Reviewed trigger deployment', 'Exact version promotion']);
});

test('API refuses split or third-version state before any mutation', async () => {
  const baselineVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  for (const initialState of [
    splitDeployment(baselineVersionId, candidateVersionId),
    stableDeployment(randomUUID()),
  ]) {
    await assert.rejects(
      () => deployApiTestHooks.runProductionSequence(
        {
          expectedCurrentVersionId: baselineVersionId,
          heliusApiKey: 'helius-test-key',
          previewUrl: deployApiTestHooks.expectedPreviewOrigin(candidateVersionId),
          smokeOwner: OWNER,
          versionId: candidateVersionId,
          wranglerEnvironment: deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token'),
        },
        {
          deployment: deploymentReader([initialState]),
          smoke: async () => undefined,
          benchmark: async () => ({ runs: 5, workerMedianMs: 10, legacyMedianMs: 20 }),
          wrangler: () => assert.fail('unsafe initial state was mutated'),
          evidence: () => assert.fail('unsafe initial state wrote evidence'),
          sleep: async () => undefined,
        },
      ),
      /not a stable single-version deployment|matched neither tracked production/,
    );
  }
});

test('API evidence failure never rolls back and directs a guarded-resume rerun', async () => {
  const baselineVersionId = randomUUID();
  const candidateVersionId = randomUUID();
  const labels: string[] = [];

  await assert.rejects(
    () => deployApiTestHooks.runProductionSequence(
      {
        expectedCurrentVersionId: baselineVersionId,
        heliusApiKey: 'helius-test-key',
        previewUrl: deployApiTestHooks.expectedPreviewOrigin(candidateVersionId),
        smokeOwner: OWNER,
        versionId: candidateVersionId,
        wranglerEnvironment: deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token'),
      },
      {
        deployment: deploymentReader([candidateVersionId, candidateVersionId]),
        smoke: async () => undefined,
        benchmark: async () => ({ runs: 5, workerMedianMs: 10, legacyMedianMs: 20 }),
        wrangler: (_args, _environment, label) => {
          labels.push(label);
          if (label.includes('rollback') || label.includes('promotion')) {
            assert.fail('guarded API evidence retry mutated the live version');
          }
        },
        evidence: () => {
          throw new Error('injected API evidence failure');
        },
        sleep: async () => undefined,
      },
    ),
    /remains live and verified[\s\S]*rerun the same production command[\s\S]*guarded resume/,
  );
  assert.deepEqual(labels, ['Reviewed trigger deployment']);
});

test('temporary secret setup enforces modes and removes partial files after injected failures', () => {
  const previousSecret = process.env.HELIUS_API_KEY;
  process.env.HELIUS_API_KEY = 'release-test-secret';
  try {
    const secretFile = deployApiTestHooks.createSecretFile(
      deployApiTestHooks.secretFileOperations,
      'release-test-secret',
      FIRESTORE_SERVICE_ACCOUNT_JSON,
      FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON,
    );
    assert.equal(statSync(secretFile.directory).mode & 0o777, 0o700);
    assert.equal(statSync(secretFile.path).mode & 0o777, 0o600);
    const storedSecrets = JSON.parse(readFileSync(secretFile.path, 'utf8'));
    assert.equal(storedSecrets.HELIUS_API_KEY, 'release-test-secret');
    assert.equal(storedSecrets.FIRESTORE_SERVICE_ACCOUNT_JSON, FIRESTORE_SERVICE_ACCOUNT_JSON);
    assert.equal(storedSecrets.FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON, FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON);
    secretFile.dispose();
    assert.equal(existsSync(secretFile.directory), false);

    let partialDirectory = '';
    const operations = {
      ...deployApiTestHooks.secretFileOperations,
      mkdtemp: (prefix: string) => {
        partialDirectory = deployApiTestHooks.secretFileOperations.mkdtemp(prefix);
        return partialDirectory;
      },
      stat: (path: string) => {
        if (String(path).endsWith('/secrets.json')) throw new Error('injected setup failure');
        return deployApiTestHooks.secretFileOperations.stat(path);
      },
    };
    assert.throws(
      () => deployApiTestHooks.createSecretFile(
        operations,
        'release-test-secret',
        FIRESTORE_SERVICE_ACCOUNT_JSON,
        FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON,
      ),
      /injected setup failure/,
    );
    assert.equal(existsSync(partialDirectory), false);

    let cleanupDirectory = '';
    const cleanupFailureOperations = {
      ...operations,
      mkdtemp: (prefix: string) => {
        cleanupDirectory = deployApiTestHooks.secretFileOperations.mkdtemp(prefix);
        return cleanupDirectory;
      },
      remove: () => {
        throw new Error('injected cleanup failure');
      },
    };
    assert.throws(
      () => deployApiTestHooks.createSecretFile(
        cleanupFailureOperations,
        'release-test-secret',
        FIRESTORE_SERVICE_ACCOUNT_JSON,
        FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON,
      ),
      (error) => error instanceof AggregateError && error.errors.length === 2,
    );
    assert.equal(existsSync(cleanupDirectory), true);
    deployApiTestHooks.removeSecretDirectory(cleanupDirectory);
  } finally {
    if (previousSecret === undefined) Reflect.deleteProperty(process.env, 'HELIUS_API_KEY');
    else process.env.HELIUS_API_KEY = previousSecret;
  }
});

test('Firestore viewer credential input is exact, private, and compacted before upload', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mons-firestore-viewer-test-'));
  const path = join(directory, 'viewer.json');
  try {
    writeFileSync(path, JSON.stringify({
      type: 'service_account',
      project_id: 'mons-shop',
      client_email: 'mons-shop-cloudflare-reader@mons-shop.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\ntest-key\n-----END PRIVATE KEY-----\n',
      private_key_id: 'not-forwarded',
    }), { mode: 0o600 });
    assert.equal(deployApiTestHooks.readFirestoreServiceAccount(path), FIRESTORE_SERVICE_ACCOUNT_JSON);
    assert.equal(deployApiTestHooks.validateFirestoreServiceAccountJson(FIRESTORE_SERVICE_ACCOUNT_JSON), FIRESTORE_SERVICE_ACCOUNT_JSON);
    chmodSync(path, 0o644);
    assert.throws(() => deployApiTestHooks.readFirestoreServiceAccount(path), /permissions/);
    assert.throws(
      () => deployApiTestHooks.validateFirestoreServiceAccountJson(FIRESTORE_SERVICE_ACCOUNT_JSON.replace(
        'mons-shop-cloudflare-reader',
        'firebase-adminsdk',
      )),
      /mons-shop-cloudflare-reader/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Firestore writer credential input is exact, private, and distinct from the reader', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mons-firestore-writer-test-'));
  const path = join(directory, 'writer.json');
  try {
    writeFileSync(path, JSON.stringify({
      type: 'service_account',
      project_id: 'mons-shop',
      client_email: 'mons-shop-cloudflare-writer@mons-shop.iam.gserviceaccount.com',
      private_key: FIRESTORE_WRITER_PRIVATE_KEY,
      private_key_id: 'not-forwarded',
    }), { mode: 0o600 });
    assert.equal(deployApiTestHooks.readFirestoreWriterServiceAccount(path), FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON);
    assert.equal(
      deployApiTestHooks.validateFirestoreWriterServiceAccountJson(FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON),
      FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON,
    );
    assert.throws(
      () => deployApiTestHooks.validateFirestoreWriterServiceAccountJson(FIRESTORE_SERVICE_ACCOUNT_JSON),
      /mons-shop-cloudflare-writer/,
    );
    assert.throws(
      () => deployApiTestHooks.validateFirestoreWriterServiceAccountJson(JSON.stringify({
        project_id: 'mons-shop',
        client_email: 'mons-shop-cloudflare-writer@mons-shop.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----\n',
      })),
      /valid PKCS8 private key/,
    );
    chmodSync(path, 0o644);
    assert.throws(() => deployApiTestHooks.readFirestoreWriterServiceAccount(path), /permissions/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Firestore writer preflight verifies OAuth and database write access without creating data', async () => {
  const requests: Array<{ method: string; url: URL }> = [];
  await deployApiTestHooks.verifyFirestoreWriterAccess(
    FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON,
    async (input, init) => {
      const url = new URL(String(input));
      requests.push({ method: String(init?.method), url });
      if (url.href === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: 'writer-token', token_type: 'Bearer', expires_in: 3600 });
      }
      assert.equal(init?.method, 'DELETE');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer writer-token');
      assert.match(url.pathname, /\/databases\/\(default\)\/documents\/cloudflareReleaseChecks\//);
      assert.equal(url.searchParams.get('currentDocument.exists'), 'false');
      return Response.json({});
    },
  );
  assert.deepEqual(requests.map(({ method }) => method), ['POST', 'DELETE']);

  await assert.rejects(
    deployApiTestHooks.verifyFirestoreWriterAccess(
      FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON,
      async (input) => String(input) === 'https://oauth2.googleapis.com/token'
        ? Response.json({ access_token: 'writer-token' })
        : Response.json({}, { status: 403 }),
    ),
    /Firestore writer access verification failed/,
  );
});

test('release CLI requires exact production version metadata', () => {
  const versionId = randomUUID();
  assert.deepEqual(
    deployApiTestHooks.parseArgs(['production', '--version-id', versionId, '--smoke-owner', OWNER]),
    {
      firestoreServiceAccountFile: undefined,
      firestoreWriterServiceAccountFile: undefined,
      mode: 'production',
      versionId,
      smokeOwner: OWNER,
      tokenFile: undefined,
    },
  );
  assert.throws(
    () => deployApiTestHooks.parseArgs(['production', '--version-id', 'latest', '--smoke-owner', OWNER]),
    /exact UUID/,
  );
});

test('release CLI requires separate Firestore reader and writer credentials for candidate uploads', () => {
  assert.throws(() => deployApiTestHooks.parseArgs([]), /firestore-service-account-file/);
  assert.throws(() => deployApiTestHooks.parseArgs(['release']), /firestore-service-account-file/);
  assert.throws(() => deployApiTestHooks.parseArgs([
    'release',
    '--firestore-service-account-file',
    '/tmp/firestore-reader.json',
  ]), /firestore-writer-service-account-file/);
  assert.deepEqual(deployApiTestHooks.parseArgs([
    'release',
    '--firestore-service-account-file',
    '/tmp/firestore-reader.json',
    '--firestore-writer-service-account-file',
    '/tmp/firestore-writer.json',
  ]), {
    firestoreServiceAccountFile: '/tmp/firestore-reader.json',
    firestoreWriterServiceAccountFile: '/tmp/firestore-writer.json',
    mode: 'release',
    smokeOwner: deployApiTestHooks.defaultSmokeOwner,
    tokenFile: undefined,
    versionId: undefined,
  });
  assert.deepEqual(deployApiTestHooks.parseArgs([
    '--firestore-service-account-file',
    '/tmp/firestore-reader.json',
    '--firestore-writer-service-account-file',
    '/tmp/firestore-writer.json',
    '--smoke-owner',
    OWNER,
  ]), {
    firestoreServiceAccountFile: '/tmp/firestore-reader.json',
    firestoreWriterServiceAccountFile: '/tmp/firestore-writer.json',
    mode: 'release',
    smokeOwner: OWNER,
    tokenFile: undefined,
    versionId: undefined,
  });
  assert.throws(
    () => deployApiTestHooks.parseArgs([
      'release',
      '--firestore-service-account-file',
      '/tmp/firestore-reader.json',
      '--firestore-writer-service-account-file',
      '/tmp/firestore-writer.json',
      '--version-id',
      randomUUID(),
    ]),
    /not valid in release mode/,
  );
  assert.throws(
    () => deployApiTestHooks.parseArgs([
      'production',
      '--firestore-service-account-file',
      '/tmp/firestore-reader.json',
      '--version-id',
      randomUUID(),
      '--smoke-owner',
      OWNER,
    ]),
    /not valid in production mode/,
  );
});

test('API release resolves the Helius key without exposing it as an argument', () => {
  assert.equal(deployApiTestHooks.resolveHeliusApiKey({}), '');
  assert.equal(deployApiTestHooks.resolveHeliusApiKey({ VITE_HELIUS_API_KEY: 'browser-secret' }), '');
  assert.equal(deployApiTestHooks.resolveHeliusApiKey({ HELIUS_API_KEY: ' server-secret ' }), 'server-secret');
});

test('tracked release metadata is exact and excludes direct-Helius frontend rollback', () => {
  const manifest = deployApiTestHooks.readReleaseManifest();
  assert.equal(deployApiTestHooks.isReleaseManifest(manifest), true);
  assert.deepEqual(manifest.approvedRollback, {
    apiVersionId: '91ca69bb-c4ba-4ebf-b3d0-a12528b11910',
    frontendVersionId: 'ea8e4a16-d46e-4c5b-beb7-cfd44a40630d',
  });
  assert.equal(manifest.allowDirectHeliusFrontendRollback, false);
});

test('release finalization requires both explicit IDs and deliberate confirmation', () => {
  const apiVersionId = randomUUID();
  const frontendVersionId = randomUUID();
  assert.deepEqual(
    parseFinalizeReleaseArgs([
      '--api-version-id',
      apiVersionId,
      '--frontend-version-id',
      frontendVersionId,
      '--confirm',
    ]),
    { apiVersionId, frontendVersionId, confirm: true },
  );
  assert.throws(
    () => parseFinalizeReleaseArgs([
      '--api-version-id',
      apiVersionId,
      '--frontend-version-id',
      frontendVersionId,
    ]),
    /without --confirm/,
  );
});

test('release finalization atomically updates production IDs while preserving rollback metadata', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mons-shop-release-manifest-test-'));
  const path = join(directory, 'release-manifest.json');
  const evidenceDirectory = join(directory, 'evidence');
  const before = deployApiTestHooks.readReleaseManifest();
  const apiVersionId = randomUUID();
  const frontendVersionId = randomUUID();
  const now = new Date('2026-08-10T12:34:56.000Z');
  try {
    writeFileSync(path, `${JSON.stringify(before, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 });
    assert.throws(
      () => finalizeReleaseManifest(
        { apiVersionId, frontendVersionId },
        { evidenceDirectory, manifestPath: path, now },
      ),
      /requires api evidence/,
    );
    const apiEvidence = writeProductionEvidence('api', apiVersionId, { directory: evidenceDirectory, now });
    const frontendEvidence = writeProductionEvidence('frontend', frontendVersionId, { directory: evidenceDirectory, now });
    assert.equal(isProductionEvidence(apiEvidence, 'api', apiVersionId, now), true);
    assert.equal(isProductionEvidence(frontendEvidence, 'frontend', frontendVersionId, now), true);
    assert.equal(isProductionEvidence(apiEvidence, 'api', apiVersionId, new Date(now.getTime() + 25 * 60 * 60 * 1000)), false);
    const after = finalizeReleaseManifest(
      { apiVersionId, frontendVersionId },
      { evidenceDirectory, manifestPath: path, now },
    );
    assert.deepEqual(after.currentProduction, { apiVersionId, frontendVersionId });
    assert.equal(after.recordedAt, now.toISOString());
    assert.deepEqual(after.approvedRollback, before.approvedRollback);
    assert.equal(after.allowDirectHeliusFrontendRollback, false);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), after);
    assert.deepEqual(readdirSync(directory).sort(), ['evidence', 'release-manifest.json']);
    assert.equal(statSync(path).mode & 0o777, 0o640);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('one-step API release advances only the verified API production baseline', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mons-shop-api-release-manifest-test-'));
  const path = join(directory, 'release-manifest.json');
  const evidenceDirectory = join(directory, 'evidence');
  const before = deployApiTestHooks.readReleaseManifest();
  const apiVersionId = randomUUID();
  const now = new Date('2026-08-11T12:34:56.000Z');
  try {
    writeFileSync(path, `${JSON.stringify(before, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 });
    assert.throws(
      () => recordApiProductionVersion(apiVersionId, {
        evidenceDirectory,
        expectedCurrentProduction: before.currentProduction,
        manifestPath: path,
        now,
      }),
      /requires api evidence/,
    );
    writeProductionEvidence('api', apiVersionId, { directory: evidenceDirectory, now });
    assert.throws(
      () => recordApiProductionVersion(apiVersionId, {
        evidenceDirectory,
        expectedCurrentProduction: {
          ...before.currentProduction,
          apiVersionId: randomUUID(),
        },
        manifestPath: path,
        now,
      }),
      /changed during deployment/,
    );
    assert.throws(
      () => recordApiProductionVersion(apiVersionId, {
        evidenceDirectory,
        expectedCurrentProduction: {
          ...before.currentProduction,
          frontendVersionId: randomUUID(),
        },
        manifestPath: path,
        now,
      }),
      /changed during deployment/,
    );
    const after = recordApiProductionVersion(apiVersionId, {
      evidenceDirectory,
      expectedCurrentProduction: before.currentProduction,
      manifestPath: path,
      now,
    });
    assert.equal(after.currentProduction.apiVersionId, apiVersionId);
    assert.equal(after.currentProduction.frontendVersionId, before.currentProduction.frontendVersionId);
    assert.deepEqual(after.approvedRollback, before.approvedRollback);
    assert.equal(after.recordedAt, now.toISOString());
    assert.equal(statSync(path).mode & 0o777, 0o640);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), after);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('one-step frontend release advances only the verified frontend production baseline', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mons-shop-frontend-release-manifest-test-'));
  const path = join(directory, 'release-manifest.json');
  const evidenceDirectory = join(directory, 'evidence');
  const before = deployApiTestHooks.readReleaseManifest();
  const frontendVersionId = randomUUID();
  const now = new Date('2026-08-11T12:34:56.000Z');
  try {
    writeFileSync(path, `${JSON.stringify(before, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 });
    assert.throws(
      () => recordFrontendProductionVersion(frontendVersionId, {
        evidenceDirectory,
        expectedCurrentProduction: before.currentProduction,
        manifestPath: path,
        now,
      }),
      /requires frontend evidence/,
    );
    writeProductionEvidence('frontend', frontendVersionId, { directory: evidenceDirectory, now });
    assert.throws(
      () => recordFrontendProductionVersion(frontendVersionId, {
        evidenceDirectory,
        expectedCurrentProduction: {
          ...before.currentProduction,
          apiVersionId: randomUUID(),
        },
        manifestPath: path,
        now,
      }),
      /changed during deployment/,
    );
    assert.throws(
      () => recordFrontendProductionVersion(frontendVersionId, {
        evidenceDirectory,
        expectedCurrentProduction: {
          ...before.currentProduction,
          frontendVersionId: randomUUID(),
        },
        manifestPath: path,
        now,
      }),
      /changed during deployment/,
    );
    const after = recordFrontendProductionVersion(frontendVersionId, {
      evidenceDirectory,
      expectedCurrentProduction: before.currentProduction,
      manifestPath: path,
      now,
    });
    assert.equal(after.currentProduction.apiVersionId, before.currentProduction.apiVersionId);
    assert.equal(after.currentProduction.frontendVersionId, frontendVersionId);
    assert.deepEqual(after.approvedRollback, before.approvedRollback);
    assert.equal(after.allowDirectHeliusFrontendRollback, false);
    assert.equal(after.recordedAt, now.toISOString());
    assert.equal(statSync(path).mode & 0o777, 0o640);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), after);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
