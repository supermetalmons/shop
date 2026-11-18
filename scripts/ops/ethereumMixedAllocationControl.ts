import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getInstalledMixedAllocation } from '../../shared/ethereum/installedMixedAllocation.ts';
import { mixedAllocationScope, registeredMixedCatalog, type MixedAllocationMaintenanceRequest, type MixedAllocationMaintenanceResult as Result } from '../../shared/ethereum/mixedAllocationMaintenance.ts';
import { ETHEREUM_REVEAL_DEPLOYMENT_ID, type EthereumRevealDeployment } from '../../shared/ethereum/revealDeployment.ts';
import { mixedAllocationCounts, mixedAllocationHash, type MixedAllocationDefinition } from '../../shared/ethereum/revealMixedAllocation.ts';
import type { Ethereum111kConfig } from '../../shared/ethereum/config.ts';
import { privateHatchPath } from '../ethereum-metadata/privateHatchPath.ts';
import { writeDurableJsonJournalAsync } from '../shared/durableJsonJournal.ts';
import { mixedAllocationProgress, withEthereumRevealMaintenance } from '../shared/ethereumRevealMaintenance.ts';
import { runEthereumRevealControl } from './ethereumRevealControl.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const JOURNAL = fileURLToPath(new URL('../../releases/111k-catalog-v10/mainnet-mixed-20261117.journal.json', import.meta.url));
const USAGE = 'Usage: ethereum:mixed-allocation <status|apply|verify|refresh-scan|refresh-activation|cancel> --batch-id ID [--deployment-id ID] [--expected-revision N] [--journal PATH] [--write]';
type Command = 'status' | 'apply' | 'verify' | 'refresh-scan' | 'refresh-activation' | 'cancel';
type Action = MixedAllocationMaintenanceRequest['action'];
type Transport = (request: MixedAllocationMaintenanceRequest) => Promise<Result>;
type Storefront = Pick<Ethereum111kConfig, 'enabled' | 'chainId' | 'contractAddress' | 'metadataBaseUri' | 'deploymentBlock'>;
type MediaPreflight = Awaited<ReturnType<typeof import('../ethereum-metadata/mixedMedia.ts').preflightMixedMedia>>;
type Dependencies = {
  installed?: typeof getInstalledMixedAllocation;
  storefront?: () => Promise<Storefront>;
  preflight?: typeof import('../ethereum-metadata/mixedMedia.ts').preflightMixedMedia;
  registry?: (deploymentId: string) => Promise<EthereumRevealDeployment>;
  defaultJournalPath?: string;
  transport?: Transport;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onProgress?: (result: Result) => void;
  onMediaPreflight?: (receipt: MediaPreflight) => void;
};
type Journal = ReturnType<typeof releaseIdentity> & { expectedRevision: number; sourceCatalogRevision: number };

function parseOptions(args: string[]) {
  const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, tokens: true, options: {
    'expected-revision': { type: 'string' }, 'batch-id': { type: 'string' }, 'deployment-id': { type: 'string' }, journal: { type: 'string' }, write: { type: 'boolean', default: false },
  } });
  const options = tokens.filter(token => token.kind === 'option').map(token => token.name);
  const command = positionals[0] as Command;
  const revision = values['expected-revision'];
  if (positionals.length !== 1 || !['status','apply','verify','refresh-scan','refresh-activation','cancel'].includes(command) ||
    !ETHEREUM_REVEAL_DEPLOYMENT_ID.test(values['batch-id'] ?? '') ||
    values['deployment-id'] !== undefined && !ETHEREUM_REVEAL_DEPLOYMENT_ID.test(values['deployment-id']) ||
    new Set(options).size !== options.length || values.write !== (command !== 'status') || values.journal?.trim() === '' ||
    revision !== undefined && (!/^[1-9]\d*$/.test(revision) || !Number.isSafeInteger(Number(revision)))) throw new Error(USAGE);
  return { command, batchId: values['batch-id']!, deploymentId: values['deployment-id'], journalPath: values.journal ? resolve(values.journal) : undefined, revision: revision === undefined ? undefined : Number(revision) };
}

function releaseIdentity(definition: MixedAllocationDefinition) {
  return { ...mixedAllocationScope(definition), definitionSha256: mixedAllocationHash(definition),
    sourceSha256: definition.sourceSha256, predecessorVersion: definition.predecessor.catalogVersion,
    predecessorSha256: definition.predecessor.manifestSha256, targetVersion: definition.target.catalogVersion, targetSha256: definition.target.manifestSha256 };
}

async function activeStorefront(): Promise<Storefront> {
  const response = await fetch('https://mons.shop/api/ethereum/111k/config', {
    headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Could not discover the active Sepolia storefront.');
  return response.json() as Promise<Storefront>;
}

async function originalOperation(path: string, revision: number | undefined, registry: EthereumRevealDeployment, command: Command,
  release: ReturnType<typeof releaseIdentity>): Promise<Journal> {
  if (registry.deploymentId !== release.deploymentId || registry.chainId !== release.chainId || registry.contractAddress !== release.contractAddress ||
    registry.metadataBaseUri !== release.metadataBaseUri || registry.deploymentBlock !== release.deploymentBlock ||
    registry.dropId !== (release.chainId === 1 ? '111k' : '111k_devnet') || registry.retiredAtMs != null ||
    registry.state !== 'active' || !registry.provisionedAtMs || registry.lastError !== null ||
    !['status','verify'].includes(command) && registry.catalogUpdateId != null && registry.catalogUpdateId !== release.batchId) {
    throw new Error('Mixed deployment identity, ownership or readiness changed.');
  }
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
  const effective = registeredMixedCatalog(registry);
  const old = effective?.catalogVersion === release.predecessorVersion && effective.manifestSha256 === release.predecessorSha256;
  const target = effective?.catalogVersion === release.targetVersion && effective.manifestSha256 === release.targetSha256;
  const expectedRevision = revision ?? (old && registry.catalogUpdateId == null ? registry.revision : undefined);
  if (expectedRevision === undefined || !old && !target || !Number.isSafeInteger(registry.catalogRevision) ||
    (command !== 'status' && revision === undefined)) throw new Error('The first write requires the original --expected-revision and matching predecessor or target.');
  const step = registry.revision - expectedRevision;
  const active = registry.catalogUpdateId === release.batchId;
  const afterActivation = target && (step === 2 && active || step === 3 && !active);
  const beforeActivation = old && (step === 1 && active || step === 0 && !active);
  const sourceCatalogRevision = registry.catalogRevision! - Number(afterActivation);
  if (sourceCatalogRevision < 0 || !beforeActivation && !afterActivation) {
    throw new Error('Registry does not match the original mixed operation revision.');
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
      if (r.published !== r.readyCount || r.retrying || r.pendingEnrichment) initialPasses = Math.max(initialPasses, r.verificationPasses);
      else if (r.verificationPasses > initialPasses && !r.verificationInProgress) return r;
    } else if (r.complete && r.published === r.readyCount && !r.pendingEnrichment && !r.retrying && !r.verificationInProgress) return r;
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
          r.published === r.readyCount && !r.retrying && !r.pendingEnrichment ? 'complete' : 'verify';
    }
    r = await send(action);
    if (!r.complete) await sleep(r.phase === 'publishing' && r.published < r.readyCount ? Math.max(250, Math.min(2_000, r.retryAfterMs)) : 100);
  }
}

export async function mixedAllocationControlMain(args: string[], dependencies: Dependencies = {}): Promise<Result & { mediaPreflight?: MediaPreflight | null }> {
  const options = parseOptions(args);
  const { definition, targetCatalog } = (dependencies.installed ?? getInstalledMixedAllocation)(options.batchId);
  const release = releaseIdentity(definition);
  if (options.batchId !== release.batchId || options.deploymentId !== undefined && options.deploymentId !== release.deploymentId) {
    throw new Error('Mixed deployment does not match the requested release.');
  }
  if (options.deploymentId === undefined) {
    if (release.chainId !== 11155111) throw new Error('Mainnet requires explicit --deployment-id selection.');
    const current = await (dependencies.storefront ?? activeStorefront)();
    if (current?.enabled !== true || current.chainId !== release.chainId || current.contractAddress !== release.contractAddress ||
      current.metadataBaseUri !== release.metadataBaseUri || current.deploymentBlock !== release.deploymentBlock) {
      throw new Error('Mixed deployment differs from the active Sepolia storefront.');
    }
  }
  const registry = dependencies.registry ? await dependencies.registry(release.deploymentId) :
    (await runEthereumRevealControl(['status','--deployment-id',release.deploymentId])).deployments?.[0];
  if (!registry) throw new Error('The selected reveal deployment is unavailable.');
  const path = options.journalPath ?? dependencies.defaultJournalPath ?? (definition.version === 1 ? JOURNAL :
    join(root, '.operations', release.deploymentId, release.batchId + '.journal.json'));
  if (options.command !== 'status' && (definition.version !== 1 || path !== JOURNAL)) privateHatchPath(path);
  const operation = await originalOperation(path, options.revision, registry, options.command, release);
  const counts = mixedAllocationCounts(definition);
  const identity = { deploymentId: operation.deploymentId, batchId: operation.batchId, expectedRevision: operation.expectedRevision,
    ...(definition.version === 1 ? {} : { definitionSha256: release.definitionSha256 }) };
  let priorProgress = '';
  let mediaPreflight: MediaPreflight | null = null;
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
        r.readyCount !== counts.readyCount || r.grailCount !== counts.preassignedCount || r.futureCount !== counts.futureCount ||
        r.complete && (r.phase !== 'complete' || r.activationSelected !== counts.readyCount ||
          r.generationSeeded !== 111_111 || r.staged !== counts.totalCount || r.verificationPasses < 2 ||
          r.catalogUpdateId !== null && (r.catalogUpdateId === identity.batchId || !['status','verify'].includes(options.command)) || r.catalogRevision < operation.sourceCatalogRevision + 1 ||
          r.registryRevision < operation.expectedRevision + 3)) throw new Error('Unexpected mixed allocation release, verification or registry response.');
      const progress = JSON.stringify(r);
      if (progress !== priorProgress) { dependencies.onProgress?.(r); priorProgress = progress; }
      return r;
    };
    const status = await send('status');
    if (status.phase === 'unstarted' && options.command === 'apply' && definition.version !== 1) {
      const { preflightMixedMedia } = await import('../ethereum-metadata/mixedMedia.ts');
      mediaPreflight = await (dependencies.preflight ?? preflightMixedMedia)(definition, targetCatalog, fetch, registry.templateJson);
      dependencies.onMediaPreflight?.(mediaPreflight);
    }
    if (options.command !== 'status') {
      await mkdir(dirname(path), { recursive: true });
      try { await writeDurableJsonJournalAsync({ filePath: path, mode: 'create', value: operation }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' ||
          (await readFile(path, 'utf8')).trim() !== JSON.stringify(operation, null, 2)) throw error;
      }
    }
    const result = await runCommand(options.command,status,send,dependencies);
    return options.command === 'apply' && definition.version === 2 ? { ...result, mediaPreflight } : result;
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
