import { pathToFileURL } from 'node:url';
import { DATABASE_SCHEMA_TARGETS } from './shared/databaseSchemaManifest.ts';
import { readD1Migrations } from './shared/d1MigrationReplay.ts';
import { buildD1SchemaManifest, captureD1SchemaObjects, generateD1SchemaManifest, type D1SchemaObject } from './shared/d1SchemaManifest.ts';

export function generateDatabaseSchema(database: keyof typeof DATABASE_SCHEMA_TARGETS, options: {
  check: boolean;
  migrationsDirectory?: string;
  manifestPath?: string;
}): void {
  const target = DATABASE_SCHEMA_TARGETS[database];
  generateD1SchemaManifest<{ objects: D1SchemaObject[] }>({
    check: options.check,
    manifestPath: options.manifestPath ?? target.manifestPath,
    label: target.label,
    generateCommand: `generate:${database}-schema`,
    build: (recorded) => buildD1SchemaManifest(readD1Migrations(options.migrationsDirectory ?? target.migrationsDirectory, target.label), {
      label: target.label,
      recorded,
      checkpoint: (database) => ({ objects: captureD1SchemaObjects(database) }),
    }),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [database, mode, ...extra] = process.argv.slice(2);
  if ((database !== 'data' && database !== 'ops') || (mode !== '--check' && mode !== '--write') || extra.length) {
    throw new Error('Usage: generateDatabaseSchema.ts data|ops --check|--write');
  }
  generateDatabaseSchema(database, { check: mode === '--check' });
}
