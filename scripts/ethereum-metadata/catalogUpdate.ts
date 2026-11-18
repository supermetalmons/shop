import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { computeRevealCatalogDescriptor } from '../../shared/ethereum/revealAssetCatalog.ts';
import { validateRevealCatalogUpdateBatch } from '../../shared/ethereum/revealCatalogUpdate.ts';
import type { EthereumRevealCatalogUpdateRequest, EthereumRevealCatalogUpdateResult } from '../../shared/ethereum/revealMaintenance.ts';
import { withEthereumRevealMaintenance } from '../shared/ethereumRevealMaintenance.ts';
import { buildRevealAssetCatalog } from './assetImport.ts';
import { sha256 } from './catalog.ts';

type UpdateTransport = (request: EthereumRevealCatalogUpdateRequest) => Promise<EthereumRevealCatalogUpdateResult>;

async function optionalFile(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

function requireUnchangedSource(before: string, after: string): void {
  const previous = JSON.parse(before) as Record<string, unknown>;
  const next = JSON.parse(after) as Record<string, unknown>;
  if (Object.entries(previous).some(([path, dimensions]) => {
    const updated = next[path];
    return !Array.isArray(dimensions) || !Array.isArray(updated) ||
      dimensions[0] !== updated[0] || dimensions[1] !== updated[1];
  })) {
    throw new Error('Catalog expansion cannot remove or change existing source paths or dimensions.');
  }
  if (Object.entries(previous).some(([path, dimensions]) => Array.isArray(dimensions) && dimensions.length === 3 &&
    dimensions[2] !== (next[path] as unknown[])[2])) {
    throw new Error('Catalog expansion cannot remove or change existing collection block labels.');
  }
}

export async function readRevealCatalogUpdateBundle(directory: string) {
  const [raw, source, predecessorSource] = await Promise.all(['batch.json', 'source.json', 'predecessor-source.json']
    .map(name => readFile(join(directory, name), 'utf8')));
  const batch: unknown = JSON.parse(raw);
  validateRevealCatalogUpdateBatch(batch);
  if (sha256(source) !== batch.target.manifest.source.sha256 || sha256(predecessorSource) !== batch.predecessor.manifest.source.sha256) {
    throw new Error('Frozen catalog source checksum mismatch.');
  }
  requireUnchangedSource(predecessorSource, source);
  const generated = buildRevealAssetCatalog(source, { catalogVersion: batch.target.descriptor.catalogVersion,
    availableEggs: batch.target.manifest.importSettings.availableEggs });
  if (computeRevealCatalogDescriptor(generated).manifestSha256 !== batch.target.descriptor.manifestSha256) {
    throw new Error('Frozen target manifest does not reproduce from its source.');
  }
  return { batch, source, predecessorSource };
}

export function publicCatalogUpdateResult(result: EthereumRevealCatalogUpdateResult) {
  return { deploymentId: result.deploymentId, batchId: result.batchId, phase: result.phase, complete: result.complete,
    catalogRevision: result.catalogRevision, total: result.total, staged: result.staged, applied: result.applied,
    published: result.published, frozen: result.frozen, conflicts: result.conflicts, retrying: result.retrying,
    retryAfterMs: result.retryAfterMs, ...(result.refreshTransaction && { refreshTransaction: {
      chainId: result.refreshTransaction.chainId, to: result.refreshTransaction.to, data: result.refreshTransaction.data, value: result.refreshTransaction.value } }) };
}

export async function runRevealCatalogUpdate(options: {
  directory: string; deploymentId: string; expectedRevision: number; action: 'inspect' | 'verify'; transport?: UpdateTransport;
}): Promise<EthereumRevealCatalogUpdateResult> {
  if (!['inspect', 'verify'].includes(options.action)) throw new Error('Historical catalog operations are read-only.');
  const directory = resolve(options.directory);
  const { batch } = await readRevealCatalogUpdateBundle(directory);
  const request = { deploymentId: options.deploymentId, expectedRevision: options.expectedRevision, batchId: batch.batchId };
  const journalPath = join(directory, `${options.deploymentId}.journal.json`);
  const journal = await optionalFile(journalPath);
  if (journal) {
    const previous = JSON.parse(journal);
    if (previous.batchSha256 !== batch.batchSha256 || previous.expectedRevision !== options.expectedRevision ||
      previous.deploymentId !== options.deploymentId) throw new Error('Catalog operation journal belongs to a different batch or original revision.');
  }
  const execute = async (transport: UpdateTransport) => {
    if (options.action === 'verify') {
      let cursor = batch.version === 2 ? batch.eggCutoff : batch.target.manifest.categories.eggs.count;
      while (true) {
        const result = await transport({ ...request, action: 'verify', verificationAfterEggId: cursor });
        if (result.deploymentId !== request.deploymentId || result.batchId !== batch.batchId) throw new Error('Catalog verification returned a different operation identity.');
        if (result.nextVerificationEggId === null) return result;
        if (!Number.isSafeInteger(result.nextVerificationEggId) || result.nextVerificationEggId! <= cursor ||
          result.nextVerificationEggId! > (batch.version === 2 ? batch.predecessor.manifest.importSettings.availableEggs
            : batch.predecessor.manifest.categories.eggs.count)) throw new Error('Catalog verification cursor did not advance.');
        cursor = result.nextVerificationEggId!;
      }
    }
    return transport({ ...request, action: 'inspect' });
  };
  if (options.transport) return execute(options.transport);
  return withEthereumRevealMaintenance(async transport => {
    if (!transport.catalogUpdate) throw new Error('Catalog update maintenance is not available.');
    return execute(request => transport.catalogUpdate!(request));
  });
}
