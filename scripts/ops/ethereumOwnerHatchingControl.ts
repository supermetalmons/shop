import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import supplement from '../../shared/ethereum/ownerHatchingCatalog.json';
import { getOwnerHatchingGrail, ownerHatchingCatalogSha256, type OwnerHatchingGrail } from '../../shared/ethereum/ownerHatchingCatalog.ts';
import type { OwnerHatchingMaintenanceRequest, OwnerHatchingMaintenanceResult } from '../../shared/ethereum/ownerHatchingMaintenance.ts';
import type { EthereumRevealDeployment } from '../../shared/ethereum/revealDeployment.ts';
import { withEthereumRevealMaintenance } from '../shared/ethereumRevealMaintenance.ts';
import { runEthereumRevealControl } from './ethereumRevealControl.ts';

const USAGE = `Usage: npm run ethereum:owner-hatching -- COMMAND --deployment-id ID --batch-id ID --expected-revision N [options]

  inspect|status
  verify --write
  refresh-scan --write
  refresh-activation --write
  apply --source FILE --fresh-egg-start N --fresh-egg-count N [--ready-count N] --write

Inspect and status are read-only. Verify advances the backend verification cursor.
Refresh-activation renews an unallocated snapshot and rechecks the same saved draws.
Refresh-scan restarts an unfinished candidate scan against a new canonical snapshot.
Apply validates media and resumes the same private batch through publication,
five-minute scheduler observation, re-verification, and completion.
Only aggregate progress is printed. No selection or assignment files are written.
`;

type ControlOptions = {
  command: 'inspect' | 'status' | 'verify' | 'refresh-scan' | 'refresh-activation' | 'apply';
  deploymentId: string;
  batchId: string;
  expectedRevision: number;
  sourcePath?: string;
  freshEggStart?: number;
  freshEggCount?: number;
  readyCount?: number;
};
type Transport = (request: OwnerHatchingMaintenanceRequest) => Promise<OwnerHatchingMaintenanceResult>;
type Continuation = (action: OwnerHatchingMaintenanceRequest['action']) => Promise<OwnerHatchingMaintenanceResult>;
type Dependencies = {
  readSource?: (path: string) => Promise<string>;
  registry?: (deploymentId: string) => Promise<EthereumRevealDeployment>;
  transport?: Transport;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  onProgress?: (result: OwnerHatchingMaintenanceResult) => void;
};

export function parseOwnerHatchingControlArgs(args: string[]): ControlOptions | null {
  const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, tokens: true, options: {
    'deployment-id': { type: 'string' }, 'batch-id': { type: 'string' }, 'expected-revision': { type: 'string' },
    source: { type: 'string' }, 'fresh-egg-start': { type: 'string' }, 'fresh-egg-count': { type: 'string' },
    'ready-count': { type: 'string' }, write: { type: 'boolean', default: false }, help: { type: 'boolean' },
  } });
  const seen = new Set<string>();
  for (const token of tokens) if (token.kind === 'option') {
    if (seen.has(token.name)) throw new Error(`Duplicate option --${token.name}.`);
    seen.add(token.name);
  }
  if (values.help) return null;
  const command = positionals[0];
  const validId = (value: string | undefined) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(value ?? '');
  const integer = (value: string | undefined, minimum: number, maximum = Number.MAX_SAFE_INTEGER) => {
    if (value === undefined || !/^(0|[1-9]\d*)$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
  };
  const expectedRevision = integer(values['expected-revision'], 1);
  if (positionals.length !== 1 || !['inspect', 'status', 'verify', 'refresh-scan', 'refresh-activation', 'apply'].includes(command) ||
    !validId(values['deployment-id']) || !validId(values['batch-id']) || expectedRevision === undefined ||
    values.write !== ['apply', 'verify', 'refresh-scan', 'refresh-activation'].includes(command)) throw new Error(USAGE);
  const freshEggStart = integer(values['fresh-egg-start'], 1);
  const freshEggCount = integer(values['fresh-egg-count'], 0, 2_000);
  const readyCount = values['ready-count'] === undefined ? undefined : integer(values['ready-count'], 1, 2_000);
  if (command === 'apply') {
    if (!values.source?.trim() || freshEggStart === undefined || freshEggCount === undefined ||
      !Number.isSafeInteger(freshEggStart + freshEggCount) || values['ready-count'] !== undefined && readyCount === undefined) throw new Error(USAGE);
  } else if (values.source !== undefined || values['fresh-egg-start'] !== undefined || values['fresh-egg-count'] !== undefined ||
    values['ready-count'] !== undefined) throw new Error(USAGE);
  return { command: command as ControlOptions['command'], deploymentId: values['deployment-id']!, batchId: values['batch-id']!,
    expectedRevision, ...(command === 'apply' ? { sourcePath: resolve(values.source!), freshEggStart, freshEggCount,
      ...(readyCount === undefined ? {} : { readyCount }) } : {}) };
}

async function readDeployment(deploymentId: string): Promise<EthereumRevealDeployment> {
  const result = await runEthereumRevealControl(['status', '--deployment-id', deploymentId]);
  if (!('deployments' in result) || result.deployments.length !== 1) throw new Error('Owner hatching deployment was not found.');
  return result.deployments[0];
}

function requireMainnetDeployment(deployment: EthereumRevealDeployment, options: ControlOptions): void {
  if (deployment.deploymentId !== options.deploymentId || deployment.chainId !== 1 || deployment.dropId !== '111k' ||
    deployment.state !== 'active' || deployment.retiredAtMs != null || deployment.catalogUpdateId != null ||
    deployment.revision < options.expectedRevision) {
    throw new Error('Owner hatching requires the active mainnet deployment without a catalog update.');
  }
}

export async function preflightOwnerHatchingMedia(grails: readonly OwnerHatchingGrail[], freshEggIds: readonly number[],
  fetchSource: typeof fetch = fetch): Promise<{ objects: number }> {
  const media = [
    ...grails.flatMap(grail => [
      { url: grail.image, mime: 'image/png' },
      { url: grail.animation_url, mime: grail.animation_url.endsWith('.gif') ? 'image/gif' : 'video/mp4' },
      { url: `https://cdn.lil.org/nft/111k/animated/json/v0/${grail.assetId}.json`, mime: 'application/json' },
    ]),
    ...freshEggIds.map(id => ({ url: `https://cdn.lil.org/nft/111k/eggs/${id}.png`, mime: 'image/png' })),
  ];
  for (let offset = 0; offset < media.length; offset += 8) {
    const results = await Promise.allSettled(media.slice(offset, offset + 8).map(async item => {
      const response = await fetchSource(item.url, { method: 'HEAD', redirect: 'manual',
        headers: { Origin: 'https://vvv.so', 'User-Agent': 'Mozilla/5.0 MonsOwnerHatchingPreflight/1.0' }, signal: AbortSignal.timeout(20_000) });
      try {
        const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
        if (response.status !== 200 || type !== item.mime || !['*', 'https://vvv.so'].includes(response.headers.get('access-control-allow-origin') ?? '')) {
          throw new Error(`Owner hatching media is unavailable or incompatible: ${item.url} (HTTP ${response.status}, ${type ?? 'no content type'}).`);
        }
      } finally { await response.body?.cancel(); }
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  return { objects: media.length };
}

function sanitizedResult(value: OwnerHatchingMaintenanceResult, options: ControlOptions): OwnerHatchingMaintenanceResult {
  if (value.deploymentId !== options.deploymentId || value.batchId !== options.batchId ||
    !['scanning', 'staging', 'prepared', 'activating', 'publishing', 'observing', 'complete'].includes(value.phase) ||
    typeof value.complete !== 'boolean' || value.verificationCursor !== null && typeof value.verificationCursor !== 'string' ||
    value.observationUntilMs !== null && (!Number.isSafeInteger(value.observationUntilMs) || value.observationUntilMs < 0)) {
    throw new Error('Owner hatching returned an invalid operation identity or status.');
  }
  for (const key of ['readyCount', 'grailCount', 'candidates', 'scanned', 'total', 'staged', 'activationChecked', 'activationSelected', 'published', 'hatched', 'retrying', 'conflicts',
    'pendingEnrichment', 'failedEnrichment', 'retryAfterMs'] as const) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`Owner hatching returned invalid ${key}.`);
  }
  return { deploymentId: value.deploymentId, batchId: value.batchId, phase: value.phase, readyCount: value.readyCount,
    grailCount: value.grailCount, candidates: value.candidates, scanned: value.scanned, total: value.total,
    staged: value.staged, activationChecked: value.activationChecked, activationSelected: value.activationSelected,
    published: value.published, hatched: value.hatched, retrying: value.retrying, conflicts: value.conflicts,
    pendingEnrichment: value.pendingEnrichment, failedEnrichment: value.failedEnrichment,
    retryAfterMs: value.retryAfterMs, verificationCursor: value.verificationCursor,
    observationUntilMs: value.observationUntilMs, complete: value.complete };
}

async function verifyBatch(send: Continuation, pause: (result: OwnerHatchingMaintenanceResult) => Promise<void>) {
  let result: OwnerHatchingMaintenanceResult;
  do {
    result = await send('verify');
    requireHealthyEnrichment(result);
    if (result.pendingEnrichment) return result;
    if (result.verificationCursor !== null) await pause(result);
  } while (result.verificationCursor !== null);
  if (result.conflicts) throw new Error(`Owner hatching has ${result.conflicts} publication conflicts; inspect before resuming the same batch.`);
  return result;
}

function requireHealthyEnrichment(result: OwnerHatchingMaintenanceResult): void {
  if (result.failedEnrichment) {
    throw new Error(`Owner hatching has ${result.failedEnrichment} failed trait enrichments; restore the trait source before resuming the same batch.`);
  }
  if (result.complete && result.pendingEnrichment) {
    throw new Error(`Owner hatching trait enrichment is incomplete (${result.pendingEnrichment} pending).`);
  }
}

export async function completeOwnerHatchingBatch(initial: OwnerHatchingMaintenanceResult, send: Continuation,
  dependencies: Pick<Dependencies, 'now' | 'sleep'> = {}): Promise<OwnerHatchingMaintenanceResult> {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? (milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds)));
  const pause = (result: OwnerHatchingMaintenanceResult) => sleep(Math.min(30_000, Math.max(250, result.retryAfterMs)));
  let result = initial;
  while (!result.complete && ['scanning', 'staging', 'prepared', 'activating'].includes(result.phase)) {
    if (result.phase === 'scanning') {
      if (result.scanned === result.total && result.candidates < result.readyCount) {
        throw new Error(`Only ${result.candidates} minted eggs are eligible; ${result.readyCount} are required. The batch is not activated; inspect its eligibility snapshot before retrying.`);
      }
      result = await send('scan');
    } else if (result.phase === 'staging') result = await send('stage');
    else result = await send('activate');
    if (!result.complete && result.phase !== 'prepared') await pause(result);
  }
  requireHealthyEnrichment(result);
  if (result.complete) return result;
  const fullyPublished = (value: OwnerHatchingMaintenanceResult) => value.published === value.readyCount && !value.retrying &&
    !value.conflicts && !value.pendingEnrichment && !value.failedEnrichment;
  do {
    result = await verifyBatch(send, pause);
    if (!fullyPublished(result)) await pause(result);
  } while (!fullyPublished(result));
  if (result.observationUntilMs === null) throw new Error('Owner hatching did not record a scheduler observation deadline.');
  while (now() < result.observationUntilMs) {
    await sleep(Math.min(30_000, Math.max(1, result.observationUntilMs - now())));
    result = await send('status');
    requireHealthyEnrichment(result);
    if (result.complete && fullyPublished(result)) return result;
    if (result.observationUntilMs === null) throw new Error('Owner hatching observation deadline disappeared.');
  }
  for (;;) {
    result = await verifyBatch(send, pause);
    if (!fullyPublished(result)) { await pause(result); continue; }
    result = await send('complete');
    requireHealthyEnrichment(result);
    if (result.complete && fullyPublished(result)) return result;
    await pause(result);
  }
}

async function runOperation(options: ControlOptions, transport: Transport, dependencies: Dependencies): Promise<OwnerHatchingMaintenanceResult> {
  const sleep = dependencies.sleep ?? (milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds)));
  const identity = { deploymentId: options.deploymentId, batchId: options.batchId, expectedRevision: options.expectedRevision };
  let previousProgress = '';
  const send = async (action: OwnerHatchingMaintenanceRequest['action'], body: Partial<OwnerHatchingMaintenanceRequest> = {}) => {
    const result = sanitizedResult(await transport({ ...identity, ...body, action }), options);
    const progress = JSON.stringify(result);
    if (progress !== previousProgress) {
      dependencies.onProgress?.(result);
      previousProgress = progress;
    }
    return result;
  };
  const pause = (result: OwnerHatchingMaintenanceResult) => sleep(Math.min(30_000, Math.max(250, result.retryAfterMs)));
  if (options.command === 'inspect' || options.command === 'status') return send('status');
  requireMainnetDeployment(await (dependencies.registry ?? readDeployment)(options.deploymentId), options);
  if (options.command === 'refresh-activation' || options.command === 'refresh-scan') return send(options.command);
  if (options.command === 'verify') {
    const result = await verifyBatch(send, pause);
    if (result.pendingEnrichment) throw new Error(`Owner hatching trait enrichment is incomplete (${result.pendingEnrichment} pending).`);
    return result;
  }
  const source = await (dependencies.readSource ?? (path => readFile(path, 'utf8')))(options.sourcePath!);
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const catalogBatch = supplement.batches.find(batch => batch.source.sha256 === sourceSha256);
  if (!catalogBatch) throw new Error('Source checksum does not match an approved owner hatching catalog batch.');
  const grailIds = catalogBatch.artworks.map(artwork => artwork.assetId);
  const readyCount = options.readyCount ?? grailIds.length * 2;
  if (readyCount > 2_000 || readyCount !== grailIds.length + options.freshEggCount!) {
    throw new Error('Ready count must equal the grail count plus the fresh egg count, with at most 2000 ready eggs.');
  }
  const freshEggIds = Array.from({ length: options.freshEggCount! }, (_, index) => options.freshEggStart! + index);
  await preflightOwnerHatchingMedia(grailIds.map(id => getOwnerHatchingGrail('animated', id)!), freshEggIds, dependencies.fetch);
  const deployment = await (dependencies.registry ?? readDeployment)(options.deploymentId);
  requireMainnetDeployment(deployment, options);
  const result = await send('begin', { sourceSha256, catalogSha256: ownerHatchingCatalogSha256, readyCount, grailIds, freshEggIds });
  return completeOwnerHatchingBatch(result, send, dependencies);
}

export async function ownerHatchingControlMain(args: string[], dependencies: Dependencies = {}): Promise<OwnerHatchingMaintenanceResult | string> {
  const options = parseOwnerHatchingControlArgs(args);
  if (!options) return USAGE;
  if (dependencies.transport) return runOperation(options, dependencies.transport, dependencies);
  return withEthereumRevealMaintenance(async maintenance => {
    if (!maintenance.ownerHatching) throw new Error('Owner hatching maintenance is unavailable. Deploy its Worker support first.');
    return runOperation(options, request => maintenance.ownerHatching!(request), dependencies);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  ownerHatchingControlMain(process.argv.slice(2), { onProgress: result => process.stderr.write(`${JSON.stringify(result)}\n`) })
    .then(result => process.stdout.write(typeof result === 'string' ? result : `${JSON.stringify(result)}\n`))
    .catch(error => { process.stderr.write(`Owner hatching failed: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1; });
}
