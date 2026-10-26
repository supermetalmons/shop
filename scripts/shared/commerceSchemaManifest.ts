import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { CommerceMigration } from './commerceMigrationReplay.ts';
import { buildD1SchemaManifest, captureD1SchemaObjects, readD1SchemaManifest, type D1SchemaManifest } from './d1SchemaManifest.ts';

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

export type CommerceSchemaManifest = D1SchemaManifest<CommerceSchemaCheckpoint>;

export function readCommerceSchemaManifest(path = COMMERCE_SCHEMA_MANIFEST_PATH): CommerceSchemaManifest {
  return readD1SchemaManifest(path, 'Commerce');
}

function schemaCheckpoint(database: DatabaseSync): CommerceSchemaCheckpoint {
  const objects = captureD1SchemaObjects(database).map(({ type, name, fingerprint }) => ({ type, name, fingerprint }));
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
  return buildD1SchemaManifest(migrations, {
    label: 'Commerce',
    recorded,
    checkpoint: (database, index) => index >= 12 ? schemaCheckpoint(database) : undefined,
  });
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
