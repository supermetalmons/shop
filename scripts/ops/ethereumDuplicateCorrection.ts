import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { duplicateCorrectionDefinition as definition, duplicateCorrectionDefinitionSha256 as digest } from '../../shared/ethereum/installedDuplicateCorrection.ts';
import { duplicateCorrectionRegistryPhase, parseDuplicateCorrectionRequest, requireDuplicateCorrectionScope,
  type DuplicateCorrectionRequest, type DuplicateCorrectionResult } from '../../shared/ethereum/duplicateCorrection.ts';
import { duplicateCorrectionLedgerSummary } from '../shared/duplicateCorrectionLedgerSummary.ts';
import type { EthereumRevealDeployment } from '../../shared/ethereum/revealDeployment.ts';
import { duplicateCorrectionMediaPreflight } from '../ethereum-metadata/duplicateCorrectionMedia.ts';
import { privateHatchPath } from '../ethereum-metadata/privateHatchPath.ts';
import { writeDurableJsonJournalAsync } from '../shared/durableJsonJournal.ts';
import { withEthereumRevealMaintenance } from '../shared/ethereumRevealMaintenance.ts';
import { runEthereumRevealControl } from './ethereumRevealControl.ts';

type Identity = Omit<DuplicateCorrectionRequest, 'action'>;
type Transport = (request: DuplicateCorrectionRequest) => Promise<DuplicateCorrectionResult>;
type Dependencies = {
  registry?: () => Promise<EthereumRevealDeployment>;
  transport?: Transport;
  preflight?: typeof duplicateCorrectionMediaPreflight;
};

const usage = 'Usage: ethereum:duplicate-correction <status|inspect|apply|verify> --deployment-id mainnet-v1 [--expected-revision N] [--journal FILE] [--write]';
const journalDefault = fileURLToPath(new URL(`../../.operations/${definition.deploymentId}/${definition.operationId}.journal.json`, import.meta.url));

export async function duplicateCorrectionMain(args: string[], dependencies: Dependencies = {}) {
  const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, tokens: true, options: {
    'deployment-id': { type: 'string' }, 'expected-revision': { type: 'string' }, journal: { type: 'string' }, write: { type: 'boolean', default: false },
  } });
  const specified = tokens.filter(t => t.kind === 'option').map(t => t.name);
  const command = positionals[0], revision = values['expected-revision'];
  if (positionals.length !== 1 || !['status','inspect','apply','verify'].includes(command) || new Set(specified).size !== specified.length ||
    values['deployment-id'] !== definition.deploymentId || values.write !== (command === 'apply') || values.journal?.trim() === '' ||
    revision !== undefined && (!/^[1-9]\d*$/.test(revision) || !Number.isSafeInteger(Number(revision)))) throw new Error(usage);
  const path = resolve(values.journal ?? journalDefault);
  if (command === 'apply') privateHatchPath(path);
  const registry = dependencies.registry ? await dependencies.registry() :
    (await runEthereumRevealControl(['status','--deployment-id',definition.deploymentId])).deployments?.[0];
  requireDuplicateCorrectionScope(registry, definition);
  let saved: string | undefined;
  try { saved = await readFile(path,'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const fixed = { deploymentId: definition.deploymentId, operationId: definition.operationId, definitionSha256: digest };
  let identity: Identity;
  if (saved !== undefined) {
    const journal = JSON.parse(saved) as Identity;
    const validated = parseDuplicateCorrectionRequest({ ...journal, action: 'inspect' }, definition, digest);
    if (revision !== undefined && Number(revision) !== validated.expectedRevision) throw new Error('Use the original duplicate correction journal revision.');
    identity = { ...fixed, expectedRevision: validated.expectedRevision, sourceCatalogRevision: validated.sourceCatalogRevision };
  } else {
    if (command !== 'inspect' && command !== 'status' && revision === undefined || registry.catalogUpdateId === definition.operationId && revision === undefined) {
      throw new Error('Supply the original --expected-revision or the retained correction journal.');
    }
    const expectedRevision = revision === undefined ? registry.revision : Number(revision);
    const step = registry.revision - expectedRevision;
    identity = { ...fixed, expectedRevision, sourceCatalogRevision: registry.catalogRevision! - Number(step >= 2) };
    parseDuplicateCorrectionRequest({ ...identity, action: 'inspect' }, definition, digest);
  }
  duplicateCorrectionRegistryPhase(registry, definition, { ...identity, action: 'inspect' });
  const execute = async (send: Transport) => {
    const rpc = async (action: DuplicateCorrectionRequest['action']) => {
      const r = await send({ ...identity, action });
      if (Object.entries(identity).some(([k,v]) => r[k as keyof Identity] !== v) || r.ledger.definitionSha256 !== digest || r.ledger.operationId !== identity.operationId ||
        !['unstarted','claimed','mirrored','complete'].includes(r.phase) || !Number.isSafeInteger(r.registryRevision) || !Number.isSafeInteger(r.catalogRevision) ||
        (r.phase === 'complete' || r.phase === 'mirrored') && !r.ledger.applied || r.phase === 'unstarted' && r.ledger.applied ||
        action !== 'inspect' && r.phase !== 'complete') throw new Error('Unexpected duplicate correction response.');
      return { ...identity, registryRevision: r.registryRevision, catalogRevision: r.catalogRevision, phase: r.phase,
        ledger: duplicateCorrectionLedgerSummary(r.ledger) };
    };
    if (command !== 'apply') return rpc(command === 'verify' ? 'verify' : 'inspect');
    const state = await rpc('inspect');
    if (state.phase === 'complete') return rpc('verify');
    if (!state.ledger.applied && state.ledger.totals.conflicts) throw new Error('Protected artwork conflicts require inspection before apply.');
    const mediaPreflight = state.ledger.applied ? null : await (dependencies.preflight ?? duplicateCorrectionMediaPreflight)(definition);
    if (!saved) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try { await writeDurableJsonJournalAsync({ filePath:path, mode:'create', value:identity }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || (await readFile(path,'utf8')).trim() !== JSON.stringify(identity,null,2)) throw error;
      }
    }
    return { ...await rpc('apply'), mediaPreflight };
  };
  if (dependencies.transport) return execute(dependencies.transport);
  return withEthereumRevealMaintenance(transport => {
    if (!transport.duplicateCorrection) throw new Error('Duplicate correction maintenance transport is unavailable.');
    return execute(request => transport.duplicateCorrection!(request));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  duplicateCorrectionMain(process.argv.slice(2)).then(result => console.log(JSON.stringify(result,null,2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
