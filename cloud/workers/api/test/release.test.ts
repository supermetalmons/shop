import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
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
import { randomUUID } from 'node:crypto';
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
  writeProductionEvidence,
} from '../../../../scripts/finalize-cloudflare-release.ts';

const OWNER = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';

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
    { apiOrigin: 'https://api.mons.shop', owner: OWNER, runs: 5 },
  );
});

test('candidate promotion evidence is exact, version-keyed, and owner-bound', () => {
  const versionId = randomUUID();
  const path = deployApiTestHooks.candidateRecordPath(versionId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const record = {
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

test('frontend promotion requires exact version-keyed fresh candidate evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mons-shop-frontend-candidate-test-'));
  const versionId = randomUUID();
  const now = new Date('2026-08-10T12:34:56.000Z');
  const metadata = {
    versionId,
    previewUrl: frontendDeployTestHooks.expectedFrontendPreviewOrigin(versionId),
    htmlSha256: 'a'.repeat(64),
  };
  try {
    assert.deepEqual(
      parseFrontendDeployArgs(['production', '--version-id', versionId, '--token-file', '/tmp/token']),
      { mode: 'production', versionId, tokenFile: '/tmp/token' },
    );
    assert.throws(
      () => parseFrontendDeployArgs(['production', '--token-file', '/tmp/token']),
      /requires --version-id/,
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

test('frontend production promotes the exact version before reviewed triggers', () => {
  const versionId = randomUUID();
  assert.deepEqual(frontendDeployTestHooks.frontendProductionWranglerCommands(versionId), [
    {
      label: 'Frontend exact-version promotion',
      args: [
        'versions',
        'deploy',
        '--version-id',
        versionId,
        '--percentage',
        '100',
        '--yes',
        '--config',
        'wrangler.jsonc',
      ],
    },
    {
      label: 'Frontend trigger deployment',
      args: ['triggers', 'deploy', '--config', 'wrangler.jsonc'],
    },
  ]);
  assert.deepEqual(frontendDeployTestHooks.frontendProductionOrigins, [
    'https://mons.shop',
    'https://www.mons.shop',
  ]);
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
    WRANGLER_OUTPUT_FILE_PATH: '/tmp/output',
    DOTENV_KEY: 'dotenv-secret',
  };
  const validation = deployApiTestHooks.validationEnvironment(source);
  assert.equal(validation.PATH, '/bin');
  assert.equal(validation.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(validation.CF_API_TOKEN, undefined);
  assert.equal(validation.HELIUS_API_KEY, undefined);
  assert.equal(validation.WRANGLER_OUTPUT_FILE_PATH, undefined);
  assert.equal(validation.DOTENV_KEY, undefined);
  let childEnvironment: NodeJS.ProcessEnv | undefined;
  deployApiTestHooks.runApiValidation(source, (_command, args, environment) => {
    assert.deepEqual(args, ['run', 'check:api']);
    childEnvironment = environment;
  });
  assert.equal(childEnvironment?.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(childEnvironment?.HELIUS_API_KEY, undefined);
  const authenticated = deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token', source);
  assert.equal(authenticated.CLOUDFLARE_API_TOKEN, 'scoped-token');
  assert.equal(authenticated.HELIUS_API_KEY, undefined);
  const frontendValidation = frontendDeployTestHooks.credentialFreeEnvironment({
    ...source,
    VITE_MONS_API_ORIGIN: 'https://untrusted.example',
  });
  assert.equal(frontendValidation.PATH, '/bin');
  assert.equal(frontendValidation.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(frontendValidation.CF_API_TOKEN, undefined);
  assert.equal(frontendValidation.HELIUS_API_KEY, undefined);
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
  let clock = 0;
  const result = await benchmarkApi(
    { apiOrigin: 'https://api.mons.shop', owner: OWNER, runs: 3 },
    'helius-test-key',
    {
      now: () => clock,
      workerInventory: async () => {
        calls.push('worker');
        clock += 1;
        return [];
      },
      legacyInventory: async () => {
        calls.push('legacy');
        clock += 3;
        return [];
      },
    },
  );
  assert.deepEqual(calls, ['worker', 'legacy', 'worker', 'legacy', 'legacy', 'worker', 'worker', 'legacy']);
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

test('direct benchmark retries a transient grouped failure before whole-wallet fallback', async () => {
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
  await benchmarkApiTestHooks.workerInventory('https://preview.example', OWNER, {
    clearTimer: (handle) => clearedTimers.push(handle),
    fetch: async (_input, init) => {
      assert.ok(init?.signal instanceof AbortSignal);
      return Response.json({ ok: true, items: [] });
    },
    scheduleTimer: (_callback, milliseconds) => {
      scheduledTimeouts.push(milliseconds);
      return milliseconds;
    },
  });
  assert.deepEqual(scheduledTimeouts, [benchmarkApiTestHooks.workerInventoryTimeoutMs]);
  assert.deepEqual(clearedTimers, [benchmarkApiTestHooks.workerInventoryTimeoutMs]);
});

test('API smoke grants inventory routes the Worker deadline while keeping other checks short', async () => {
  const timeouts = new Map<string, number>();
  await deployApiTestHooks.smokeApi('https://preview.example', OWNER, {
    fetchSmoke: async (url, init, _label, timeoutMs = deployApiTestHooks.defaultSmokeTimeoutMs) => {
      const pathname = new URL(url).pathname;
      const method = init.method || 'GET';
      timeouts.set(`${method}:${pathname}`, timeoutMs);
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
      if (method === 'POST' && (pathname === '/inventory' || pathname === '/pending-open-boxes')) {
        return {
          response: Response.json({ ok: true, items: [] }, { status: 200, headers }),
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
  for (const [request, timeoutMs] of timeouts) {
    if (request === 'POST:/inventory' || request === 'POST:/pending-open-boxes') continue;
    assert.equal(timeoutMs, deployApiTestHooks.defaultSmokeTimeoutMs);
  }
});

test('API production benchmarks the exact preview before mutation and writes evidence last', async () => {
  const versionId = randomUUID();
  const previewUrl = deployApiTestHooks.expectedPreviewOrigin(versionId);
  const events: string[] = [];
  const wranglerEnvironment = deployApiTestHooks.authenticatedWranglerEnvironment('scoped-token');
  await deployApiTestHooks.runProductionSequence(
    {
      heliusApiKey: 'helius-test-key',
      previewUrl,
      smokeOwner: OWNER,
      versionId,
      wranglerEnvironment,
    },
    {
      smoke: async (origin, owner) => {
        assert.equal(owner, OWNER);
        events.push(`smoke:${origin}`);
      },
      benchmark: async (options, apiKey) => {
        assert.deepEqual(options, { apiOrigin: previewUrl, owner: OWNER, runs: 5 });
        assert.equal(apiKey, 'helius-test-key');
        events.push(`benchmark:${options.apiOrigin}`);
        return { runs: 5, workerMedianMs: 10, legacyMedianMs: 20 };
      },
      wrangler: (args, environment, label) => {
        assert.equal(environment, wranglerEnvironment);
        events.push(label);
        if (label === 'Exact version promotion') {
          assert.deepEqual(args.slice(0, 7), [
            'versions', 'deploy', '--version-id', versionId, '--percentage', '100', '--yes',
          ]);
        } else {
          assert.deepEqual(args.slice(0, 2), ['triggers', 'deploy']);
        }
      },
      evidence: (kind, evidenceVersionId) => {
        assert.equal(kind, 'api');
        assert.equal(evidenceVersionId, versionId);
        events.push(`evidence:${evidenceVersionId}`);
        return {
          schemaVersion: 1,
          kind: 'api',
          workerName: 'mons-shop-api',
          versionId,
          verifiedAt: new Date().toISOString(),
        };
      },
    },
  );
  assert.deepEqual(events, [
    `smoke:${previewUrl}`,
    `benchmark:${previewUrl}`,
    'Exact version promotion',
    'Reviewed trigger deployment',
    'smoke:https://api.mons.shop',
    `evidence:${versionId}`,
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
        wrangler: () => assert.fail('Wrangler mutation ran after a failed benchmark'),
        evidence: () => assert.fail('production evidence was written after a failed benchmark'),
      },
    ),
    /injected benchmark failure/,
  );
  assert.deepEqual(events, [`smoke:${previewUrl}`, `benchmark:${previewUrl}`]);
});

test('temporary secret setup enforces modes and removes partial files after injected failures', () => {
  const previousSecret = process.env.HELIUS_API_KEY;
  process.env.HELIUS_API_KEY = 'release-test-secret';
  try {
    const secretFile = deployApiTestHooks.createSecretFile();
    assert.equal(statSync(secretFile.directory).mode & 0o777, 0o700);
    assert.equal(statSync(secretFile.path).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(secretFile.path, 'utf8')).HELIUS_API_KEY, 'release-test-secret');
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
    assert.throws(() => deployApiTestHooks.createSecretFile(operations), /injected setup failure/);
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
      () => deployApiTestHooks.createSecretFile(cleanupFailureOperations),
      (error) => error instanceof AggregateError && error.errors.length === 2,
    );
    assert.equal(existsSync(cleanupDirectory), true);
    deployApiTestHooks.removeSecretDirectory(cleanupDirectory);
  } finally {
    if (previousSecret === undefined) Reflect.deleteProperty(process.env, 'HELIUS_API_KEY');
    else process.env.HELIUS_API_KEY = previousSecret;
  }
});

test('release CLI requires exact production version metadata', () => {
  const versionId = randomUUID();
  assert.deepEqual(
    deployApiTestHooks.parseArgs(['production', '--version-id', versionId, '--smoke-owner', OWNER]),
    { mode: 'production', versionId, smokeOwner: OWNER, tokenFile: undefined },
  );
  assert.throws(
    () => deployApiTestHooks.parseArgs(['production', '--version-id', 'latest', '--smoke-owner', OWNER]),
    /exact UUID/,
  );
});

test('tracked release metadata is exact and excludes direct-Helius frontend rollback', () => {
  const manifest = deployApiTestHooks.readReleaseManifest();
  assert.equal(deployApiTestHooks.isReleaseManifest(manifest), true);
  assert.deepEqual(manifest.approvedRollback, {
    apiVersionId: '5ca5a74a-a68b-43b3-a6fb-6e218d2a3950',
    frontendVersionId: '0ffe94c8-97e7-46b1-8ae0-63c0abfddaef',
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
