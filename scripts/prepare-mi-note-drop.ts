import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseMiNoteDropManifest, prepareMiNoteDropManifest, verifyMiNoteDropManifest,
} from './shared/miNoteDropManifest.ts';

const usage = 'Usage: prepare-mi-note-drop <preorderId> [--output <manifest.json> | --check <manifest.json>]';

export function parsePrepareMiNoteDropArgs(argv: string[]) {
  const [preorderId, flag, path, ...extra] = argv;
  if (!preorderId || extra.length || flag && (!['--output', '--check'].includes(flag) || !path) || !flag && path) {
    throw new Error(usage);
  }
  return { preorderId, ...(flag === '--output' ? { output: resolve(path) } : {}), ...(flag === '--check' ? { check: resolve(path) } : {}) };
}

export async function prepareMiNoteDrop(argv: string[]) {
  const options = parsePrepareMiNoteDropArgs(argv);
  const manifest = options.check
    ? parseMiNoteDropManifest(JSON.parse(readFileSync(options.check, 'utf8')))
    : await prepareMiNoteDropManifest(options.preorderId);
  if (manifest.sourcePreorder.preorderId !== options.preorderId) throw new Error('Manifest belongs to another preorder collection.');
  if (options.check) await verifyMiNoteDropManifest(manifest);
  if (options.output) {
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  }
  return {
    preorderId: manifest.sourcePreorder.preorderId, cluster: manifest.sourcePreorder.cluster,
    excludedCards: manifest.excludedCardIds.length, eligibleCards: manifest.eligibleCardIds.length,
    packs: manifest.packCount, maxFigureId: manifest.maxFigureId, sha256: manifest.sha256,
    ...(options.output ? { manifestPath: options.output } : {}), verified: true,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  prepareMiNoteDrop(process.argv.slice(2)).then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error instanceof Error ? error.message : 'Mi Note inventory preparation failed.'); process.exitCode = 1; });
}
