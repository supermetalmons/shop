import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ETHEREUM_REVEAL_DEPLOYMENT_ID } from '../../shared/ethereum/revealDeployment.ts';
import { applyRelicImages, prepareRelicImages, verifyRelicImages } from './relicImages.ts';

const USAGE = `Usage: npm run ethereum:relic-images -- COMMAND --directory DIR [options]

  prepare --directory DIR --deployment-id ID
  apply --directory DIR
  verify --directory DIR

Prepare freezes all 18 relic image changes against the current deployment revision.
Apply changes only matching relic image URLs and resumes from the same journal.
Verify checks stored objects, public CDN JSON, and the public metadata API.
`;

export function parseRelicImagesArgs(args: string[]) {
  const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, tokens: true, options: {
    directory: { type: 'string' }, 'deployment-id': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) return null;
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new Error(`Duplicate option --${token.name}.`);
    seen.add(token.name);
  }
  const command = positionals[0];
  if (positionals.length !== 1 || !['prepare', 'apply', 'verify'].includes(command) || !values.directory?.trim()) throw new Error(USAGE);
  const deploymentId = values['deployment-id'];
  if (command === 'prepare' ? !deploymentId || !ETHEREUM_REVEAL_DEPLOYMENT_ID.test(deploymentId) : deploymentId !== undefined) throw new Error(USAGE);
  return { command, directory: resolve(values.directory), deploymentId };
}

export async function relicImagesMain(args: string[]): Promise<unknown> {
  const options = parseRelicImagesArgs(args);
  if (!options) return USAGE;
  if (options.command === 'prepare') {
    const journal = await prepareRelicImages(options.directory, options.deploymentId!);
    return { prepared: true, complete: false, deploymentId: journal.scope.deploymentId, expectedRevision: journal.scope.expectedRevision,
      metadataBaseUri: journal.scope.metadataBaseUri, objectCount: journal.objects.length, journalSha256: journal.journalSha256,
      directory: options.directory };
  }
  if (options.command === 'verify') return verifyRelicImages(options.directory);
  return applyRelicImages(options.directory, { onProgress: progress => process.stderr.write(`${JSON.stringify(progress)}\n`) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  relicImagesMain(process.argv.slice(2)).then(result => process.stdout.write(typeof result === 'string' ? result : `${JSON.stringify(result)}\n`))
    .catch(error => { process.stderr.write(`Relic image update failed: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1; });
}
