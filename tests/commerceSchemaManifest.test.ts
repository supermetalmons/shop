import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PREORDER_CARD_IDS } from '../shared/preorderCardIds.generated.ts';
import { generateCommerceSchema } from '../scripts/generateCommerceSchema.ts';
import {
  DEFAULT_COMMERCE_MIGRATIONS_DIRECTORY,
  readCommerceMigrations,
} from '../scripts/shared/commerceMigrationReplay.ts';
import {
  readCommerceSchemaManifest,
  selectCommerceSchemaCheckpoint,
} from '../scripts/shared/commerceSchemaManifest.ts';

function fixture(context: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'shop-commerce-schema-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const migrationsDirectory = join(root, 'migrations');
  cpSync(DEFAULT_COMMERCE_MIGRATIONS_DIRECTORY, migrationsDirectory, { recursive: true });
  const manifestPath = join(root, 'generated', 'schema.json');
  const options = { migrationsDirectory, manifestPath };
  const appendMigration = (sql: string) => {
    const number = readCommerceMigrations(migrationsDirectory).length + 1;
    const name = `${String(number).padStart(4, '0')}_fixture.sql`;
    writeFileSync(join(migrationsDirectory, name), sql, { flag: 'wx' });
    return name;
  };
  return { ...options, options, appendMigration };
}

test('Commerce schema generation is deterministic and checking never writes missing or stale artifacts', (context) => {
  const { options, manifestPath, appendMigration } = fixture(context);
  assert.throws(() => generateCommerceSchema({ ...options, check: true }), /manifest is stale/);
  assert.equal(existsSync(manifestPath), false);
  generateCommerceSchema({ ...options, check: false });
  const original = readFileSync(manifestPath, 'utf8');
  generateCommerceSchema({ ...options, check: true });
  generateCommerceSchema({ ...options, check: false });
  assert.equal(readFileSync(manifestPath, 'utf8'), original);
  appendMigration('CREATE INDEX commerce_fixture_lookup ON commerce_documents (version);');
  assert.throws(() => generateCommerceSchema({ ...options, check: true }), /manifest is stale/);
  assert.equal(readFileSync(manifestPath, 'utf8'), original);
  generateCommerceSchema({ ...options, check: false });
  generateCommerceSchema({ ...options, check: true });
  const before = JSON.parse(original);
  const after = readCommerceSchemaManifest(manifestPath);
  for (const [name, checkpoint] of Object.entries(before.checkpoints)) {
    assert.deepEqual(after.checkpoints[name], checkpoint);
  }
  const latest = after.checkpoints[after.migrations.at(-1)!.name];
  assert.ok(latest.objects.some(({ name }) => name === 'commerce_fixture_lookup'));
});

test('recorded migration changes or removals cannot be accepted by regeneration', (context) => {
  const { options, manifestPath, migrationsDirectory } = fixture(context);
  generateCommerceSchema({ ...options, check: false });
  const original = readFileSync(manifestPath, 'utf8');
  const migrations = readCommerceMigrations(migrationsDirectory);
  const first = join(migrationsDirectory, migrations[0].name);
  writeFileSync(first, `${migrations[0].sql}\n`);
  for (const check of [true, false]) {
    assert.throws(() => generateCommerceSchema({ ...options, check }), /Recorded Commerce migration changed/);
    assert.equal(readFileSync(manifestPath, 'utf8'), original);
  }
  writeFileSync(first, migrations[0].sql);
  unlinkSync(join(migrationsDirectory, migrations.at(-1)!.name));
  assert.throws(() => generateCommerceSchema({ ...options, check: false }), /Recorded Commerce migration changed/);
  assert.equal(readFileSync(manifestPath, 'utf8'), original);
});

test('migration replay failures and altered historical checkpoints do not overwrite the manifest', (context) => {
  const { options, manifestPath, migrationsDirectory, appendMigration } = fixture(context);
  generateCommerceSchema({ ...options, check: false });
  const original = readFileSync(manifestPath, 'utf8');
  const added = appendMigration('CREATE TABLE fixture (id INTEGER); INSERT INTO missing_table VALUES (1);');
  assert.throws(() => generateCommerceSchema({ ...options, check: false }), /missing_table/);
  assert.equal(readFileSync(manifestPath, 'utf8'), original);
  unlinkSync(join(migrationsDirectory, added));
  const altered = JSON.parse(original);
  Object.values(altered.checkpoints as Record<string, { objects: { fingerprint: string }[] }>)[0]
    .objects[0].fingerprint = '0'.repeat(64);
  const alteredContent = JSON.stringify(altered);
  writeFileSync(manifestPath, alteredContent);
  assert.throws(() => generateCommerceSchema({ ...options, check: false }), /Recorded Commerce schema checkpoint changed/);
  assert.equal(readFileSync(manifestPath, 'utf8'), alteredContent);
});

test('every supported checkpoint is selected only by its complete ordered migration prefix', () => {
  const manifest = readCommerceSchemaManifest();
  const names = manifest.migrations.map(({ name }) => name);
  for (let count = 13; count <= names.length; count += 1) {
    assert.equal(selectCommerceSchemaCheckpoint(manifest, names.slice(0, count)), manifest.checkpoints[names[count - 1]]);
  }
  for (const invalid of [
    [], names.slice(0, 12), names.slice(1), names.toReversed(),
    [...names, '9999_future.sql'], [names[0], names[0], ...names.slice(2)],
  ]) {
    assert.throws(() => selectCommerceSchemaCheckpoint(manifest, invalid), /schema baseline is invalid/);
  }
});

test('catalog data is versioned while internal statistics are excluded from schema fingerprints', (context) => {
  const { options, manifestPath, appendMigration } = fixture(context);
  generateCommerceSchema({ ...options, check: false });
  const before = readCommerceSchemaManifest(manifestPath);
  const previous = before.checkpoints[before.migrations.at(-1)!.name];
  assert.deepEqual(previous.preorderCardIds, PREORDER_CARD_IDS);
  const addedId = Math.max(...PREORDER_CARD_IDS) + 1;
  const migration = appendMigration(`INSERT INTO commerce_preorder_cards (card_id) VALUES (${addedId}); ANALYZE;`);
  generateCommerceSchema({ ...options, check: false });
  const after = readCommerceSchemaManifest(manifestPath);
  assert.deepEqual(after.checkpoints[migration].objects, previous.objects);
  assert.deepEqual(after.checkpoints[migration].preorderCardIds, [...previous.preorderCardIds!, addedId]);
  assert.deepEqual(after.checkpoints[before.migrations.at(-1)!.name], previous);
});

test('migration discovery rejects gaps and duplicate version numbers', (context) => {
  const { migrationsDirectory } = fixture(context);
  const first = readCommerceMigrations(migrationsDirectory)[0];
  const duplicate = join(migrationsDirectory, '0001_duplicate.sql');
  writeFileSync(duplicate, first.sql);
  assert.throws(() => readCommerceMigrations(migrationsDirectory), /consecutive versions/);
  unlinkSync(duplicate);
  unlinkSync(join(migrationsDirectory, first.name));
  assert.throws(() => readCommerceMigrations(migrationsDirectory), /consecutive versions/);
});
