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

test('Cloudflare releases use direct pinned Wrangler commands', () => {
  assert.equal(packageJson.devDependencies.wrangler, '4.120.0');
  assert.equal(
    packageJson.scripts['check:frontend'],
    'npm run validate:legacy-runtime && npm run types:frontend-worker:check && npm run typecheck:frontend-worker && npm run test:frontend-worker && npm run typecheck && npm test && npm run build && npm run validate:browser-bundle',
  );
  assert.equal(
    packageJson.scripts['dry-run:frontend'],
    'npm run check:frontend && wrangler deploy --dry-run --config wrangler.jsonc --env-file cloud/workers/frontend/release.env',
  );
  assert.equal(
    packageJson.scripts.deploy,
    'npm run check:frontend && wrangler deploy --strict --config wrangler.jsonc --env-file cloud/workers/frontend/release.env',
  );
  assert.equal(
    packageJson.scripts['dry-run:api'],
    'wrangler deploy --dry-run --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env',
  );
  assert.equal(
    packageJson.scripts['check:api'],
    'npm run validate:legacy-runtime && npm run types:api:check && npm run typecheck:api && npm run test:api && npm run test:api:runtime && npm run dry-run:api && npm run startup:api',
  );
  assert.equal(
    packageJson.scripts['db:migrate:data'],
    'wrangler d1 migrations apply mons-shop-data --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env',
  );
  assert.equal(
    packageJson.scripts['db:migrate:ops'],
    'wrangler d1 migrations apply mons-shop-ops --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env',
  );
  assert.equal(
    packageJson.scripts['db:migrate:commerce'],
    'wrangler d1 migrations apply mons-shop-commerce --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env',
  );
  assert.equal(
    packageJson.scripts['db:migrate:api'],
    'npm run db:migrate:data && npm run db:migrate:ops && npm run db:migrate:commerce',
  );
  assert.equal(
    packageJson.scripts['check:pack-status-d1'],
    'node --import tsx scripts/ops/checkPackStatusD1.ts',
  );
  assert.equal(
    packageJson.scripts['check:ops-d1'],
    'node --import tsx scripts/ops/checkOpsD1.ts',
  );
  assert.equal(
    packageJson.scripts['check:commerce-d1'],
    'node --import tsx scripts/ops/checkCommerceD1.ts',
  );
  assert.equal(
    packageJson.scripts['ready-notifications-control'],
    'node --import tsx scripts/ops/readyNotificationsControl.ts',
  );
  assert.equal(
    packageJson.scripts['deploy:api'],
    'npm run check:api && npm run db:migrate:api && npm run check:pack-status-d1 && npm run check:ops-d1 && npm run check:commerce-d1 && wrangler deploy --strict --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env',
  );
});

test('API Worker binds separate immutable data, ops, and commerce D1 histories', () => {
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
