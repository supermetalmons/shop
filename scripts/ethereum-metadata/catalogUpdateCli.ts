import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readRevealCatalogUpdateBundle, runRevealCatalogUpdate, publicCatalogUpdateResult } from './catalogUpdate.ts';

const USAGE = 'Usage: ethereum:catalog-history inspect|verify --bundle DIRECTORY [--deployment-id ID --expected-revision N]';

export async function catalogUpdateMain(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    bundle: { type: 'string' }, 'deployment-id': { type: 'string' }, 'expected-revision': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) return USAGE;
  const [action] = positionals;
  const deploymentId = values['deployment-id'];
  const expectedRevision = Number(values['expected-revision']);
  if (positionals.length !== 1 || (action !== 'inspect' && action !== 'verify') || !values.bundle?.trim() ||
    (deploymentId === undefined) !== (values['expected-revision'] === undefined) ||
    deploymentId !== undefined && (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(deploymentId) ||
      !/^[1-9]\d*$/.test(values['expected-revision']!) || !Number.isSafeInteger(expectedRevision))) throw new Error(USAGE);
  if (deploymentId !== undefined) return publicCatalogUpdateResult(await runRevealCatalogUpdate({
    directory: values.bundle, deploymentId, expectedRevision, action,
  }));
  const { batch } = await readRevealCatalogUpdateBundle(values.bundle);
  return { verified: true, batchId: batch.batchId, batchSha256: batch.batchSha256, artworks: batch.mappings.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  catalogUpdateMain(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
}
