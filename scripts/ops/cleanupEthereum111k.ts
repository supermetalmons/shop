import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { run111kReplacementCleanup, type ReplacementCleanupOptions } from '../shared/ethereum111kReplacementCleanup.ts';

export function parse111kReplacementCleanupArgs(argv: string[]): ReplacementCleanupOptions {
  const { values, positionals, tokens } = parseArgs({ args: argv, allowPositionals: true, tokens: true,
    options: { 'release-directory': { type: 'string' }, write: { type: 'boolean', default: false } } });
  const seen = new Set<string>();
  for (const token of tokens) if (token.kind === 'option') {
    if (seen.has(token.name)) throw new Error(`Duplicate option --${token.name}.`);
    seen.add(token.name);
  }
  if (positionals.length !== 1 || !['finalize', 'cancel'].includes(positionals[0]) || !values['release-directory']?.trim()) {
    throw new Error('Usage: cleanup:ethereum111k -- <finalize|cancel> --release-directory DIR [--write]');
  }
  return { releaseDirectory: resolve(values['release-directory']), write: values.write,
    ...(positionals[0] === 'cancel' ? { cancel: true } : {}) };
}

export async function runCleanupEthereum111k(argv: string[]) {
  return run111kReplacementCleanup(parse111kReplacementCleanupArgs(argv));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { console.log(JSON.stringify(await runCleanupEthereum111k(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Cleanup failed.'); process.exitCode = 1; }
}
