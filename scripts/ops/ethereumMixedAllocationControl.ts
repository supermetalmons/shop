import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { getInstalledMixedAllocation } from '../../shared/ethereum/installedMixedAllocation.ts';
import { MIXED_MAINNET_BATCH_ID, type MixedAllocationMaintenanceRequest, type MixedAllocationMaintenanceResult as Result } from '../../shared/ethereum/mixedAllocationMaintenance.ts';
import type { EthereumRevealDeployment } from '../../shared/ethereum/revealDeployment.ts';
import { mixedAllocationHash } from '../../shared/ethereum/revealMixedAllocation.ts';
import { writeDurableJsonJournalAsync } from '../shared/durableJsonJournal.ts';
import { mixedAllocationProgress, withEthereumRevealMaintenance } from '../shared/ethereumRevealMaintenance.ts';
import { runEthereumRevealControl } from './ethereumRevealControl.ts';

const DEPLOYMENT = 'mainnet-v1';
const CONTRACT = '0x08cded8258730bda384ff198001e47a1b50f7f9d';
const JOURNAL = fileURLToPath(new URL('../../releases/111k-catalog-v10/mainnet-mixed-20261117.journal.json', import.meta.url));
const USAGE = 'Usage: ethereum:mixed-allocation <status|apply|verify|refresh-scan|refresh-activation|cancel> [--expected-revision N] [--journal PATH] [--write]';
type Command = 'status' | 'apply' | 'verify' | 'refresh-scan' | 'refresh-activation' | 'cancel';
type Action = MixedAllocationMaintenanceRequest['action'];
type Transport = (request: MixedAllocationMaintenanceRequest) => Promise<Result>;
type Dependencies = {
  registry?: () => Promise<EthereumRevealDeployment>;
  defaultJournalPath?: string;
  transport?: Transport;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onProgress?: (result: Result) => void;
};
type Journal = ReturnType<typeof releaseIdentity> & { expectedRevision: number; sourceCatalogRevision: number };

function parseOptions(args: string[], defaultJournalPath = JOURNAL) {
  const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, tokens: true, options: {
    'expected-revision': { type: 'string' }, journal: { type: 'string' }, write: { type: 'boolean', default: false },
  } });
  const options = tokens.filter(token => token.kind === 'option').map(token => token.name);
  const command = positionals[0] as Command;
  const revision = values['expected-revision'];
  if (positionals.length !== 1 || !['status','apply','verify','refresh-scan','refresh-activation','cancel'].includes(command) ||
    new Set(options).size !== options.length || values.write !== (command !== 'status') || values.journal?.trim() === '' ||
    revision !== undefined && (!/^[1-9]\d*$/.test(revision) || !Number.isSafeInteger(Number(revision)))) throw new Error(USAGE);
  return { command, path: values.journal ? resolve(values.journal) : defaultJournalPath, revision: revision === undefined ? undefined : Number(revision) };
}

function releaseIdentity() {
  const { definition } = getInstalledMixedAllocation();
  return { deploymentId: DEPLOYMENT, batchId: MIXED_MAINNET_BATCH_ID, chainId: 1, contractAddress: CONTRACT,
    metadataBaseUri: 'https://cdn.mons.shop/111k/', deploymentBlock: 26387160, definitionSha256: mixedAllocationHash(definition),
    sourceSha256: definition.sourceSha256, predecessorVersion: definition.predecessor.catalogVersion,
    predecessorSha256: definition.predecessor.manifestSha256, targetVersion: definition.target.catalogVersion, targetSha256: definition.target.manifestSha256 };
}

async function originalOperation(path: string, revision: number | undefined, registry: EthereumRevealDeployment, command: Command): Promise<Journal> {
  const release = releaseIdentity();
  if (registry.deploymentId !== release.deploymentId || registry.chainId !== release.chainId || registry.contractAddress !== release.contractAddress ||
    registry.metadataBaseUri !== release.metadataBaseUri || registry.deploymentBlock !== release.deploymentBlock || registry.dropId !== '111k' ||
    registry.retiredAtMs != null || command !== 'status' && (registry.state !== 'active' || !registry.provisionedAtMs ||
      command !== 'verify' && registry.catalogUpdateId != null && registry.catalogUpdateId !== release.batchId)) throw new Error('Mainnet mixed deployment identity, ownership or readiness changed.');
  let saved: Journal | undefined;
  try { saved = JSON.parse(await readFile(path,'utf8')) as Journal; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (saved !== undefined) {
    if (!saved || Object.entries(release).some(([key,value]) => saved![key as keyof Journal] !== value) ||
      !Number.isSafeInteger(saved.expectedRevision) || saved.expectedRevision < 1 ||
      !Number.isSafeInteger(saved.sourceCatalogRevision) || saved.sourceCatalogRevision < 0 ||
      revision !== undefined && revision !== saved.expectedRevision) throw new Error('Resume with the frozen mixed release and original journal revision.');
    return { ...release, expectedRevision: saved.expectedRevision, sourceCatalogRevision: saved.sourceCatalogRevision };
  }
  const old = registry.effectiveCatalogVersion === release.predecessorVersion && registry.effectiveCatalogSha256 === release.predecessorSha256;
  const target = registry.effectiveCatalogVersion === release.targetVersion && registry.effectiveCatalogSha256 === release.targetSha256;
  const expectedRevision = revision ?? (old && registry.catalogUpdateId == null ? registry.revision : undefined);
  if (!Number.isSafeInteger(expectedRevision) || !old && !target || !Number.isSafeInteger(registry.catalogRevision) ||
    (command !== 'status' && revision === undefined)) throw new Error('The first write requires the original --expected-revision and matching predecessor or target.');
  const sourceCatalogRevision = registry.catalogRevision! - Number(target);
  if (sourceCatalogRevision < 0 || command !== 'status' && registry.revision !== expectedRevision! +
    (old ? Number(registry.catalogUpdateId != null) : registry.catalogUpdateId === release.batchId ? 2 : 3)) {
    throw new Error('Mainnet registry does not match the original mixed operation revision.');
  }
  return { ...release, expectedRevision: expectedRevision!, sourceCatalogRevision };
}

const sleepFor = (ms: number) => new Promise<void>(done => setTimeout(done,ms));

async function runCommand(command: Command, initial: Result, send: (action: Action) => Promise<Result>, dependencies: Dependencies) {
  const sleep = dependencies.sleep ?? sleepFor;
  const now = dependencies.now ?? Date.now;
  let r = initial;
  if (command === 'status') return r;
  if (command === 'refresh-scan' || command === 'refresh-activation') return send(command);
  if (command === 'cancel') {
    do {
      r = await send('cancel');
      if (r.phase !== 'cancelled' || !Number.isSafeInteger(r.remainingCleanup)) throw new Error('Mixed cancellation is incomplete.');
    } while (r.remainingCleanup! > 0);
    return r;
  }
  let initialPasses = r.verificationPasses;
  for (;;) {
    if (r.phase === 'cancelled') throw new Error('This mixed batch was cancelled.');
    if (r.conflicts || r.failedEnrichment) throw new Error('Mixed publication or enrichment conflicts require inspection.');
    if (command === 'verify') {
      if (!['publishing','observing','complete'].includes(r.phase)) throw new Error('Mixed verification requires an activated batch.');
      if (r.published !== 424 || r.retrying || r.pendingEnrichment) initialPasses = Math.max(initialPasses, r.verificationPasses);
      else if (r.verificationPasses > initialPasses && !r.verificationInProgress) return r;
    } else if (r.complete && r.published === 424 && !r.pendingEnrichment && !r.retrying && !r.verificationInProgress) return r;
    if (r.complete && (r.pendingEnrichment || r.retrying)) {
      await sleep(1_000);
      r = await send('status');
      continue;
    }
    if (r.phase === 'observing' && r.observationUntilMs !== null && now() < r.observationUntilMs) {
      await sleep(Math.min(15_000,r.observationUntilMs - now()));
      r = await send('status');
      continue;
    }
    if ((r.phase === 'scanning' || r.phase === 'staging') && r.scanned === r.total && r.candidates < r.readyCount) {
      throw new Error('Insufficient eligible minted eggs. When eligibility increases, run refresh-scan --write with this journal, then resume apply.');
    }
    let action: Action;
    switch (r.phase) {
      case 'unstarted': action = 'begin'; break;
      case 'scanning': action = 'scan'; break;
      case 'staging': action = 'stage'; break;
      case 'prepared':
      case 'activating': action = 'activate'; break;
      default:
        action = command === 'apply' && r.verificationPasses >= 2 && !r.verificationInProgress &&
          r.published === 424 && !r.retrying && !r.pendingEnrichment ? 'complete' : 'verify';
    }
    r = await send(action);
    if (!r.complete) await sleep(r.phase === 'publishing' && r.published < 424 ? Math.max(250, Math.min(2_000, r.retryAfterMs)) : 100);
  }
}

export async function mixedAllocationControlMain(args: string[], dependencies: Dependencies = {}): Promise<Result> {
  const options = parseOptions(args, dependencies.defaultJournalPath);
  const registry = dependencies.registry ? await dependencies.registry() :
    (await runEthereumRevealControl(['status','--deployment-id',DEPLOYMENT])).deployments?.[0];
  if (!registry) throw new Error('The mainnet reveal deployment is unavailable.');
  const operation = await originalOperation(options.path, options.revision, registry, options.command);
  const identity = { deploymentId: operation.deploymentId, batchId: operation.batchId, expectedRevision: operation.expectedRevision };
  let priorProgress = '';
  const execute = async (transport: Transport) => {
    const send = async (action: Action) => {
      const r = mixedAllocationProgress(await transport({ ...identity, action }));
      if (r.deploymentId !== identity.deploymentId || r.batchId !== identity.batchId || r.sourceSha256 !== operation.sourceSha256 ||
        r.targetVersion !== operation.targetVersion || r.targetSha256 !== operation.targetSha256 ||
        !['unstarted','scanning','staging','prepared','activating','publishing','observing','complete','cancelled'].includes(r.phase) ||
        !['readyCount','grailCount','candidates','scanned','total','staged','generationSeeded','futureCount','activationChecked',
          'activationSelected','published','hatched','retrying','conflicts','pendingEnrichment','failedEnrichment','verificationPasses',
          'registryRevision','catalogRevision','retryAfterMs'].every(key => {
          const count = r[key as keyof Result];
          return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
        }) || typeof r.verificationInProgress !== 'boolean' || typeof r.complete !== 'boolean' ||
        r.catalogUpdateId !== null && typeof r.catalogUpdateId !== 'string' ||
        r.observationUntilMs !== null && (!Number.isSafeInteger(r.observationUntilMs) || r.observationUntilMs <= 0) ||
        r.complete && (r.phase !== 'complete' || r.readyCount !== 424 || r.grailCount !== 424 || r.activationSelected !== 424 ||
          r.futureCount !== 6162 || r.generationSeeded !== 111_111 || r.staged !== 6586 || r.verificationPasses < 2 ||
          r.catalogUpdateId !== null && (r.catalogUpdateId === identity.batchId || !['status','verify'].includes(options.command)) || r.catalogRevision < operation.sourceCatalogRevision + 1 ||
          r.registryRevision < operation.expectedRevision + 3)) throw new Error('Unexpected mixed allocation release, verification or registry response.');
      const progress = JSON.stringify(r);
      if (progress !== priorProgress) { dependencies.onProgress?.(r); priorProgress = progress; }
      return r;
    };
    const status = await send('status');
    if (options.command !== 'status') {
      await mkdir(dirname(options.path), { recursive: true });
      try { await writeDurableJsonJournalAsync({ filePath: options.path, mode: 'create', value: operation }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' ||
          (await readFile(options.path, 'utf8')).trim() !== JSON.stringify(operation, null, 2)) throw error;
      }
    }
    return runCommand(options.command,status,send,dependencies);
  };
  for (let attempt = 0; ; attempt++) {
    try {
      if (dependencies.transport) return await execute(dependencies.transport);
      return await withEthereumRevealMaintenance(transport => {
        if (!transport.mixedAllocation) throw new Error('Mixed allocation maintenance is unavailable.');
        return execute(request => transport.mixedAllocation!(request));
      });
    } catch (error) {
      if (attempt >= 3 || !(error instanceof Error) ||
        !/timed out|timeout|fetch failed|network connection|disconnected|connection reset|unable to connect|temporarily unavailable|registry (?:mirror|transition) needs retry|^internal error; reference = [a-z0-9]{24}$/i.test(error.message)) throw error;
      await (dependencies.sleep ?? sleepFor)(1_000 * 2 ** attempt);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  mixedAllocationControlMain(process.argv.slice(2), { onProgress: result => process.stderr.write(JSON.stringify(result)+'\n') })
    .then(result => process.stdout.write(JSON.stringify(result)+'\n'))
    .catch(error => { process.stderr.write(`Mixed allocation failed: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode=1; });
}
