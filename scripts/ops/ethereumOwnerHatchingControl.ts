import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { redactOwnerHatchingCursor, type OwnerHatchingMaintenanceRequest, type OwnerHatchingMaintenanceResult } from '../../shared/ethereum/ownerHatchingMaintenance.ts';
import type { EthereumRevealDeployment } from '../../shared/ethereum/revealDeployment.ts';
import { withEthereumRevealMaintenance } from '../shared/ethereumRevealMaintenance.ts';
import { runEthereumRevealControl } from './ethereumRevealControl.ts';

const USAGE = 'Usage: ethereum:owner-hatch-history status|verify --deployment-id ID --batch-id ID --expected-revision N [--write]';

type ControlOptions = {
  command: 'inspect' | 'status' | 'verify'; deploymentId: string; batchId: string; expectedRevision: number;
};
type Transport = (request: OwnerHatchingMaintenanceRequest) => Promise<OwnerHatchingMaintenanceResult>;
type Continuation = (action: OwnerHatchingMaintenanceRequest['action']) => Promise<OwnerHatchingMaintenanceResult>;
type Dependencies = {
  registry?: (deploymentId: string) => Promise<EthereumRevealDeployment>;
  transport?: Transport;
  sleep?: (milliseconds: number) => Promise<void>;
  onProgress?: (result: OwnerHatchingMaintenanceResult) => void;
};

export function parseOwnerHatchingControlArgs(args: string[]): ControlOptions | null {
  const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, tokens: true, options: {
    'deployment-id': { type: 'string' }, 'batch-id': { type: 'string' }, 'expected-revision': { type: 'string' },
    write: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  const seen = new Set<string>();
  for (const token of tokens) if (token.kind === 'option') {
    if (seen.has(token.name)) throw new Error(`Duplicate option --${token.name}.`);
    seen.add(token.name);
  }
  if (values.help) return null;
  const command = positionals[0];
  const validId = (value: string | undefined) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(value ?? '');
  const expectedRevision = Number(values['expected-revision']);
  if (positionals.length !== 1 || (command !== 'inspect' && command !== 'status' && command !== 'verify') ||
    !validId(values['deployment-id']) || !validId(values['batch-id']) || !/^[1-9]\d*$/.test(values['expected-revision'] ?? '') ||
    !Number.isSafeInteger(expectedRevision) || Boolean(values.write) !== (command === 'verify')) throw new Error(USAGE);
  return { command, deploymentId: values['deployment-id']!, batchId: values['batch-id']!, expectedRevision };
}

async function readDeployment(deploymentId: string): Promise<EthereumRevealDeployment> {
  const result = await runEthereumRevealControl(['status', '--deployment-id', deploymentId]);
  if (!result.deployments || result.deployments.length !== 1) throw new Error('Owner hatching deployment was not found.');
  return result.deployments[0];
}

function requireMainnetDeployment(deployment: EthereumRevealDeployment, options: ControlOptions): void {
  if (deployment.deploymentId !== options.deploymentId || deployment.chainId !== 1 || deployment.dropId !== '111k' ||
    deployment.state !== 'active' || deployment.retiredAtMs != null || deployment.catalogUpdateId != null ||
    deployment.revision < options.expectedRevision) {
    throw new Error('Owner hatching requires the active mainnet deployment without a catalog update.');
  }
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
    retryAfterMs: value.retryAfterMs, verificationCursor: redactOwnerHatchingCursor(value.verificationCursor),
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

async function runOperation(options: ControlOptions, transport: Transport, dependencies: Dependencies): Promise<OwnerHatchingMaintenanceResult> {
  const sleep = dependencies.sleep ?? (milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds)));
  const identity = { deploymentId: options.deploymentId, batchId: options.batchId, expectedRevision: options.expectedRevision };
  let previousProgress = '';
  const send = async (action: OwnerHatchingMaintenanceRequest['action']) => {
    const result = sanitizedResult(await transport({ ...identity, action }), options);
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
  const result = await verifyBatch(send, pause);
  if (result.pendingEnrichment) throw new Error(`Owner hatching trait enrichment is incomplete (${result.pendingEnrichment} pending).`);
  return result;
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
