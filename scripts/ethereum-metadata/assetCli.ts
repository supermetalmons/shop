import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { importRevealAssets, type RevealAssetImportOptions } from './assetImport.ts';

const usage = `Usage: npm run ethereum:assets -- import [options]

  --source PATH              Complete asset dimension JSON (default: saved source.json)
  --catalog-version VERSION  Catalog revision, e.g. 111k-v4 (default: saved descriptor)
  --available-eggs NUMBER    Available egg images (default: saved settings or 76700)
  --check                    Verify generated outputs without writing
  --help                     Show this help
`;

export function parseAssetCliArgs(args: string[]): RevealAssetImportOptions | null {
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
  if (positionals.length !== 1 || positionals[0] !== 'import') throw new Error(usage);
  if (values.source !== undefined && !values.source.trim()) throw new Error('--source cannot be empty');
  if (values['catalog-version'] !== undefined && !/^111k-v[1-9][0-9]{0,8}$/.test(values['catalog-version'])) {
    throw new Error('--catalog-version must be 111k-v followed by a positive integer');
  }
  const availableEggs = values['available-eggs'] === undefined ? undefined : Number(values['available-eggs']);
  if (availableEggs !== undefined && (!/^[1-9][0-9]*$/.test(values['available-eggs']!) || !Number.isSafeInteger(availableEggs))) {
    throw new Error('--available-eggs must be a positive safe integer');
  }
  return {
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
