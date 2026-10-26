import { pathToFileURL } from 'node:url';
import { readCommerceMigrations } from './shared/commerceMigrationReplay.ts';
import {
  buildCommerceSchemaManifest,
  COMMERCE_SCHEMA_MANIFEST_PATH,
  type CommerceSchemaCheckpoint,
} from './shared/commerceSchemaManifest.ts';
import { generateD1SchemaManifest } from './shared/d1SchemaManifest.ts';

export function generateCommerceSchema(options: {
  check: boolean;
  migrationsDirectory?: string;
  manifestPath?: string;
}): void {
  generateD1SchemaManifest<CommerceSchemaCheckpoint>({
    check: options.check,
    manifestPath: options.manifestPath ?? COMMERCE_SCHEMA_MANIFEST_PATH,
    label: 'Commerce',
    generateCommand: 'generate:commerce-schema',
    build: (recorded) => buildCommerceSchemaManifest(readCommerceMigrations(options.migrationsDirectory), recorded),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || (args[0] !== '--check' && args[0] !== '--write')) {
    throw new Error('Usage: generateCommerceSchema.ts --check|--write');
  }
  generateCommerceSchema({ check: args[0] === '--check' });
}
