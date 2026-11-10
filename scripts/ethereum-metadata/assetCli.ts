import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { importRevealAssets, type RevealAssetImportOptions } from './assetImport.ts';
import { importRevealCollectionBlocks } from './collectionBlocks.ts';

const usage = `Usage: npm run ethereum:assets -- <import|collection-blocks> [options]

  --source PATH              Complete asset manifest (default: command's saved source)
  --catalog-version VERSION  Catalog revision, e.g. 111k-v5 (default: saved descriptor)
  --available-eggs NUMBER    Available egg images (default: saved settings or 76700)
  --check                    Verify generated outputs without writing
  --help                     Show this help
`;

export function parseAssetCliArgs(args: string[]): (RevealAssetImportOptions & { command?: 'collection-blocks' }) | null {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      source: { type: 'string' },
      'catalog-version': { type: 'string' },
      'available-eggs': { type: 'string' },
      check: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) return null;
  if (positionals.length !== 1 || !['import', 'collection-blocks'].includes(positionals[0])) throw new Error(usage);
  if (positionals[0] === 'collection-blocks' && (values['catalog-version'] !== undefined || values['available-eggs'] !== undefined)) {
    throw new Error('collection-blocks binds to existing catalogs and does not accept allocation options');
  }
  if (values.source !== undefined && !values.source.trim()) throw new Error('--source cannot be empty');
  if (values['catalog-version'] !== undefined && !/^111k-v[1-9][0-9]{0,8}$/.test(values['catalog-version'])) {
    throw new Error('--catalog-version must be 111k-v followed by a positive integer');
  }
  const availableEggs = values['available-eggs'] === undefined ? undefined : Number(values['available-eggs']);
  if (availableEggs !== undefined && (!/^[1-9][0-9]*$/.test(values['available-eggs']!) || !Number.isSafeInteger(availableEggs))) {
    throw new Error('--available-eggs must be a positive safe integer');
  }
  return {
    ...(positionals[0] === 'collection-blocks' ? { command: 'collection-blocks' as const } : {}),
    ...(values.source !== undefined ? { sourcePath: resolve(values.source) } : {}),
    ...(values['catalog-version'] !== undefined ? { catalogVersion: values['catalog-version'] } : {}),
    ...(availableEggs !== undefined ? { availableEggs } : {}),
    ...(values.check ? { check: true } : {}),
  };
}

async function main(): Promise<void> {
  const options = parseAssetCliArgs(process.argv.slice(2));
  if (!options) {
    process.stdout.write(usage);
    return;
  }
  if (options.command === 'collection-blocks') {
    process.stdout.write(`${JSON.stringify(await importRevealCollectionBlocks(options))}\n`);
    return;
  }
  const { status, manifest, descriptor, changedFiles } = await importRevealAssets(options);
  process.stdout.write(`${JSON.stringify({ status, ...descriptor, artworkCount: manifest.artworkCount,
    counts: Object.fromEntries(Object.entries(manifest.categories).map(([category, value]) => [category, value.count])),
    changedFiles })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`Asset import failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
