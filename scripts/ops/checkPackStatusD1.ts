import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readD1Integrity } from '../shared/d1PackStatusMaintenance.ts';

export function formatPackStatusD1Report(): string {
  const report = readD1Integrity();
  return `D1 pack status is healthy: ${report.drops.length} summaries, ${report.eventCount} events, cache generation ${report.cacheGeneration}.`;
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href);
}

if (isDirectRun()) {
  try {
    console.log(formatPackStatusD1Report());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
