import { fileURLToPath } from 'node:url';
import { readD1SchemaManifest, type D1SchemaManifest, type D1SchemaObject } from './d1SchemaManifest.ts';

export const DATABASE_SCHEMA_TARGETS = {
  data: {
    label: 'Data',
    migrationsDirectory: fileURLToPath(new URL('../../cloud/workers/api/migrations/', import.meta.url)),
    manifestPath: fileURLToPath(new URL('../generated/dataSchemaManifest.json', import.meta.url)),
  },
  ops: {
    label: 'Ops',
    migrationsDirectory: fileURLToPath(new URL('../../cloud/workers/api/ops-migrations/', import.meta.url)),
    manifestPath: fileURLToPath(new URL('../generated/opsSchemaManifest.json', import.meta.url)),
  },
} as const;

export function readDatabaseSchemaManifest(
  database: keyof typeof DATABASE_SCHEMA_TARGETS,
  path = DATABASE_SCHEMA_TARGETS[database].manifestPath,
): D1SchemaManifest<{ objects: D1SchemaObject[] }> {
  return readD1SchemaManifest(path, DATABASE_SCHEMA_TARGETS[database].label);
}
