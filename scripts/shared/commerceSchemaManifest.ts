import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { replayCommerceMigrations, type CommerceMigration } from './commerceMigrationReplay.ts';
import { sqlSchemaFingerprint } from './sqlSchemaFingerprint.ts';

export const COMMERCE_SCHEMA_MANIFEST_PATH = fileURLToPath(
  new URL('../generated/commerceSchemaManifest.json', import.meta.url),
);

type SchemaObject = {
  type: string;
  name: string;
  fingerprint: string;
};

export type CommerceSchemaCheckpoint = {
  objects: SchemaObject[];
  preorderCardIds?: number[];
};

export type CommerceSchemaManifest = {
  formatVersion: 1;
  migrations: { name: string; checksum: string }[];
  checkpoints: Record<string, CommerceSchemaCheckpoint>;
};

export function readCommerceSchemaManifest(path = COMMERCE_SCHEMA_MANIFEST_PATH): CommerceSchemaManifest {
  const manifest: CommerceSchemaManifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.formatVersion !== 1 || !Array.isArray(manifest.migrations) || !manifest.checkpoints) {
    throw new Error('Invalid Commerce schema manifest.');
  }
  return manifest;
}

function schemaCheckpoint(database: DatabaseSync): CommerceSchemaCheckpoint {
  const objects = database.prepare(`SELECT type, name, sql FROM sqlite_schema
    WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
      AND name <> 'd1_migrations'
    ORDER BY type, name`).all().map((row) => ({
    type: String(row.type),
    name: String(row.name),
    fingerprint: sqlSchemaFingerprint(String(row.sql)),
  }));
  return {
    objects,
    ...(objects.some((object) => object.type === 'table' && object.name === 'commerce_preorder_cards')
      ? { preorderCardIds: database.prepare('SELECT card_id FROM commerce_preorder_cards ORDER BY card_id')
        .all().map((row) => Number(row.card_id)) }
      : {}),
  };
}

export function buildCommerceSchemaManifest(
  migrations: readonly CommerceMigration[],
  recorded?: CommerceSchemaManifest,
): CommerceSchemaManifest {
  for (const [index, migration] of (recorded?.migrations ?? []).entries()) {
    if (migration.name !== migrations[index]?.name || migration.checksum !== migrations[index]?.checksum) {
      throw new Error(`Recorded Commerce migration changed: ${migration.name}. Append a new migration instead.`);
    }
  }
  const checkpoints: CommerceSchemaManifest['checkpoints'] = {};
  const database = replayCommerceMigrations(migrations, (database, migration, index) => {
    if (index >= 12) checkpoints[migration.name] = schemaCheckpoint(database);
  });
  database.close();
  for (const [name, checkpoint] of Object.entries(recorded?.checkpoints ?? {})) {
    if (JSON.stringify(checkpoint) !== JSON.stringify(checkpoints[name])) {
      throw new Error(`Recorded Commerce schema checkpoint changed: ${name}.`);
    }
  }
  return {
    formatVersion: 1,
    migrations: migrations.map(({ name, checksum }) => ({ name, checksum })),
    checkpoints,
  };
}

export function selectCommerceSchemaCheckpoint(
  manifest: CommerceSchemaManifest,
  migrationNames: readonly unknown[],
): CommerceSchemaCheckpoint {
  const lastName = migrationNames.at(-1);
  if (typeof lastName !== 'string' || migrationNames.length > manifest.migrations.length ||
    migrationNames.some((name, index) => name !== manifest.migrations[index].name) ||
    !Object.hasOwn(manifest.checkpoints, lastName)) {
    throw new Error('Commerce D1 schema baseline is invalid.');
  }
  return manifest.checkpoints[lastName];
}
