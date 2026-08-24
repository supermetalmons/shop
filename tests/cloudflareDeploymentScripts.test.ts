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

test('Cloudflare releases use direct pinned Wrangler commands', () => {
  assert.equal(packageJson.devDependencies.wrangler, '4.120.0');
  assert.equal(
    packageJson.scripts['check:frontend'],
    'npm run typecheck && npm test && npm run build && npm run validate:browser-bundle',
  );
  assert.equal(
    packageJson.scripts['dry-run:frontend'],
    'npm run check:frontend && wrangler deploy --dry-run --config wrangler.jsonc',
  );
  assert.equal(
    packageJson.scripts.deploy,
    'npm run check:frontend && wrangler deploy --strict --config wrangler.jsonc',
  );
  assert.equal(
    packageJson.scripts['dry-run:api'],
    'wrangler deploy --dry-run --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env',
  );
  assert.equal(
    packageJson.scripts['check:api'],
    'npm run types:api:check && npm run typecheck:api && npm run test:api && npm run test:api:runtime && npm run dry-run:api && npm run startup:api',
  );
  assert.equal(
    packageJson.scripts['db:migrate:api'],
    'wrangler d1 migrations apply mons-shop-data --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env',
  );
  assert.equal(
    packageJson.scripts['check:pack-status-d1'],
    'node --import tsx scripts/ops/checkPackStatusD1.ts',
  );
  assert.equal(
    packageJson.scripts['deploy:api'],
    'npm run check:api && npm run db:migrate:api && npm run check:pack-status-d1 && wrangler deploy --strict --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env',
  );
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
