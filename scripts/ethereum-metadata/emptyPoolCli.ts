import { emptyPoolRelease } from '../../shared/ethereum/installedMixedAllocation.ts';
import { mixedAllocationHash, validateMixedAllocationDefinition } from '../../shared/ethereum/revealMixedAllocation.ts';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { EthereumRevealEmptyPoolRequest, EthereumRevealEmptyPoolResult } from '../../shared/ethereum/revealMaintenance.ts';
import { withEthereumRevealMaintenance } from '../shared/ethereumRevealMaintenance.ts';
import { writeDurableJsonJournalAsync } from '../shared/durableJsonJournal.ts';
import { readRevealCatalogUpdateBundle } from './catalogUpdate.ts';
import { withMetadataLock } from './lock.ts';
import { privateHatchPath } from './privateHatchPath.ts';

export function parseEmptyPoolArgs(argv: string[]) {
  const { values, positionals, tokens } = parseArgs({ args: argv, allowPositionals: true, tokens: true, options: {
    bundle: { type: 'string' }, 'deployment-id': { type: 'string' }, 'operation-id': { type: 'string' },
    'expected-revision': { type: 'string' }, write: { type: 'boolean', default: false },
  } });
  const command = positionals[0];
  const seen = new Set<string>();
  for (const token of tokens) if (token.kind === 'option') {
    if (seen.has(token.name)) throw new Error(`Duplicate option --${token.name}.`);
    seen.add(token.name);
  }
  if (positionals.length !== 1 || !['inspect', 'apply', 'verify', 'cancel'].includes(command) || !values.bundle?.trim() ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(values['deployment-id'] ?? '') ||
    !/^empty-[a-f0-9]{32}$/.test(values['operation-id'] ?? '') ||
    !/^[1-9]\d*$/.test(values['expected-revision'] ?? '') || !Number.isSafeInteger(Number(values['expected-revision'])) ||
    values.write !== ['apply', 'cancel'].includes(command)) {
    throw new Error('Usage: ethereum:empty-pool <inspect|apply|verify|cancel> --bundle DIR --deployment-id ID --operation-id empty-HEX32 --expected-revision N [--write]');
  }
  return { command: command as 'inspect' | 'apply' | 'verify' | 'cancel', directory: resolve(values.bundle),
    deploymentId: values['deployment-id']!, operationId: values['operation-id']!, expectedRevision: Number(values['expected-revision']) };
}

type EmptyPoolTransport = (request: EthereumRevealEmptyPoolRequest) => Promise<EthereumRevealEmptyPoolResult>;

async function readEmptyPoolBundle(directory: string, deploymentId: string): Promise<NonNullable<EthereumRevealEmptyPoolRequest['batch']>> {
  let definitionBytes: string;
  try { definitionBytes = await readFile(join(directory, 'definition.json'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return (await readRevealCatalogUpdateBundle(directory)).batch;
  }
  const definition: unknown = JSON.parse(definitionBytes);
  validateMixedAllocationDefinition(definition);
  if (definition.version !== 2) throw new Error('Empty-pool rebuild requires a future-only release.');
  const batchSha256 = mixedAllocationHash(definition);
  emptyPoolRelease(definition.batchId, batchSha256, deploymentId);
  return { version: 'mixed', batchId: definition.batchId, batchSha256 };
}

export async function emptyPoolMain(argv: string[], dependencies: { transport?: EmptyPoolTransport } = {}): Promise<EthereumRevealEmptyPoolResult> {
  const options = parseEmptyPoolArgs(argv);
  if (options.command === 'apply' || options.command === 'cancel') options.directory = privateHatchPath(options.directory);
  const batch = await readEmptyPoolBundle(options.directory, options.deploymentId);
  const request = { deploymentId: options.deploymentId, operationId: options.operationId, expectedRevision: options.expectedRevision };
  const journalPath = join(options.directory, `${options.deploymentId}.empty-pool.journal.json`);
  const run = async () => {
    try {
      const previous = JSON.parse(await readFile(journalPath, 'utf8'));
      if (previous.batchSha256 !== batch.batchSha256 || Object.entries(request).some(([key, value]) => previous[key] !== value)) {
        throw new Error('Empty-pool journal belongs to another operation or original revision.');
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const execute = async (transport: EmptyPoolTransport) => {
      const send = async (action: 'inspect' | 'begin' | 'advance' | 'verify' | 'cancel') => {
        const result = await transport({ ...request, action, ...(action === 'begin' ? { batch } : {}) });
        if (result.deploymentId !== request.deploymentId || result.operationId !== request.operationId) throw new Error('Empty-pool response identity changed.');
        return result;
      };
      if (options.command === 'inspect' || options.command === 'verify') return send(options.command);
      if (options.command === 'cancel') {
        const result = await send('cancel');
        await writeDurableJsonJournalAsync({ filePath: journalPath, mode: 'replace', value: { ...request, batchSha256: batch.batchSha256, result } });
        return result;
      }
      await writeDurableJsonJournalAsync({ filePath: journalPath, mode: 'replace', value: { ...request, batchSha256: batch.batchSha256, result: null } });
      let result = await send('begin');
      for (;;) {
        await writeDurableJsonJournalAsync({ filePath: journalPath, mode: 'replace', value: { ...request, batchSha256: batch.batchSha256, result } });
        process.stderr.write(JSON.stringify({ observedAt: new Date().toISOString(), ...result }) + '\n');
        if (result.complete || result.phase === 'cancelled') return result;
        const wait = Math.min(5000, Math.max(0, result.retryAfterMs));
        if (wait) await new Promise(resolveWait => setTimeout(resolveWait, wait));
        result = await send('advance');
      }
    };
    if (dependencies.transport) return execute(dependencies.transport);
    return withEthereumRevealMaintenance(transport => {
      if (!transport.rebuildEmptyPool) throw new Error('Empty-pool maintenance is unavailable.');
      return execute(request => transport.rebuildEmptyPool!(request));
    });
  };
  return options.command === 'apply' || options.command === 'cancel'
    ? withMetadataLock(join(options.directory, `${options.deploymentId}.operation.lock`), run) : run();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  emptyPoolMain(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { process.stderr.write(`Empty-pool rebuild failed: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1; });
}
