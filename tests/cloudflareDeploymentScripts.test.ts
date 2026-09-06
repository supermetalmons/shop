import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createViteConfig, resolveViteClientSettings } from '../vite.config.ts';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};
const apiWrangler = JSON.parse(
  readFileSync(
    new URL('../cloud/workers/api/wrangler.jsonc', import.meta.url),
    'utf8',
  ),
) as {
  d1_databases: Array<{
    binding: string;
    database_name: string;
    database_id: string;
    migrations_dir: string;
  }>;
};

function commandStages(name: string, scripts = packageJson.scripts): string[] {
  assert.ok(scripts[name], `Missing npm script: ${name}`);
  const stages = scripts[name].split(/\s*&&\s*/).map((stage) => stage.trim());
  for (const stage of stages) {
    assert.ok(stage, `${name} has an empty command`);
    assert.doesNotMatch(stage, /[|;&<>`#\r\n]|\$\(/, `${name} must use simple commands joined by &&`);
  }
  return stages;
}

function requiredChecks(name: string, required: string[], scripts = packageJson.scripts): void {
  const checks = commandStages(name, scripts).map((stage) =>
    stage === 'npm test' ? 'test' : stage.match(/^npm run ([\w:-]+)(?:\s|$)/)?.[1],
  );
  for (const check of required) assert.ok(checks.includes(check), `${name} must run ${check}`);
}

function wranglerOptions(tokens: string[]): Map<string, string | true> {
  const valueOptions = new Set(['--config', '--env-file', '--outfile']);
  const flagOptions = new Set(['--strict', '--dry-run', '--remote']);
  const options = new Map<string, string | true>();
  for (let index = 0; index < tokens.length; index += 1) {
    const [name, ...parts] = tokens[index].split('=');
    assert.ok(valueOptions.has(name) || flagOptions.has(name), `Unsupported Wrangler option: ${name}`);
    assert.ok(!options.has(name), `${name} must not be repeated`);
    const inlineValue = parts.length ? parts.join('=') : undefined;
    if (valueOptions.has(name)) {
      const value = inlineValue ?? tokens[++index];
      assert.ok(value && !value.startsWith('-'), `${name} requires one value`);
      options.set(name, value);
    } else {
      assert.ok(inlineValue === undefined || inlineValue === 'true', `${name} must be enabled`);
      options.set(name, true);
    }
  }
  return options;
}

function deploymentStage(name: string, scripts = packageJson.scripts) {
  const stages = commandStages(name, scripts);
  const positions = stages.flatMap((stage, index) => /(?:^|\s)wrangler\s+deploy(?:\s|$)/.test(stage) ? [index] : []);
  assert.equal(positions.length, 1, `${name} must have exactly one deployment stage`);
  const position = positions[0];
  const tokens = stages[position].split(/\s+/);
  assert.deepEqual(tokens.slice(0, 2), ['wrangler', 'deploy']);
  return { stages, position, options: wranglerOptions(tokens.slice(2)) };
}

test('release gates retain required validation without fixing command formatting or patch versions', () => {
  assert.match(packageJson.devDependencies.wrangler, /^\d+\.\d+\.\d+$/);
  requiredChecks('check:frontend', [
    'types:frontend-worker:check', 'typecheck:frontend-worker', 'test:frontend-worker',
    'typecheck', 'test:shop-api', 'test:card-nft-2-common-ids', 'test', 'build', 'validate:browser-bundle',
  ]);
  requiredChecks('check:api', [
    'types:api:check', 'typecheck:api', 'test:api', 'test:api:runtime', 'dry-run:api', 'startup:api',
  ]);
  requiredChecks('check', [
    'types:frontend-worker:check', 'typecheck:frontend-worker', 'test:frontend-worker',
    'typecheck', 'check:api', 'typecheck:tools', 'check:dead-code', 'test', 'test:onchain',
    'build', 'validate:browser-bundle',
  ]);
  for (const name of ['check:frontend', 'check']) {
    const stages = commandStages(name);
    const build = stages.indexOf('npm run build');
    const validation = stages.indexOf('npm run validate:browser-bundle');
    assert.ok(
      build >= 0 && validation > build,
      `${name} must build before validating its browser bundle`,
    );
  }
  for (const [name, testFiles] of [
    ['test:shop-api', ['tests/api/shopApiClient.test.ts']],
    ['test:card-nft-2-common-ids', ['tests/api/cardNft2CommonIds.test.ts']],
    ['test:api', ['cloud/workers/api/test/*.test.ts', 'tests/api/*.test.ts']],
  ] as const) {
    const tokens = packageJson.scripts[name].split(/\s+/);
    assert.ok(tokens.includes('--test'), `${name} must execute tests`);
    for (const file of testFiles) assert.ok(tokens.includes(file), `${name} must cover ${file}`);
  }
});

function assertPublicationPolicy(scripts = packageJson.scripts) {
  for (const [name, config, envFile, prerequisite] of [
    ['deploy', 'wrangler.jsonc', 'cloud/workers/frontend/release.env', 'check:frontend'],
    ['deploy:api', 'cloud/workers/api/wrangler.jsonc', 'cloud/workers/api/release.env', 'check:api'],
  ]) {
    const { stages, position, options } = deploymentStage(name, scripts);
    requiredChecks(name, [prerequisite], scripts);
    assert.equal(position, stages.length - 1);
    const prerequisitePosition = stages.indexOf(`npm run ${prerequisite}`);
    assert.ok(prerequisitePosition >= 0 && prerequisitePosition < position);
    assert.equal(options.get('--strict'), true);
    assert.ok(!options.has('--dry-run'));
    assert.equal(options.get('--config'), config);
    assert.equal(options.get('--env-file'), envFile);
  }

  const stages = commandStages('deploy:api', scripts);
  const checks = ['check:api', 'db:migrate:api', 'check:pack-status-d1', 'check:ops-d1', 'check:commerce-d1'];
  let previous = -1;
  for (const check of checks) {
    const position = stages.findIndex((stage) => stage === `npm run ${check}` || stage.startsWith(`npm run ${check} `));
    assert.ok(position > previous, `${check} must run in order before publication`);
    previous = position;
  }
  assert.ok(stages[previous].split(/\s+/).includes('--for-deployment'));
}

test('publication uses strict native Wrangler with isolated production configuration after checks', () => {
  assertPublicationPolicy();
});

function assertDryRunPolicy(scripts = packageJson.scripts) {
  requiredChecks('dry-run:frontend', ['check:frontend'], scripts);
  for (const [name, config, envFile] of [
    ['dry-run:frontend', 'wrangler.jsonc', 'cloud/workers/frontend/release.env'],
    ['dry-run:api', 'cloud/workers/api/wrangler.jsonc', 'cloud/workers/api/release.env'],
  ]) {
    const { stages, position, options } = deploymentStage(name, scripts);
    if (name === 'dry-run:frontend') {
      const prerequisitePosition = stages.indexOf('npm run check:frontend');
      assert.ok(prerequisitePosition >= 0 && prerequisitePosition < position);
    }
    assert.equal(options.get('--dry-run'), true);
    assert.equal(options.get('--config'), config);
    assert.equal(options.get('--env-file'), envFile);
    if (name === 'dry-run:api') {
      const output = options.get('--outfile');
      assert.ok(typeof output === 'string' && output);
      const validation = stages.slice(position + 1).find((stage) =>
        stage.split(/\s+/).includes('scripts/validate-api-bundle.ts'),
      );
      assert.deepEqual(validation?.split(/\s+/), [
        'node', '--experimental-strip-types', 'scripts/validate-api-bundle.ts', output,
      ]);
    }
  }
}

test('dry runs cannot publish and keep API bundle validation tied to their output', () => {
  assertDryRunPolicy();
});

test('release policies reject ignored prerequisite failures and missing checks', () => {
  for (const [name, prerequisite, policy] of [
    ['deploy', 'npm run check:frontend', assertPublicationPolicy],
    ['deploy:api', 'npm run check:commerce-d1 -- --for-deployment', assertPublicationPolicy],
    ['dry-run:frontend', 'npm run check:frontend', assertDryRunPolicy],
  ] as const) {
    for (const replacement of [`${prerequisite} || true`, `${prerequisite}; true`, `${prerequisite} & true`, 'true']) {
      assert.throws(() => policy({
        ...packageJson.scripts,
        [name]: packageJson.scripts[name].replace(prerequisite, replacement),
      }), assert.AssertionError);
    }
  }
});

test('dry-run policy rejects false, negated, and duplicate flags', () => {
  for (const name of ['dry-run:frontend', 'dry-run:api']) {
    for (const replacement of [
      '', '--dry-run false', '--dry-run=false', '--no-dry-run',
      '--dry-run --dry-run=false', '--dry-run --no-dry-run', '--dry-run --dry-run',
      '--dryRun', '--dry-run --dryRun=false', '--dry-run --no-dryRun',
      '--dry-run -- --no-dry-run',
    ]) {
      assert.throws(() => assertDryRunPolicy({
        ...packageJson.scripts,
        [name]: packageJson.scripts[name].replace('--dry-run', replacement),
      }), assert.AssertionError);
    }
    assert.doesNotThrow(() => assertDryRunPolicy({
      ...packageJson.scripts,
      [name]: packageJson.scripts[name].replace('--dry-run', '--dry-run=true'),
    }));
  }
  assert.throws(() => assertDryRunPolicy({
    ...packageJson.scripts,
    'dry-run:frontend': `${packageJson.scripts['dry-run:frontend'].replace('--dry-run ', '')} # --dry-run`,
  }), assert.AssertionError);
});

test('release policies reject additional or aliased Wrangler options', () => {
  for (const [name, policy] of [
    ['deploy', assertPublicationPolicy],
    ['deploy:api', assertPublicationPolicy],
    ['dry-run:frontend', assertDryRunPolicy],
    ['dry-run:api', assertDryRunPolicy],
  ] as const) {
    for (const extra of [
      '--env-file .env.local', '--env-file=.env.local', '--envFile .env.local',
      '--config other.jsonc', '-c other.jsonc', '--unknown', '--', '.env.local',
    ]) {
      const { stages, position } = deploymentStage(name);
      stages[position] += ` ${extra}`;
      assert.throws(() => policy({
        ...packageJson.scripts,
        [name]: stages.join(' && '),
      }), assert.AssertionError);
    }
    assert.doesNotThrow(() => policy({
      ...packageJson.scripts,
      [name]: packageJson.scripts[name].replace('--env-file ', '--env-file='),
    }));
  }
});

test('API bundle validation must execute the validator against the built output', () => {
  const invocation = 'node --experimental-strip-types scripts/validate-api-bundle.ts';
  for (const replacement of [
    'echo scripts/validate-api-bundle.ts',
    'node --check scripts/validate-api-bundle.ts',
    `${invocation} .cache/stale-api.js`,
  ]) {
    assert.throws(() => assertDryRunPolicy({
      ...packageJson.scripts,
      'dry-run:api': packageJson.scripts['dry-run:api'].replace(invocation, replacement),
    }), assert.AssertionError);
  }
});

test('database migrations retain separate production targets before API publication', () => {
  requiredChecks('db:migrate:api', ['db:migrate:data', 'db:migrate:ops', 'db:migrate:commerce']);
  for (const database of ['data', 'ops', 'commerce']) {
    const stages = commandStages(`db:migrate:${database}`);
    assert.equal(stages.length, 1);
    const tokens = stages[0].split(/\s+/);
    assert.deepEqual(tokens.slice(0, 5), ['wrangler', 'd1', 'migrations', 'apply', `mons-shop-${database}`]);
    const options = wranglerOptions(tokens.slice(5));
    assert.equal(options.get('--remote'), true);
    assert.equal(options.get('--config'), 'cloud/workers/api/wrangler.jsonc');
    assert.equal(options.get('--env-file'), 'cloud/workers/api/release.env');
  }
});

test('API Worker binds separate data, ops, and commerce D1 baselines', () => {
  assert.deepEqual(apiWrangler.d1_databases, [
    {
      binding: 'DATA_DB',
      database_name: 'mons-shop-data',
      database_id: '4b09f942-b0c6-4a1e-81df-cb802fbf7099',
      migrations_dir: 'migrations',
    },
    {
      binding: 'OPS_DB',
      database_name: 'mons-shop-ops',
      database_id: '6f8f6e7e-e6b1-4e1d-bd68-ece26fd918d5',
      migrations_dir: 'ops-migrations',
    },
    {
      binding: 'COMMERCE_DB',
      database_name: 'mons-shop-commerce',
      database_id: 'b9ff0689-3433-47f2-84c1-64677fe85db1',
      migrations_dir: 'commerce-migrations',
    },
  ]);
});

test('production Vite builds ignore local client overrides and inject build time', () => {
  const environmentDirectory = mkdtempSync(join(tmpdir(), 'mons-shop-vite-production-'));
  const previousApiOrigin = process.env.VITE_MONS_API_ORIGIN;
  writeFileSync(
    join(environmentDirectory, '.env.production.local'),
    'VITE_MONS_API_ORIGIN=https://dotenv-override.example\n',
  );
  process.env.VITE_MONS_API_ORIGIN = 'https://process-override.example';

  try {
    const settings = resolveViteClientSettings('production', environmentDirectory, 1_700_000_000_999);
    const config = createViteConfig('production', environmentDirectory, 1_700_000_000_999);

    assert.equal(settings.apiOrigin, 'https://api.mons.shop');
    assert.equal(settings.envDir, false);
    assert.deepEqual(settings.envPrefix, []);
    assert.equal(settings.buildDatetime, '1700000000');
    assert.equal(config.envDir, false);
    assert.deepEqual(config.envPrefix, []);
    assert.equal(config.define?.['import.meta.env.VITE_BUILD_DATETIME'], JSON.stringify('1700000000'));
  } finally {
    if (previousApiOrigin === undefined) delete process.env.VITE_MONS_API_ORIGIN;
    else process.env.VITE_MONS_API_ORIGIN = previousApiOrigin;
    rmSync(environmentDirectory, { force: true, recursive: true });
  }
});

test('development Vite builds keep local client overrides', () => {
  const environmentDirectory = mkdtempSync(join(tmpdir(), 'mons-shop-vite-development-'));
  const previousApiOrigin = process.env.VITE_MONS_API_ORIGIN;
  delete process.env.VITE_MONS_API_ORIGIN;
  writeFileSync(
    join(environmentDirectory, '.env.development.local'),
    'VITE_MONS_API_ORIGIN=https://development-override.example\n',
  );

  try {
    const settings = resolveViteClientSettings('development', environmentDirectory);
    const config = createViteConfig('development', environmentDirectory);

    assert.equal(settings.apiOrigin, 'https://development-override.example');
    assert.equal(settings.envDir, environmentDirectory);
    assert.deepEqual(settings.envPrefix, ['VITE_', 'STRIPE_TEST_UNIT_AMOUNT_CENTS']);
    assert.equal(settings.buildDatetime, undefined);
    assert.equal(config.define?.['import.meta.env.VITE_BUILD_DATETIME'], undefined);
  } finally {
    if (previousApiOrigin === undefined) delete process.env.VITE_MONS_API_ORIGIN;
    else process.env.VITE_MONS_API_ORIGIN = previousApiOrigin;
    rmSync(environmentDirectory, { force: true, recursive: true });
  }
});
