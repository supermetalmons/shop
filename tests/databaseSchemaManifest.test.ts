import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { generateDatabaseSchema } from '../scripts/generateDatabaseSchema.ts';
import {
  DATABASE_SCHEMA_TARGETS,
  readDatabaseSchemaManifest,
} from '../scripts/shared/databaseSchemaManifest.ts';

type Database = 'data' | 'ops';

function fixture(context: test.TestContext, database: Database) {
  const root = mkdtempSync(join(tmpdir(), `shop-${database}-schema-`));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const migrationsDirectory = join(root, 'migrations');
  cpSync(DATABASE_SCHEMA_TARGETS[database].migrationsDirectory, migrationsDirectory, { recursive: true });
  const manifestPath = join(root, 'generated', 'schema.json');
  const options = { migrationsDirectory, manifestPath };
  const migrationNames = () => readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort();
  const appendMigration = (sql: string) => {
    const version = migrationNames().length + 1;
    const name = `${String(version).padStart(4, '0')}_fixture.sql`;
    writeFileSync(join(migrationsDirectory, name), sql, { flag: 'wx' });
    return name;
  };
  return { ...options, options, migrationNames, appendMigration };
}

for (const database of ['data', 'ops'] as const) {
  const label = database.toUpperCase();

  test(`${label} schema generation is deterministic and check mode never creates or updates artifacts`, (context) => {
    const { options, manifestPath, appendMigration } = fixture(context, database);
    assert.throws(() => generateDatabaseSchema(database, { ...options, check: true }), /manifest is stale/);
    assert.equal(existsSync(dirname(manifestPath)), false);

    generateDatabaseSchema(database, { ...options, check: false });
    const original = readFileSync(manifestPath, 'utf8');
    generateDatabaseSchema(database, { ...options, check: true });
    generateDatabaseSchema(database, { ...options, check: false });
    assert.equal(readFileSync(manifestPath, 'utf8'), original);

    const before = readDatabaseSchemaManifest(database, manifestPath);
    assert.deepEqual(Object.keys(before.checkpoints).sort(), before.migrations.map(({ name }) => name).sort());
    const added = appendMigration('CREATE TABLE schema_fixture (id INTEGER PRIMARY KEY, value TEXT);');
    assert.throws(() => generateDatabaseSchema(database, { ...options, check: true }), /manifest is stale/);
    assert.equal(readFileSync(manifestPath, 'utf8'), original);

    generateDatabaseSchema(database, { ...options, check: false });
    generateDatabaseSchema(database, { ...options, check: true });
    const after = readDatabaseSchemaManifest(database, manifestPath);
    assert.deepEqual(after.migrations.slice(0, -1), before.migrations);
    for (const [name, checkpoint] of Object.entries(before.checkpoints)) {
      assert.deepEqual(after.checkpoints[name], checkpoint);
    }
    assert.ok(after.checkpoints[added].objects.some(({ name }) => name === 'schema_fixture'));
  });

  for (const change of ['edit', 'delete', 'rename'] as const) {
    test(`${label} rejects a historical migration ${change} in both modes without overwriting the manifest`, (context) => {
      const { options, manifestPath, migrationsDirectory, migrationNames } = fixture(context, database);
      generateDatabaseSchema(database, { ...options, check: false });
      const original = readFileSync(manifestPath, 'utf8');
      const name = migrationNames().at(-1)!;
      const path = join(migrationsDirectory, name);
      if (change === 'edit') writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
      if (change === 'delete') unlinkSync(path);
      if (change === 'rename') renameSync(path, join(migrationsDirectory, `${name.slice(0, 4)}_renamed.sql`));

      for (const check of [true, false]) {
        assert.throws(() => generateDatabaseSchema(database, { ...options, check }), /Recorded .* migration changed/);
        assert.equal(readFileSync(manifestPath, 'utf8'), original);
      }
    });
  }

  test(`${label} replay failures and historical checkpoint tampering preserve the manifest`, (context) => {
    const { options, manifestPath, migrationsDirectory, appendMigration } = fixture(context, database);
    generateDatabaseSchema(database, { ...options, check: false });
    const original = readFileSync(manifestPath, 'utf8');
    const added = appendMigration('CREATE TABLE schema_fixture (id INTEGER); INSERT INTO missing_fixture_table VALUES (1);');
    for (const check of [true, false]) {
      assert.throws(() => generateDatabaseSchema(database, { ...options, check }), /missing_fixture_table/);
      assert.equal(readFileSync(manifestPath, 'utf8'), original);
    }
    unlinkSync(join(migrationsDirectory, added));

    const altered = readDatabaseSchemaManifest(database, manifestPath);
    altered.checkpoints[altered.migrations[0].name].objects[0].fingerprint = '0'.repeat(64);
    const alteredContent = JSON.stringify(altered);
    writeFileSync(manifestPath, alteredContent);
    for (const check of [true, false]) {
      assert.throws(() => generateDatabaseSchema(database, { ...options, check }), /Recorded .* schema checkpoint changed/);
      assert.equal(readFileSync(manifestPath, 'utf8'), alteredContent);
    }
  });

  test(`${label} rejects missing historical checkpoints without repairing the manifest`, (context) => {
    const { options, manifestPath } = fixture(context, database);
    generateDatabaseSchema(database, { ...options, check: false });
    const altered = readDatabaseSchemaManifest(database, manifestPath);
    delete altered.checkpoints[altered.migrations[0].name];
    const alteredContent = JSON.stringify(altered);
    writeFileSync(manifestPath, alteredContent);
    for (const check of [true, false]) {
      assert.throws(() => generateDatabaseSchema(database, { ...options, check }), /Recorded .* schema checkpoint changed/);
      assert.equal(readFileSync(manifestPath, 'utf8'), alteredContent);
    }
  });

  for (const problem of ['gap', 'duplicate'] as const) {
    test(`${label} rejects ${problem} migration versions without overwriting the manifest`, (context) => {
      const { options, manifestPath, migrationsDirectory, migrationNames } = fixture(context, database);
      generateDatabaseSchema(database, { ...options, check: false });
      const original = readFileSync(manifestPath, 'utf8');
      const version = problem === 'gap' ? migrationNames().length + 2 : 1;
      writeFileSync(join(migrationsDirectory, `${String(version).padStart(4, '0')}_invalid.sql`), 'SELECT 1;');
      for (const check of [true, false]) {
        assert.throws(() => generateDatabaseSchema(database, { ...options, check }), /consecutive versions/);
        assert.equal(readFileSync(manifestPath, 'utf8'), original);
      }
    });
  }

  test(`${label} checkpoints record object ownership and exclude SQLite and Cloudflare internal objects`, (context) => {
    const { options, manifestPath, appendMigration } = fixture(context, database);
    generateDatabaseSchema(database, { ...options, check: false });
    const before = readDatabaseSchemaManifest(database, manifestPath);
    const previous = before.checkpoints[before.migrations.at(-1)!.name];
    const added = appendMigration(`
      CREATE TABLE schema_fixture (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT);
      CREATE INDEX schema_fixture_lookup ON schema_fixture (value);
      CREATE TRIGGER schema_fixture_insert AFTER INSERT ON schema_fixture
      BEGIN UPDATE schema_fixture SET value = 'inserted' WHERE id = NEW.id; END;
      CREATE VIEW schema_fixture_view AS SELECT value FROM schema_fixture;
      CREATE TABLE _cf_fixture (id INTEGER PRIMARY KEY);
      CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT);
      ANALYZE;
    `);
    generateDatabaseSchema(database, { ...options, check: false });
    const after = readDatabaseSchemaManifest(database, manifestPath);
    const objects = after.checkpoints[added].objects;
    const existingNames = new Set(previous.objects.map(({ name }) => name));
    assert.deepEqual(objects.filter(({ name }) => existingNames.has(name)), previous.objects);
    assert.deepEqual(objects.filter(({ name }) => !existingNames.has(name)).map(({ type, name, tableName }) => ({
      type, name, tableName,
    })).sort((a, b) => a.name.localeCompare(b.name)), [
      { type: 'table', name: 'schema_fixture', tableName: 'schema_fixture' },
      { type: 'trigger', name: 'schema_fixture_insert', tableName: 'schema_fixture' },
      { type: 'index', name: 'schema_fixture_lookup', tableName: 'schema_fixture' },
      { type: 'view', name: 'schema_fixture_view', tableName: 'schema_fixture_view' },
    ]);
    assert.deepEqual(after.checkpoints[before.migrations.at(-1)!.name], previous);
    generateDatabaseSchema(database, { ...options, check: true });
  });
}
