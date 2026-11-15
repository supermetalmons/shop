import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { applyLocalCacheCleanup, initializeOperationsDirectory, LOCAL_ARTIFACT_MANIFEST,
  planLocalCacheCleanup } from '../shared/localArtifacts.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

export function runLocalArtifacts(argv: string[], repositoryRoot = root) {
  const { values, positionals, tokens } = parseArgs({ args: argv, allowPositionals: true, tokens: true,
    options: { write: { type: 'boolean', default: false }, only: { type: 'string' } } });
  const names = tokens.filter(token => token.kind === 'option').map(token => token.name);
  if (positionals.length !== 1 || !['init', 'cache'].includes(positionals[0]) || new Set(names).size !== names.length ||
    positionals[0] === 'init' && names.length || values.only !== undefined && !values.only.trim()) {
    throw new Error('Usage: npm run artifacts -- init | cache [--only CACHE_ID,...] [--write]');
  }
  if (positionals[0] === 'init') return { directory: initializeOperationsDirectory(repositoryRoot) };
  const plan = planLocalCacheCleanup(repositoryRoot, values.only?.split(','));
  const result = values.write ? applyLocalCacheCleanup(plan) : null;
  return {
    mode: values.write ? 'cleaned' : 'dry-run',
    files: plan.files.length,
    bytes: plan.bytes,
    caches: LOCAL_ARTIFACT_MANIFEST.caches.filter(entry => plan.selected.includes(entry.id)).map(entry => ({
      id: entry.id, directory: entry.directory, regenerate: entry.regenerate,
      files: plan.files.filter(file => file.cache === entry.id).map(file => file.path),
    })),
    preserved: plan.preserved,
    policy: 'Only listed downloaded source files are disposable. Unlisted files, release evidence, journals, outputs, and approved presets are retained.',
    ...(result ? { removed: result } : {}),
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(runLocalArtifacts(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
