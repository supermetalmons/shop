import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCommerceMigrations } from './shared/commerceMigrationReplay.ts';
import {
  buildCommerceSchemaManifest,
  COMMERCE_SCHEMA_MANIFEST_PATH,
  readCommerceSchemaManifest,
} from './shared/commerceSchemaManifest.ts';

export function generateCommerceSchema(options: {
  check: boolean;
  migrationsDirectory?: string;
  manifestPath?: string;
}): void {
  const manifestPath = options.manifestPath ?? COMMERCE_SCHEMA_MANIFEST_PATH;
  const previous = existsSync(manifestPath) ? readCommerceSchemaManifest(manifestPath) : undefined;
  const manifest = buildCommerceSchemaManifest(readCommerceMigrations(options.migrationsDirectory), previous);
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  if (options.check) {
    if (!previous || readFileSync(manifestPath, 'utf8') !== content) {
      throw new Error('Commerce schema manifest is stale. Run npm run generate:commerce-schema.');
    }
    return;
  }
  if (previous && readFileSync(manifestPath, 'utf8') === content) return;
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, content);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || (args[0] !== '--check' && args[0] !== '--write')) {
    throw new Error('Usage: generateCommerceSchema.ts --check|--write');
  }
  generateCommerceSchema({ check: args[0] === '--check' });
}
