import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import miNoteCatalog from '../mi_note_cards.json';
import { generatePreorderCatalog } from '../scripts/shared/preorderCatalog.ts';
import {
  DEFAULT_COMMERCE_MIGRATIONS_DIRECTORY,
  readCommerceMigrations,
  replayCommerceMigrations,
} from '../scripts/shared/commerceMigrationReplay.ts';

const BOOTSTRAP_CARD_IDS = new Set([
  ...Array.from({ length: 1400 }, (_, index) => index + 1),
  ...Array.from({ length: 11 }, (_, index) => index + 1409),
]);

function fixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'shop-preorder-catalog-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const migrationsDirectory = join(directory, 'migrations');
  mkdirSync(migrationsDirectory);
  for (const { name } of readCommerceMigrations().slice(0, 31)) {
    copyFileSync(join(DEFAULT_COMMERCE_MIGRATIONS_DIRECTORY, name), join(migrationsDirectory, name));
  }
  const catalogPath = join(directory, 'catalog.json');
  const generatedPath = join(directory, 'preorderCardIds.generated.ts');
  const catalog = structuredClone(miNoteCatalog);
  for (const collection of catalog.ethereumCollections) {
    collection.tokens = collection.tokens.filter(({ clean_card_id }) => BOOTSTRAP_CARD_IDS.has(clean_card_id));
  }
  const saveCatalog = () => writeFileSync(catalogPath, JSON.stringify(catalog));
  saveCatalog();
  return { catalogPath, generatedPath, migrationsDirectory, catalog, saveCatalog };
}

function snapshot(options: ReturnType<typeof fixture>) {
  return {
    migrations: readCommerceMigrations(options.migrationsDirectory),
    generated: readFileSync(options.generatedPath, 'utf8'),
  };
}

test('catalog bootstrap is deterministic and leaves every existing migration unchanged', (context) => {
  const options = fixture(context);
  const before = readCommerceMigrations(options.migrationsDirectory);
  assert.throws(() => generatePreorderCatalog(options), /catalog is stale/);
  assert.deepEqual(generatePreorderCatalog({ ...options, write: true }), {
    cardCount: 1411, generatedChanged: true, migration: '0032_preorder_catalog.sql',
  });
  assert.deepEqual(readCommerceMigrations(options.migrationsDirectory).slice(0, 31), before);
  const generated = snapshot(options);
  assert.deepEqual(generatePreorderCatalog(options), { cardCount: 1411, generatedChanged: false, migration: null });
  assert.deepEqual(generatePreorderCatalog({ ...options, write: true }), { cardCount: 1411, generatedChanged: false, migration: null });
  assert.deepEqual(snapshot(options), generated);
  const database = replayCommerceMigrations(generated.migrations);
  context.after(() => database.close());
  const expected = options.catalog.ethereumCollections.flatMap(({ tokens }) => tokens.map(({ clean_card_id }) => clean_card_id)).sort((a, b) => a - b);
  assert.deepEqual(database.prepare('SELECT card_id FROM commerce_preorder_cards ORDER BY card_id').all().map(({ card_id }) => card_id), expected);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('later additions generate only inserts and freshness uses the full migration chain', (context) => {
  const options = fixture(context);
  generatePreorderCatalog({ ...options, write: true });
  const initial = snapshot(options);
  const before = replayCommerceMigrations(initial.migrations);
  const schemaBefore = before.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name').all();
  before.close();
  const tokens = options.catalog.ethereumCollections[0].tokens;
  tokens.push({ ...tokens[0], id: '999999999999', clean_card_id: 1420 });
  options.saveCatalog();
  assert.throws(() => generatePreorderCatalog(options), /catalog is stale/);
  assert.deepEqual(generatePreorderCatalog({ ...options, write: true }), {
    cardCount: 1412, generatedChanged: true, migration: '0033_preorder_catalog.sql',
  });
  const after = readCommerceMigrations(options.migrationsDirectory);
  assert.deepEqual(after.slice(0, initial.migrations.length), initial.migrations);
  assert.equal(after.at(-1)!.sql, 'INSERT INTO commerce_preorder_cards (card_id) VALUES\n  (1420);\n');
  assert.deepEqual(generatePreorderCatalog(options), { cardCount: 1412, generatedChanged: false, migration: null });
  const database = replayCommerceMigrations(after);
  context.after(() => database.close());
  assert.deepEqual(database.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name').all(), schemaBefore);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM commerce_preorder_cards').get()!.count, 1412);
  assert.equal(database.prepare('SELECT card_id FROM commerce_preorder_cards WHERE card_id = 1420').get()!.card_id, 1420);
});

for (const bootstrap of [true, false]) {
  test(`catalog generation rejects removed cards ${bootstrap ? 'before' : 'after'} bootstrap`, (context) => {
    const options = fixture(context);
    if (!bootstrap) generatePreorderCatalog({ ...options, write: true });
    const migrations = readCommerceMigrations(options.migrationsDirectory);
    for (const collection of options.catalog.ethereumCollections) {
      collection.tokens = collection.tokens.filter(({ clean_card_id }) => clean_card_id !== 1);
    }
    options.saveCatalog();
    assert.throws(() => generatePreorderCatalog({ ...options, write: true }), /must be additive; removed card IDs: 1/);
    assert.deepEqual(readCommerceMigrations(options.migrationsDirectory), migrations);
  });
}

for (const invalid of [
  { name: 'duplicate card ID', mutate: (catalog: typeof miNoteCatalog) => { catalog.ethereumCollections[0].tokens[1].clean_card_id = 1; }, match: /Duplicate catalog card ID/ },
  { name: 'fractional card ID', mutate: (catalog: typeof miNoteCatalog) => { catalog.ethereumCollections[0].tokens[0].clean_card_id = 1.5; }, match: /positive safe integers/ },
  { name: 'special card overlap', mutate: (catalog: typeof miNoteCatalog) => { catalog.ethereumCollections[0].tokens[0].clean_card_id = 1401; }, match: /cannot be eligible for preorder/ },
  { name: 'omitted collection', mutate: (catalog: typeof miNoteCatalog) => { catalog.ethereumCollections.pop(); }, match: /every supported Ethereum collection/ },
  { name: 'duplicate token identity', mutate: (catalog: typeof miNoteCatalog) => { catalog.ethereumCollections[0].tokens[1].id = catalog.ethereumCollections[0].tokens[0].id; }, match: /unique canonical decimal strings/ },
  { name: 'uint256 token overflow', mutate: (catalog: typeof miNoteCatalog) => { catalog.ethereumCollections[0].tokens[0].id = (1n << 256n).toString(); }, match: /within uint256/ },
  { name: 'overlong token ID', mutate: (catalog: typeof miNoteCatalog) => { catalog.ethereumCollections[0].tokens[0].id = '1'.repeat(79); }, match: /within uint256/ },
]) {
  test(`catalog generation rejects ${invalid.name} without writing artifacts`, (context) => {
    const options = fixture(context);
    generatePreorderCatalog({ ...options, write: true });
    const before = snapshot(options);
    invalid.mutate(options.catalog);
    options.saveCatalog();
    for (const write of [false, true]) {
      assert.throws(() => generatePreorderCatalog({ ...options, write }), invalid.match);
      assert.deepEqual(snapshot(options), before);
    }
  });
}

test('catalog generation accepts the maximum uint256 token ID', (context) => {
  const options = fixture(context);
  options.catalog.ethereumCollections[0].tokens[0].id = ((1n << 256n) - 1n).toString();
  options.saveCatalog();
  assert.equal(generatePreorderCatalog({ ...options, write: true }).cardCount, 1411);
  assert.deepEqual(generatePreorderCatalog(options), { cardCount: 1411, generatedChanged: false, migration: null });
});

test('freshness detects modified generated IDs without rewriting migrations', (context) => {
  const options = fixture(context);
  generatePreorderCatalog({ ...options, write: true });
  const before = snapshot(options);
  writeFileSync(options.generatedPath, `${before.generated}\n`);
  assert.throws(() => generatePreorderCatalog(options), /catalog is stale/);
  assert.deepEqual(generatePreorderCatalog({ ...options, write: true }), { cardCount: 1411, generatedChanged: true, migration: null });
  assert.deepEqual(snapshot(options), before);
});

test('checked-in catalog artifacts agree with their canonical source', () => {
  const cardCount = miNoteCatalog.ethereumCollections.reduce((count, { tokens }) => count + tokens.length, 0);
  assert.deepEqual(generatePreorderCatalog(), { cardCount, generatedChanged: false, migration: null });
  assert.ok(readdirSync(DEFAULT_COMMERCE_MIGRATIONS_DIRECTORY).includes('0032_preorder_catalog.sql'));
});
