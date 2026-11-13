import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { inspectRevealCatalogUpdate, prepareRevealCatalogUpdate, promoteRevealCatalogUpdate,
  prepareRevealCatalogUpdateFromBundle, readRevealCatalogUpdateBundle, runRevealCatalogUpdate, inspectEligibleCutoffEggs } from './catalogUpdate.ts';

const USAGE = `Usage: npm run ethereum:catalog-update -- COMMAND [options]

  inspect --source PATH [--catalog-version 111k-vN]
  prepare --source PATH --bundle DIR [--catalog-version 111k-vN]
  prepare --source PATH --bundle DIR --egg-ids JSON --egg-cutoff N [--catalog-version 111k-vN]
  eligible-eggs --deployment-id ID --expected-revision N --egg-cutoff N
  prepare --from-bundle CANCELLED_DIR --bundle NEW_DIR
  promote --bundle DIR --write
  apply|cancel --bundle DIR --deployment-id ID --expected-revision N --write
  inspect|verify --bundle DIR --deployment-id ID --expected-revision N
  verify --bundle DIR

Inspect and verify are read-only. Prepare freezes one random bijection locally.
Promote changes the local default catalog only. Apply and cancel use maintenance RPC.
Apply stages and activates online; cancellation is available before activation.
`;

export function parseCatalogUpdateArgs(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    source: { type: 'string' }, bundle: { type: 'string' }, 'from-bundle': { type: 'string' }, 'catalog-version': { type: 'string' },
    'egg-ids': { type: 'string' }, 'egg-cutoff': { type: 'string' },
    'deployment-id': { type: 'string' }, 'expected-revision': { type: 'string' }, write: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) return null;
  const command = positionals[0];
  if (positionals.length !== 1 || !['inspect', 'prepare', 'promote', 'apply', 'verify', 'cancel', 'eligible-eggs'].includes(command)) throw new Error(USAGE);
  if (Object.values(values).some(value => typeof value === 'string' && !value.trim())) throw new Error('Catalog update options cannot be empty.');
  if (values['catalog-version'] && !/^111k-v[1-9]\d{0,8}$/.test(values['catalog-version'])) throw new Error('Invalid catalog version.');
  const expectedRevision = values['expected-revision'] === undefined ? undefined : Number(values['expected-revision']);
  if (expectedRevision !== undefined && (!/^[1-9]\d*$/.test(values['expected-revision']!) || !Number.isSafeInteger(expectedRevision))) {
    throw new Error('Expected revision must be a positive safe integer.');
  }
  const eggCutoff = values['egg-cutoff'] === undefined ? undefined : Number(values['egg-cutoff']);
  if (eggCutoff !== undefined && (!/^(0|[1-9]\d*)$/.test(values['egg-cutoff']!) || !Number.isSafeInteger(eggCutoff) || eggCutoff >= 111_111)) {
    throw new Error('Egg cutoff must be a nonnegative artwork ID.');
  }
  if (command === 'eligible-eggs') {
    if (!values['deployment-id'] || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(values['deployment-id']) || expectedRevision === undefined || eggCutoff === undefined ||
      values.write || values.source || values.bundle || values['from-bundle'] || values['catalog-version'] || values['egg-ids']) throw new Error(USAGE);
    return { command, deploymentId: values['deployment-id'], expectedRevision, eggCutoff, write: false };
  }
  if ((values['egg-ids'] !== undefined) !== (eggCutoff !== undefined) ||
    values['egg-ids'] !== undefined && (command !== 'prepare' || values['from-bundle'])) throw new Error(USAGE);
  const remote = Boolean(values['deployment-id']);
  const fromBundle = values['from-bundle'];
  const sourceCommand = command === 'prepare' || command === 'inspect' && !remote;
  if (fromBundle && (command !== 'prepare' || values.source || values['catalog-version'])) throw new Error(USAGE);
  if (sourceCommand ? !values.source && !fromBundle || command === 'prepare' && !values.bundle || remote || expectedRevision !== undefined :
    !values.bundle || values.source !== undefined || values['catalog-version'] !== undefined) throw new Error(USAGE);
  if (command === 'inspect' && values.source && values.bundle) throw new Error(USAGE);
  if (['promote', 'apply', 'cancel'].includes(command) ? !values.write : values.write) throw new Error(USAGE);
  if (command === 'promote' && (remote || expectedRevision !== undefined)) throw new Error(USAGE);
  if (['apply', 'cancel'].includes(command) && !remote || remote !== (expectedRevision !== undefined)) throw new Error(USAGE);
  if (values['deployment-id'] && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(values['deployment-id'])) throw new Error('Invalid deployment ID.');
  return { command, sourcePath: values.source && resolve(values.source), directory: values.bundle && resolve(values.bundle),
    fromDirectory: fromBundle && resolve(fromBundle),
    catalogVersion: values['catalog-version'], deploymentId: values['deployment-id'], expectedRevision,
    eggIdsPath: values['egg-ids'] && resolve(values['egg-ids']), eggCutoff, write: Boolean(values.write) };
}

export async function catalogUpdateMain(args: string[]): Promise<unknown> {
  const options = parseCatalogUpdateArgs(args);
  if (!options) return USAGE;
  if (options.command === 'eligible-eggs') {
    return inspectEligibleCutoffEggs({ deploymentId: options.deploymentId!, expectedRevision: options.expectedRevision!, eggCutoff: options.eggCutoff! });
  }
  if (options.command === 'inspect' && !options.deploymentId) {
    return inspectRevealCatalogUpdate({ sourcePath: options.sourcePath!, catalogVersion: options.catalogVersion });
  }
  if (options.command === 'prepare') {
    const eggIdsValue: unknown = options.eggIdsPath ? JSON.parse(await readFile(options.eggIdsPath, 'utf8')) : undefined;
    const eggIds = Array.isArray(eggIdsValue) ? eggIdsValue : eggIdsValue && typeof eggIdsValue === 'object' &&
      'eggIds' in eggIdsValue ? eggIdsValue.eggIds : undefined;
    if (options.eggIdsPath && (!Array.isArray(eggIds) || eggIds.some(id => !Number.isSafeInteger(id) || id <= 0))) {
      throw new Error('Egg IDs must be a JSON integer array or an eligible-eggs report.');
    }
    const { batch } = options.fromDirectory ? await prepareRevealCatalogUpdateFromBundle(options.fromDirectory, options.directory!) :
      await prepareRevealCatalogUpdate({ sourcePath: options.sourcePath!, directory: options.directory!, catalogVersion: options.catalogVersion,
        ...(Array.isArray(eggIds) ? { eggIds, eggCutoff: options.eggCutoff } : {}) });
    return { batchId: batch.batchId, batchSha256: batch.batchSha256, mappings: batch.mappings.length, directory: options.directory };
  }
  if (options.command === 'promote') {
    await promoteRevealCatalogUpdate(options.directory!, { write: options.write });
    return { promoted: true };
  }
  if (options.command === 'verify' && !options.deploymentId) {
    const { batch } = await readRevealCatalogUpdateBundle(options.directory!);
    return { verified: true, batchId: batch.batchId, batchSha256: batch.batchSha256 };
  }
  return runRevealCatalogUpdate({ directory: options.directory!, deploymentId: options.deploymentId!, expectedRevision: options.expectedRevision!,
    action: options.command as 'apply' | 'inspect' | 'verify' | 'cancel', onProgress: result => process.stderr.write(`${JSON.stringify(result)}\n`) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  catalogUpdateMain(process.argv.slice(2)).then(result => process.stdout.write(typeof result === 'string' ? result : `${JSON.stringify(result)}\n`))
    .catch(error => { process.stderr.write(`Catalog update failed: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1; });
}
