import { isDeepStrictEqual } from 'node:util';
import { PREORDER_CARD_IDS } from '../../shared/preorderCardIds.generated.ts';
import { queryRemoteCommerceD1 } from './commerceD1Maintenance.ts';
import { sqlSchemaFingerprint } from './sqlSchemaFingerprint.ts';
import { readCommerceSchemaManifest, selectCommerceSchemaCheckpoint, type CommerceSchemaManifest, type CommerceSchemaCheckpoint } from './commerceSchemaManifest.ts';

type CheckCommerceD1Query = typeof queryRemoteCommerceD1;
function fail(message: string): never { throw new Error(message); }

function createCommerceSchemaCatalog(query: CheckCommerceD1Query) {
  type Rows = ReturnType<CheckCommerceD1Query>;
  let catalog: { rows: Rows; objects: Map<string, Rows> } | undefined;
  const load = () => {
    if (catalog) return catalog;
    const rows = query(`SELECT type, name, sql,
      type = 'trigger' AND name LIKE 'commerce_%' AS commerce_trigger
      FROM sqlite_schema ORDER BY name`);
    const objects = new Map<string, Rows>();
    for (const row of rows) {
      const key = `${String(row.type)}:${String(row.name)}`;
      const existing = objects.get(key);
      if (existing) existing.push(row);
      else objects.set(key, [row]);
    }
    catalog = { rows, objects };
    return catalog;
  };
  return {
    get: (type: string, name: string): Rows => load().objects.get(`${type}:${name}`) || [],
    commerceTriggers: (): Rows => load().rows.filter((row) => row.commerce_trigger === 1),
  };
}

function validateCommerceSchema(
  manifest: CommerceSchemaManifest,
  checkpoint: CommerceSchemaCheckpoint,
  catalog: ReturnType<typeof createCommerceSchemaCatalog>,
  query: CheckCommerceD1Query,
  migration: string,
): void {
  const invalidObject = (name: string): never => fail(`Commerce D1 schema ${name} is invalid at ${migration}.`);
  const expected = new Set(checkpoint.objects.map(({ type, name }) => `${type}:${name}`));
  for (const { type, name, fingerprint } of checkpoint.objects) {
    const rows = catalog.get(type, name);
    if (rows.length !== 1 || typeof rows[0].sql !== 'string' || sqlSchemaFingerprint(rows[0].sql) !== fingerprint) {
      invalidObject(name);
    }
  }
  const historicalObjects = new Map(Object.values(manifest.checkpoints)
    .flatMap((version) => version.objects).map((object) => [`${object.type}:${object.name}`, object]));
  for (const [key, { type, name }] of historicalObjects) {
    if (!expected.has(key) && catalog.get(type, name).length) invalidObject(name);
  }
  const tables = query(`SELECT name, strict
    FROM pragma_table_list
    WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*'
      AND name <> 'd1_migrations'
    ORDER BY name`);
  const expectedTables = checkpoint.objects.filter(({ type }) => type === 'table').map(({ name }) => name).sort();
  if (tables.length !== expectedTables.length || tables.some((row, index) => row.name !== expectedTables[index] || row.strict !== 1)) {
    fail('Commerce D1 authoritative strict table inventory is invalid.');
  }
  const expectedTriggers = new Set(checkpoint.objects.filter(({ type, name }) =>
    type === 'trigger' && /^commerce./i.test(name)).map(({ name }) => name));
  const triggers = catalog.commerceTriggers();
  if (triggers.length !== expectedTriggers.size || triggers.some((row) => !expectedTriggers.has(String(row.name)))) {
    fail('Commerce D1 trigger inventory is invalid.');
  }
  if (checkpoint.preorderCardIds) {
    const cards = query('SELECT card_id FROM commerce_preorder_cards ORDER BY card_id').map((row) => row.card_id);
    if (!isDeepStrictEqual(cards, checkpoint.preorderCardIds)) fail('Commerce D1 preorder catalog is invalid.');
  }
}

export function checkCurrentCommerceSchema(query: CheckCommerceD1Query): void {
  const quick = query('PRAGMA quick_check');
  if (quick.length !== 1 || quick[0].quick_check !== 'ok') fail('Commerce D1 quick check failed.');
  if (query('PRAGMA foreign_key_check').length !== 0) fail('Commerce D1 foreign-key check failed.');
  const manifest = readCommerceSchemaManifest();
  const migrations = query('SELECT name FROM d1_migrations ORDER BY id');
  if (migrations.length !== manifest.migrations.length) {
    fail(`Commerce D1 requires the latest migration: ${manifest.migrations.at(-1)!.name}.`);
  }
  const checkpoint = selectCommerceSchemaCheckpoint(manifest, migrations.map((migration) => migration.name));
  if (!isDeepStrictEqual(checkpoint.preorderCardIds, PREORDER_CARD_IDS)) {
    fail('Commerce D1 catalog differs from the generated application catalog.');
  }
  validateCommerceSchema(manifest, checkpoint, createCommerceSchemaCatalog(query), query, manifest.migrations.at(-1)!.name);
}
